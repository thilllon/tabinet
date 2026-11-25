import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { overrideCloudSyncConfig } from '@/lib/cloud-config';
import { docRecordId, encryptRecord, keyIdOf, toBase64 } from '@/lib/cloud-crypto';
import { type LocalDoc, resolveDoc } from '@/lib/cloud-docs';
import { CLOUD_ACCOUNT_KEY, CLOUD_KEY_KEY } from '@/lib/cloud-storage';
import { syncNow } from '@/lib/cloud-sync';
import { CLOUD_SYNC_META_KEY } from '@/lib/cloud-sync-state';
import type { CloudAccountV2, CloudKeyV2, CloudSyncMeta, DocTrack } from '@/types';

import { createChromeFake } from './chrome-fake';
import { fakeSyncServer, type FakeSyncServer } from './cloud-fetch';
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

// ---------------------------------------------------------------------------
// resolveDoc, pure
// ---------------------------------------------------------------------------

const live = (text: string, at = 1): LocalDoc<Jot> => ({
  state: 'live',
  data: { id: 'j', text },
  at,
});
const remote = (at: number, text: string | null, seq = at) => ({
  at,
  deleted: text === null,
  data: { id: 'j', ...(text === null ? {} : { text }) } as Jot,
  seq,
  hash: `h:${text ?? 'deleted'}`,
});
const track = (overrides: Partial<DocTrack> = {}): DocTrack => ({
  recordId: 'r',
  seq: null,
  known: null,
  pending: null,
  sent: [],
  ...overrides,
});

describe('resolveDoc, keepBoth (the table of spec 11.4)', () => {
  it.each<[string, DocTrack, LocalDoc<Jot>, ReturnType<typeof remote>, string]>([
    ['nothing pending takes it', track(), live('a'), remote(5, 'b'), 'take'],
    [
      'an edit against the same text takes it, no copy',
      track({ pending: { at: 4, deleted: false } }),
      live('b'),
      remote(5, 'b'),
      'take',
    ],
    [
      'an edit against another text copies',
      track({ pending: { at: 4, deleted: false } }),
      live('a'),
      remote(5, 'b'),
      'copy',
    ],
    [
      'an edit against a deletion copies',
      track({ pending: { at: 4, deleted: false } }),
      live('a'),
      remote(5, null),
      'copy',
    ],
    [
      'a deletion against an edit brings the edit back',
      track({ pending: { at: 4, deleted: true } }),
      { state: 'none' },
      remote(5, 'b'),
      'take',
    ],
    [
      'an untouched automatic copy yields',
      track({ pending: { at: 4, deleted: false }, autoCopy: true }),
      live('a'),
      remote(5, 'b'),
      'take',
    ],
    [
      'a body this build cannot read is held',
      track(),
      { state: 'unreadable' },
      remote(5, 'b'),
      'hold',
    ],
  ])('%s', (_name, given, local, incoming, action) => {
    expect(resolveDoc(jotCollection, given, local, incoming, 'r').action).toBe(action);
  });

  it('this device’s own push whose answer was lost settles without a copy', () => {
    const result = resolveDoc(
      jotCollection,
      track({ pending: { at: 5, deleted: false }, sent: [{ at: 5, hash: 'h:a' }] }),
      live('a', 5),
      remote(5, 'a'),
      'r',
    );
    expect(result.action).toBe('keep');
    expect(result.track).toMatchObject({
      pending: null,
      known: { at: 5, deleted: false },
      sent: [],
    });
  });

  it('an echo or replay at or below known never applies content', () => {
    const known = track({ known: { at: 9, deleted: false }, seq: 9 });
    const result = resolveDoc(jotCollection, known, live('a', 9), remote(9, 'other', 12), 'r');
    expect(result.action).toBe('keep');
    expect(result.track.seq).toBe(12);
    const lost = resolveDoc(jotCollection, known, live('a', 9), remote(3, 'old', 14), 'r');
    expect(lost.action).toBe('keep');
    expect(lost.track.pending).toEqual({ at: 10, deleted: false });
    expect(lost.restamp).toBe(10);
  });
});

describe('resolveDoc, lastWriter', () => {
  it('keeps the later stamp, the remote one on a tie, and restamps a kept version above known', () => {
    const pending = track({ pending: { at: 7, deleted: false } });
    expect(
      resolveDoc(
        clipCollection,
        pending,
        { state: 'live', data: { id: 'j', parent: 'p', text: 'a' }, at: 7 },
        { ...remote(6, 'b'), data: { id: 'j', parent: 'p', text: 'b' } },
        'r',
      ).action,
    ).toBe('keep');
    expect(
      resolveDoc(
        clipCollection,
        pending,
        { state: 'live', data: { id: 'j', parent: 'p', text: 'a' }, at: 7 },
        { ...remote(7, 'b'), data: { id: 'j', parent: 'p', text: 'b' } },
        'r',
      ).action,
    ).toBe('take');
    const kept = resolveDoc(
      clipCollection,
      track({ pending: { at: 7, deleted: false } }),
      { state: 'live', data: { id: 'j', parent: 'p', text: 'a' }, at: 7 },
      { ...remote(7, 'b'), data: { id: 'j', parent: 'p', text: 'b' }, hash: 'x' },
      'r',
    );
    expect(kept.track.known).toEqual({ at: 7, deleted: false });
  });
});

