import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { POLICY } from '@/constants';
import { overrideCloudSyncConfig } from '@/lib/cloud-config';
import { encryptRecord, keyIdOf, toBase64 } from '@/lib/cloud-crypto';
import { CLOUD_ACCOUNT_KEY, CLOUD_KEY_KEY } from '@/lib/cloud-storage';
import {
  handleCloudStorageChange,
  readLocalSettings,
  syncNow,
  type SyncResult,
} from '@/lib/cloud-sync';
import { CLOUD_SYNC_META_KEY, type CloudSyncMeta } from '@/lib/cloud-sync-state';
import { sessionRepo } from '@/lib/session-repo';
import {
  type CloudAccountV2,
  type CloudKeyV2,
  type RecordOut,
  SESSION_SCHEMA_VERSION,
  type Session,
  type WriteResult,
} from '@/types';

import { createChromeFake } from './chrome-fake';
import { fakeSyncServer, type FakeSyncServer } from './cloud-fetch';

type ChromeFake = ReturnType<typeof createChromeFake>;

interface Device {
  fake: ChromeFake;
  pending: Promise<unknown>[];
}

const NOW = 1_800_000_000_000;
let server: FakeSyncServer;
let account: CloudAccountV2;
let key: CloudKeyV2;

function device(): Device {
  const fake = createChromeFake();
  fake.state.local.set(CLOUD_ACCOUNT_KEY, account);
  fake.state.local.set(CLOUD_KEY_KEY, key);
  const made: Device = { fake, pending: [] };
  fake.chrome.storage.onChanged.addListener((changes, area) => {
    made.pending.push(handleCloudStorageChange(changes, area));
  });
  return made;
}

async function on<T>(target: Device, fn: () => Promise<T>): Promise<T> {
  const previous = globalThis.chrome;
  Object.assign(globalThis, { chrome: target.fake.chrome });
  try {
    const result = await fn();
    while (target.pending.length > 0) {
      await Promise.all(target.pending.splice(0));
    }
    return result;
  } finally {
    Object.assign(globalThis, { chrome: previous });
  }
}

const sync = (target: Device): Promise<SyncResult> =>
  on(target, () => syncNow({ fetch: server.fetch, apiBase: 'https://sync.test', inWorker: false }));
const metaOf = (target: Device) =>
  target.fake.state.local.get(CLOUD_SYNC_META_KEY) as CloudSyncMeta;
const posts = () => server.requests.filter((request) => request.method === 'POST');

function session(id: string, name = id): Session {
  return {
    schemaVersion: SESSION_SCHEMA_VERSION,
    id,
    kind: 'saved',
    name,
    origin: 'manual',
    createdAt: 1,
    updatedAt: 1,
    windows: [
      {
        state: 'normal',
        focused: false,
        groups: [],
        tabs: [{ url: `https://${id}.example/`, title: id, pinned: false, active: true }],
      },
    ],
  };
}

const put = (target: Device, value: Session) => on(target, () => sessionRepo.put(value));
const get = (target: Device, id: string) => on(target, () => sessionRepo.get(id));

async function injectSession(value: Session, stamp: number, deleted = false): Promise<RecordOut> {
  const meta = { kind: 'session', id: value.id, updatedAt: stamp, deleted } as const;
  const content = deleted ? { deleted: true } : { ...value, updatedAt: stamp };
  return server.inject({ ...meta, ...(await encryptRecord(key.dek, meta, content)) });
}

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ['Date'], now: NOW });
  overrideCloudSyncConfig(() => ({ apiBase: 'https://sync.test', googleClientId: 'cid' }));
  server = fakeSyncServer();
  const seeded = server.seedAccount({ token: 'tok' });
  const dek = toBase64(crypto.getRandomValues(new Uint8Array(32)));
  const keyId = await keyIdOf(dek);
  server.seedKey({
    keyId,
    generation: 1,
    envelope: {
      v: 2,
      generation: 1,
      keyId,
      salt: toBase64(new Uint8Array(16)),
      iv: toBase64(new Uint8Array(12)),
      wrapped: toBase64(new Uint8Array(48)),
    },
  });
  account = {
    accountId: seeded.accountId,
    token: 'tok',
    expiresAt: 4_000_000_000_000,
    email: 'person@example.com',
    uploadConfirmed: true,
  };
  key = { accountId: seeded.accountId, keyId, generation: 1, dek };
});

