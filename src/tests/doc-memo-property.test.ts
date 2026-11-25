import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The real doc stores (memos and YouTube notes, `DOC_STORES`) through the real sync engine
 * between simulated devices, each its own chrome fake, against the fake v2 server (spec 13.8).
 */
import { overrideCloudSyncConfig } from '@/lib/cloud-config';
import { keyIdOf, toBase64 } from '@/lib/cloud-crypto';
import { CLOUD_ACCOUNT_KEY, CLOUD_KEY_KEY } from '@/lib/cloud-storage';
import { syncNow } from '@/lib/cloud-sync';
import { CLOUD_SYNC_META_KEY } from '@/lib/cloud-sync-state';
import { memoRepo } from '@/lib/memo-repo';
import { notesRepo } from '@/lib/notes-repo';
import type { CloudAccountV2, CloudKeyV2, CloudSyncMeta, Memo, MemoSummary } from '@/types';

import { createChromeFake } from './chrome-fake';
import { fakeSyncServer, type FakeSyncServer } from './cloud-fetch';

type ChromeFake = ReturnType<typeof createChromeFake>;
const NOW = 1_800_000_000_000;
const IMAGE = 'data:image/webp;base64,UklGRhoAAABXRUJQVlA4TA0AAAAvAAAAEAcQERGIiP4HAA==';
const V = 'dQw4w9WgXcQ';
const M = '00000000-0000-4000-8000-0000000000aa';
let server: FakeSyncServer;
let account: CloudAccountV2;
let key: CloudKeyV2;

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

const sync = (fake: ChromeFake) =>
  on(fake, () => syncNow({ fetch: server.fetch, apiBase: 'https://sync.test', inWorker: false }));
const metaOf = (fake: ChromeFake) => fake.state.local.get(CLOUD_SYNC_META_KEY) as CloudSyncMeta;
const memos = (fake: ChromeFake): Promise<MemoSummary[]> =>
  on(fake, () => memoRepo.listSummaries());
const texts = async (fake: ChromeFake): Promise<string[]> => {
  const out: string[] = [];
  for (const summary of await memos(fake)) {
    const memo = (await on(fake, () => memoRepo.get(summary.id))) as Memo;
    out.push(memo.text);
  }
  return out.sort();
};
const save = (fake: ChromeFake, text: string, expected: (string | null)[], id = M) =>
  on(fake, () => memoRepo.save({ id, text, expected }));
const tick = (ms = 1000) => vi.setSystemTime(Date.now() + ms);

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