/** A small seeded generator, so a failing history can be replayed. */
function random(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state ^ (state >>> 15), 0x2c1b3c6d) + 0x9e3779b9) >>> 0;
    return state / 2 ** 32;
  };
}

describe('resolveDoc, seeded histories', () => {
  it.each([1, 2, 3, 4, 5])(
    'never lowers known, never applies an echo, keeps pending above known (seed %i)',
    (seed) => {
      const next = random(seed);
      for (let history = 0; history < 300; history += 1) {
        let state: DocTrack | undefined;
        let local: LocalDoc<Jot> = { state: 'none' };
        for (let step = 0; step < 12; step += 1) {
          const at = 1 + Math.floor(next() * 20);
          const text = next() < 0.3 ? null : `t${Math.floor(next() * 3)}`;
          if (next() < 0.4) {
            // A local edit or deletion.
            const stamp = Math.max(at, (state?.known?.at ?? 0) + 1, (state?.pending?.at ?? 0) + 1);
            state = { ...(state ?? track()), pending: { at: stamp, deleted: text === null } };
            local = text === null ? { state: 'none' } : live(text, stamp);
            continue;
          }
          const before = state;
          const result = resolveDoc(jotCollection, state, local, remote(at, text, step + 1), 'r');
          state = result.track;
          if (before?.known != null) {
            expect(state.known!.at).toBeGreaterThanOrEqual(before.known.at);
            if (at <= before.known.at) {
              expect(['keep']).toContain(result.action);
            }
          }
          if (state.pending !== null && state.known !== null && result.action === 'keep') {
            expect(state.pending.at).toBeGreaterThan(state.known.at);
          }
          if (result.action === 'take' || result.action === 'copy') {
            local = text === null ? { state: 'none' } : live(text, at);
            expect(state.pending).toBeNull();
          }
        }
      }
    },
  );
});

// ---------------------------------------------------------------------------
// The engine with test collections
// ---------------------------------------------------------------------------

type ChromeFake = ReturnType<typeof createChromeFake>;
const NOW = 1_800_000_000_000;
const IMAGE = 'data:image/webp;base64,UklGRhoAAABXRUJQVlA4TA0AAAAvAAAAEAcQERGIiP4HAA==';
let server: FakeSyncServer;
let account: CloudAccountV2;
let key: CloudKeyV2;
const clips = testStore(clipCollection, true);
const jots = testStore(jotCollection);

function device(): ChromeFake {
  const fake = createChromeFake();
  fake.state.local.set(CLOUD_ACCOUNT_KEY, account);
  fake.state.local.set(CLOUD_KEY_KEY, key);
  return fake;
}

async function on<T>(fake: ChromeFake, fn: () => Promise<T>): Promise<T> {
  const previous = globalThis.chrome;
  Object.assign(globalThis, { chrome: fake.chrome });
  try {
    return await fn();
  } finally {
    Object.assign(globalThis, { chrome: previous });
  }
}

const sync = (fake: ChromeFake, stores = [clips, jots]) =>
  on(fake, () =>
    syncNow({ fetch: server.fetch, apiBase: 'https://sync.test', inWorker: false, stores }),
  );
const metaOf = (fake: ChromeFake) => fake.state.local.get(CLOUD_SYNC_META_KEY) as CloudSyncMeta;

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
    expiresAt: 4e12,
    email: 'p@x',
    uploadConfirmed: true,
  };
  key = { accountId: seeded.accountId, keyId, generation: 1, dek };
});

afterEach(() => {
  overrideCloudSyncConfig();
  vi.useRealTimers();
});

