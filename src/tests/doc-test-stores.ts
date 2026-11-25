import {
  type DocCollection,
  type DocStore,
  type DocTx,
  type LocalDoc,
  trackLocalDocChange,
} from '@/lib/cloud-docs';
/**
 * Test-only doc collections and a doc store over `chrome.storage.local` (spec 11.1, 13.6): one
 * `lastWriter` collection with screenshots (`clip`, shaped like a YouTube note) and one
 * `keepBoth` collection (`jot`, shaped like a memo). The store takes the sessions lock and commits
 * everything staged in one `set`, as a real store must (10.6). Not a test file.
 */
import { setThenClean, withSessionsLock } from '@/lib/cloud-storage';
import { CLOUD_SYNC_META_KEY, freshSyncMeta, readSyncMeta } from '@/lib/cloud-sync-state';
import type { CloudSyncMeta } from '@/types';

export interface Clip {
  id: string;
  parent: string;
  text: string;
  imageId?: string;
}
export interface ClipDeleted {
  id: string;
  parent: string;
}
export interface Jot {
  id: string;
  text: string;
  conflictOf?: string;
}

const ID = /^[A-Za-z0-9_-]{1,64}$/;

function exact(
  value: unknown,
  keys: string[],
  optional: string[] = [],
): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false;
  }
  const own = Object.keys(value);
  return (
    keys.every((key) => own.includes(key)) &&
    own.every((key) => keys.includes(key) || optional.includes(key))
  );
}

export const clipCollection: DocCollection<Clip, ClipDeleted> = {
  type: 'clip',
  version: 1,
  conflict: 'lastWriter',
  parseLive: (data) =>
    exact(data, ['id', 'parent', 'text'], ['imageId']) &&
    typeof data.id === 'string' &&
    ID.test(data.id) &&
    typeof data.parent === 'string' &&
    typeof data.text === 'string' &&
    (data.imageId === undefined || (typeof data.imageId === 'string' && ID.test(data.imageId)))
      ? (data as unknown as Clip)
      : null,
  parseDeleted: (data) =>
    exact(data, ['id', 'parent']) && typeof data.id === 'string' && typeof data.parent === 'string'
      ? (data as unknown as ClipDeleted)
      : null,
  deletedOf: (id, parent) => ({ id, parent: parent ?? '' }),
  parentOf: (data) => data.parent,
  imageOf: (data) => data.imageId,
  fingerprint: (data) => [data.parent, data.text, data.imageId ?? null],
};

export const jotCollection: DocCollection<Jot, { id: string }> = {
  type: 'jot',
  version: 1,
  conflict: 'keepBoth',
  parseLive: (data) =>
    exact(data, ['id', 'text'], ['conflictOf']) &&
    typeof data.id === 'string' &&
    ID.test(data.id) &&
    typeof data.text === 'string'
      ? (data as unknown as Jot)
      : null,
  parseDeleted: (data) =>
    exact(data, ['id']) && typeof data.id === 'string' ? { id: data.id } : null,
  deletedOf: (id) => ({ id }),
  fingerprint: (data) => [data.text],
  keepBoth: {
    textOf: (data) => data.text,
    makeCopy: (data, copyId, originalId) => ({
      id: copyId,
      text: data.text,
      conflictOf: originalId,
    }),
  },
};

const bodyKey = (type: string, id: string) => `tdoc:${type}:${id}`;
const imageKey = (id: string) => `timg:${id}`;

