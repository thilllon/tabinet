import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { POLICY } from '@/constants';
import { overrideCloudSyncConfig } from '@/lib/cloud-config';
import { CLOUD_ACCOUNT_KEY, CLOUD_KEY_KEY, cloudRawKey } from '@/lib/cloud-storage';
import {
  CLOUD_SYNC_META_KEY,
  contextFrom,
  ensureSyncMeta,
  freshSyncMeta,
  hasPendingWork,
  heldByReason,
  localChangeMade,
  markConflictsNoticed,
  markHeldNoticed,
  parseSyncMeta,
  readSyncNotices,
  stampOf,
  syncWorkGrew,
  type SyncContext,
  withSessionChanges,
} from '@/lib/cloud-sync-state';
import { sessionRepo } from '@/lib/session-repo';
import { SESSION_SCHEMA_VERSION, type CloudSyncMeta, type Session } from '@/types';

import { getChromeFake } from './chrome-fake';

const NOW = 1_800_000_000_000;
const context: SyncContext = {
  account: { accountId: 'a', token: 't', expiresAt: NOW * 2, email: 'e', uploadConfirmed: true },
  key: { accountId: 'a', keyId: 'K'.repeat(22), generation: 1, dek: 'd' },
};
const fresh = (): CloudSyncMeta => freshSyncMeta(context);
const local = () => getChromeFake().state.local;

function session(id: string, updatedAt = 5): Session {
  return {
    schemaVersion: SESSION_SCHEMA_VERSION,
    id,
    kind: 'saved',
    name: id,
    origin: 'manual',
    createdAt: 1,
    updatedAt,
    windows: [{ state: 'normal', focused: false, groups: [], tabs: [] }],
  };
}

beforeEach(() => {
  overrideCloudSyncConfig(() => ({ apiBase: 'https://sync.test', googleClientId: 'cid' }));
});

afterEach(() => {
  overrideCloudSyncConfig();
  vi.useRealTimers();
});

describe('parseSyncMeta', () => {
  it('reads back what it wrote, and a damaged value as absent', () => {
    const meta: CloudSyncMeta = {
      ...fresh(),
      docs: {
        'jot:j1': {
          recordId: 'r',
          seq: 3,
          known: { at: 4, deleted: false },
          pending: null,
          sent: [{ at: 4, hash: 'h' }],
          autoCopy: true,
        },
      },
      held: { 'session:s': { stamp: 1, reason: 'storage_limit', usage: 9 } },
      blocked: { 'x:y': { at: 2, reason: 'unknownType', raw: 'cloudRaw:doc:z' } },
      usage: { bytes: 1, screenshots: 0 },
      pullIncomplete: true,
    };
    expect(parseSyncMeta(JSON.parse(JSON.stringify(meta)))).toEqual(meta);
    expect(parseSyncMeta({ ...meta, schemaVersion: 1 })).toBeUndefined();
    expect(parseSyncMeta({ ...meta, cursor: -1 })).toBeUndefined();
    expect(
      parseSyncMeta({ ...meta, held: { x: { stamp: 1, reason: 'other', usage: 1 } } }),
    ).toBeUndefined();
    expect(
      parseSyncMeta({ ...meta, images: { dirty: {}, deleted: {}, known: {} } }),
    ).toBeUndefined();
    expect(parseSyncMeta(null)).toBeUndefined();
  });
});

describe('stampOf', () => {
  it('lets only a sane stamp into the bookkeeping', () => {
    expect(stampOf(5.7, NOW)).toBe(5);
    expect(stampOf(0, NOW)).toBe(1);
    expect(stampOf(-3, NOW)).toBe(1);
    expect(stampOf(Number.NaN, NOW)).toBe(1);
    expect(stampOf('x', NOW)).toBe(1);
    expect(stampOf(2 ** 60, NOW)).toBe(1);
    expect(stampOf(NOW + POLICY.record.maxClockAheadMs, NOW)).toBe(
      NOW + POLICY.record.maxClockAheadMs,
    );
    expect(stampOf(NOW + POLICY.record.maxClockAheadMs + 1, NOW)).toBe(NOW);
  });
});

describe('session changes', () => {
  it('a deletion replaces a change, is stamped past the session, and leaves known alone', () => {
    const meta = { ...fresh(), sessions: { dirty: { s: 5 }, deleted: {}, known: { s: 3 } } };
    const next = withSessionChanges(meta, { deleted: [['s', NOW + 10]] }, NOW);
    expect(next.sessions).toEqual({ dirty: {}, deleted: { s: NOW + 11 }, known: { s: 3 } });
    expect(withSessionChanges(next, { changed: [['s', 7]] }, NOW).sessions.deleted).toEqual({});
  });

  it('a saved-session write records itself in the same set, once tracking started', async () => {
    local().set(CLOUD_SYNC_META_KEY, { ...fresh(), started: ['session'] });
    const set = vi.spyOn(chrome.storage.local, 'set');
    await sessionRepo.put(session('s1'));
    expect(set).toHaveBeenCalledTimes(1);
    const written = set.mock.calls[0]![0] as Record<string, unknown>;
    expect(Object.keys(written).sort()).toEqual(
      [CLOUD_SYNC_META_KEY, 'session:s1', 'sessionIndex'].sort(),
    );
    const meta = written[CLOUD_SYNC_META_KEY] as CloudSyncMeta;
    expect(meta.sessions.dirty.s1).toBeGreaterThan(0);
    expect(meta.changedAt).toBeDefined();
  });

  it('records nothing before tracking started, or while unconfigured', async () => {
    local().set(CLOUD_SYNC_META_KEY, fresh());
    await sessionRepo.put(session('s1'));
    expect((local().get(CLOUD_SYNC_META_KEY) as CloudSyncMeta).sessions.dirty).toEqual({});
    overrideCloudSyncConfig(() => ({ apiBase: '', googleClientId: 'cid' }));
    const get = vi.spyOn(chrome.storage.local, 'get');
    await sessionRepo.put(session('s2'));
    expect(
      get.mock.calls.some(([keys]) => JSON.stringify(keys).includes(CLOUD_SYNC_META_KEY)),
    ).toBe(false);
  });
});

