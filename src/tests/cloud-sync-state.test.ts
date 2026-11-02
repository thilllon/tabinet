import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { CLOUD_ACCOUNT_KEY, CLOUD_SYNC_KEY } from '@/lib/cloud-auth';
import { overrideCloudSyncConfig } from '@/lib/cloud-config';
import {
  afterApplied,
  CLOUD_SYNC_ALARM,
  CLOUD_SYNC_SOON_ALARM,
  ensureSyncAlarm,
  handleCloudStorageChange,
  isSyncAlarm,
  noteSettingsChange,
  parseSyncedSession,
  parseSyncedSettings,
  recordBytes,
  scheduleSoonSync,
  settingsFingerprint,
  settingsState,
  splitIntoBatches,
  SYNC_PERIOD_MINUTES,
  syncNow,
} from '@/lib/cloud-sync';
import {
  belongsTo,
  CLOUD_SYNC_META_KEY,
  type CloudSyncMeta,
  freshSyncMeta,
  keyFingerprint,
  parseSyncMeta,
  readSyncMeta,
  type SyncContext,
  syncWorkGrew,
  withKnownVersion,
  withSessionChanges,
} from '@/lib/cloud-sync-state';
import { sessionRepo } from '@/lib/session-repo';
import { DEFAULT_SORT_SETTINGS } from '@/lib/sort-settings';
import {
  type CloudRecord,
  DEFAULT_SESSION_SETTINGS,
  SESSION_SCHEMA_VERSION,
  type Session,
} from '@/types';

import { getChromeFake } from './chrome-fake';

const ACCOUNT = { token: 'tok', expiresAt: 4_000_000_000_000, email: 'a@b.c' };
const RAW_KEY = 'a2V5a2V5a2V5a2V5a2V5a2V5a2V5a2V5a2V5a2V5a2U=';
const CONTEXT: SyncContext = { account: ACCOUNT, rawKey: RAW_KEY, keyId: keyFingerprint(RAW_KEY) };

function configure(): void {
  overrideCloudSyncConfig(() => ({ apiBase: 'https://sync.test', googleClientId: 'cid' }));
}

function signIn(): void {
  const { state } = getChromeFake();
  state.local.set(CLOUD_ACCOUNT_KEY, ACCOUNT);
  state.local.set(CLOUD_SYNC_KEY, RAW_KEY);
}

/** Sync started for this account: the bookkeeping exists and is empty. */
function startTracking(overrides: Partial<CloudSyncMeta> = {}): void {
  getChromeFake().state.local.set(CLOUD_SYNC_META_KEY, {
    ...freshSyncMeta(CONTEXT, {}),
    settingsDirty: false,
    ...overrides,
  });
}

function storedMeta(): CloudSyncMeta | undefined {
  return parseSyncMeta(getChromeFake().state.local.get(CLOUD_SYNC_META_KEY));
}

function makeSession(id: string, overrides: Partial<Session> = {}): Session {
  return {
    schemaVersion: SESSION_SCHEMA_VERSION,
    id,
    kind: 'saved',
    name: id,
    origin: 'manual',
    createdAt: 1_000,
    updatedAt: 1_000,
    windows: [
      {
        state: 'normal',
        focused: false,
        groups: [],
        tabs: [{ url: 'https://a.example/', title: 'A', pinned: false, active: true }],
      },
    ],
    ...overrides,
  };
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(5_000);
});

afterEach(() => {
  overrideCloudSyncConfig();
  vi.useRealTimers();
});

