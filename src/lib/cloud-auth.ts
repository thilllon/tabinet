/**
 * The cloud sync account on this device (spec section 9): Google sign-in through
 * `chrome.identity`, the account question, the sync passphrase (create, unlock, change, which is
 * also the reset of a forgotten one), sign-out and deletion, and the pure state Settings shows.
 * Page only: every key operation starts from a click.
 *
 * Every key operation validates its form first, then asks Chrome for a Google access token from
 * that click, does the slow work (PBKDF2) and the request, and drops the token from Chrome's cache
 * in `finally`. The token lives in that function only. Every store after an await is a
 * compare-and-write against the bearer the operation started with (`writeIfAccount()`), so a
 * sign-out or another account meanwhile makes its late result write nothing. A closed or refused
 * consent window is `{ outcome: 'cancelled' }`, never a throw. Only sign-out, a confirmed deletion
 * and a confirmed replacement remove a data key (invariant 9).
 */
import { GOOGLE_OAUTH_SCOPES, POLICY } from '@/constants';
import {
  authGoogle,
  type CloudApiOptions,
  CloudHttpError,
  CloudUnauthorizedError,
  deleteAccount,
  logout,
  me,
  type MeAnswer,
  openKey,
  putKey,
} from '@/lib/cloud-api';
import { createKey, rewrapKey, unwrapKey } from '@/lib/cloud-crypto';
import {
  CLOUD_ACCOUNT_KEY,
  CLOUD_KEY_KEY,
  CLOUD_OWNER_KEY,
  readCloudStored,
  removeAccountIfToken,
  writeIfAccount,
} from '@/lib/cloud-storage';
import { dropSyncMetaFor } from '@/lib/cloud-sync-state';
import { ExplainedError } from '@/lib/error-message';
import type { AccountInput, AccountState, CloudAccountV2, CloudKeyV2, CloudOwnerV2 } from '@/types';

export type Cancelled = { outcome: 'cancelled' };

// ---------------------------------------------------------------------------
// Pure
// ---------------------------------------------------------------------------

/** What Settings > Account shows (9.1). Pure. */
export function accountState(input: AccountInput): AccountState {
  if (!input.configured) {
    return 'unconfigured';
  }
  if (!input.loaded) {
    return 'loading';
  }
  const { account, key, server } = input;
  if (account === null || account.expiresAt <= input.now) {
    return key === null ? 'signedOut' : 'expired';
  }
  if (!account.uploadConfirmed) {
    return 'confirmAccount';
  }
  if (key !== null && key.accountId === account.accountId) {
    if (server !== undefined && (server === null || server.keyId !== key.keyId)) {
      return 'keyMismatch';
    }
    return 'ready';
  }
  if (server === undefined) {
    return 'unknown';
  }
  return server === null ? 'needsCreate' : 'needsUnlock';
}

/** Why a new passphrase is refused, after NFC, or `null`. Pure. */
export function newPassphraseProblem(
  passphrase: string,
  repeated: string,
): 'empty' | 'short' | 'mismatch' | null {
  const nfc = passphrase.normalize('NFC');
  if (nfc === '') {
    return 'empty';
  }
  if ([...nfc].length < POLICY.passphrase.minLength) {
    return 'short';
  }
  return nfc === repeated.normalize('NFC') ? null : 'mismatch';
}

/**
 * Whether the upload to a just signed-in account is confirmed without asking: no owner, the
 * owner's account, or a legacy owner (no account id) with the same email, ignoring case. Pure.
 */
export function uploadConfirmedFor(
  owner: CloudOwnerV2 | null,
  accountId: string,
  email: string,
): boolean {
  if (owner === null || owner.accountId === accountId) {
    return true;
  }
  return owner.accountId === null && owner.email.toLowerCase() === email.toLowerCase();
}

/**
 * Whether a `chrome.identity.getAuthToken` failure is the person closing or turning down Chrome's
 * consent window ("The user did not approve access."), which is not an error to report.
 */
export function isSignInCancelled(err: unknown): boolean {
  const message = err instanceof Error ? err.message.toLowerCase() : '';
  return message.includes('did not approve') || /\bcancel(l?ed)?\b/.test(message);
}

// ---------------------------------------------------------------------------
// Google
// ---------------------------------------------------------------------------

