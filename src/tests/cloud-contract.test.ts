/**
 * The contract suite (spec 13.7): the real client (`cloud-api.ts`, `cloud-auth.ts` and
 * `syncNow()` with the test doc collections) against the real server app (`createApp()` over
 * PGlite with the real migrations), in process. Only Google is injected (a verifier that reads
 * `google:<sub>` tokens, which the chrome fake's `getAuthToken` hands out) and the key encryption key is a test
 * one. Each simulated device is its own chrome fake.
 */
import { PGlite } from '@electric-sql/pglite';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { POLICY } from '@/constants';
import { CloudHttpError, me } from '@/lib/cloud-api';
import {
  cancelAccountSwitch,
  changePassphrase,
  confirmAccount,
  createPassphrase,
  deleteCloudData,
  refreshMe,
  signIn,
  unlockWithPassphrase,
} from '@/lib/cloud-auth';
import { overrideCloudSyncConfig } from '@/lib/cloud-config';
import { overrideKdfIterations } from '@/lib/cloud-crypto';
import { CLOUD_ACCOUNT_KEY, CLOUD_KEY_KEY } from '@/lib/cloud-storage';
import { readLocalSettings, syncNow, type SyncResult } from '@/lib/cloud-sync';
import { CLOUD_SYNC_META_KEY, readSyncNotices } from '@/lib/cloud-sync-state';
import { sessionRepo } from '@/lib/session-repo';
import {
  type CloudAccountV2,
  type CloudKeyV2,
  type CloudSyncMeta,
  SESSION_SCHEMA_VERSION,
  type Session,
} from '@/types';

import { createApp } from '../../server/src/app';
import { runMigrations } from '../../server/src/db/migrations';
import { createSqlStore, type Query } from '../../server/src/db/store';
import { importKeyEncryptionKey } from '../../server/src/envelope';
import { createChromeFake } from './chrome-fake';
import {
  clipCollection,
  type Jot,
  jotCollection,
  localBody,
  localImage,
  putLocal,
  removeLocal,
  testStore,
} from './doc-test-stores';

type ChromeFake = ReturnType<typeof createChromeFake>;

const API_BASE = 'https://sync.contract.test';
const NOW = 1_800_000_000_000;
const DAY_MS = 24 * 60 * 60 * 1000;
const IMAGE = 'data:image/webp;base64,UklGRhoAAABXRUJQVlA4TA0AAAAvAAAAEAcQERGIiP4HAA==';
const clips = testStore(clipCollection, true);
const jots = testStore(jotCollection);

let db: PGlite;
let query: Query;
let app: { fetch: (request: Request) => Promise<Response> };
/** How far the server's clock is behind the devices'. */
let serverBehindMs = 0;
/** Every request the client made, with the bytes of each answer body it read. */
let requests: { device: ChromeFake | null; method: string; path: string; bytes: number }[];
let current: ChromeFake | null = null;

/** The client's `fetch`: a real `Request` into the real app, the answer body counted as read. */
const fetchApp: typeof fetch = async (input, init) => {
  const request = new Request(input, init);
  const url = new URL(request.url);
  const entry = { device: current, method: request.method, path: url.pathname, bytes: 0 };
  requests.push(entry);
  const response = await app.fetch(request);
  if (response.body === null) {
    return response;
  }
  const counted = response.body.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        entry.bytes += chunk.byteLength;
        controller.enqueue(chunk);
      },
    }),
  );
  return new Response(counted, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
};

const API = { fetch: fetchApp, apiBase: API_BASE, inWorker: false } as const;

beforeAll(async () => {
  db = new PGlite();
  query = async (text, params) => (await db.query<Record<string, unknown>>(text, params)).rows;
  await runMigrations({
    exec: async (sql) => {
      await db.exec(sql);
    },
    query,
  });
  const keyEncryptionKey = await importKeyEncryptionKey(new Uint8Array(32).fill(9));
  app = createApp({
    store: createSqlStore(query),
    // The injected Google: `google:<sub>` is that account, anything else is refused.
    verifyGoogleToken: async (accessToken) => {
      const match = /^google:([a-z0-9-]+)$/.exec(accessToken);
      return match === null ? null : { sub: match[1]!, email: `${match[1]}@example.com` };
    },
    keyEncryptionKey,
    now: () => Date.now() - serverBehindMs,
    randomBytes: (n) => crypto.getRandomValues(new Uint8Array(n)),
    allowedOrigins: ['chrome-extension://bmbpmnfhfbdjdjpblimidmbohgccmjdg'],
  });
}, 60_000);