describe('memos between devices (the table of spec 11.4)', () => {
  it('offers memos written before sign-in, and a quiet round sends nothing', async () => {
    const a = device();
    const b = device();
    await save(a, 'first', [null]);
    expect((await sync(a)).pushed).toBeGreaterThan(0);
    await sync(b);
    expect(await texts(b)).toEqual(['first']);
    expect((await sync(a)).pushed).toBe(0);
    expect((await sync(b)).pushed).toBe(0);
  });

  it('an edit against another text keeps both, the same on both devices, with no further copy', async () => {
    const a = device();
    const b = device();
    await save(a, 'base', [null]);
    await sync(a);
    await sync(b);
    tick();
    await save(a, 'from a', ['base']);
    tick();
    await save(b, 'from b', ['base']);
    await sync(a);
    await sync(b);
    await sync(a);
    expect(await texts(a)).toEqual(['from a', 'from b']);
    expect(await texts(b)).toEqual(['from a', 'from b']);
    expect((await memos(b)).filter((memo) => memo.conflict)).toHaveLength(1);
    expect(metaOf(b).conflicts).toBe(1);
    // Replays and more rounds make no second copy.
    for (let round = 0; round < 3; round += 1) {
      await sync(b);
      await sync(a);
    }
    expect(await texts(a)).toEqual(['from a', 'from b']);
    expect(await texts(b)).toEqual(['from a', 'from b']);
  });

  it('an edit against the same text takes it, no copy', async () => {
    const a = device();
    const b = device();
    await save(a, 'base', [null]);
    await sync(a);
    await sync(b);
    await save(a, 'same', ['base']);
    await save(b, 'same', ['base']);
    await sync(a);
    await sync(b);
    await sync(a);
    expect(await texts(a)).toEqual(['same']);
    expect(await texts(b)).toEqual(['same']);
  });

  it('an edit beats a deletion, either way round', async () => {
    const a = device();
    const b = device();
    await save(a, 'base', [null]);
    await sync(a);
    await sync(b);
    tick();
    await on(a, () => memoRepo.remove(M));
    tick();
    await save(b, 'kept', ['base']);
    // The deletion arrives first at the server: b's edit becomes a copy, the original goes.
    await sync(a);
    await sync(b);
    await sync(a);
    expect(await texts(a)).toEqual(['kept']);
    expect(await texts(b)).toEqual(['kept']);

    // The edit arrives first: a's pending deletion yields and the edit comes back.
    const c = device();
    const d = device();
    const other = '00000000-0000-4000-8000-0000000000bb';
    await save(c, 'two', [null], other);
    await sync(c);
    await sync(d);
    tick();
    await save(c, 'two edited', ['two'], other);
    await sync(c);
    await on(d, () => memoRepo.remove(other));
    await sync(d);
    await sync(c);
    expect(await texts(d)).toContain('two edited');
  });

  it('a deletion against a deletion is a deletion', async () => {
    const a = device();
    const b = device();
    await save(a, 'base', [null]);
    await sync(a);
    await sync(b);
    await on(a, () => memoRepo.remove(M));
    await on(b, () => memoRepo.remove(M));
    await sync(a);
    await sync(b);
    await sync(a);
    expect(await memos(a)).toEqual([]);
    expect(await memos(b)).toEqual([]);
  });

  it('the editor writes into the copy sync made of its text, never a second copy', async () => {
    const a = device();
    const b = device();
    await save(a, 'base', [null]);
    await sync(a);
    await sync(b);
    tick();
    await save(a, 'server text', ['base']);
    await sync(a);
    tick();
    await save(b, 'mine', ['base']);
    await sync(b);
    // Sync made a copy of "mine"; the editor on b still has its pending "mine" and goes on typing.
    const result = await save(b, 'mine, more', ['base', 'mine']);
    expect(result.outcome).toBe('redirected');
    await sync(b);
    await sync(a);
    expect(await texts(a)).toEqual(['mine, more', 'server text']);
    expect(await texts(b)).toEqual(['mine, more', 'server text']);
  });

  it('three devices editing at once lose no text and agree', async () => {
    const devices = [device(), device(), device()];
    await save(devices[0], 'base', [null]);
    for (const fake of devices) {
      await sync(fake);
    }
    for (const [n, fake] of devices.entries()) {
      tick();
      await save(fake, `edit ${n}`, ['base']);
    }
    for (let round = 0; round < 3; round += 1) {
      for (const fake of devices) {
        await sync(fake);
      }
    }
    const expected = ['edit 0', 'edit 1', 'edit 2'];
    for (const fake of devices) {
      expect(await texts(fake)).toEqual(expected);
    }
  });

  it('an untouched automatic copy yields to a later edit of it elsewhere', async () => {
    const a = device();
    const b = device();
    await save(a, 'base', [null]);
    await sync(a);
    await sync(b);
    tick();
    await save(a, 'from a', ['base']);
    tick();
    await save(b, 'from b', ['base']);
    await sync(a);
    await sync(b);
    await sync(a);
    const copy = (await memos(a)).find((memo) => memo.conflict);
    expect(copy).toBeDefined();
    tick();
    await save(a, 'from b, merged', ['from b'], copy!.id);
    await sync(a);
    await sync(b);
    expect(await texts(b)).toEqual(['from a', 'from b, merged']);
    expect((await memos(b)).filter((memo) => memo.conflict)).toHaveLength(1);
  });
});

