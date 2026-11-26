import { describe, expect, it } from 'vitest';

import { POLICY } from '@/constants';
import {
  accountKey,
  dropToken,
  isTokenLive,
  listTokens,
  readToken,
  saveToken,
  tokenKeysFor,
} from '@/lib/token-store';
import type { StoredToken } from '@/types';

import { getChromeFake } from './setup';

const token = (accessToken: string, email: string, expiresAt = 1_000_000): StoredToken => ({
  accessToken,
  email,
  expiresAt,
});

describe('account keys', () => {
  it('prefers the address, lowercased, else the index', () => {
    expect(accountKey({ email: ' Kim@Example.com ', index: 1 })).toBe('e.kim@example.com');
    expect(accountKey({ index: 2 })).toBe('u.2');
    expect(accountKey({})).toBe('u.0');
    expect(accountKey({ email: '' })).toBe('u.0');
  });

  it('stores a token under the address and the page index', () => {
    expect(tokenKeysFor('kim@example.com', { index: 1 })).toEqual(['e.kim@example.com', 'u.1']);
    expect(tokenKeysFor('kim@example.com', {})).toEqual(['e.kim@example.com', 'u.0']);
  });
});

describe('the token store', () => {
  it('expires a token a margin before Google does, and removes it on read', async () => {
    const t = token('a', 'kim@example.com', 100_000);
    expect(isTokenLive(t, 100_000 - POLICY.auth.expiryMarginMs - 1)).toBe(true);
    expect(isTokenLive(t, 100_000 - POLICY.auth.expiryMarginMs)).toBe(false);
    await saveToken(['u.0'], t);
    expect(await readToken('u.0', 0)).toEqual(t);
    expect(await readToken('u.0', 100_000)).toBeUndefined();
    expect(getChromeFake().state.session.has('token:u.0')).toBe(false);
  });

  it('drops a token from every key it was stored under', async () => {
    await saveToken(['e.kim@example.com', 'u.1'], token('a', 'kim@example.com'));
    await saveToken(['u.2'], token('b', 'lee@example.com'));
    expect((await dropToken('a')).sort()).toEqual(['e.kim@example.com', 'u.1']);
    expect([...getChromeFake().state.session.keys()]).toEqual(['token:u.2']);
  });

  it('lists each address once, live tokens only', async () => {
    await saveToken(['e.kim@example.com', 'u.1'], token('a', 'kim@example.com'));
    await saveToken(['u.2'], token('b', 'lee@example.com', 10));
    expect(await listTokens(0)).toEqual([token('a', 'kim@example.com')]);
  });

  it('ignores something that is not a token', async () => {
    await chrome.storage.session.set({
      'token:u.0': { accessToken: '', email: 'x', expiresAt: 1e12 },
    });
    expect(await readToken('u.0', 0)).toBeUndefined();
  });
});