/** A Google access token from this click, or `null` when the window was closed or refused. */
async function googleToken(): Promise<string | null> {
  let token: string | undefined;
  try {
    const answer = await chrome.identity.getAuthToken({
      interactive: true,
      scopes: [...GOOGLE_OAUTH_SCOPES],
    });
    token = answer.token;
  } catch (err: unknown) {
    if (isSignInCancelled(err)) {
      return null;
    }
    const reason = err instanceof Error ? err.name : 'unknown';
    throw new ExplainedError(`getAuthToken failed (${reason})`, 'errorCloudSignInFailed');
  }
  if (token === undefined || token === '') {
    throw new ExplainedError('getAuthToken answered without a token', 'errorCloudSignInFailed');
  }
  return token;
}

async function dropGoogleToken(token: string): Promise<void> {
  try {
    await chrome.identity.removeCachedAuthToken({ token });
  } catch {
    console.warn('[tabinet] could not drop the Google token from the cache');
  }
}

/**
 * Forgets this extension's Google grant and Chrome's account choice for it, so the next request
 * asks again and another account can be picked. Behind a `typeof` guard (`identity` exists only
 * with the permission); best effort.
 */
export async function forgetGoogleGrant(): Promise<void> {
  if (typeof chrome.identity?.clearAllCachedAuthTokens !== 'function') {
    return;
  }
  try {
    await chrome.identity.clearAllCachedAuthTokens();
  } catch {
    console.warn('[tabinet] could not clear the Google token cache');
  }
}

/** Runs `work` with a Google token from this click, dropping the token whatever happens. */
async function withGoogle<T>(work: (accessToken: string) => Promise<T>): Promise<T | Cancelled> {
  const accessToken = await googleToken();
  if (accessToken === null) {
    return { outcome: 'cancelled' };
  }
  try {
    return await work(accessToken);
  } finally {
    await dropGoogleToken(accessToken);
  }
}

// ---------------------------------------------------------------------------
// Stored state
// ---------------------------------------------------------------------------

export async function loadCloudState(): Promise<{
  account: CloudAccountV2 | null;
  key: CloudKeyV2 | null;
  owner: CloudOwnerV2 | null;
}> {
  return readCloudStored();
}

async function liveAccount(): Promise<CloudAccountV2> {
  const { account } = await readCloudStored();
  if (account === null || account.expiresAt <= Date.now()) {
    throw new CloudUnauthorizedError('local');
  }
  return account;
}

/**
 * What a failed request means for the stored state: a 401 removes that bearer's account (only
 * while it is still the stored one), a `google_account_mismatch` clears Chrome's choice. Nothing
 * else is written, and a data key is never removed here. The error is thrown on.
 */
async function reactTo(err: unknown, token: string): Promise<never> {
  if (err instanceof CloudUnauthorizedError) {
    await removeAccountIfToken(token);
  } else if (err instanceof CloudHttpError && err.code === 'google_account_mismatch') {
    await forgetGoogleGrant();
  }
  throw err;
}

/** Runs `request` for `account`, reacting to what its failure means (`reactTo()`). */
async function guarded<T>(account: CloudAccountV2, request: () => Promise<T>): Promise<T> {
  try {
    return await request();
  } catch (err: unknown) {
    return reactTo(err, account.token);
  }
}

/** Removes the account when it has expired, compare-and-remove (9.2, expiry). */
export async function forgetExpiredAccount(now: number = Date.now()): Promise<void> {
  const { account } = await readCloudStored();
  if (account !== null && account.expiresAt <= now) {
    await removeAccountIfToken(account.token);
  }
}

// ---------------------------------------------------------------------------
// Actions (9.2)
// ---------------------------------------------------------------------------

/** Signs in: the account is written with whether its upload is confirmed. Nothing else is. */
export async function signIn(
  options: CloudApiOptions = {},
): Promise<{ outcome: 'signedIn'; server: MeAnswer['key'] } | Cancelled> {
  const result = await withGoogle(async (accessToken) => {
    const answer = await authGoogle(accessToken, options);
    const { owner } = await readCloudStored();
    const account: CloudAccountV2 = {
      accountId: answer.accountId,
      token: answer.token,
      expiresAt: answer.expiresAt,
      email: answer.email,
      uploadConfirmed: uploadConfirmedFor(owner, answer.accountId, answer.email),
    };
    const { account: before } = await readCloudStored();
    await writeIfAccount(before?.token ?? null, () => ({ [CLOUD_ACCOUNT_KEY]: account }));
    return answer.key;
  });
  if (isCancelled(result)) {
    return result;
  }
  return { outcome: 'signedIn', server: result };
}

function isCancelled(value: unknown): value is Cancelled {
  return (
    typeof value === 'object' &&
    value !== null &&
    (value as { outcome?: unknown }).outcome === 'cancelled'
  );
}