describe('dormant while cloud sync is unconfigured', () => {
  beforeEach(() => {
    // The shipped build names a server, so the unconfigured case is set up explicitly.
    overrideCloudSyncConfig(() => ({ apiBase: '', googleClientId: 'cid' }));
  });

  it('session writes track nothing and read no account', async () => {
    signIn();
    startTracking();
    const get = vi.spyOn(chrome.storage.local, 'get');
    await sessionRepo.put(makeSession('s1'));
    const keysRead = get.mock.calls.flatMap(([keys]) =>
      typeof keys === 'string' ? [keys] : Array.isArray(keys) ? keys : [],
    );
    expect(keysRead).not.toContain(CLOUD_ACCOUNT_KEY);
    expect(keysRead).not.toContain(CLOUD_SYNC_META_KEY);
    expect(storedMeta()?.dirtySessions).toEqual({});
  });

  it('an edit keeps updatedAt, as it always has', async () => {
    await sessionRepo.put(makeSession('s1'));
    const saved = await sessionRepo.get('s1');
    vi.setSystemTime(9_000);
    await sessionRepo.rename('s1', 'Renamed');
    await sessionRepo.update('s1', (session) => ({ ...session, name: 'Edited' }));
    expect((await sessionRepo.get('s1'))?.updatedAt).toBe(saved?.updatedAt);
  });

  it('no sync, no alarm, no reaction to storage changes', async () => {
    signIn();
    const fetch = vi.fn<typeof globalThis.fetch>();
    expect(await syncNow({ fetch })).toEqual({ outcome: 'notReady', pulled: 0, pushed: 0 });
    expect(fetch).not.toHaveBeenCalled();
    await ensureSyncAlarm();
    await scheduleSoonSync();
    await handleCloudStorageChange({ [CLOUD_ACCOUNT_KEY]: { newValue: ACCOUNT } }, 'local');
    await handleCloudStorageChange({ sortBy: { newValue: 'title' } }, 'sync');
    expect(getChromeFake().state.alarms.size).toBe(0);
    expect(getChromeFake().state.local.has(CLOUD_SYNC_META_KEY)).toBe(false);
  });
});

describe('dirty tracking in sessionRepo', () => {
  beforeEach(() => {
    configure();
    signIn();
    startTracking();
  });

  it('records saved sessions put, renamed, edited and kept, with their updatedAt', async () => {
    await sessionRepo.put(makeSession('s1'));
    expect(storedMeta()?.dirtySessions).toEqual({ s1: 5_000 });

    vi.setSystemTime(6_000);
    await sessionRepo.rename('s1', 'Renamed');
    expect((await sessionRepo.get('s1'))?.updatedAt).toBe(6_000);
    expect(storedMeta()?.dirtySessions).toEqual({ s1: 6_000 });

    // An edit always moves updatedAt forward, even within the same millisecond.
    await sessionRepo.update('s1', (session) => ({ ...session, name: 'Edited' }));
    expect((await sessionRepo.get('s1'))?.updatedAt).toBe(6_001);
    expect(storedMeta()?.dirtySessions).toEqual({ s1: 6_001 });

    await sessionRepo.put(makeSession('h1', { kind: 'history', origin: 'alarm' }));
    const kept = await sessionRepo.duplicateAsSaved('h1');
    expect(storedMeta()?.dirtySessions).toEqual({ s1: 6_001, [kept.id]: 6_000 });
  });

  it('records deletions of saved sessions as tombstones newer than the session', async () => {
    await sessionRepo.put(makeSession('s1'));
    await sessionRepo.put(makeSession('s2'));
    await sessionRepo.put(makeSession('s3'));
    vi.setSystemTime(7_000);
    await sessionRepo.remove('s1');
    expect(storedMeta()?.deletedSessions).toEqual({ s1: 7_000 });
    expect(storedMeta()?.dirtySessions).toEqual({ s2: 5_000, s3: 5_000 });

    // Removing the last window deletes the session through update().
    await sessionRepo.update('s2', () => null);
    expect(storedMeta()?.deletedSessions).toEqual({ s1: 7_000, s2: 7_000 });

    // A session stamped by a device whose clock runs ahead: the tombstone is still newer.
    await sessionRepo.applyRemote({
      type: 'session',
      session: makeSession('ahead', { updatedAt: 90_000 }),
    });
    await sessionRepo.remove('ahead');
    expect(storedMeta()?.deletedSessions.ahead).toBe(90_001);
  });

  it('removeAll leaves a tombstone for every saved session, none for snapshots', async () => {
    await sessionRepo.put(makeSession('s1'));
    await sessionRepo.put(makeSession('h1', { kind: 'history', origin: 'alarm' }));
    vi.setSystemTime(8_000);
    await sessionRepo.removeAll();
    expect(storedMeta()?.deletedSessions).toEqual({ s1: 8_000 });
    expect(storedMeta()?.dirtySessions).toEqual({});
  });

  it('never tracks snapshots', async () => {
    await sessionRepo.put(makeSession('h1', { kind: 'history', origin: 'alarm' }));
    await sessionRepo.markRecovered('h1', 'Recovered');
    await sessionRepo.pruneHistory(0);
    await sessionRepo.put(makeSession('h2', { kind: 'history', origin: 'alarm' }));
    await sessionRepo.remove('h2');
    expect(storedMeta()?.dirtySessions).toEqual({});
    expect(storedMeta()?.deletedSessions).toEqual({});
  });

  it('tracks nothing before the first sync started', async () => {
    getChromeFake().state.local.delete(CLOUD_SYNC_META_KEY);
    await sessionRepo.put(makeSession('s1'));
    expect(getChromeFake().state.local.has(CLOUD_SYNC_META_KEY)).toBe(false);
  });

  it('keeps tracking while signed out or expired, for the next sign-in to send', async () => {
    getChromeFake().state.local.set(CLOUD_ACCOUNT_KEY, { ...ACCOUNT, expiresAt: 1 });
    await sessionRepo.put(makeSession('s1'));
    getChromeFake().state.local.delete(CLOUD_ACCOUNT_KEY);
    await sessionRepo.put(makeSession('s2'));
    vi.setSystemTime(6_000);
    await sessionRepo.remove('s1');
    expect(storedMeta()).toMatchObject({
      dirtySessions: { s2: 5_000 },
      deletedSessions: { s1: 6_000 },
    });
  });

  it('settings received but not fully written are not taken for an edit', async () => {
    startTracking({
      settingsHash: 'remote',
      settingsSyncedAt: 1_000,
      settingsUpdatedAt: 1_000,
      pendingSettings: { uiLanguage: 'ko' },
    });
    await chrome.storage.sync.set({ sortBy: 'title' });
    await handleCloudStorageChange({ sortBy: { newValue: 'title' } }, 'sync');
    expect(storedMeta()).toMatchObject({ settingsDirty: false, settingsUpdatedAt: 1_000 });
    // A sync soon finishes writing them.
    expect(getChromeFake().state.alarms.has(CLOUD_SYNC_SOON_ALARM)).toBe(true);
  });
});

