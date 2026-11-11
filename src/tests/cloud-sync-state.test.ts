import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { CLOUD_ACCOUNT_KEY, CLOUD_SYNC_KEY } from '@/lib/cloud-auth';
import { overrideCloudSyncConfig } from '@/lib/cloud-config';
import {
  afterApplied,
  afterImageRefused,
  CLOUD_SYNC_ALARM,
  CLOUD_SYNC_SOON_ALARM,
  ensureSyncAlarm,
  handleCloudStorageChange,
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
  withHeldImagesReleased,
} from '@/lib/cloud-sync';
import {
  belongsTo,
  CLOUD_SYNC_META_KEY,
  type CloudSyncMeta,
  emptyTrack,
  freshSyncMeta,
  keyFingerprint,
  parseSyncMeta,
  readSyncMeta,
  type SyncContext,
  syncWorkGrew,
  withKnownVersion,
  withNoteChanges,
  withSessionChanges,
} from '@/lib/cloud-sync-state';
import { notesRepo } from '@/lib/notes-repo';
import { sessionRepo } from '@/lib/session-repo';
import { DEFAULT_SORT_SETTINGS } from '@/lib/sort-settings';
import {
  type CloudRecord,
  DEFAULT_SESSION_SETTINGS,
  NOTES_SCHEMA_VERSION,
  SESSION_SCHEMA_VERSION,
  type Session,
  type VideoNotes,
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
    expect(afterApplied(meta, { set: 'dirty', stamp: 3 }, 'session', 's1').knownVersions).toEqual({
      s1: 3,
    });
    expect(afterApplied(meta, { set: 'dirty', stamp: 2 }, 'session', 's1').knownVersions).toEqual({
      s1: 2,
    });
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
    expect(afterApplied(meta, { set: 'dirty', stamp: 5 }, 'session', 's1').dirtySessions).toEqual({
      s2: 6,
    });
    expect(afterApplied(meta, { set: 'dirty', stamp: 4 }, 'session', 's1').dirtySessions).toEqual({
      s1: 5,
      s2: 6,
    });
    const settings = afterApplied(
      meta,
      { set: 'settings', stamp: 0, hash: 'h' },
      'settings',
      'settings',
    );
    expect(settings).toMatchObject({
      settingsDirty: false,
      settingsHash: 'h',
      settingsSyncedAt: 0,
    });
    expect(
      afterApplied(meta, { set: 'settings', stamp: 7, hash: 'h' }, 'settings', 'settings'),
    ).toBe(meta);
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
});

describe('note tracking in notesRepo', () => {
  const VIDEO = { videoId: 'dQw4w9WgXcQ', title: 'Video' };
  const PICTURE = 'data:image/webp;base64,AAAA';

  function startNotesTracking(): void {
    startTracking({ notes: emptyTrack(), images: emptyTrack() });
  }

  beforeEach(() => {
    configure();
    signIn();
  });

  it('records notes written and deleted, and screenshots stored and deleted', async () => {
    startNotesTracking();
    vi.setSystemTime(10_000);
    const entry = await notesRepo.addEntry(VIDEO, { at: 1, text: 'One', image: PICTURE });
    const imageId = entry.imageId ?? '';
    expect(storedMeta()?.notes?.dirty).toEqual({ [VIDEO.videoId]: 10_000 });
    expect(storedMeta()?.images?.dirty).toEqual({ [imageId]: 10_000 });

    vi.setSystemTime(11_000);
    await notesRepo.updateEntry(VIDEO.videoId, entry.id, { text: 'One, edited' });
    expect(storedMeta()?.notes?.dirty).toEqual({ [VIDEO.videoId]: 11_000 });

    vi.setSystemTime(12_000);
    const removed = await notesRepo.removeEntry(VIDEO.videoId, entry.id);
    expect(storedMeta()?.notes).toEqual({
      dirty: {},
      deleted: { [VIDEO.videoId]: 12_000 },
      known: { [VIDEO.videoId]: 12_000 },
    });
    expect(storedMeta()?.images?.deleted).toEqual({ [imageId]: 12_000 });
    expect(storedMeta()?.images?.dirty).toEqual({});

    // Undo in the same millisecond: still newer than the tombstone it answers.
    await notesRepo.restoreEntry(VIDEO, removed ?? { entry });
    expect(storedMeta()?.images?.dirty).toEqual({ [imageId]: 12_001 });
    expect(storedMeta()?.images?.deleted).toEqual({});
    expect(storedMeta()?.notes?.deleted).toEqual({});
  });

  it('tracks nothing before a sync of this version started tracking notes', async () => {
    startTracking();
    await notesRepo.addEntry(VIDEO, { at: 1, text: 'One', image: PICTURE });
    expect(storedMeta()?.notes).toBeUndefined();
  });

  it('startSyncTracking marks every note and stored screenshot dirty and reads the feed again', async () => {
    startTracking({ cursor: 42 });
    vi.setSystemTime(10_000);
    const withPicture = await notesRepo.addEntry(VIDEO, { at: 1, text: 'One', image: PICTURE });
    expect(await notesRepo.startSyncTracking()).toBe(true);
    const meta = storedMeta();
    expect(meta?.cursor).toBe(0);
    expect(meta?.notes?.dirty).toEqual({ [VIDEO.videoId]: 10_000 });
    expect(meta?.images?.dirty).toEqual({ [withPicture.imageId ?? '']: 10_000 });
    // Once.
    expect(await notesRepo.startSyncTracking()).toBe(false);
  });

  it('notes are dormant while cloud sync is unconfigured', async () => {
    overrideCloudSyncConfig(() => ({ apiBase: '', googleClientId: 'cid' }));
    startNotesTracking();
    await notesRepo.addEntry(VIDEO, { at: 1, text: 'One' });
    expect(storedMeta()?.notes?.dirty).toEqual({});
  });
});

