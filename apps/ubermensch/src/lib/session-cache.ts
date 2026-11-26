/**
 * A short-lived cache in `chrome.storage.session`: kept in memory by Chrome, cleared when the
 * browser closes, never written to disk and (at the default access level) not readable by content
 * scripts. Keys start with `cache:` so Clear cache and sign-out can find them.
 */

export const CACHE_PREFIX = 'cache:';

export interface CacheEntry<T> {
  value: T;
  /** Epoch milliseconds when it was stored. */
  storedAt: number;
}

/** Whether an entry stored at `storedAt` may still be used at `now`. A clock that went back is not trusted. */
export function isFresh(storedAt: number, now: number, ttlMs: number): boolean {
  return storedAt <= now && now - storedAt < ttlMs;
}

/** `cache:<area>:<account>:<id>`: what one account sees of one file is its own. */
export function cacheKey(
  area: 'file' | 'folder' | 'drive' | 'root',
  account: string,
  id: string,
): string {
  return `${CACHE_PREFIX}${area}:${account}:${id}`;
}

function isEntry(value: unknown): value is CacheEntry<unknown> {
  return (
    typeof value === 'object' &&
    value !== null &&
    'storedAt' in value &&
    typeof value.storedAt === 'number' &&
    'value' in value
  );
}

/**
 * The cached value for `key` when it is fresh and passes `guard`; a stale or malformed entry reads
 * as absent (and is left for the next write to replace).
 */
export async function readCache<T>(
  key: string,
  ttlMs: number,
  now: number,
  guard: (value: unknown) => value is T,
): Promise<T | undefined> {
  const stored = await chrome.storage.session.get(key);
  const entry: unknown = stored[key];
  if (!isEntry(entry) || !isFresh(entry.storedAt, now, ttlMs) || !guard(entry.value)) {
    return undefined;
  }
  return entry.value;
}

export async function writeCache<T>(key: string, value: T, now: number): Promise<void> {
  const entry: CacheEntry<T> = { value, storedAt: now };
  await chrome.storage.session.set({ [key]: entry });
}

/** Removes every cached entry, or only one account's when `account` is given. */
export async function clearCache(account?: string): Promise<void> {
  const all = await chrome.storage.session.get(null);
  const keys = Object.keys(all).filter(
    (key) =>
      key.startsWith(CACHE_PREFIX) && (account === undefined || key.split(':')[2] === account),
  );
  if (keys.length > 0) {
    await chrome.storage.session.remove(keys);
  }
}
