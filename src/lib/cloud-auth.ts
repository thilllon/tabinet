/**
 * The cloud sync account on this device: Google sign-in through `chrome.identity`, the stored
 * account (`cloudAccount`) and sync key (`cloudSyncKey`) in `chrome.storage.local`, the sync
 * passphrase, and the state Settings shows. Page only: sign-in needs a click, and nothing here is
 * loaded by the service worker. Neither key is session data, so they are written here rather
 * than through `sessionRepo`; signing out or deleting the cloud data never touches a session.
 */
import { GOOGLE_OAUTH_SCOPES, POLICY } from '@/constants';
import {
  type CloudApiOptions,
  type CloudSignInResult,
  CloudUnauthorizedError,
  authGoogle,
  deleteAccount,
  logout,
  putKeys,
} from '@/lib/cloud-api';
import { createKeySetup, keyMatchesSetup, unlockKeySetup } from '@/lib/cloud-crypto';
import { ExplainedError } from '@/lib/error-message';
import { isRecord } from '@/lib/import-guards';
import type { CloudAccount, CloudKeySetup } from '@/types';

/** `chrome.storage.local` key of the signed-in account. */
export const CLOUD_ACCOUNT_KEY = 'cloudAccount';
/** `chrome.storage.local` key of the raw sync key (base64). Never sent anywhere. */
export const CLOUD_SYNC_KEY = 'cloudSyncKey';

/** What Settings > Account shows. */
export type AccountState =
  | 'unconfigured'
  | 'signedOut'
  | 'needsPassphrase'
  | 'needsUnlock'
  | 'ready';

export function isCloudAccount(value: unknown): value is CloudAccount {
  return (
    isRecord(value) &&
    typeof value.token === 'string' &&
    value.token !== '' &&
    typeof value.expiresAt === 'number' &&
    typeof value.email === 'string'
  );
}

/**
 * The state for what is known: whether sync is configured, the stored account, whether this device
 * holds a key for the server's setup, and that setup (`undefined` while it is not known yet).
 * 'ready' needs both halves: a setup on the server and its key here, so a key is never trusted
 * before the server's setup is known (`keepSyncKeyFor()` drops one that does not open it). Pure.
 */
export function accountState(input: {
  configured: boolean;
  account: CloudAccount | null;
  hasLocalKey: boolean;
  keySetup: CloudKeySetup | null | undefined;
  now: number;
}): AccountState | 'unknown' {
  if (!input.configured) {
    return 'unconfigured';
  }
  if (input.account === null || input.account.expiresAt <= input.now) {
    return 'signedOut';
  }
  if (input.keySetup === undefined) {
    return 'unknown';
  }
  if (input.keySetup === null) {
    return 'needsPassphrase';
  }
  return input.hasLocalKey ? 'ready' : 'needsUnlock';
}

/** Why a new passphrase is refused, or `null` when it is fine. Pure. */
export function newPassphraseProblem(
  passphrase: string,
  repeated: string,
): 'tooShort' | 'mismatch' | null {
  if ([...passphrase].length < POLICY.passphrase.minLength) {
    return 'tooShort';
  }
  return passphrase === repeated ? null : 'mismatch';
}

/**
 * Whether a `chrome.identity.getAuthToken` failure is the person closing or turning down Chrome's
 * consent window, which is not an error to report. Chrome rejects with "The user did not approve
 * access." for both; anything else (no network, sign-in turned off in Chrome, a bad client id) is
 * a real failure and is explained as one, so only that wording and an explicit cancel count.
 */
export function isSignInCancelled(err: unknown): boolean {
  const message = err instanceof Error ? err.message.toLowerCase() : '';
  return message.includes('did not approve') || /\bcancel(l?ed)?\b/.test(message);
}

/**
 * Takes the access token out of Chrome's token cache once the server has had it (or refused it).
 * The server needs it once, to learn who signed in, so neither Chrome nor this extension holds a
 * Google token afterwards, and a token Google has since revoked is never offered again (the next
 * sign-in gets a fresh one, without a prompt while the grant stands). Best effort.
 */
async function dropCachedGoogleToken(token: string): Promise<void> {
  try {
    await chrome.identity.removeCachedAuthToken({ token });
  } catch (err: unknown) {
    console.warn('[tabinet] could not drop the Google token from the cache', err);
  }
}