describe('what counts as work', () => {
  it('leaves held and blocked refs out', () => {
    const meta: CloudSyncMeta = {
      ...fresh(),
      settingsDirty: false,
      sessions: { dirty: { s: 5 }, deleted: {}, known: {} },
      held: { 'session:s': { stamp: 5, reason: 'storage_limit', usage: 1 } },
    };
    expect(hasPendingWork(meta)).toBe(false);
    expect(heldByReason(meta)).toEqual({ storage: 1, screenshots: 0 });
    // An edit (another stamp) releases it by itself.
    const edited = { ...meta, sessions: { ...meta.sessions, dirty: { s: 6 } } };
    expect(hasPendingWork(edited)).toBe(true);
    expect(heldByReason(edited)).toEqual({ storage: 0, screenshots: 0 });
    const blocked = {
      ...edited,
      blocked: { 'session:s': { at: 1, reason: 'newer' as const, raw: 'r' } },
    };
    expect(hasPendingWork(blocked)).toBe(false);
    expect(hasPendingWork({ ...blocked, pullIncomplete: true })).toBe(true);
  });

  it('grows only with a new pending entry or stamp', () => {
    const before = { ...fresh(), settingsDirty: false };
    expect(syncWorkGrew(before, { ...before, cursor: 9 })).toBe(false);
    expect(
      syncWorkGrew(before, { ...before, sessions: { dirty: { s: 1 }, deleted: {}, known: {} } }),
    ).toBe(true);
    const doc = {
      recordId: '',
      seq: null,
      known: null,
      pending: { at: 4, deleted: false },
      sent: [],
    };
    expect(syncWorkGrew(before, { ...before, docs: { 'jot:a': doc } })).toBe(true);
    expect(
      syncWorkGrew({ ...before, docs: { 'jot:a': doc } }, { ...before, docs: { 'jot:a': doc } }),
    ).toBe(false);
    expect(localChangeMade(before, { ...before, changedAt: 3 })).toBe(true);
    expect(
      localChangeMade({ ...before, changedAt: 3 }, { ...before, changedAt: 3, cursor: 4 }),
    ).toBe(false);
  });
});

describe('the context and the bookkeeping', () => {
  it('needs a live, confirmed account and the key of that account', () => {
    const stored = { [CLOUD_ACCOUNT_KEY]: context.account, [CLOUD_KEY_KEY]: context.key };
    expect(contextFrom(stored, NOW)).toEqual(context);
    expect(
      contextFrom(
        { ...stored, [CLOUD_ACCOUNT_KEY]: { ...context.account, uploadConfirmed: false } },
        NOW,
      ),
    ).toBeNull();
    expect(
      contextFrom({ ...stored, [CLOUD_KEY_KEY]: { ...context.key, accountId: 'b' } }, NOW),
    ).toBeNull();
    expect(contextFrom(stored, NOW * 3)).toBeNull();
  });

  it('starts afresh for another key and drops every raw copy then', async () => {
    local().set(CLOUD_SYNC_META_KEY, { ...fresh(), keyId: 'L'.repeat(22), cursor: 7 });
    local().set(cloudRawKey('doc', 'x'), { any: 1 });
    const meta = await ensureSyncMeta(context);
    expect(meta.cursor).toBe(0);
    expect(local().has(cloudRawKey('doc', 'x'))).toBe(false);
    local().set(cloudRawKey('doc', 'y'), { any: 1 });
    await ensureSyncMeta(context);
    expect(local().has(cloudRawKey('doc', 'y'))).toBe(true);
  });
});

describe('notices', () => {
  it('reads held refs and conflicts, and remembers what was noticed', async () => {
    local().set(CLOUD_SYNC_META_KEY, {
      ...fresh(),
      images: { dirty: { i: 2 }, deleted: {}, known: {}, owner: {} },
      held: { 'image:i': { stamp: 2, reason: 'image_limit', usage: 100 } },
      conflicts: 3,
    });
    expect(await readSyncNotices()).toEqual({
      heldByReason: { storage: 0, screenshots: 1 },
      heldNoticed: false,
      conflicts: 3,
      conflictsNoticed: 0,
    });
    await markHeldNoticed();
    await markConflictsNoticed(2);
    await markConflictsNoticed(1);
    expect(await readSyncNotices()).toMatchObject({ heldNoticed: true, conflictsNoticed: 2 });
  });
});
