/**
 * Where cloud sync v2 keeps its own state in `chrome.storage.local` (spec 8.1, 8.2): the key
 * names, the guards that read them back, the account lock and the compare-and-write helpers, and
 * the upgrade from the v1 keys. It imports nothing from a repository, so every repository and the
 * engine can import it without a cycle.
 *
 * - `cloudAccountV2`, `cloudKeyV2`, `cloudOwnerV2`: written here and in `cloud-auth.ts`, always under
 *   the account lock (`tabinet:cloud-account`), never held while another lock or a request waits.
 * - `cloudSyncMetaV2` and `cloudRaw:*`: written by the sync bookkeeping under the sessions lock.
 */
import { isCloudSyncEnabled } from '@/lib/cloud-config';
import type { CloudAccountV2, CloudKeyV2, CloudOwnerV2 } from '@/types';

export const CLOUD_ACCOUNT_KEY = 'cloudAccountV2';
export const CLOUD_KEY_KEY = 'cloudKeyV2';
export const CLOUD_OWNER_KEY = 'cloudOwnerV2';
export const CLOUD_SYNC_META_KEY = 'cloudSyncMetaV2';
/** `cloudRaw:<kind>:<recordId>`: the raw record of a held item (8.3). */
export const CLOUD_RAW_PREFIX = 'cloudRaw:';
/** The v1 keys the upgrade removes. */
export const LEGACY_CLOUD_KEYS = ['cloudAccount', 'cloudSyncKey', 'cloudSyncMeta'] as const;
/** Guards the three account keys. */
export const ACCOUNT_LOCK_NAME = 'tabinet:cloud-account';