/**
 * On sign-out and deletion Chrome is also told to forget this extension's Google grant
 * (`clearAllCachedAuthTokens`), so the next sign-in asks again and another account can be picked.
 * There is no single token to remove at that point (it was dropped right after signing in), which
 * is why the whole cache is cleared rather than `removeCachedAuthToken`. Behind a `typeof` guard
 * because `chrome.identity` exists only with the `identity` permission; best effort, like logout.
 */
async function forgetGoogleGrant(): Promise<void> {
  if (typeof chrome.identity?.clearAllCachedAuthTokens !== 'function') {
    return;
  }
  try {
    await chrome.identity.clearAllCachedAuthTokens();
  } catch (err: unknown) {
    console.warn('[tabinet] could not clear the Google token cache', err);
  }
}

// ---------------------------------------------------------------------------
// Stored account and key
// ---------------------------------------------------------------------------

export async function loadCloudAccount(): Promise<CloudAccount | null> {
  const stored = await chrome.storage.local.get(CLOUD_ACCOUNT_KEY);
  const value: unknown = stored[CLOUD_ACCOUNT_KEY];
  return isCloudAccount(value) ? value : null;
}

export async function loadSyncKey(): Promise<string | null> {
  const stored = await chrome.storage.local.get(CLOUD_SYNC_KEY);
  const value: unknown = stored[CLOUD_SYNC_KEY];
  return typeof value === 'string' && value !== '' ? value : null;
}

/** Forgets the account and the key on this device. Local sessions are untouched. */
export async function forgetCloudAccount(): Promise<void> {
  await chrome.storage.local.remove([CLOUD_ACCOUNT_KEY, CLOUD_SYNC_KEY]);
}

/**
 * The stored account while its token is still good. An expired one is forgotten, together with
 * the key, so no key outlives the account it was entered for.
 */
export async function loadLiveCloudAccount(now: number): Promise<CloudAccount | null> {
  const account = await loadCloudAccount();
  if (account !== null && account.expiresAt <= now) {
    await forgetCloudAccount();
    return null;
  }
  return account;
}

/**
 * Keeps the key on this device only when it opens `setup`, the account's setup on the server:
 * with no setup there, or one made with another passphrase (another account, or a passphrase
 * created again after the cloud data was deleted), the key is removed. Whether a key is kept.
 */
export async function keepSyncKeyFor(setup: CloudKeySetup | null): Promise<boolean> {
  const rawKey = await loadSyncKey();
  if (rawKey === null) {
    return false;
  }
  if (setup !== null && (await keyMatchesSetup(rawKey, setup))) {
    return true;
  }
  await chrome.storage.local.remove(CLOUD_SYNC_KEY);
  return false;
}

/**
 * Stores the key for the account whose `token` it was made under, unless that account was
 * signed out (or replaced) meanwhile, in another tab say; then nothing is stored and the
 * request reads as signed out.
 */
async function storeSyncKeyFor(token: string, rawKey: string): Promise<void> {
  const current = await loadCloudAccount();
  if (current === null || current.token !== token) {
    throw new CloudUnauthorizedError();
  }
  await chrome.storage.local.set({ [CLOUD_SYNC_KEY]: rawKey });
}

async function requireAccount(): Promise<CloudAccount> {
  const account = await loadCloudAccount();
  if (account === null) {
    throw new CloudUnauthorizedError();
  }
  return account;
}

/**
 * Runs a request for the stored account; a 401 forgets the account (the token is no longer
 * good) and is then thrown on, so the page says so and shows "Sign in" again.
 */