afterAll(async () => {
  await db.close();
});

beforeEach(async () => {
  await db.exec('TRUNCATE accounts CASCADE');
  vi.useFakeTimers({ toFake: ['Date'], now: NOW });
  overrideCloudSyncConfig(() => ({ apiBase: API_BASE, googleClientId: 'cid' }));
  overrideKdfIterations(1000);
  serverBehindMs = 0;
  requests = [];
});

afterEach(() => {
  overrideKdfIterations();
  overrideCloudSyncConfig();
  vi.useRealTimers();
});

/** A device of its own: an empty profile whose Google account is `sub`. */
function device(sub = 'person'): ChromeFake {
  const fake = createChromeFake();
  fake.state.authTokenAnswer = `google:${sub}`;
  return fake;
}

async function on<T>(target: ChromeFake, fn: () => Promise<T>): Promise<T> {
  const previous = globalThis.chrome;
  Object.assign(globalThis, { chrome: target.chrome });
  current = target;
  try {
    return await fn();
  } finally {
    Object.assign(globalThis, { chrome: previous });
    current = null;
  }
}

const sync = (target: ChromeFake): Promise<SyncResult> =>
  on(target, () => syncNow({ ...API, stores: [clips, jots] }));
const stored = <T>(target: ChromeFake, key: string) => target.state.local.get(key) as T | undefined;
const accountOf = (target: ChromeFake) => stored<CloudAccountV2>(target, CLOUD_ACCOUNT_KEY);
const keyOf = (target: ChromeFake) => stored<CloudKeyV2>(target, CLOUD_KEY_KEY);
const metaOf = (target: ChromeFake) => stored<CloudSyncMeta>(target, CLOUD_SYNC_META_KEY)!;
const recordCalls = (target: ChromeFake) =>
  requests.filter((entry) => entry.device === target && entry.path === '/v2/records');

/** Signs in and creates the passphrase: the first device of an account. */
async function firstDevice(passphrase = 'first passphrase', sub = 'person'): Promise<ChromeFake> {
  const made = device(sub);
  await on(made, async () => {
    expect(await signIn(API)).toMatchObject({ outcome: 'signedIn', server: null });
    expect(await createPassphrase(passphrase, API)).toEqual({ outcome: 'created' });
  });
  return made;
}

/** Signs in on an empty profile and unlocks with the passphrase. */
async function nextDevice(passphrase = 'first passphrase', sub = 'person'): Promise<ChromeFake> {
  const made = device(sub);
  await on(made, async () => {
    expect((await signIn(API)).outcome).toBe('signedIn');
    expect(await unlockWithPassphrase(passphrase, API)).toEqual({ outcome: 'unlocked' });
  });
  return made;
}

function session(id: string, name = id, title = id): Session {
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
        tabs: [{ url: `https://${id}.example/`, title, pinned: false, active: true }],
      },
    ],
  };
}

const put = (target: ChromeFake, value: Session) => on(target, () => sessionRepo.put(value));
const get = (target: ChromeFake, id: string) => on(target, () => sessionRepo.get(id));

/** The server's row of a record, read straight from the database. */
async function serverRow(
  kind: string,
  id: string,
): Promise<{ deleted: boolean; updated_at: string } | undefined> {
  const rows = await query(
    'SELECT deleted, updated_at FROM account_records WHERE kind = $1 AND id = $2',
    [kind, id],
  );
  return rows[0] as { deleted: boolean; updated_at: string } | undefined;
}