export function cloudRawKey(kind: string, recordId: string): string {
  return `${CLOUD_RAW_PREFIX}${kind}:${recordId}`;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

const ID = /^[A-Za-z0-9_-]{1,64}$/;

export function isCloudAccountV2(value: unknown): value is CloudAccountV2 {
  return (
    isObject(value) &&
    typeof value.accountId === 'string' &&
    value.accountId !== '' &&
    typeof value.token === 'string' &&
    value.token !== '' &&
    typeof value.expiresAt === 'number' &&
    Number.isFinite(value.expiresAt) &&
    typeof value.email === 'string' &&
    typeof value.uploadConfirmed === 'boolean'
  );
}

export function isCloudKeyV2(value: unknown): value is CloudKeyV2 {
  return (
    isObject(value) &&
    typeof value.accountId === 'string' &&
    value.accountId !== '' &&
    typeof value.keyId === 'string' &&
    ID.test(value.keyId) &&
    typeof value.generation === 'number' &&
    Number.isInteger(value.generation) &&
    value.generation >= 1 &&
    typeof value.dek === 'string' &&
    value.dek !== ''
  );
}

export function isCloudOwnerV2(value: unknown): value is CloudOwnerV2 {
  return (
    isObject(value) &&
    (value.accountId === null || (typeof value.accountId === 'string' && value.accountId !== '')) &&
    typeof value.email === 'string' &&
    (value.legacy === undefined || value.legacy === true)
  );
}

/** The three account keys as stored; a damaged value reads as absent. */
export interface CloudStored {
  account: CloudAccountV2 | null;
  key: CloudKeyV2 | null;
  owner: CloudOwnerV2 | null;
}

export function cloudStoredFrom(raw: Record<string, unknown>): CloudStored {
  const account: unknown = raw[CLOUD_ACCOUNT_KEY];
  const key: unknown = raw[CLOUD_KEY_KEY];
  const owner: unknown = raw[CLOUD_OWNER_KEY];
  return {
    account: isCloudAccountV2(account) ? account : null,
    key: isCloudKeyV2(key) ? key : null,
    owner: isCloudOwnerV2(owner) ? owner : null,
  };
}

export async function readCloudStored(): Promise<CloudStored> {
  return cloudStoredFrom(
    await chrome.storage.local.get([CLOUD_ACCOUNT_KEY, CLOUD_KEY_KEY, CLOUD_OWNER_KEY]),
  );
}

// The extension's name before Tabinet. Kept: a lock name is shared by every page and the worker,
// so renaming it would let an old page and a new worker write at once during an update.
export const SESSIONS_LOCK_NAME = 'tab-organizer:sessions';

// Fallback serialization for runtimes without Web Locks (page-local only), one chain per lock.
let fallbackChain: Promise<unknown> = Promise.resolve();
let sessionsFallbackChain: Promise<unknown> = Promise.resolve();

/**
 * Runs `fn` under the sessions lock, shared by the worker and every page: sessions and all of
 * sync's bookkeeping (`cloudSyncMetaV2`, `cloudRaw:*`) are written only inside it.
 */
export function withSessionsLock<T>(fn: () => Promise<T>): Promise<T> {
  const locks = typeof navigator === 'undefined' ? undefined : navigator.locks;
  if (locks === undefined) {
    const run = sessionsFallbackChain.then(fn, fn);
    sessionsFallbackChain = run.catch(() => undefined);
    return run;
  }
  return new Promise<T>((resolve, reject) => {
    locks
      .request(SESSIONS_LOCK_NAME, async () => {
        try {
          resolve(await fn());
        } catch (err) {
          reject(err);
        }
      })
      .catch(reject);
  });
}

/** Runs `fn` under the account lock. Never call a request or another lock inside it. */
export function withAccountLock<T>(fn: () => Promise<T>): Promise<T> {
  const locks = typeof navigator === 'undefined' ? undefined : navigator.locks;
  if (locks === undefined) {
    const run = fallbackChain.then(fn, fn);
    fallbackChain = run.catch(() => undefined);
    return run;
  }
  return locks.request(ACCOUNT_LOCK_NAME, fn);
}

/**
 * One `set` of `entries` (a `null` value deletes, invariant 12), then the cleanup `remove` of
 * those `null` keys. A crash between the two changes nothing a reader sees.
 */
export async function setThenClean(entries: Record<string, unknown>): Promise<void> {
  if (Object.keys(entries).length === 0) {
    return;
  }
  await chrome.storage.local.set(entries);
  const removed = Object.keys(entries).filter((key) => entries[key] === null);
  if (removed.length > 0) {
    await chrome.storage.local.remove(removed);
  }
}

/**
 * Under the account lock: writes `entries` only while the stored account still has `token` (or,
 * with `token` `null`, while none is stored). Whether it wrote. A late result of an operation the
 * person signed out of, or that another account replaced, writes nothing.
 */
export async function writeIfAccount(
  token: string | null,
  entries: (stored: CloudStored) => Record<string, unknown> | null,
): Promise<boolean> {
  return withAccountLock(async () => {
    const stored = await readCloudStored();
    if ((stored.account?.token ?? null) !== token) {
      return false;
    }
    const next = entries(stored);
    if (next === null) {
      return false;
    }
    await setThenClean(next);
    return true;
  });
}

/** Removes the account only while its token is still `token` (a 401, an expiry). */
export async function removeAccountIfToken(token: string): Promise<boolean> {
  return writeIfAccount(token, () => ({ [CLOUD_ACCOUNT_KEY]: null }));
}

/**
 * The upgrade from 8.3 and 9.x (spec 8.2), idempotent, under the account lock. When a v1 key is
 * present: the email it names (the v1 account's, else the v1 bookkeeping's `owner`) becomes the
 * owner unless one is stored, and the three v1 keys go, in the same `set`. Nothing else is read or
 * kept: v1's bearer, key, cursor and pending lists went with the wiped cloud. Reads nothing while
 * cloud sync is unconfigured.
 */
export async function upgradeCloudStorage(): Promise<boolean> {
  if (!isCloudSyncEnabled()) {
    return false;
  }
  return withAccountLock(async () => {
    const raw = await chrome.storage.local.get([...LEGACY_CLOUD_KEYS, CLOUD_OWNER_KEY]);
    if (!LEGACY_CLOUD_KEYS.some((key) => raw[key] !== undefined)) {
      return false;
    }
    const entries: Record<string, unknown> = {};
    for (const key of LEGACY_CLOUD_KEYS) {
      entries[key] = null;
    }
    const email = legacyEmail(raw.cloudAccount, raw.cloudSyncMeta);
    if (email !== undefined && !isCloudOwnerV2(raw[CLOUD_OWNER_KEY])) {
      const owner: CloudOwnerV2 = { accountId: null, email, legacy: true };
      entries[CLOUD_OWNER_KEY] = owner;
    }
    await setThenClean(entries);
    return true;
  });
}

/**
 * `chrome.storage.local` for trusted contexts only (spec 8.4), where the API exists (Chrome 140+).
 * Started without waiting; a refusal (Chrome 123 to 139) or a throw is ignored.
 */
export function restrictStorageAccess(): void {
  const local = chrome.storage.local as chrome.storage.LocalStorageArea & {
    setAccessLevel?: (options: { accessLevel: string }) => Promise<void>;
  };
  if (typeof local.setAccessLevel !== 'function') {
    return;
  }
  try {
    local.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' }).catch(() => undefined);
  } catch {
    // Refused at once: nothing to do.
  }
}

/** The email the v1 keys name, if any. Pure. */
export function legacyEmail(account: unknown, meta: unknown): string | undefined {
  if (isObject(account) && typeof account.email === 'string' && account.email !== '') {
    return account.email;
  }
  if (isObject(meta) && typeof meta.owner === 'string' && meta.owner !== '') {
    return meta.owner;
  }
  return undefined;
}