export async function withCloudAccount<T>(run: (account: CloudAccount) => Promise<T>): Promise<T> {
  try {
    return await run(await requireAccount());
  } catch (err: unknown) {
    if (err instanceof CloudUnauthorizedError) {
      await forgetCloudAccount();
    }
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Sign-in, sign-out, delete
// ---------------------------------------------------------------------------

export type SignInOutcome =
  | { outcome: 'signedIn'; account: CloudAccount; keySetup: CloudKeySetup | null }
  | { outcome: 'cancelled' };

/**
 * Signs in with Google, straight from a click: Chrome's own account and consent window
 * (`chrome.identity.getAuthToken`, with the client id from the manifest's `oauth2`), the access
 * token traded once for the server's token, and the account stored. The Google token is never
 * stored and is dropped from Chrome's cache right after the exchange, whatever its outcome. A
 * closed or refused consent window is `'cancelled'`, not an error.
 */
export async function signIn(options: CloudApiOptions = {}): Promise<SignInOutcome> {
  let googleToken: string | undefined;
  try {
    // Promise form (Chrome 105+, below the minimum of 123): resolves to `{ token, grantedScopes }`.
    const answer = await chrome.identity.getAuthToken({
      interactive: true,
      scopes: [...GOOGLE_OAUTH_SCOPES],
    });
    googleToken = answer.token;
  } catch (err: unknown) {
    if (isSignInCancelled(err)) {
      return { outcome: 'cancelled' };
    }
    const reason = err instanceof Error ? err.message : String(err);
    throw new ExplainedError(`getAuthToken failed (${reason})`, 'errorCloudSignInFailed');
  }
  if (googleToken === undefined || googleToken === '') {
    throw new ExplainedError('getAuthToken answered without a token', 'errorCloudSignInFailed');
  }
  let result: CloudSignInResult;
  try {
    result = await authGoogle(googleToken, options);
  } finally {
    await dropCachedGoogleToken(googleToken);
  }
  const account: CloudAccount = {
    token: result.token,
    expiresAt: result.expiresAt,
    email: result.email,
  };
  // A key left from an earlier sign-in (another account, or this one before its passphrase was
  // made again) must not carry over: it stays only when it opens this account's setup.
  await keepSyncKeyFor(result.keySetup);
  await chrome.storage.local.set({ [CLOUD_ACCOUNT_KEY]: account });
  return { outcome: 'signedIn', account, keySetup: result.keySetup };
}

/** Signs out: the server forgets the token when it can, this device forgets account and key. */
export async function signOut(options: CloudApiOptions = {}): Promise<void> {
  const account = await loadCloudAccount();
  if (account !== null) {
    try {
      await logout(account.token, options);
    } catch (err: unknown) {
      // Best effort: the token expires on its own, and signing out here must not wait on it.
      console.warn('[tabinet] sign-out not confirmed by the server', err);
    }
  }
  await forgetCloudAccount();
  await forgetGoogleGrant();
}

/** Deletes the account and everything on the server, then signs out on this device. */
export async function deleteCloudData(options: CloudApiOptions = {}): Promise<void> {
  await withCloudAccount((account) => deleteAccount(account.token, options));
  await forgetCloudAccount();
  await forgetGoogleGrant();
}

// ---------------------------------------------------------------------------
// The sync passphrase
// ---------------------------------------------------------------------------

export type SetUpPassphraseOutcome =
  | { outcome: 'ready'; setup: CloudKeySetup }
  | { outcome: 'exists' };

/**
 * Sets up a new passphrase: the key setup goes to the server and the key is kept here (`'ready'`,
 * with the setup now on the server). `'exists'` when another device set one up first; nothing is
 * kept then, and the person enters that one. Signed out meanwhile, the key is not kept either.
 */
export async function setUpPassphrase(
  passphrase: string,
  options: CloudApiOptions & { iterations?: number } = {},
): Promise<SetUpPassphraseOutcome> {
  const { setup, rawKey } = await createKeySetup(passphrase, options.iterations);
  const { result, token } = await withCloudAccount(async (account) => ({
    result: await putKeys(account.token, setup, options),
    token: account.token,
  }));
  if (result === 'exists') {
    return { outcome: 'exists' };
  }
  await storeSyncKeyFor(token, rawKey);
  return { outcome: 'ready', setup };
}

/**
 * Tries `passphrase` against the server's setup and keeps the key when it is right, unless the
 * account was signed out (or replaced) while the key was derived.
 */
export async function unlockWithPassphrase(
  setup: CloudKeySetup,
  passphrase: string,
): Promise<boolean> {
  const { token } = await requireAccount();
  const rawKey = await unlockKeySetup(setup, passphrase);
  if (rawKey === null) {
    return false;
  }
  await storeSyncKeyFor(token, rawKey);
  return true;
}