/** "Add to this account": the upload is confirmed. Nothing is uploaded before Create or Unlock. */
export async function confirmAccount(): Promise<void> {
  const account = await liveAccount();
  await writeIfAccount(account.token, (stored) =>
    stored.account === null
      ? null
      : { [CLOUD_ACCOUNT_KEY]: { ...stored.account, uploadConfirmed: true } },
  );
}

/** "No, keep it here": the sign-in is cancelled. Key, owner and bookkeeping are kept. */
export async function cancelAccountSwitch(options: CloudApiOptions = {}): Promise<void> {
  const { account } = await readCloudStored();
  if (account !== null) {
    try {
      await logout(account.token, options);
    } catch {
      console.warn('[tabinet] logout not confirmed by the server');
    }
    await removeAccountIfToken(account.token);
  }
  await forgetGoogleGrant();
}

/**
 * Creates the sync passphrase: a new data key, its envelope at generation 1, the PUT, and only
 * after the 201 the key and the owner in one write. 409 `key_exists`, or an answer lost when the
 * server then has a key, is `'exists'`: the person enters that passphrase.
 */
export async function createPassphrase(
  passphrase: string,
  options: CloudApiOptions = {},
): Promise<{ outcome: 'created' } | { outcome: 'exists' } | Cancelled> {
  const result = await withGoogle(async (accessToken) => {
    const account = await liveAccount();
    const { dek, keyId, envelope, proof } = await createKey(passphrase);
    try {
      await guarded(account, () => putKey(account.token, accessToken, envelope, proof, options));
    } catch (err: unknown) {
      if (err instanceof CloudHttpError && err.code === 'key_exists') {
        return 'exists' as const;
      }
      if (!(err instanceof CloudHttpError)) {
        // The answer was lost: the server may have the key now. Never stored without the 201.
        const answer = await guarded(account, () => me(account.token, options)).catch(() => null);
        if (answer?.key != null) {
          return 'exists' as const;
        }
      }
      throw err;
    }
    const key: CloudKeyV2 = { accountId: account.accountId, keyId, generation: 1, dek };
    const owner: CloudOwnerV2 = { accountId: account.accountId, email: account.email };
    const written = await writeIfAccount(account.token, () => ({
      [CLOUD_KEY_KEY]: key,
      [CLOUD_OWNER_KEY]: owner,
    }));
    if (!written) {
      throw new CloudUnauthorizedError('local');
    }
    return 'created' as const;
  });
  return isCancelled(result) ? result : { outcome: result };
}

/**
 * Unlocks with the passphrase: me, then the envelope after a Google check, both checked
 * (same keyId, a generation at least me's), unwrapped and its keyId checked. A wrong passphrase
 * writes nothing. The right one stores key and owner in one write, replacing an old key.
 */
export async function unlockWithPassphrase(
  passphrase: string,
  options: CloudApiOptions = {},
): Promise<{ outcome: 'unlocked' } | { outcome: 'wrongPassphrase' } | Cancelled> {
  const result = await withGoogle(async (accessToken) => {
    const account = await liveAccount();
    const answer = await guarded(account, () => me(account.token, options));
    const envelope = await guarded(account, () => openKey(account.token, accessToken, options));
    if (
      answer.key === null ||
      envelope.keyId !== answer.key.keyId ||
      envelope.generation < answer.key.generation
    ) {
      throw new ExplainedError(
        'The envelope does not match the account key',
        'errorCloudKeyChanged',
      );
    }
    const dek = await unwrapKey(envelope, passphrase);
    if (dek === null) {
      return 'wrongPassphrase' as const;
    }
    const key: CloudKeyV2 = {
      accountId: account.accountId,
      keyId: envelope.keyId,
      generation: Math.max(envelope.generation, answer.key.generation),
      dek,
    };
    const owner: CloudOwnerV2 = { accountId: account.accountId, email: account.email };
    const written = await writeIfAccount(account.token, () => ({
      [CLOUD_KEY_KEY]: key,
      [CLOUD_OWNER_KEY]: owner,
    }));
    if (!written) {
      throw new CloudUnauthorizedError('local');
    }
    return 'unlocked' as const;
  });
  return isCancelled(result) ? result : { outcome: result };
}

/**
 * Changes the passphrase from a ready device, which is also the reset of a forgotten one: the
 * same data key under a new envelope at me's generation + 1, with the write proof. The stored
 * generation becomes the confirmed one the PUT returned (not a maximum), which ends a rollback
 * warning. The old passphrase is never asked.
 */