describe('notesRepo.applyRemote', () => {
  const VIDEO_ID = 'dQw4w9WgXcQ';
  const PICTURE = 'data:image/webp;base64,AAAA';

  function remoteNotes(updatedAt: number, text: string, imageId?: string): VideoNotes {
    return {
      schemaVersion: NOTES_SCHEMA_VERSION,
      videoId: VIDEO_ID,
      url: `https://www.youtube.com/watch?v=${VIDEO_ID}`,
      title: 'Video',
      createdAt: 1_000,
      updatedAt,
      entries: [{ id: 'e1', at: 3, text, imageId, createdAt: 1_000, updatedAt }],
    };
  }

  beforeEach(() => {
    configure();
    signIn();
    startTracking({ notes: emptyTrack(), images: emptyTrack() });
  });

  it('writes newer notes, ignores older ones and keeps a newer local copy pending', async () => {
    expect(await notesRepo.applyRemote({ type: 'notes', notes: remoteNotes(2_000, 'v2') })).toBe(
      'applied',
    );
    expect((await notesRepo.get(VIDEO_ID))?.entries[0].text).toBe('v2');
    expect(storedMeta()?.notes?.known).toEqual({ [VIDEO_ID]: 2_000 });
    expect(storedMeta()?.notes?.dirty).toEqual({});
    expect(await notesRepo.applyRemote({ type: 'notes', notes: remoteNotes(1_500, 'v1') })).toBe(
      'kept-local',
    );
    expect(storedMeta()?.notes?.dirty).toEqual({ [VIDEO_ID]: 2_000 });
    expect(await notesRepo.applyRemote({ type: 'notes', notes: remoteNotes(2_000, 'tie') })).toBe(
      'unchanged',
    );
  });

  it('a newer tombstone deletes the notes and their screenshots, and a replay cannot bring them back', async () => {
    await notesRepo.applyRemote({
      type: 'image',
      imageId: 'img1',
      image: PICTURE,
      updatedAt: 1_000,
    });
    await notesRepo.applyRemote({ type: 'notes', notes: remoteNotes(2_000, 'v2', 'img1') });
    expect(await notesRepo.getImage('img1')).toBe(PICTURE);
    expect(
      await notesRepo.applyRemote({ type: 'notesDeleted', videoId: VIDEO_ID, updatedAt: 3_000 }),
    ).toBe('applied');
    expect(await notesRepo.get(VIDEO_ID)).toBeUndefined();
    expect(await notesRepo.getImage('img1')).toBeUndefined();
    expect(await notesRepo.listSummaries()).toEqual([]);
    // The picture's own tombstone goes to the server too.
    expect(Object.keys(storedMeta()?.images?.deleted ?? {})).toEqual(['img1']);
    expect(await notesRepo.applyRemote({ type: 'notes', notes: remoteNotes(2_000, 'v2') })).toBe(
      'unchanged',
    );
    expect(await notesRepo.get(VIDEO_ID)).toBeUndefined();
  });

  it('stores a screenshot before its note arrives, and refuses one that is not an image', async () => {
    expect(
      await notesRepo.applyRemote({ type: 'image', imageId: 'img1', image: PICTURE, updatedAt: 5 }),
    ).toBe('applied');
    expect(await notesRepo.getImage('img1')).toBe(PICTURE);
    await expect(
      notesRepo.applyRemote({
        type: 'image',
        imageId: 'img2',
        image: 'javascript:1',
        updatedAt: 5,
      }),
    ).rejects.toThrow();
    expect(await notesRepo.getImage('img2')).toBeUndefined();
  });

  it('a screenshot tombstone older than the local picture deletes nothing', async () => {
    await notesRepo.applyRemote({ type: 'image', imageId: 'img1', image: PICTURE, updatedAt: 5 });
    expect(
      await notesRepo.applyRemote({ type: 'imageDeleted', imageId: 'img1', updatedAt: 4 }),
    ).toBe('kept-local');
    expect(await notesRepo.getImage('img1')).toBe(PICTURE);
    expect(
      await notesRepo.applyRemote({ type: 'imageDeleted', imageId: 'img1', updatedAt: 6 }),
    ).toBe('applied');
    expect(await notesRepo.getImage('img1')).toBeUndefined();
  });

  it('does nothing before notes tracking started', async () => {
    startTracking();
    expect(await notesRepo.applyRemote({ type: 'notes', notes: remoteNotes(2_000, 'v2') })).toBe(
      'unchanged',
    );
    expect(await notesRepo.get(VIDEO_ID)).toBeUndefined();
  });
});