afterEach(() => {
  overrideCloudSyncConfig();
  vi.useRealTimers();
});

describe('two devices', () => {
  it('create, edit and delete sessions either way', async () => {
    const a = device();
    const b = device();
    await put(a, session('s1', 'first'));
    expect((await sync(a)).outcome).toBe('synced');
    await sync(b);
    expect((await get(b, 's1'))?.name).toBe('first');

    vi.setSystemTime(NOW + 1000);
    await on(b, () => sessionRepo.rename('s1', 'renamed'));
    await sync(b);
    await sync(a);
    expect((await get(a, 's1'))?.name).toBe('renamed');

    vi.setSystemTime(NOW + 2000);
    await on(a, () => sessionRepo.remove('s1'));
    await sync(a);
    expect(server.record('session', 's1')?.deleted).toBe(true);
    await sync(b);
    expect(await get(b, 's1')).toBeUndefined();
  });

  it('keeps the later of two concurrent edits on both', async () => {
    const a = device();
    const b = device();
    await put(a, session('s1', 'base'));
    await sync(a);
    await sync(b);
    vi.setSystemTime(NOW + 1000);
    await on(a, () => sessionRepo.rename('s1', 'from a'));
    vi.setSystemTime(NOW + 2000);
    await on(b, () => sessionRepo.rename('s1', 'from b'));
    await sync(a);
    await sync(b);
    await sync(a);
    expect((await get(a, 's1'))?.name).toBe('from b');
    expect((await get(b, 's1'))?.name).toBe('from b');
  });

  it('sends the settings, and the other device takes them without an echo', async () => {
    const a = device();
    const b = device();
    await on(a, () => chrome.storage.sync.set({ sortBy: 'title' }));
    await sync(a);
    await sync(b);
    expect((await on(b, () => readLocalSettings())).sort.sortBy).toBe('title');
    const before = posts().length;
    await sync(b);
    await sync(a);
    expect(posts().length).toBe(before);
  });

  it('never uploads a snapshot', async () => {
    const a = device();
    await put(a, { ...session('h1'), kind: 'history', origin: 'alarm' });
    await sync(a);
    expect(server.record('session', 'h1')).toBeUndefined();
  });
});