describe('sessionRepo.applyRemote', () => {
  beforeEach(() => {
    configure();
    signIn();
    startTracking();
  });

  it('writes a newer remote session with its own updatedAt and does not mark it dirty', async () => {
    const remote = makeSession('s1', { name: 'From afar', updatedAt: 42_000 });
    expect(await sessionRepo.applyRemote({ type: 'session', session: remote })).toBe('applied');
    expect(await sessionRepo.get('s1')).toEqual(remote);
    expect((await sessionRepo.listSummaries())[0]).toMatchObject({ id: 's1', updatedAt: 42_000 });
    expect(storedMeta()?.dirtySessions).toEqual({});
  });

  it('drops a pending local change the remote one beats', async () => {
    await sessionRepo.put(makeSession('s1'));
    expect(storedMeta()?.dirtySessions).toEqual({ s1: 5_000 });
    const remote = makeSession('s1', { name: 'Newer', updatedAt: 6_000 });
    expect(await sessionRepo.applyRemote({ type: 'session', session: remote })).toBe('applied');
    expect(storedMeta()?.dirtySessions).toEqual({});
  });

  it('keeps a newer local copy and makes sure it is pending', async () => {
    await sessionRepo.applyRemote({
      type: 'session',
      session: makeSession('s1', { updatedAt: 9_000 }),
    });
    const older = makeSession('s1', { name: 'Older', updatedAt: 8_000 });
    expect(await sessionRepo.applyRemote({ type: 'session', session: older })).toBe('kept-local');
    expect((await sessionRepo.get('s1'))?.name).toBe('s1');
    expect(storedMeta()?.dirtySessions).toEqual({ s1: 9_000 });
  });

  it('ignores its own write coming back (same updatedAt), unless the server wins ties', async () => {
    await sessionRepo.applyRemote({
      type: 'session',
      session: makeSession('s1', { updatedAt: 9_000 }),
    });
    const same = makeSession('s1', { name: 'Same time', updatedAt: 9_000 });
    expect(await sessionRepo.applyRemote({ type: 'session', session: same })).toBe('unchanged');
    expect(
      await sessionRepo.applyRemote({ type: 'session', session: same }, { serverWinsTies: true }),
    ).toBe('applied');
    expect((await sessionRepo.get('s1'))?.name).toBe('Same time');
  });

  it('a newer tombstone deletes the local copy; an older one does not', async () => {
    await sessionRepo.applyRemote({
      type: 'session',
      session: makeSession('s1', { updatedAt: 9_000 }),
    });
    expect(await sessionRepo.applyRemote({ type: 'deleted', id: 's1', updatedAt: 8_000 })).toBe(
      'kept-local',
    );
    expect(await sessionRepo.get('s1')).toBeDefined();
    expect(await sessionRepo.applyRemote({ type: 'deleted', id: 's1', updatedAt: 10_000 })).toBe(
      'applied',
    );
    expect(await sessionRepo.get('s1')).toBeUndefined();
    expect(storedMeta()?.deletedSessions).toEqual({});
    expect(await sessionRepo.applyRemote({ type: 'deleted', id: 'never', updatedAt: 1 })).toBe(
      'unchanged',
    );
  });

  it('a pending local tombstone beats an older remote session', async () => {
    await sessionRepo.put(makeSession('s1'));
    vi.setSystemTime(7_000);
    await sessionRepo.remove('s1');
    const older = makeSession('s1', { updatedAt: 6_000 });
    expect(await sessionRepo.applyRemote({ type: 'session', session: older })).toBe('kept-local');
    expect(await sessionRepo.get('s1')).toBeUndefined();
    expect(storedMeta()?.deletedSessions).toEqual({ s1: 7_000 });
  });

  it('never overwrites or deletes a snapshot', async () => {
    await sessionRepo.put(makeSession('h1', { kind: 'history', origin: 'alarm' }));
    const remote = makeSession('h1', { updatedAt: 99_000 });
    expect(await sessionRepo.applyRemote({ type: 'session', session: remote })).toBe('unchanged');
    expect(await sessionRepo.applyRemote({ type: 'deleted', id: 'h1', updatedAt: 99_000 })).toBe(
      'unchanged',
    );
    expect((await sessionRepo.get('h1'))?.kind).toBe('history');
  });
});