describe('the account and its key', () => {
  it('creates, unlocks elsewhere, changes and resets the passphrase over the real server', async () => {
    const a = await firstDevice();
    const key = keyOf(a)!;
    expect(key.generation).toBe(1);
    expect(stored(a, CLOUD_KEY_KEY)).toBeDefined();

    // A second profile: the wrong passphrase writes nothing, the right one gives the same key.
    const b = device();
    await on(b, async () => {
      await signIn(API);
      expect(await unlockWithPassphrase('not the passphrase', API)).toEqual({
        outcome: 'wrongPassphrase',
      });
      expect(keyOf(b)).toBeUndefined();
      // The NFD spelling of a passphrase opens what its NFC spelling made.
      expect(await unlockWithPassphrase('first passphrase'.normalize('NFD'), API)).toEqual({
        outcome: 'unlocked',
      });
    });
    expect(keyOf(b)).toEqual(key);

    // A changes it: the same data key under generation 2; the old passphrase no longer opens it.
    expect(await on(a, () => changePassphrase('second passphrase', API))).toEqual({
      outcome: 'changed',
      generation: 2,
    });
    const c = device();
    await on(c, async () => {
      await signIn(API);
      expect(await unlockWithPassphrase('first passphrase', API)).toEqual({
        outcome: 'wrongPassphrase',
      });
      expect(await unlockWithPassphrase('second passphrase', API)).toEqual({ outcome: 'unlocked' });
    });
    expect(keyOf(c)).toEqual({ ...key, generation: 2 });

    // B, still ready at generation 1, resets it without knowing the current passphrase.
    expect(await on(b, () => changePassphrase('third passphrase', API))).toEqual({
      outcome: 'changed',
      generation: 3,
    });
    expect(await nextDevice('third passphrase').then(keyOf)).toEqual({ ...key, generation: 3 });

    // A learns the new generation from me; its data key never changed, so it keeps syncing.
    const refreshed = await on(a, () => refreshMe(accountOf(a)!, API));
    expect(refreshed.rollback).toBe(false);
    expect(refreshed.answer.key).toEqual({ keyId: key.keyId, generation: 3 });
    expect(keyOf(a)?.generation).toBe(3);
    expect((await sync(a)).outcome).toBe('synced');
  });

  it('refuses a second create: the device enters the existing passphrase', async () => {
    const a = await firstDevice();
    const b = device();
    await on(b, async () => {
      expect(await signIn(API)).toMatchObject({
        outcome: 'signedIn',
        server: { keyId: keyOf(a)!.keyId, generation: 1 },
      });
      expect(await createPassphrase('another passphrase', API)).toEqual({ outcome: 'exists' });
    });
    expect(keyOf(b)).toBeUndefined();
  });

  it('asks before uploading to another account: no record request until yes', async () => {
    const a = await firstDevice();
    await put(a, session('s1'));
    await sync(a);
    expect(await serverRow('session', 's1')).toBeDefined();

    // The same profile signs in with another Google account.
    a.state.authTokenAnswer = 'google:someone-else';
    const before = recordCalls(a).length;
    await on(a, async () => {
      expect((await signIn(API)).outcome).toBe('signedIn');
    });
    expect(accountOf(a)?.uploadConfirmed).toBe(false);
    expect((await sync(a)).outcome).toBe('notReady');
    expect(recordCalls(a).length).toBe(before);

    // "No, keep it here": the old key stays.
    const oldKey = keyOf(a);
    await on(a, () => cancelAccountSwitch(API));
    expect(accountOf(a)).toBeUndefined();
    expect(keyOf(a)).toEqual(oldKey);

    // Yes: nothing goes up before the new account has its own key.
    await on(a, async () => {
      await signIn(API);
      await confirmAccount();
    });
    expect((await sync(a)).outcome).toBe('notReady');
    expect(recordCalls(a).length).toBe(before);
    await on(a, () => createPassphrase('other passphrase', API));
    expect((await sync(a)).outcome).toBe('synced');
    const rows = await query(
      `SELECT a.google_sub FROM account_records r JOIN accounts a ON a.id = r.account_id
         WHERE r.kind = 'session' AND r.id = 's1' ORDER BY a.google_sub`,
      [],
    );
    expect(rows.map((row) => row.google_sub)).toEqual(['person', 'someone-else']);
  });

  it('deletes the account: the bearer is gone with every record, and no device loses its key', async () => {
    const a = await firstDevice();
    const b = await nextDevice();
    const keyOfB = keyOf(b);
    await put(a, session('s1'));
    await sync(a);
    await sync(b);
    const token = accountOf(a)!.token;
    expect(await on(a, () => deleteCloudData(API))).toEqual({ outcome: 'deleted' });
    expect(accountOf(a)).toBeUndefined();
    expect(keyOf(a)).toBeUndefined();
    expect(await query('SELECT count(*)::int AS n FROM account_records', [])).toEqual([{ n: 0 }]);
    await expect(me(token, API)).rejects.toMatchObject({ status: 401 });
    // Local data is never touched.
    expect((await get(a, 's1'))?.id).toBe('s1');

    // B's bearer went with the account: its next run is a 401, which removes that bearer only.
    expect((await sync(b)).outcome).toBe('failed');
    expect(accountOf(b)).toBeUndefined();
    expect(keyOf(b)).toEqual(keyOfB);
    expect((await get(b, 's1'))?.id).toBe('s1');
  });

  it('reads a closed protocol as a 410 the client explains', async () => {
    const v1: typeof fetch = (input, init) => {
      const request = new Request(input, init);
      return app.fetch(new Request(request.url.replace('/v2/', '/v1/'), request));
    };
    const failure = await me('any-token', { ...API, fetch: v1 }).catch((err: unknown) => err);
    expect(failure).toBeInstanceOf(CloudHttpError);
    expect(failure).toMatchObject({
      status: 410,
      code: 'upgrade_required',
      userKey: 'errorCloudUpgrade',
    });
  });
});