describe('the pull', () => {
  it('pushes nothing when the stream is cut, and keeps the cursor of the last batch', async () => {
    const a = device();
    await injectSession(session('r1'), NOW - 10);
    server.streamLines = (lines) => lines.slice(0, -1);
    await put(a, session('s1'));
    expect((await sync(a)).outcome).toBe('failed');
    expect(posts()).toEqual([]);
    expect(metaOf(a).cursor).toBe(server.record('session', 'r1')!.seq);
    expect(metaOf(a).lastError).toBeDefined();
    server.streamLines = undefined;
    expect((await sync(a)).outcome).toBe('synced');
    expect(server.record('session', 's1')).toBeDefined();
  });

  it('stops at maxRequestsPerRun with more to read, and sends nothing then', async () => {
    const a = device();
    for (let index = 0; index < POLICY.pull.maxRequestsPerRun + 2; index += 1) {
      await injectSession(session(`r${index}`), NOW - 100 + index);
    }
    // One record per answer, each ending incomplete at its checkpoint.
    server.streamLines = (lines) => {
      const record = lines.find((text) => text.includes('"type":"record"'));
      if (record === undefined) {
        return lines;
      }
      const seq = (JSON.parse(record) as { record: RecordOut }).record.seq;
      return [
        lines[0]!,
        record,
        JSON.stringify({ type: 'checkpoint', cursor: seq, count: 1 }),
        JSON.stringify({ type: 'end', cursor: seq, complete: false }),
      ];
    };
    await put(a, session('s1'));
    expect((await sync(a)).outcome).toBe('synced');
    expect(metaOf(a).pullIncomplete).toBe(true);
    expect(posts()).toEqual([]);
    server.streamLines = undefined;
    await sync(a);
    expect(metaOf(a).pullIncomplete).toBeUndefined();
    expect(server.record('session', 's1')).toBeDefined();
  });

  it('reads again from 0, once, when the server was rewound', async () => {
    const a = device();
    for (const id of ['r1', 'r1b', 'r1c']) {
      await injectSession(session(id), NOW - 10);
    }
    await sync(a);
    const cursor = metaOf(a).cursor;
    // Restored from a backup: fewer rows, and lower seqs than this device has read.
    server.account().records.clear();
    await injectSession(session('r2'), NOW - 5);
    server.account().records.get('session:r2')!.seq = 1;
    server.account().lastSeq = 1;
    expect(server.account().lastSeq).toBeLessThan(cursor);
    await sync(a);
    expect(await get(a, 'r2')).toBeDefined();
    expect(await get(a, 'r1')).toBeDefined();
  });
});

describe('a hostile server', () => {
  it('cannot forge, move, replay or empty a record', async () => {
    const a = device();
    await put(a, session('s1', 'mine'));
    await sync(a);
    const real = server.record('session', 's1')!;
    // Moved to another id, replayed under a newer stamp, flipped to a tombstone.
    server.inject({ ...real, id: 's2' });
    server.inject({ ...real, updatedAt: real.updatedAt + 5 });
    server.inject({
      kind: 'session',
      id: 's1',
      updatedAt: real.updatedAt + 9,
      deleted: true,
      iv: real.iv,
      ciphertext: real.ciphertext,
    });
    expect((await sync(a)).outcome).toBe('synced');
    expect((await get(a, 's1'))?.name).toBe('mine');
    expect(await get(a, 's2')).toBeUndefined();
    expect(Object.keys(metaOf(a).unreadable).length).toBeGreaterThan(0);
    expect(metaOf(a).lastError).toBeDefined();
  });

  it('a junk row is replaced through the stale answer by the pending version', async () => {
    const a = device();
    await put(a, session('s1', 'mine'));
    const stamp = (await get(a, 's1'))!.updatedAt;
    // A bearer thief wrote junk above it before this device could send.
    server.inject({
      kind: 'session',
      id: 's1',
      updatedAt: stamp + 50,
      deleted: false,
      iv: toBase64(new Uint8Array(12)),
      ciphertext: btoa('junk that is not a ciphertext'),
    });
    expect((await sync(a)).outcome).toBe('synced');
    const row = server.record('session', 's1')!;
    expect(row.updatedAt).toBeGreaterThan(stamp + 50);
    expect((await get(a, 's1'))?.updatedAt).toBe(row.updatedAt);
    const b = device();
    await sync(b);
    expect((await get(b, 's1'))?.name).toBe('mine');
  });

  it('reorders results: nothing in that answer is believed', async () => {
    const a = device();
    await put(a, session('s1'));
    await put(a, session('s2'));
    server.pushResults = (results) => [...results].reverse();
    expect((await sync(a)).outcome).toBe('failed');
    expect(Object.keys(metaOf(a).sessions.dirty).sort()).toEqual(['s1', 's2']);
  });

  it('answers stale forever without a loop', async () => {
    const a = device();
    await put(a, session('s1'));
    server.pushResults = (results) =>
      results.map((result): WriteResult => ({
        kind: result.kind,
        id: result.id,
        status: 'stale',
        withheld: true,
      }));
    expect((await sync(a)).outcome).toBe('synced');
    expect(posts().length).toBeLessThanOrEqual(12);
    expect(metaOf(a).sessions.dirty.s1).toBeDefined();
  });
});

