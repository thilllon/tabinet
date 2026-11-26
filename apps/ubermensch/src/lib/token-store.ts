import { POLICY } from '@/constants';
import type { AccountHint, StoredToken } from '@/types';

/**
 * Google access tokens, one per account, in `chrome.storage.session` only: in memory, gone when
 * Chrome closes, never synced, and not readable by the content script. Each token is kept under
 * the account's address and, when the page named one, its `/u/<n>/` index as well, so a page that
 * gives only the index still finds it.
 */

const TOKEN_PREFIX = 'token:';

/**
 * The account a request is for: `e.<address>` when the page showed one, else `u.<index>`
 * (`u.0` for an address without an index). No colon, so it can sit inside a cache key.
 */
export function accountKey(hint: AccountHint): string {
  const email = hint.email?.trim().toLowerCase();
  if (email !== undefined && email !== '') {
    return `e.${email}`;
  }
  return `u.${hint.index ?? 0}`;
}

/** Every key a token for `email`, signed in from a page described by `hint`, is stored under. */
export function tokenKeysFor(email: string, hint: AccountHint): string[] {
  const keys = new Set([accountKey({ email }), accountKey({ index: hint.index })]);
  return [...keys];
}

/** Whether a token may still be used at `now` (not within the safety margin of its expiry). */
export function isTokenLive(token: StoredToken, now: number): boolean {
  return token.expiresAt - POLICY.auth.expiryMarginMs > now;
}

export function isStoredToken(value: unknown): value is StoredToken {
  return (
    typeof value === 'object' &&
    value !== null &&
    'accessToken' in value &&
    typeof value.accessToken === 'string' &&
    value.accessToken !== '' &&
    'expiresAt' in value &&
    typeof value.expiresAt === 'number' &&
    'email' in value &&
    typeof value.email === 'string'
  );
}

/** The live token for `account`, or `undefined`; an expired one is removed. */
export async function readToken(account: string, now: number): Promise<StoredToken | undefined> {
  const key = TOKEN_PREFIX + account;
  const stored = await chrome.storage.session.get(key);
  const token: unknown = stored[key];
  if (!isStoredToken(token)) {
    return undefined;
  }
  if (!isTokenLive(token, now)) {
    await chrome.storage.session.remove(key);
    return undefined;
  }
  return token;
}

export async function saveToken(accounts: string[], token: StoredToken): Promise<void> {
  await chrome.storage.session.set(
    Object.fromEntries(accounts.map((account) => [TOKEN_PREFIX + account, token])),
  );
}

/** Forgets a token everywhere it is stored (a 401, or sign-out). Returns the accounts it was under. */
export async function dropToken(accessToken: string): Promise<string[]> {
  const all = await chrome.storage.session.get(null);
  const keys = Object.entries(all)
    .filter(
      ([key, value]) =>
        key.startsWith(TOKEN_PREFIX) && isStoredToken(value) && value.accessToken === accessToken,
    )
    .map(([key]) => key);
  if (keys.length > 0) {
    await chrome.storage.session.remove(keys);
  }
  return keys.map((key) => key.slice(TOKEN_PREFIX.length));
}

/** The signed-in accounts, one entry per address, for the options page. */
export async function listTokens(now: number): Promise<StoredToken[]> {
  const all = await chrome.storage.session.get(null);
  const byEmail = new Map<string, StoredToken>();
  for (const [key, value] of Object.entries(all)) {
    if (key.startsWith(TOKEN_PREFIX) && isStoredToken(value) && isTokenLive(value, now)) {
      byEmail.set(value.email.toLowerCase(), value);
    }
  }
  return [...byEmail.values()].sort((a, b) => a.email.localeCompare(b.email));
}

/** Whether a storage change touched a token (the options page re-reads then). */
export function touchesTokens(changes: Record<string, unknown>): boolean {
  return Object.keys(changes).some((key) => key.startsWith(TOKEN_PREFIX));
}