describe('records between devices', () => {
  it('sessions and settings both ways', async () => {
    const a = await firstDevice();
    const b = await nextDevice();
    await put(a, session('s1', 'first'));
    await on(a, () => chrome.storage.sync.set({ sortBy: 'title' }));
    expect((await sync(a)).outcome).toBe('synced');
    expect((await sync(b)).outcome).toBe('synced');
    expect((await get(b, 's1'))?.name).toBe('first');
    expect((await on(b, () => readLocalSettings())).sort.sortBy).toBe('title');

    vi.setSystemTime(NOW + 1000);
    await on(b, () => sessionRepo.rename('s1', 'renamed'));
    await on(b, () => chrome.storage.sync.set({ sortBy: 'url' }));
    await sync(b);
    await sync(a);
    expect((await get(a, 's1'))?.name).toBe('renamed');
    expect((await on(a, () => readLocalSettings())).sort.sortBy).toBe('url');

    vi.setSystemTime(NOW + 2000);
    await on(a, () => sessionRepo.remove('s1'));
    await sync(a);
    expect((await serverRow('session', 's1'))?.deleted).toBe(true);
    await sync(b);
    expect(await get(b, 's1')).toBeUndefined();

    // Nothing left to say: another round sends no record.
    const posts = () =>
      requests.filter((entry) => entry.method === 'POST' && entry.path === '/v2/records');
    const before = posts().length;
    await sync(a);
    await sync(b);
    expect(posts().length).toBe(before);
  });

  it('docs and their screenshots, and a keepBoth conflict caught by the server’s compare and swap', async () => {
    const a = await firstDevice();
    const b = await nextDevice();
    await on(a, () =>
      putLocal(clips, { id: 'c1', parent: 'v', text: 'note', imageId: 'i1' }, IMAGE),
    );
    await on(a, () => putLocal(jots, { id: 'j1', text: 'base' }));
    await sync(a);
    await sync(b);
    expect((await on(b, () => localBody('clip', 'c1')))?.data).toEqual({
      id: 'c1',
      parent: 'v',
      text: 'note',
      imageId: 'i1',
    });
    expect(await on(b, () => localImage('i1'))).toBe(IMAGE);

    vi.setSystemTime(NOW + 1000);
    await on(a, () => putLocal(jots, { id: 'j1', text: 'from a' }));
    vi.setSystemTime(NOW + 2000);
    await on(b, () => putLocal(jots, { id: 'j1', text: 'from b' }));
    await sync(a);
    await sync(b);
    await sync(a);
    const texts = (target: ChromeFake) =>
      on(target, async () =>
        Object.entries(await chrome.storage.local.get(null))
          .filter(([name, value]) => name.startsWith('tdoc:jot:') && value !== null)
          .map(([, value]) => (value as { data: Jot }).data.text)
          .sort(),
      );
    expect(await texts(a)).toEqual(['from a', 'from b']);
    expect(await texts(b)).toEqual(['from a', 'from b']);

    vi.setSystemTime(NOW + 3000);
    await on(b, () => removeLocal(clips, { id: 'c1', parent: 'v' }));
    await sync(b);
    expect((await serverRow('image', 'i1'))?.deleted).toBe(true);
    await sync(a);
    expect(await on(a, () => localBody('clip', 'c1'))).toBeUndefined();
    expect(await on(a, () => localImage('i1'))).toBeUndefined();
  });

  it('pulls more than 5 MiB through the stream, in batches', async () => {
    const a = await firstDevice();
    const b = await nextDevice();
    // Seven sessions of about 940 KB of ciphertext each: under the record limit, over 6 MiB in all.
    const big = (n: number) => session(`big${n}`, `big ${n}`, String(n).repeat(700_000));
    for (let n = 0; n < 7; n += 1) {
      await put(a, big(n));
    }
    expect((await sync(a)).outcome).toBe('synced');
    const pushes = requests.filter((entry) => entry.device === a && entry.method === 'POST');
    expect(pushes.length).toBeGreaterThan(1);

    const pull = requests.length;
    expect((await sync(b)).outcome).toBe('synced');
    const pulls = requests
      .slice(pull)
      .filter((entry) => entry.method === 'GET' && entry.path === '/v2/records');
    expect(pulls.reduce((sum, entry) => sum + entry.bytes, 0)).toBeGreaterThan(5 * 1024 * 1024);
    for (let n = 0; n < 7; n += 1) {
      expect((await get(b, `big${n}`))?.windows[0]?.tabs[0]?.title).toBe(
        big(n).windows[0]!.tabs[0]!.title,
      );
    }
  }, 60_000);
});