describe('the caps', () => {
  it('holds what does not fit, and sends it in the same run once a deletion made room', async () => {
    const a = device();
    await put(a, session('big', 'x'.repeat(4000)));
    await sync(a);
    server.storageLimit = server.usage().bytes + 700;
    await put(a, session('next', 'y'.repeat(4000)));
    await sync(a);
    expect(Object.keys(metaOf(a).held)).toEqual(['session:next']);
    expect(server.record('session', 'next')).toBeUndefined();

    await on(a, () => sessionRepo.remove('big'));
    expect((await sync(a)).outcome).toBe('synced');
    expect(server.record('session', 'big')?.deleted).toBe(true);
    expect(server.record('session', 'next')).toBeDefined();
    expect(metaOf(a).held).toEqual({});
  });

  it('settles a deletion the server answers absent', async () => {
    const a = device();
    await put(a, session('s1'));
    await on(a, () => sessionRepo.remove('s1'));
    server.storageLimit = 0;
    await sync(a);
    expect(metaOf(a).sessions.deleted).toEqual({});
    expect(server.record('session', 's1')).toBeUndefined();
  });
});

describe('clocks', () => {
  it('keeps a version the server finds ahead pending, and says why', async () => {
    const a = device();
    server.now = () => Date.now() - 3 * 86_400_000;
    await put(a, session('s1'));
    await sync(a);
    expect(metaOf(a).sessions.dirty.s1).toBeDefined();
    expect(metaOf(a).lastError).toBeDefined();
  });

  it('restamps a stamp a month ahead once the clock is right again, so it syncs', async () => {
    const a = device();
    vi.setSystemTime(NOW + 30 * 86_400_000);
    await put(a, session('s1', 'from the future'));
    vi.setSystemTime(NOW);
    expect((await sync(a)).outcome).toBe('synced');
    const row = server.record('session', 's1')!;
    expect(row.updatedAt).toBeLessThanOrEqual(NOW + POLICY.record.maxClockAheadMs);
    expect((await get(a, 's1'))?.updatedAt).toBe(row.updatedAt);
  });
});

describe('the account and the key', () => {
  it('a 401 removes the account and keeps the key; a key change keeps both', async () => {
    const a = device();
    server.tokens.clear();
    expect((await sync(a)).outcome).toBe('failed');
    expect(a.fake.state.local.has(CLOUD_ACCOUNT_KEY)).toBe(false);
    expect(a.fake.state.local.get(CLOUD_KEY_KEY)).toEqual(key);

    const b = device();
    server.seedAccount({ token: 'tok' });
    server.account().key = { ...server.account().key!, keyId: 'Z'.repeat(22) };
    expect((await sync(b)).outcome).toBe('failed');
    expect(b.fake.state.local.get(CLOUD_KEY_KEY)).toEqual(key);
    expect(b.fake.state.local.get(CLOUD_ACCOUNT_KEY)).toEqual(account);
  });

  it('nothing is read, armed or fetched while unconfigured', async () => {
    const a = device();
    overrideCloudSyncConfig(() => ({ apiBase: '', googleClientId: 'cid' }));
    const get = vi.spyOn(a.fake.chrome.storage.local, 'get');
    expect((await sync(a)).outcome).toBe('notReady');
    expect(get).not.toHaveBeenCalled();
    expect(server.requests).toEqual([]);
    expect(a.fake.state.alarms.size).toBe(0);
  });

  it('a device whose upload was not confirmed sends nothing', async () => {
    const a = device();
    a.fake.state.local.set(CLOUD_ACCOUNT_KEY, { ...account, uploadConfirmed: false });
    await put(a, session('s1'));
    expect((await sync(a)).outcome).toBe('notReady');
    expect(server.requests).toEqual([]);
  });
});