describe('note bookkeeping helpers', () => {
  function tracked(overrides: Partial<CloudSyncMeta> = {}): CloudSyncMeta {
    return {
      ...freshSyncMeta(CONTEXT, {}),
      notes: emptyTrack(),
      images: emptyTrack(),
      ...overrides,
    };
  }

  it('parseSyncMeta reads bookkeeping from before notes, and refuses damaged note tracks', () => {
    const meta = parseSyncMeta(freshSyncMeta(CONTEXT, {}));
    expect(meta?.notes).toBeUndefined();
    expect(parseSyncMeta(tracked())?.images).toEqual(emptyTrack());
    expect(
      parseSyncMeta({ ...tracked(), notes: { dirty: { a: -1 }, deleted: {}, known: {} } }),
    ).toBe(undefined);
    expect(parseSyncMeta({ ...tracked(), heldImages: { a: 'x' } })).toBeUndefined();
  });

  it('withNoteChanges leaves bookkeeping alone while notes are not tracked', () => {
    const meta = freshSyncMeta(CONTEXT, {});
    expect(withNoteChanges(meta, { notesChanged: [['v', 1]] }, 5)).toBe(meta);
  });

  it('a stored or deleted screenshot leaves the held-back set', () => {
    const meta = tracked({ heldImages: { a: 1, b: 2 }, heldImagesNoticed: true });
    const next = withNoteChanges(meta, { imagesDeleted: ['a'], imagesStored: ['b'] }, 10);
    expect(next.heldImages).toBeUndefined();
    expect(next.heldImagesNoticed).toBeUndefined();
    expect(next.images?.dirty).toEqual({ b: 10 });
    expect(next.images?.deleted).toEqual({ a: 10 });
  });

  it('a refused screenshot is held back, and offered again once room is made', () => {
    const meta = tracked({ images: { dirty: { a: 5, b: 6 }, deleted: {}, known: {} } });
    const held = afterImageRefused(meta, 'a', 5);
    expect(held.images?.dirty).toEqual({ b: 6 });
    expect(held.heldImages).toEqual({ a: 5 });
    // Changed since it was sent: still pending, not held.
    expect(afterImageRefused(meta, 'b', 1)).toBe(meta);
    const released = withHeldImagesReleased({ ...held, heldImagesNoticed: true });
    expect(released.images?.dirty).toEqual({ a: 5, b: 6 });
    expect(released.heldImages).toBeUndefined();
    expect(released.heldImagesNoticed).toBeUndefined();
  });

  it('syncWorkGrew counts new note and screenshot work', () => {
    const before = tracked();
    const after = withNoteChanges(before, { notesChanged: [['v', 1]] }, 5);
    expect(syncWorkGrew(before, after)).toBe(true);
    const image = withNoteChanges(before, { imagesDeleted: ['i'] }, 5);
    expect(syncWorkGrew(before, image)).toBe(true);
    expect(syncWorkGrew(after, before)).toBe(false);
  });

  it('afterApplied settles a note or screenshot entry and remembers its version', () => {
    const meta = tracked({ notes: { dirty: { v: 5 }, deleted: {}, known: {} } });
    const next = afterApplied(meta, { set: 'dirty', stamp: 5 }, 'notes', 'v');
    expect(next.notes).toEqual({ dirty: {}, deleted: {}, known: { v: 5 } });
    expect(afterApplied(meta, { set: 'dirty', stamp: 4 }, 'notes', 'v').notes?.dirty).toEqual({
      v: 5,
    });
  });
});