export async function changePassphrase(
  passphrase: string,
  options: CloudApiOptions = {},
): Promise<{ outcome: 'changed'; generation: number } | { outcome: 'conflict' } | Cancelled> {
  const result = await withGoogle(async (accessToken) => {
    const account = await liveAccount();
    const { key } = await readCloudStored();
    if (key === null || key.accountId !== account.accountId) {
      throw new ExplainedError('No data key of this account here', 'errorCloudKeyChanged');
    }
    const answer = await guarded(account, () => me(account.token, options));
    if (answer.key === null || answer.key.keyId !== key.keyId) {
      throw new ExplainedError('The account has another key', 'errorCloudKeyChanged');
    }
    const generation = answer.key.generation + 1;
    const { envelope, proof } = await rewrapKey(key.dek, passphrase, generation);
    let confirmed: number;
    try {
      const put = await guarded(account, () =>
        putKey(account.token, accessToken, envelope, proof, options),
      );
      confirmed = put.key.generation;
    } catch (err: unknown) {
      if (err instanceof CloudHttpError && err.code === 'generation_conflict') {
        return { outcome: 'conflict' } as const;
      }
      throw err;
    }
    await writeIfAccount(account.token, (stored) =>
      stored.key === null || stored.key.keyId !== key.keyId
        ? null
        : { [CLOUD_KEY_KEY]: { ...stored.key, generation: confirmed } },
    );
    return { outcome: 'changed', generation: confirmed } as const;
  });
  return result;
}

/**
 * Signs out: the server forgets the bearer when it can; the account goes, and the key when it is
 * this account's (always when the account is no longer live). Owner, bookkeeping and held items
 * stay.
 */
export async function signOut(options: CloudApiOptions = {}): Promise<void> {
  const { account } = await readCloudStored();
  if (account !== null) {
    try {
      await logout(account.token, options);
    } catch {
      console.warn('[tabinet] sign-out not confirmed by the server');
    }
  }
  await writeIfAccount(account?.token ?? null, (stored) => {
    const entries: Record<string, unknown> = { [CLOUD_ACCOUNT_KEY]: null };
    const live = stored.account !== null && stored.account.expiresAt > Date.now();
    if (stored.key !== null && (!live || stored.key.accountId === stored.account?.accountId)) {
      entries[CLOUD_KEY_KEY] = null;
    }
    return entries;
  });
  await forgetGoogleGrant();
}

/**
 * Deletes the account and everything on the server, after a Google check. Only after the 204:
 * the account goes; when the key or the owner is this account's, the key goes, the owner becomes
 * `{ accountId: null, email }` and the bookkeeping and every raw copy are dropped.
 */
export async function deleteCloudData(
  options: CloudApiOptions = {},
): Promise<{ outcome: 'deleted' } | Cancelled> {
  const result = await withGoogle(async (accessToken) => {
    const account = await liveAccount();
    await guarded(account, () => deleteAccount(account.token, accessToken, options));
    let dropMeta = false;
    await writeIfAccount(account.token, (stored) => {
      const entries: Record<string, unknown> = { [CLOUD_ACCOUNT_KEY]: null };
      const keyMine = stored.key?.accountId === account.accountId;
      const ownerMine = stored.owner?.accountId === account.accountId;
      if (keyMine || ownerMine) {
        dropMeta = true;
        if (keyMine) {
          entries[CLOUD_KEY_KEY] = null;
        }
        const owner: CloudOwnerV2 = { accountId: null, email: account.email };
        entries[CLOUD_OWNER_KEY] = owner;
      }
      return entries;
    });
    if (dropMeta) {
      await dropSyncMetaFor(account.accountId);
    }
    return 'deleted' as const;
  });
  await forgetGoogleGrant();
  return isCancelled(result) ? result : { outcome: result };
}

/**
 * Reads me for the stored account: a higher generation raises the stored one (not a reason to
 * sync), a lower one is reported as a rollback and changes nothing. A 401 removes that bearer.
 */
export async function refreshMe(
  account: CloudAccountV2,
  options: CloudApiOptions = {},
): Promise<{ answer: MeAnswer; rollback: boolean }> {
  const answer = await guarded(account, () => me(account.token, options));
  let rollback = false;
  const server = answer.key;
  if (server !== null) {
    await writeIfAccount(account.token, (stored) => {
      const key = stored.key;
      if (key === null || key.accountId !== account.accountId || key.keyId !== server.keyId) {
        return null;
      }
      if (server.generation < key.generation) {
        rollback = true;
        return null;
      }
      return server.generation > key.generation
        ? { [CLOUD_KEY_KEY]: { ...key, generation: server.generation } }
        : null;
    });
  }
  return { answer, rollback };
}
