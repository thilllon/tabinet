/**
 * The transaction under every synced doc store (memos, YouTube notes; spec 10.6 and 11.1): the
 * store's own lock, then the sessions lock (where sync's bookkeeping lives), a working copy of
 * the bookkeeping, and everything staged committed in **one** `chrome.storage.local.set` (bodies,
 * deleted keys as `null`, index, bookkeeping), then the cleanup `remove` of the `null` keys.
 *
 * With cloud sync unconfigured nothing of sync is read or written and the sessions lock is not
 * taken: the working bookkeeping is a blank one whose tracking never started, so
 * `trackLocalDocChange()` only computes the stamp.
 */
import { isCloudSyncEnabled } from '@/lib/cloud-config';
import { setThenClean, withSessionsLock } from '@/lib/cloud-storage';
import { CLOUD_SYNC_META_KEY, emptyTrack, readSyncMeta } from '@/lib/cloud-sync-state';
import type { CloudSyncMeta } from '@/types';

// Fallback serialization for runtimes without Web Locks (page-local only), one chain per lock.
const fallbackChains = new Map<string, Promise<unknown>>();

/** Runs `fn` under the Web Lock `name`, shared by the worker and every extension page. */
export function withNamedLock<T>(name: string, fn: () => Promise<T>): Promise<T> {
  const locks = typeof navigator === 'undefined' ? undefined : navigator.locks;
  if (locks === undefined) {
    const chain = fallbackChains.get(name) ?? Promise.resolve();
    const run = chain.then(fn, fn);
    fallbackChains.set(
      name,
      run.catch(() => undefined),
    );
    return run;
  }
  return new Promise<T>((resolve, reject) => {
    locks
      .request(name, async () => {
        try {
          resolve(await fn());
        } catch (err) {
          reject(err);
        }
      })
      .catch(reject);
  });
}

/** Bookkeeping that tracks nothing: what a store works with while there is none stored. */
export function blankSyncMeta(): CloudSyncMeta {
  return {
    schemaVersion: 2,
    accountId: '',
    keyId: '',
    cursor: 0,
    sessions: emptyTrack(),
    images: { ...emptyTrack(), owner: {} },
    docs: {},
    started: [],
    settingsUpdatedAt: 0,
    settingsDirty: false,
    held: {},
    blocked: {},
    unreadable: {},
    conflicts: 0,
    conflictsNoticed: 0,
    lastSyncAt: null,
  };
}

export interface DocWork<T> {
  result: T;
  /** Every key to write in the one `set`; `null` deletes. */
  entries: Record<string, unknown>;
}

/**
 * Runs `work` under `lockName` (and the sessions lock while sync is configured) over a working
 * copy of the bookkeeping, then commits what it returns, with the bookkeeping when one is stored
 * and it changed, in one `set`.
 */
export function runDocTransaction<T>(
  lockName: string,
  work: (meta: CloudSyncMeta) => Promise<DocWork<T>>,
): Promise<T> {
  return withNamedLock(lockName, async () => {
    if (!isCloudSyncEnabled()) {
      const { result, entries } = await work(blankSyncMeta());
      await setThenClean(entries);
      return result;
    }
    return withSessionsLock(async () => {
      const stored = await readSyncMeta();
      const meta = structuredClone(stored ?? blankSyncMeta());
      const { result, entries } = await work(meta);
      const all = { ...entries };
      if (stored !== undefined && JSON.stringify(meta) !== JSON.stringify(stored)) {
        all[CLOUD_SYNC_META_KEY] = meta;
      }
      await setThenClean(all);
      return result;
    });
  });
}

/** Every key in `chrome.storage.local` (`getKeys()` is Chrome 130+; older Chrome reads all). */
export async function allLocalKeys(): Promise<string[]> {
  const area = chrome.storage.local;
  if (typeof area.getKeys === 'function') {
    return area.getKeys();
  }
  return Object.keys(await area.get(null));
}
