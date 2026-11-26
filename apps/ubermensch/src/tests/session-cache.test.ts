import { describe, expect, it } from 'vitest';

import { cacheKey, clearCache, isFresh, readCache, writeCache } from '@/lib/session-cache';

import { getChromeFake } from './setup';

const isString = (value: unknown): value is string => typeof value === 'string';

describe('isFresh', () => {
  it('is fresh only inside the lifetime, and never from the future', () => {
    expect(isFresh(1000, 1000, 10)).toBe(true);
    expect(isFresh(1000, 1009, 10)).toBe(true);
    expect(isFresh(1000, 1010, 10)).toBe(false);
    expect(isFresh(2000, 1000, 10)).toBe(false);
  });
});

describe('the session cache', () => {
  it('reads back what it wrote until it expires', async () => {
    const key = cacheKey('folder', 'e.kim@example.com', 'F1');
    expect(key).toBe('cache:folder:e.kim@example.com:F1');
    await writeCache(key, 'Projects', 1000);
    expect(await readCache(key, 100, 1050, isString)).toBe('Projects');
    expect(await readCache(key, 100, 1100, isString)).toBeUndefined();
  });

  it('treats a malformed entry as absent', async () => {
    await chrome.storage.session.set({
      'cache:file:u.0:x': { value: 3, storedAt: 1 },
      'cache:file:u.0:y': 'junk',
    });
    expect(await readCache('cache:file:u.0:x', 100, 2, isString)).toBeUndefined();
    expect(await readCache('cache:file:u.0:y', 100, 2, isString)).toBeUndefined();
  });

  it('clears everything, or one account, and never touches tokens', async () => {
    await writeCache(cacheKey('file', 'u.0', 'a'), 'A', 1);
    await writeCache(cacheKey('file', 'u.1', 'b'), 'B', 1);
    await chrome.storage.session.set({ 'token:u.0': 'kept' });
    await clearCache('u.0');
    expect([...getChromeFake().state.session.keys()].sort()).toEqual([
      'cache:file:u.1:b',
      'token:u.0',
    ]);
    await clearCache();
    expect([...getChromeFake().state.session.keys()]).toEqual(['token:u.0']);
  });
});