describe('YouTube notes, one doc per entry (spec 11.3)', () => {
  const video = { videoId: V, title: 'Talk' };

  it('offers every note and screenshot written before sign-in, once', async () => {
    const a = device();
    const b = device();
    await on(a, () => notesRepo.addEntry(video, { at: 3, text: 'one', image: IMAGE }));
    await on(a, () => notesRepo.addEntry(video, { at: 9, text: 'two' }));
    const first = await sync(a);
    // Two notes, the screenshot and the settings of a first run.
    expect(first.pushed).toBe(4);
    expect((await sync(a)).pushed).toBe(0);
    await sync(b);
    const notes = await on(b, () => notesRepo.get(V));
    expect(notes?.title).toBe('Talk');
    expect(notes?.entries.map((entry) => entry.text).sort()).toEqual(['one', 'two']);
    const imageId = notes?.entries.find((entry) => entry.text === 'one')?.imageId;
    expect(await on(b, () => notesRepo.getImage(imageId!))).toBe(IMAGE);
  });

  it('a note and its screenshot from one batch are stored in one write (10.6)', async () => {
    const a = device();
    const b = device();
    await on(a, () => notesRepo.addEntry(video, { at: 1, text: 'x', image: IMAGE }));
    await sync(a);
    // B's worker is killed at the first write that stores the screenshot.
    const realSet = b.chrome.storage.local.set.bind(b.chrome.storage.local);
    let killed = false;
    b.chrome.storage.local.set = (async (items: Record<string, unknown>) => {
      const picture = Object.keys(items).some(
        (k) => k.startsWith('noteImage:') && items[k] !== null,
      );
      if (!killed && picture) {
        killed = true;
        throw new Error('worker killed');
      }
      return realSet(items);
    }) as typeof b.chrome.storage.local.set;
    await sync(b);
    expect(killed).toBe(true);
    // Never a note whose screenshot is missing: both or neither.
    const cut = await on(b, () => notesRepo.get(V));
    expect(cut).toBeUndefined();
    tick();
    await sync(b);
    const notes = await on(b, () => notesRepo.get(V));
    const imageId = notes?.entries[0]?.imageId;
    expect(await on(b, () => notesRepo.getImage(imageId!))).toBe(IMAGE);
  });

  it('two devices adding notes to one video lose nothing', async () => {
    const a = device();
    const b = device();
    await on(a, () => notesRepo.addEntry(video, { at: 1, text: 'from a' }));
    await on(b, () => notesRepo.addEntry(video, { at: 2, text: 'from b' }));
    await sync(a);
    await sync(b);
    await sync(a);
    for (const fake of [a, b]) {
      const notes = await on(fake, () => notesRepo.get(V));
      expect(notes?.entries.map((entry) => entry.text).sort()).toEqual(['from a', 'from b']);
    }
  });

  it('the later of an edit and a deletion wins, either way', async () => {
    const a = device();
    const b = device();
    const entry = await on(a, () => notesRepo.addEntry(video, { at: 1, text: 'x' }));
    await sync(a);
    await sync(b);
    tick();
    await on(a, () => notesRepo.removeEntry(V, entry.id));
    tick();
    await on(b, () => notesRepo.updateEntry(V, entry.id, { text: 'edited later' }));
    await sync(a);
    await sync(b);
    await sync(a);
    expect((await on(a, () => notesRepo.get(V)))?.entries.map((e) => e.text)).toEqual([
      'edited later',
    ]);

    tick();
    await on(b, () => notesRepo.updateEntry(V, entry.id, { text: 'edited earlier' }));
    tick();
    await on(a, () => notesRepo.removeEntry(V, entry.id));
    await sync(b);
    await sync(a);
    await sync(b);
    expect(await on(b, () => notesRepo.get(V))).toBeUndefined();
  });

  it('a deleted note and its screenshot leave the other device; Undo after the sent deletion brings both back', async () => {
    const a = device();
    const b = device();
    const entry = await on(a, () => notesRepo.addEntry(video, { at: 1, text: 'x', image: IMAGE }));
    await sync(a);
    await sync(b);
    tick();
    const removed = await on(a, () => notesRepo.removeEntry(V, entry.id));
    await sync(a);
    await sync(b);
    expect(await on(b, () => notesRepo.get(V))).toBeUndefined();
    expect(await on(b, () => notesRepo.getImage(entry.imageId!))).toBeUndefined();

    tick();
    await on(a, () => notesRepo.restoreEntry(video, removed!));
    await sync(a);
    await sync(b);
    expect((await on(b, () => notesRepo.get(V)))?.entries.map((e) => e.text)).toEqual(['x']);
    expect(await on(b, () => notesRepo.getImage(entry.imageId!))).toBe(IMAGE);
  });

  it('a title refresh travels with the entry written, and Delete all is one tombstone per entry', async () => {
    const a = device();
    const b = device();
    await on(a, () => notesRepo.addEntry(video, { at: 1, text: 'one' }));
    await on(a, () => notesRepo.addEntry(video, { at: 2, text: 'two' }));
    await sync(a);
    await sync(b);
    tick();
    await on(a, () =>
      notesRepo.addEntry({ videoId: V, title: 'Talk, renamed' }, { at: 3, text: 'three' }),
    );
    expect((await sync(a)).pushed).toBe(1);
    await sync(b);
    expect((await on(b, () => notesRepo.get(V)))?.title).toBe('Talk, renamed');

    tick();
    await on(b, () => notesRepo.remove(V));
    expect((await sync(b)).pushed).toBe(3);
    await sync(a);
    expect(await on(a, () => notesRepo.get(V))).toBeUndefined();
    expect(await on(a, () => notesRepo.listSummaries())).toEqual([]);
  });
});

describe('held records (spec 8.3)', () => {
  it('a held record whose retry is cut between its apply and its unblock is not lost', async () => {
    const a = device();
    const b = device();
    await save(a, 'hello', [null]);
    await sync(a);
    // B is an older build that does not know memos: the memo is held with its raw copy.
    await on(b, () =>
      syncNow({ fetch: server.fetch, apiBase: 'https://sync.test', inWorker: false, stores: [] }),
    );
    expect(Object.keys(metaOf(b).blocked)).toEqual([`memo:${M}`]);
    // B updates; its first retry is killed at the write that applies the memo.
    const realSet = b.chrome.storage.local.set.bind(b.chrome.storage.local);
    let killed = false;
    b.chrome.storage.local.set = (async (items: Record<string, unknown>) => {
      if (!killed && Object.keys(items).some((k) => k.startsWith('memo:') && items[k] !== null)) {
        killed = true;
        throw new Error('worker killed');
      }
      return realSet(items);
    }) as typeof b.chrome.storage.local.set;
    tick();
    await sync(b);
    expect(killed).toBe(true);
    tick();
    await sync(b);
    tick();
    await sync(b);
    expect(await texts(b)).toEqual(['hello']);
    expect(metaOf(b).blocked).toEqual({});
  });
});