describe('docs between two devices', () => {
  it('offers items written before sign-in, then edits and deletions either way', async () => {
    const a = device();
    const b = device();
    await on(a, () => putLocal(clips, { id: 'c1', parent: 'v', text: 'one' }));
    await sync(a);
    await sync(b);
    expect((await on(b, () => localBody('clip', 'c1')))?.data).toEqual({
      id: 'c1',
      parent: 'v',
      text: 'one',
    });

    vi.setSystemTime(NOW + 1000);
    await on(b, () => putLocal(clips, { id: 'c1', parent: 'v', text: 'edited' }));
    await sync(b);
    await sync(a);
    expect((await on(a, () => localBody('clip', 'c1')))?.data).toMatchObject({ text: 'edited' });

    vi.setSystemTime(NOW + 2000);
    await on(a, () => removeLocal(clips, { id: 'c1', parent: 'v' }));
    await sync(a);
    await sync(b);
    expect(await on(b, () => localBody('clip', 'c1'))).toBeUndefined();
  });

  it('keeps both texts of a memo-like conflict, once, also on replay', async () => {
    const a = device();
    const b = device();
    await on(a, () => putLocal(jots, { id: 'j1', text: 'base' }));
    await sync(a);
    await sync(b);
    vi.setSystemTime(NOW + 1000);
    await on(a, () => putLocal(jots, { id: 'j1', text: 'from a' }));
    vi.setSystemTime(NOW + 2000);
    await on(b, () => putLocal(jots, { id: 'j1', text: 'from b' }));
    await sync(a);
    await sync(b);
    await sync(a);
    await sync(b);
    const texts = async (fake: ChromeFake) =>
      on(fake, async () =>
        Object.entries(await chrome.storage.local.get(null))
          .filter(([name, value]) => name.startsWith('tdoc:jot:') && value !== null)
          .map(([, value]) => (value as { data: Jot }).data.text)
          .sort(),
      );
    expect(await texts(a)).toEqual(['from a', 'from b']);
    expect(await texts(b)).toEqual(['from a', 'from b']);
    expect(metaOf(b).conflicts).toBe(1);
    // A replay of the whole feed makes no second copy.
    await on(b, async () => {
      await chrome.storage.local.set({ [CLOUD_SYNC_META_KEY]: { ...metaOf(b), cursor: 0 } });
    });
    await sync(b);
    expect(await texts(b)).toEqual(['from a', 'from b']);
  });

  it('a picture follows its note, and its tombstone goes once the note’s deletion is accepted', async () => {
    const a = device();
    const b = device();
    await on(a, () => putLocal(clips, { id: 'c1', parent: 'v', text: '', imageId: 'i1' }, IMAGE));
    await sync(a);
    await sync(b);
    expect(await on(b, () => localImage('i1'))).toBe(IMAGE);
    vi.setSystemTime(NOW + 1000);
    await on(a, () => removeLocal(clips, { id: 'c1', parent: 'v' }));
    await sync(a);
    expect(server.record('image', 'i1')?.deleted).toBe(true);
    await sync(b);
    expect(await on(b, () => localImage('i1'))).toBeUndefined();
  });

  it('holds a picture over the cap, and sends it in the run whose deletion made room', async () => {
    server.imageLimit = 1;
    const a = device();
    await on(a, () => putLocal(clips, { id: 'c1', parent: 'v', text: '', imageId: 'i1' }, IMAGE));
    await sync(a);
    await on(a, () => putLocal(clips, { id: 'c2', parent: 'v', text: '', imageId: 'i2' }, IMAGE));
    await sync(a);
    expect(Object.keys(metaOf(a).held)).toEqual(['image:i2']);
    await on(a, () => removeLocal(clips, { id: 'c1', parent: 'v' }));
    await sync(a);
    expect(server.record('image', 'i2')?.deleted).toBe(false);
    expect(metaOf(a).held).toEqual({});
  });
});

describe('what this build cannot apply', () => {
  it('holds an unknown type with its raw record and adopts it in a build that knows it', async () => {
    const a = device();
    await on(a, () => putLocal(jots, { id: 'j1', text: 'hello' }));
    await sync(a, [jots]);
    const b = device();
    const before = server.record('doc', await docRecordId(key.dek, 'jot', 'j1'))!.seq;
    await sync(b, []);
    const ref = 'jot:j1';
    expect(metaOf(b).blocked[ref]?.reason).toBe('unknownType');
    expect(b.state.local.has(metaOf(b).blocked[ref]!.raw)).toBe(true);
    // Never pushed over.
    expect(server.record('doc', await docRecordId(key.dek, 'jot', 'j1'))!.seq).toBe(before);
    await sync(b, [jots]);
    expect((await on(b, () => localBody('jot', 'j1')))?.data).toEqual({ id: 'j1', text: 'hello' });
    expect(metaOf(b).blocked).toEqual({});
  });

  it('holds a newer version, and a replay of an older one never replaces the raw copy', async () => {
    const b = device();
    const meta = (at: number) => ({ kind: 'doc', id: '', updatedAt: at, deleted: false }) as const;
    const id = await docRecordId(key.dek, 'jot', 'j9');
    const content = { type: 'jot', version: 2, data: { id: 'j9', text: 'newer' } };
    const newer = { ...meta(NOW), id };
    server.inject({ ...newer, ...(await encryptRecord(key.dek, newer, content)) });
    await sync(b);
    expect(metaOf(b).blocked['jot:j9']).toMatchObject({ reason: 'newer', at: NOW });
    const older = { ...meta(NOW - 5), id };
    server.inject({ ...older, ...(await encryptRecord(key.dek, older, content)) });
    await sync(b);
    expect(metaOf(b).blocked['jot:j9']?.at).toBe(NOW);
    expect(metaOf(b).lastError).toBeDefined();
  });

  it('a doc under another doc’s id is unreadable and applies nothing', async () => {
    const b = device();
    const id = await docRecordId(key.dek, 'jot', 'other');
    const record = { kind: 'doc', id, updatedAt: NOW, deleted: false } as const;
    server.inject({
      ...record,
      ...(await encryptRecord(key.dek, record, {
        type: 'jot',
        version: 1,
        data: { id: 'j1', text: 'x' },
      })),
    });
    await sync(b);
    expect(await on(b, () => localBody('jot', 'j1'))).toBeUndefined();
    expect(metaOf(b).unreadable[`doc:${id}`]).toBe(NOW);
  });
});