describe('pure helpers', () => {
  it('parseSyncMeta refuses damaged bookkeeping', () => {
    const meta = freshSyncMeta(CONTEXT, { s1: 3 });
    expect(parseSyncMeta(meta)).toEqual(meta);
    expect(parseSyncMeta({ ...meta, cursor: -1 })).toBeUndefined();
    expect(parseSyncMeta({ ...meta, dirtySessions: { s1: 'x' } })).toBeUndefined();
    expect(parseSyncMeta(null)).toBeUndefined();
  });

  it('freshSyncMeta marks every saved session and the settings dirty', () => {
    expect(freshSyncMeta(CONTEXT, { s1: 3, s2: 4 })).toMatchObject({
      owner: 'a@b.c',
      cursor: 0,
      dirtySessions: { s1: 3, s2: 4 },
      settingsDirty: true,
      settingsUpdatedAt: 0,
    });
  });

  it('withSessionChanges: a change cancels a tombstone and the other way round', () => {
    const meta = freshSyncMeta(CONTEXT, { s1: 3 });
    const deleted = withSessionChanges(meta, { deleted: [['s1', 3]] }, 10);
    expect(deleted).toMatchObject({ dirtySessions: {}, deletedSessions: { s1: 10 } });
    const back = withSessionChanges(deleted, { changed: [['s1', 11]] }, 11);
    expect(back).toMatchObject({ dirtySessions: { s1: 11 }, deletedSessions: {} });
  });

  it('a deletion is remembered in knownVersions, which never goes down', () => {
    const meta = freshSyncMeta(CONTEXT, { s1: 3 });
    const deleted = withSessionChanges(meta, { deleted: [['s1', 3]] }, 10);
    expect(deleted.knownVersions).toEqual({ s1: 10 });
    expect(withKnownVersion(deleted, 's1', 5)).toBe(deleted);
    expect(withKnownVersion(deleted, 's1', 12).knownVersions).toEqual({ s1: 12 });
    // Accepted pushes are remembered too, also when the entry changed again since.
    expect(afterApplied(meta, { set: 'dirty', stamp: 3 }, 's1').knownVersions).toEqual({ s1: 3 });
    expect(afterApplied(meta, { set: 'dirty', stamp: 2 }, 's1').knownVersions).toEqual({ s1: 2 });
  });

  it('belongsTo follows the key alone, never the email the server reports', () => {
    const meta = freshSyncMeta(CONTEXT, {});
    const otherEmail = { ...CONTEXT, account: { ...CONTEXT.account, email: 'A@B.C' } };
    expect(belongsTo(meta, otherEmail)).toBe(true);
    expect(belongsTo(meta, { ...CONTEXT, keyId: 'another' })).toBe(false);
  });

  it('parseSyncMeta reads bookkeeping written before knownVersions existed', () => {
    const { knownVersions: _known, ...older } = freshSyncMeta(CONTEXT, { s1: 3 });
    expect(parseSyncMeta(older)?.knownVersions).toEqual({});
    expect(parseSyncMeta({ ...older, knownVersions: { s1: -1 } })).toBeUndefined();
  });

  it('syncWorkGrew: only new work counts', () => {
    const meta = freshSyncMeta(CONTEXT, {});
    const clean = { ...meta, settingsDirty: false };
    expect(syncWorkGrew(clean, { ...clean, dirtySessions: { s1: 1 } })).toBe(true);
    expect(syncWorkGrew(clean, { ...clean, deletedSessions: { s1: 1 } })).toBe(true);
    expect(syncWorkGrew(clean, { ...clean, settingsDirty: true })).toBe(true);
    expect(syncWorkGrew({ ...clean, dirtySessions: { s1: 1 } }, clean)).toBe(false);
    expect(syncWorkGrew(clean, { ...clean, cursor: 9, lastSyncAt: 4 })).toBe(false);
    expect(syncWorkGrew(undefined, undefined)).toBe(false);
  });

  it('settingsState: clean when back to what the server has, stamped when changed', () => {
    const synced: CloudSyncMeta = {
      ...freshSyncMeta(CONTEXT, {}),
      settingsDirty: false,
      settingsHash: 'h1',
      settingsSyncedAt: 100,
      settingsUpdatedAt: 100,
    };
    expect(settingsState(synced, 'h1', 'changed', 500)).toBe(synced);
    const changed = settingsState(synced, 'h2', 'changed', 500);
    expect(changed).toMatchObject({ settingsDirty: true, settingsUpdatedAt: 500 });
    expect(settingsState(changed, 'h1', 'changed', 600)).toMatchObject({
      settingsDirty: false,
      settingsUpdatedAt: 100,
    });
    // A check before a push leaves a pending stamp alone.
    expect(settingsState(changed, 'h3', 'check', 900)).toBe(changed);
  });

  it('afterApplied clears only an entry that did not change since it was sent', () => {
    const meta = freshSyncMeta(CONTEXT, { s1: 5, s2: 6 });
    expect(afterApplied(meta, { set: 'dirty', stamp: 5 }, 's1').dirtySessions).toEqual({ s2: 6 });
    expect(afterApplied(meta, { set: 'dirty', stamp: 4 }, 's1').dirtySessions).toEqual({
      s1: 5,
      s2: 6,
    });
    const settings = afterApplied(meta, { set: 'settings', stamp: 0, hash: 'h' }, 'settings');
    expect(settings).toMatchObject({
      settingsDirty: false,
      settingsHash: 'h',
      settingsSyncedAt: 0,
    });
    expect(afterApplied(meta, { set: 'settings', stamp: 7, hash: 'h' }, 'settings')).toBe(meta);
  });

  it('splitIntoBatches respects both the count and the byte limits, in order', () => {
    const record = (id: string, size: number): CloudRecord => ({
      kind: 'session',
      id,
      updatedAt: 1,
      deleted: false,
      iv: 'aXZpdml2aXZpdml2',
      ciphertext: 'x'.repeat(size),
    });
    const many = Array.from({ length: 205 }, (_, index) => record(`r${index}`, 10));
    expect(splitIntoBatches(many).map((batch) => batch.length)).toEqual([100, 100, 5]);

    const big = Array.from({ length: 5 }, (_, index) => record(`b${index}`, 1000));
    const limit = recordBytes(big[0]) * 2 + 20;
    const batches = splitIntoBatches(big, 100, limit);
    expect(batches.map((batch) => batch.length)).toEqual([2, 2, 1]);
    expect(batches.flat().map((entry) => entry.id)).toEqual(big.map((entry) => entry.id));
    expect(splitIntoBatches([])).toEqual([]);
  });

  it('received settings and sessions are validated', () => {
    expect(parseSyncedSettings(null)).toBeNull();
    expect(parseSyncedSettings({ sort: { sortBy: 'bogus' }, uiLanguage: 'xx' })).toEqual({
      sort: DEFAULT_SORT_SETTINGS,
      sessionSettings: DEFAULT_SESSION_SETTINGS,
      uiLanguage: 'auto',
    });
    const settings = {
      sort: DEFAULT_SORT_SETTINGS,
      sessionSettings: DEFAULT_SESSION_SETTINGS,
      uiLanguage: 'auto' as const,
    };
    expect(settingsFingerprint(settings)).toBe(settingsFingerprint(structuredClone(settings)));
    expect(settingsFingerprint({ ...settings, uiLanguage: 'ko' })).not.toBe(
      settingsFingerprint(settings),
    );

    expect(parseSyncedSession(makeSession('s1'), 's1')).not.toBeNull();
    expect(parseSyncedSession(makeSession('s1'), 'other')).toBeNull();
    expect(parseSyncedSession(makeSession('s1', { kind: 'history' }), 's1')).toBeNull();
    expect(parseSyncedSession({ id: 's1' }, 's1')).toBeNull();
  });
});