/** A store of `collection` over `chrome.storage.local`; `images` holds screenshots too. */
export function testStore<Live extends { id: string }, Deleted extends { id: string }>(
  collection: DocCollection<Live, Deleted>,
  images = false,
): DocStore<Live, Deleted> {
  return {
    collection,
    transact<T>(run: (tx: DocTx<Live, Deleted>) => Promise<T>): Promise<T> {
      return withSessionsLock(async () => {
        const stored = await readSyncMeta();
        const meta: CloudSyncMeta = structuredClone(
          stored ??
            freshSyncMeta({
              account: {
                accountId: '-',
                token: '-',
                expiresAt: 0,
                email: '',
                uploadConfirmed: true,
              },
              key: { accountId: '-', keyId: '-', generation: 1, dek: '' },
            }),
        );
        const staged = new Map<string, unknown>();
        const readKey = async (key: string): Promise<unknown> =>
          staged.has(key) ? staged.get(key) : (await chrome.storage.local.get(key))[key];
        const read = async (id: string): Promise<LocalDoc<Live>> => {
          const value = await readKey(bodyKey(collection.type, id));
          if (value === undefined || value === null) {
            return { state: 'none' };
          }
          if (
            typeof value !== 'object' ||
            (value as { unreadable?: unknown }).unreadable === true
          ) {
            return { state: 'unreadable' };
          }
          const { data, at } = value as { data: unknown; at: number };
          const live = collection.parseLive(data);
          return live === null ? { state: 'unreadable' } : { state: 'live', data: live, at };
        };
        const allBodies = async (): Promise<{ data: Live; at: number }[]> => {
          const everything = await chrome.storage.local.get(null);
          const keys = new Set([...Object.keys(everything), ...staged.keys()]);
          const out: { data: Live; at: number }[] = [];
          for (const key of keys) {
            if (key.startsWith(`tdoc:${collection.type}:`)) {
              const local = await read(key.slice(`tdoc:${collection.type}:`.length));
              if (local.state === 'live') {
                out.push({ data: local.data, at: local.at });
              }
            }
          }
          return out;
        };
        const tx: DocTx<Live, Deleted> = {
          meta,
          read,
          listLive: allBodies,
          put(data, at) {
            staged.set(bodyKey(collection.type, data.id), { data, at });
          },
          remove(deleted) {
            staged.set(bodyKey(collection.type, deleted.id), null);
          },
          stage(key, value) {
            staged.set(key, value);
          },
        };
        if (images) {
          tx.readImage = async (id) => {
            const value = await readKey(imageKey(id));
            return typeof value === 'string' ? value : null;
          };
          tx.putImage = (id, dataUrl) => staged.set(imageKey(id), dataUrl);
          tx.removeImage = (id) => staged.set(imageKey(id), null);
          tx.imageReferenced = async (id) =>
            (await allBodies()).some((body) => collection.imageOf?.(body.data) === id);
        }
        const result = await run(tx);
        const entries: Record<string, unknown> = Object.fromEntries(staged);
        if (stored !== undefined) {
          entries[CLOUD_SYNC_META_KEY] = meta;
        }
        await setThenClean(entries);
        return result;
      });
    },
  };
}

/** A local write of the store's own, tracked as the real stores do. */
export async function putLocal<Live extends { id: string }, Deleted extends { id: string }>(
  store: DocStore<Live, Deleted>,
  data: Live,
  image?: string,
): Promise<number> {
  return store.transact(async (tx) => {
    const before = await tx.read(data.id);
    const at = trackLocalDocChange(tx, store.collection, {
      localId: data.id,
      before: before.state === 'live' ? before.data : null,
      after: { live: data },
      previousAt: before.state === 'live' ? before.at : 0,
      now: Date.now(),
    });
    tx.put(data, at);
    const imageId = store.collection.imageOf?.(data);
    if (image !== undefined && imageId !== undefined) {
      tx.putImage?.(imageId, image);
    }
    return at;
  });
}

/** A local deletion of the store's own; its screenshot goes with it. */
export async function removeLocal<Live extends { id: string }, Deleted extends { id: string }>(
  store: DocStore<Live, Deleted>,
  deleted: Deleted,
): Promise<void> {
  await store.transact(async (tx) => {
    const before = await tx.read(deleted.id);
    if (before.state !== 'live') {
      return;
    }
    const at = trackLocalDocChange(tx, store.collection, {
      localId: deleted.id,
      before: before.data,
      after: { deleted },
      previousAt: before.at,
      now: Date.now(),
    });
    tx.remove(deleted, at);
    const imageId = store.collection.imageOf?.(before.data);
    if (imageId !== undefined) {
      tx.removeImage?.(imageId);
    }
  });
}

/** The stored body of a test doc, or `undefined`. */
export async function localBody(
  type: string,
  id: string,
): Promise<{ data: unknown; at: number } | undefined> {
  const value = (await chrome.storage.local.get(bodyKey(type, id)))[bodyKey(type, id)];
  return value === null || value === undefined
    ? undefined
    : (value as { data: unknown; at: number });
}

export async function localImage(id: string): Promise<string | undefined> {
  const value = (await chrome.storage.local.get(imageKey(id)))[imageKey(id)];
  return typeof value === 'string' ? value : undefined;
}

export { bodyKey as testBodyKey };