describe('the caps and the clock', () => {
  it('holds what does not fit, settles a deletion the server lacks as absent, deletes at a full account', async () => {
    const a = await firstDevice();
    await put(a, session('s1'));
    await sync(a);

    // The account is full to within a few bytes.
    await query('UPDATE accounts SET storage_bytes = $1', [POLICY.account.storageBytes - 10]);
    await put(a, session('s2'));
    await sync(a);
    expect(await serverRow('session', 's2')).toBeUndefined();
    expect((await on(a, () => readSyncNotices())).heldByReason).toEqual({
      storage: 1,
      screenshots: 0,
    });

    // A deletion of what the server never had: nothing stored, and settled here.
    vi.setSystemTime(NOW + 1000);
    await on(a, () => sessionRepo.remove('s2'));
    await sync(a);
    expect(await serverRow('session', 's2')).toBeUndefined();
    expect(metaOf(a).sessions.deleted).toEqual({});
    expect(metaOf(a).held).toEqual({});

    // A deletion of a row the server has always applies.
    await on(a, () => sessionRepo.remove('s1'));
    await sync(a);
    expect((await serverRow('session', 's1'))?.deleted).toBe(true);
  });

  it('holds a screenshot over the cap, and sends it once there is room', async () => {
    const a = await firstDevice();
    await query('UPDATE accounts SET screenshots = $1', [POLICY.account.screenshots]);
    await on(a, () => putLocal(clips, { id: 'c1', parent: 'v', text: '', imageId: 'i1' }, IMAGE));
    await sync(a);
    expect(await serverRow('image', 'i1')).toBeUndefined();
    expect(await serverRow('doc', Object.values(metaOf(a).docs)[0]!.recordId)).toBeDefined();
    expect((await on(a, () => readSyncNotices())).heldByReason.screenshots).toBe(1);

    await query('UPDATE accounts SET screenshots = $1', [POLICY.account.screenshots - 1]);
    await sync(a);
    expect((await serverRow('image', 'i1'))?.deleted).toBe(false);
    expect(metaOf(a).held).toEqual({});
  });

  it('a device clock ahead is refused per record, and the item goes once the clock is right', async () => {
    const a = await firstDevice();
    // The device runs two days ahead of the server.
    serverBehindMs = 2 * DAY_MS;
    vi.setSystemTime(NOW + 2 * DAY_MS);
    await put(a, session('s1'));
    await sync(a);
    expect(await serverRow('session', 's1')).toBeUndefined();
    expect(metaOf(a).lastError).toBeDefined();

    // The clock is set back: the stamp a day ahead is restamped and the session is sent.
    serverBehindMs = 0;
    vi.setSystemTime(NOW + 1000);
    expect((await sync(a)).outcome).toBe('synced');
    const row = await serverRow('session', 's1');
    expect(row?.deleted).toBe(false);
    expect(Number(row?.updated_at)).toBeLessThanOrEqual(NOW + 1000);
    expect((await get(a, 's1'))?.updatedAt).toBe(Number(row?.updated_at));
  });
});