describe('settings tracking', () => {
  beforeEach(() => {
    configure();
    signIn();
    startTracking();
  });

  it('a changed setting marks the settings dirty; changing it back makes them clean', async () => {
    // Never exchanged yet: any change is one to send.
    await noteSettingsChange('changed');
    expect((await readSyncMeta())?.settingsDirty).toBe(true);

    // The defaults were exchanged with the server at 1000.
    const defaults = settingsFingerprint({
      sort: DEFAULT_SORT_SETTINGS,
      sessionSettings: DEFAULT_SESSION_SETTINGS,
      uiLanguage: 'auto',
    });
    startTracking({ settingsHash: defaults, settingsSyncedAt: 1_000, settingsUpdatedAt: 1_000 });

    vi.setSystemTime(8_000);
    await chrome.storage.sync.set({ sortBy: 'title' });
    await handleCloudStorageChange({ sortBy: { newValue: 'title' } }, 'sync');
    expect(storedMeta()).toMatchObject({ settingsDirty: true, settingsUpdatedAt: 8_000 });

    await chrome.storage.sync.set({ sortBy: 'url' });
    await handleCloudStorageChange({ sortBy: { newValue: 'url' } }, 'sync');
    expect(storedMeta()).toMatchObject({ settingsDirty: false, settingsUpdatedAt: 1_000 });
  });

  it('sessionSettings changes count too; unrelated keys do not', async () => {
    startTracking({ settingsHash: 'none', settingsSyncedAt: 1, settingsUpdatedAt: 1 });
    await handleCloudStorageChange({ somethingElse: { newValue: 1 } }, 'sync');
    expect(storedMeta()?.settingsDirty).toBe(false);
    await sessionRepo.setSettings({ historyMaxSnapshots: 3 });
    await handleCloudStorageChange({ sessionSettings: { newValue: {} } }, 'local');
    expect(storedMeta()?.settingsDirty).toBe(true);
  });
});

describe('alarms', () => {
  beforeEach(() => {
    configure();
  });

  it('the periodic alarm is armed while ready and cleared otherwise', async () => {
    const { state } = getChromeFake();
    await ensureSyncAlarm();
    expect(state.alarms.has(CLOUD_SYNC_ALARM)).toBe(false);
    signIn();
    await ensureSyncAlarm();
    expect(state.alarms.get(CLOUD_SYNC_ALARM)).toMatchObject({
      periodInMinutes: SYNC_PERIOD_MINUTES,
    });
    await scheduleSoonSync();
    expect(state.alarms.get(CLOUD_SYNC_SOON_ALARM)).toMatchObject({ delayInMinutes: 1 });

    state.local.delete(CLOUD_SYNC_KEY);
    await ensureSyncAlarm();
    expect(state.alarms.has(CLOUD_SYNC_ALARM)).toBe(false);
    expect(state.alarms.has(CLOUD_SYNC_SOON_ALARM)).toBe(false);
  });

  it('becoming ready arms both; signing out clears them and keeps the bookkeeping', async () => {
    const { state } = getChromeFake();
    signIn();
    await handleCloudStorageChange({ [CLOUD_SYNC_KEY]: { newValue: RAW_KEY } }, 'local');
    expect([...state.alarms.keys()].sort()).toEqual([CLOUD_SYNC_ALARM, CLOUD_SYNC_SOON_ALARM]);

    startTracking({ dirtySessions: { s1: 1 } });
    state.local.delete(CLOUD_ACCOUNT_KEY);
    await handleCloudStorageChange({ [CLOUD_ACCOUNT_KEY]: { oldValue: ACCOUNT } }, 'local');
    expect(state.alarms.size).toBe(0);
    expect(storedMeta()?.dirtySessions).toEqual({ s1: 1 });
  });

  it('a soon sync follows new work, once, and not a cleared entry', async () => {
    const { state } = getChromeFake();
    signIn();
    startTracking();
    await sessionRepo.put(makeSession('s1'));
    const [change] = [{ oldValue: undefined, newValue: state.local.get(CLOUD_SYNC_META_KEY) }];
    await handleCloudStorageChange({ [CLOUD_SYNC_META_KEY]: change }, 'local');
    const first = state.alarms.get(CLOUD_SYNC_SOON_ALARM);
    expect(first).toBeDefined();

    // Already waiting: left as it is.
    vi.setSystemTime(50_000);
    await scheduleSoonSync();
    expect(state.alarms.get(CLOUD_SYNC_SOON_ALARM)).toBe(first);

    await chrome.alarms.clear(CLOUD_SYNC_SOON_ALARM);
    const cleared = { ...storedMeta(), dirtySessions: {} };
    await handleCloudStorageChange(
      { [CLOUD_SYNC_META_KEY]: { oldValue: storedMeta(), newValue: cleared } },
      'local',
    );
    expect(state.alarms.has(CLOUD_SYNC_SOON_ALARM)).toBe(false);
  });

  it('a token that expires quietly stops the alarms at the next sync', async () => {
    const { state } = getChromeFake();
    signIn();
    await ensureSyncAlarm();
    await scheduleSoonSync();
    expect(state.alarms.size).toBe(2);
    vi.setSystemTime(ACCOUNT.expiresAt + 1);
    const fetch = vi.fn<typeof globalThis.fetch>();
    expect(await syncNow({ fetch })).toMatchObject({ outcome: 'notReady' });
    expect(fetch).not.toHaveBeenCalled();
    expect(state.alarms.size).toBe(0);
  });

  it('isSyncAlarm knows its two alarms only', () => {
    expect(isSyncAlarm(CLOUD_SYNC_ALARM)).toBe(true);
    expect(isSyncAlarm(CLOUD_SYNC_SOON_ALARM)).toBe(true);
    expect(isSyncAlarm('history-snapshot')).toBe(false);
  });
});
