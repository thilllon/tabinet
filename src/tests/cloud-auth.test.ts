import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { CloudUnauthorizedError, me } from '@/lib/cloud-api';
import {
  accountState,
  checkKeySetup,
  CLOUD_ACCOUNT_KEY,
  CLOUD_SYNC_KEY,
  deleteCloudData,
  isSignInCancelled,
  keepSyncKeyFor,
  loadCloudAccount,
  loadLiveCloudAccount,
  loadSyncKey,
  newPassphraseProblem,
  setUpPassphrase,
  showsSyncRow,
  signIn,
  signOut,
  unlockWithPassphrase,
  withCloudAccount,
} from '@/lib/cloud-auth';
import { overrideCloudSyncConfig } from '@/lib/cloud-config';
import { createKeySetup } from '@/lib/cloud-crypto';
import { errorMessage } from '@/lib/error-message';
import { t } from '@/lib/i18n';
import type { CloudAccount, CloudKeySetup } from '@/types';

import { getChromeFake } from './chrome-fake';
import { fakeFetch, jsonResponse } from './cloud-fetch';

const ACCOUNT: CloudAccount = { token: 'tok', expiresAt: 2_000_000_000_000, email: 'a@b.c' };
const SETUP: CloudKeySetup = {
  kdf: { name: 'PBKDF2', hash: 'SHA-256', iterations: 1000 },
  salt: 'c2FsdHNhbHRzYWx0c2FsdA==',
  check: 'Y2hlY2s=',
  checkIv: 'aXZpdml2aXZpdml2',
};

const GOOGLE_TOKEN = 'ya29.google-access-token';

/** Chrome's consent window: answers `getAuthToken` with a Google access token. */
function googleAnswers(token = GOOGLE_TOKEN) {
  getChromeFake().state.authTokenAnswer = token;
}

beforeEach(() => {
  overrideCloudSyncConfig(() => ({ apiBase: 'https://sync.test', googleClientId: 'client.apps' }));
});

afterEach(() => {
  overrideCloudSyncConfig();
  vi.restoreAllMocks();
});

describe('accountState', () => {
  const base = { configured: true, account: ACCOUNT, hasLocalKey: false, now: 1_000 };

  it('is unconfigured without a sync server, whatever else is stored', () => {
    expect(accountState({ ...base, configured: false, hasLocalKey: true, keySetup: SETUP })).toBe(
      'unconfigured',
    );
  });

  it('is signedOut with no account or an expired one', () => {
    expect(accountState({ ...base, account: null, keySetup: undefined })).toBe('signedOut');
    expect(accountState({ ...base, now: ACCOUNT.expiresAt, keySetup: null })).toBe('signedOut');
  });

  it('is needsPassphrase, needsUnlock or ready by the server setup and the local key', () => {
    expect(accountState({ ...base, keySetup: null })).toBe('needsPassphrase');
    expect(accountState({ ...base, keySetup: SETUP })).toBe('needsUnlock');
    expect(accountState({ ...base, hasLocalKey: true, keySetup: SETUP })).toBe('ready');
    expect(accountState({ ...base, keySetup: undefined })).toBe('unknown');
  });

  it('never trusts a local key before the server setup is known, or with none there', () => {
    expect(accountState({ ...base, hasLocalKey: true, keySetup: undefined })).toBe('unknown');
    expect(accountState({ ...base, hasLocalKey: true, keySetup: null })).toBe('needsPassphrase');
  });
});

describe('newPassphraseProblem', () => {
  it('wants 8 characters, counted as characters, and the same text twice', () => {
    expect(newPassphraseProblem('1234567', '1234567')).toBe('tooShort');
    expect(newPassphraseProblem('12345678', '12345679')).toBe('mismatch');
    expect(newPassphraseProblem('12345678', '12345678')).toBeNull();
    // Four emoji are eight UTF-16 units but four characters.
    expect(newPassphraseProblem('🔑🔑🔑🔑', '🔑🔑🔑🔑')).toBe('tooShort');
  });
});

describe('isSignInCancelled', () => {
  it("takes Chrome's refused-consent wording and an explicit cancel as cancelled", () => {
    expect(isSignInCancelled(new Error('The user did not approve access.'))).toBe(true);
    expect(isSignInCancelled(new Error('Sign-in was canceled.'))).toBe(true);
    expect(isSignInCancelled(new Error('The request was cancelled by the user'))).toBe(true);
  });

  it('treats every other failure as a real one', () => {
    expect(isSignInCancelled(new Error('Authorization page could not be loaded.'))).toBe(false);
    expect(isSignInCancelled(new Error('The user turned off browser signin'))).toBe(false);
    expect(isSignInCancelled(new Error('OAuth2 request failed: Connection failed.'))).toBe(false);
    expect(isSignInCancelled(new Error('Invalid OAuth2 Client ID.'))).toBe(false);
    expect(isSignInCancelled('did not approve')).toBe(false);
    expect(isSignInCancelled(undefined)).toBe(false);
  });
});

describe('signIn', () => {
  it('asks Chrome for a token interactively, then stores the account the server answers with', async () => {
    googleAnswers();
    const server = fakeFetch(
      jsonResponse(200, {
        token: 'tok',
        expiresAt: ACCOUNT.expiresAt,
        email: 'a@b.c',
        keySetup: null,
      }),
    );
    const result = await signIn({ fetch: server.fetch });
    expect(result).toEqual({ outcome: 'signedIn', account: ACCOUNT, keySetup: null });
    expect(await loadCloudAccount()).toEqual(ACCOUNT);
    const fake = getChromeFake();
    expect(fake.state.authTokenRequests).toEqual([
      { interactive: true, scopes: ['openid', 'email'] },
    ]);
    expect(server.requests[0]).toMatchObject({
      url: 'https://sync.test/v1/auth/google',
      body: { accessToken: GOOGLE_TOKEN },
    });
  });

  it('keeps the Google token nowhere: not stored, and dropped from Chrome after the exchange', async () => {
    googleAnswers();
    const answer = { token: 'tok', expiresAt: ACCOUNT.expiresAt, email: 'a@b.c', keySetup: null };
    await signIn({ fetch: fakeFetch(jsonResponse(200, answer)).fetch });
    const fake = getChromeFake();
    expect(fake.state.removedAuthTokens).toEqual([GOOGLE_TOKEN]);
    expect(JSON.stringify([...fake.state.local.entries()])).not.toContain(GOOGLE_TOKEN);
  });

  it('drops the Google token from Chrome also when the server refuses it, and stores nothing', async () => {
    googleAnswers();
    const server = fakeFetch(jsonResponse(401, { error: 'unauthorized' }));
    const err: unknown = await signIn({ fetch: server.fetch }).catch((e: unknown) => e);
    expect(errorMessage(err)).toBe(t('errorCloudSignInFailed'));
    expect(getChromeFake().state.removedAuthTokens).toEqual([GOOGLE_TOKEN]);
    expect(getChromeFake().state.local.has(CLOUD_ACCOUNT_KEY)).toBe(false);
  });

  it('is cancelled, not failed, when the person closes or turns down the consent window', async () => {
    const server = fakeFetch(jsonResponse(200, {}));
    // The fake's default: Chrome's wording for a refused consent.
    expect(await signIn({ fetch: server.fetch })).toEqual({ outcome: 'cancelled' });
    expect(server.requests).toHaveLength(0);
    expect(getChromeFake().state.local.has(CLOUD_ACCOUNT_KEY)).toBe(false);
  });

  it('fails, without asking the server, when Chrome answers without a token', async () => {
    googleAnswers('');
    const server = fakeFetch(jsonResponse(200, {}));
    const err: unknown = await signIn({ fetch: server.fetch }).catch((e: unknown) => e);
    expect(errorMessage(err)).toBe(t('errorCloudSignInFailed'));
    expect(server.requests).toHaveLength(0);
  });

  it('drops a key left from an expired account when another account signs in', async () => {
    const { rawKey } = await createKeySetup('account A', 100_000);
    await chrome.storage.local.set({
      [CLOUD_ACCOUNT_KEY]: { ...ACCOUNT, expiresAt: 1 },
      [CLOUD_SYNC_KEY]: rawKey,
    });
    googleAnswers();
    const b = { token: 'tok-b', expiresAt: ACCOUNT.expiresAt, email: 'b@b.c', keySetup: null };
    const result = await signIn({ fetch: fakeFetch(jsonResponse(200, b)).fetch });
    expect(result).toMatchObject({ outcome: 'signedIn', keySetup: null });
    expect(await loadSyncKey()).toBeNull();
    expect(
      accountState({
        configured: true,
        account: await loadCloudAccount(),
        hasLocalKey: (await loadSyncKey()) !== null,
        keySetup: null,
        now: Date.now(),
      }),
    ).toBe('needsPassphrase');
  });

  it("drops a key that does not open the account's setup, and keeps one that does", async () => {
    const a = await createKeySetup('passphrase A', 100_000);
    const again = await createKeySetup('passphrase made again', 100_000);
    googleAnswers();
    const answer = (keySetup: unknown) =>
      fakeFetch(
        jsonResponse(200, { token: 'tok', expiresAt: ACCOUNT.expiresAt, email: 'a@b.c', keySetup }),
      );

    await chrome.storage.local.set({ [CLOUD_SYNC_KEY]: a.rawKey });
    await signIn({ fetch: answer(a.setup).fetch });
    expect(await loadSyncKey()).toBe(a.rawKey);

    await signIn({ fetch: answer(again.setup).fetch });
    expect(await loadSyncKey()).toBeNull();
  });

  it('explains any other failure of the consent window', async () => {
    getChromeFake().state.authTokenAnswer = new Error('Authorization page could not be loaded.');
    const err: unknown = await signIn().catch((e: unknown) => e);
    expect(errorMessage(err)).toBe(t('errorCloudSignInFailed'));
  });
});

describe('signOut / deleteCloudData', () => {
  beforeEach(async () => {
    await chrome.storage.local.set({
      [CLOUD_ACCOUNT_KEY]: ACCOUNT,
      [CLOUD_SYNC_KEY]: 'a2V5',
      sessionIndex: { schemaVersion: 1, sessions: [] },
    });
  });

  it('signs out on the server and forgets account and key, leaving sessions alone', async () => {
    const server = fakeFetch(jsonResponse(204));
    await signOut({ fetch: server.fetch });
    expect(server.requests[0]).toMatchObject({
      method: 'POST',
      url: 'https://sync.test/v1/auth/logout',
    });
    const local = getChromeFake().state.local;
    expect(local.has(CLOUD_ACCOUNT_KEY)).toBe(false);
    expect(local.has(CLOUD_SYNC_KEY)).toBe(false);
    expect(local.has('sessionIndex')).toBe(true);
    expect(getChromeFake().state.authTokenCacheClears).toBe(1);
  });

  it('still signs out here when the server cannot be reached', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const offline = fakeFetch(new TypeError('Failed to fetch'));
    await signOut({ fetch: offline.fetch });
    expect(await loadCloudAccount()).toBeNull();
    expect(await loadSyncKey()).toBeNull();
  });

  it('deletes the account on the server, then forgets it here', async () => {
    const server = fakeFetch(jsonResponse(204));
    await deleteCloudData({ fetch: server.fetch });
    expect(server.requests[0]).toMatchObject({
      method: 'DELETE',
      url: 'https://sync.test/v1/account',
    });
    expect(await loadCloudAccount()).toBeNull();
    expect(await loadSyncKey()).toBeNull();
    expect(getChromeFake().state.authTokenCacheClears).toBe(1);
    expect(getChromeFake().state.local.has('sessionIndex')).toBe(true);
  });

  it('keeps everything when the deletion fails for another reason than the sign-in', async () => {
    const down = fakeFetch(jsonResponse(500, { error: 'internal' }));
    await expect(deleteCloudData({ fetch: down.fetch })).rejects.toThrow(/HTTP 500/);
    expect(await loadCloudAccount()).toEqual(ACCOUNT);
    expect(getChromeFake().state.authTokenCacheClears).toBe(0);
  });
});

describe('loadLiveCloudAccount / keepSyncKeyFor', () => {
  it('forgets an expired account together with its key', async () => {
    await chrome.storage.local.set({ [CLOUD_ACCOUNT_KEY]: ACCOUNT, [CLOUD_SYNC_KEY]: 'a2V5' });
    expect(await loadLiveCloudAccount(ACCOUNT.expiresAt - 1)).toEqual(ACCOUNT);
    expect(await loadSyncKey()).toBe('a2V5');
    expect(await loadLiveCloudAccount(ACCOUNT.expiresAt)).toBeNull();
    expect(await loadCloudAccount()).toBeNull();
    expect(await loadSyncKey()).toBeNull();
  });

  it('keeps the key only for the setup it opens', async () => {
    const { setup, rawKey } = await createKeySetup('the one', 1000);
    expect(await keepSyncKeyFor(setup)).toBe(false);
    await chrome.storage.local.set({ [CLOUD_SYNC_KEY]: rawKey });
    expect(await keepSyncKeyFor(setup)).toBe(true);
    expect(await loadSyncKey()).toBe(rawKey);
    expect(await keepSyncKeyFor(null)).toBe(false);
    expect(await loadSyncKey()).toBeNull();
    await chrome.storage.local.set({ [CLOUD_SYNC_KEY]: 'not base64!' });
    expect(await keepSyncKeyFor(setup)).toBe(false);
    expect(await loadSyncKey()).toBeNull();
  });
});

describe('showsSyncRow', () => {
  it.each(['pending', 'unreachable', 'a 500'])('shows while the account check is %s', () => {
    // All three leave the setup unknown; the engine syncs with the account and key it has.
    const now = ACCOUNT.expiresAt - 1;
    const known = { configured: true, account: ACCOUNT, hasLocalKey: true, now };
    const state = accountState({ ...known, keySetup: undefined });
    expect(showsSyncRow(state, ACCOUNT, true, now)).toBe(true);
  });

  it('not without a live account and its key', () => {
    const now = ACCOUNT.expiresAt;
    expect(showsSyncRow('unknown', ACCOUNT, false, now - 1)).toBe(false);
    expect(showsSyncRow('unknown', ACCOUNT, true, now)).toBe(false);
    expect(showsSyncRow('unknown', null, true, now - 1)).toBe(false);
    expect(showsSyncRow('needsUnlock', ACCOUNT, true, now - 1)).toBe(false);
    expect(showsSyncRow('ready', ACCOUNT, true, now - 1)).toBe(true);
  });
});

describe('an answer for the account before', () => {
  const NEXT: CloudAccount = { ...ACCOUNT, token: 'tok-next' };

  it('its 401 does not sign the next account out', async () => {
    await chrome.storage.local.set({ [CLOUD_ACCOUNT_KEY]: ACCOUNT, [CLOUD_SYNC_KEY]: 'a2V5' });
    const refused = withCloudAccount(async () => {
      await chrome.storage.local.set({ [CLOUD_ACCOUNT_KEY]: NEXT });
      throw new CloudUnauthorizedError();
    });
    await expect(refused).rejects.toBeInstanceOf(CloudUnauthorizedError);
    expect(await loadCloudAccount()).toEqual(NEXT);
    expect(await loadSyncKey()).toBe('a2V5');
  });

  it('a key written while the check runs is not removed by it', async () => {
    const { setup } = await createKeySetup('the passphrase', 1000);
    const { rawKey: stale } = await createKeySetup('an old one', 1000);
    await chrome.storage.local.set({ [CLOUD_ACCOUNT_KEY]: ACCOUNT, [CLOUD_SYNC_KEY]: stale });
    const decrypt = crypto.subtle.decrypt.bind(crypto.subtle);
    const spy = vi.spyOn(crypto.subtle, 'decrypt').mockImplementationOnce(async (...args) => {
      await chrome.storage.local.set({ [CLOUD_SYNC_KEY]: 'just-unlocked' });
      return decrypt(...args);
    });
    await keepSyncKeyFor(setup, ACCOUNT.token);
    spy.mockRestore();
    expect(await loadSyncKey()).toBe('just-unlocked');
  });

  it('the setup is asked for with the token of the account it is shown for', async () => {
    await chrome.storage.local.set({ [CLOUD_ACCOUNT_KEY]: NEXT, [CLOUD_SYNC_KEY]: 'a2V5' });
    const server = fakeFetch(jsonResponse(200, { email: ACCOUNT.email, keySetup: null }));
    await checkKeySetup(ACCOUNT, { fetch: server.fetch });
    expect(server.requests[0]?.headers.authorization).toBe('Bearer tok');
    expect(await loadSyncKey()).toBe('a2V5');
  });

  it("its setup does not remove the next account's key", async () => {
    const { setup } = await createKeySetup('the one before', 1000);
    const { rawKey } = await createKeySetup('the next one', 1000);
    await chrome.storage.local.set({ [CLOUD_ACCOUNT_KEY]: NEXT, [CLOUD_SYNC_KEY]: rawKey });
    await keepSyncKeyFor(setup, ACCOUNT.token);
    expect(await loadSyncKey()).toBe(rawKey);
  });
});

describe('withCloudAccount', () => {
  it('forgets the stored account on a 401 and throws it on', async () => {
    await chrome.storage.local.set({ [CLOUD_ACCOUNT_KEY]: ACCOUNT, [CLOUD_SYNC_KEY]: 'a2V5' });
    const server = fakeFetch(jsonResponse(401, { error: 'unauthorized' }));
    await expect(
      withCloudAccount((a) => me(a.token, { fetch: server.fetch })),
    ).rejects.toBeInstanceOf(CloudUnauthorizedError);
    expect(await loadCloudAccount()).toBeNull();
    expect(await loadSyncKey()).toBeNull();
  });

  it('throws CloudUnauthorizedError without asking the server when nobody is signed in', async () => {
    const server = fakeFetch(jsonResponse(200, {}));
    await expect(
      withCloudAccount((a) => me(a.token, { fetch: server.fetch })),
    ).rejects.toBeInstanceOf(CloudUnauthorizedError);
    expect(server.requests).toHaveLength(0);
  });

  it('ignores a stored account of the wrong shape', async () => {
    await chrome.storage.local.set({ [CLOUD_ACCOUNT_KEY]: { token: 5 } });
    expect(await loadCloudAccount()).toBeNull();
  });
});

describe('the sync passphrase', () => {
  beforeEach(async () => {
    await chrome.storage.local.set({ [CLOUD_ACCOUNT_KEY]: ACCOUNT });
  });

  it('creates a setup on the server and keeps the key here', async () => {
    const server = fakeFetch(jsonResponse(201));
    const result = await setUpPassphrase('long enough', { fetch: server.fetch, iterations: 1000 });
    const sent = server.requests[0]?.body;
    expect(result).toEqual({ outcome: 'ready', setup: sent });
    expect(sent).toMatchObject({ kdf: { name: 'PBKDF2', hash: 'SHA-256', iterations: 1000 } });
    expect(JSON.stringify(sent)).not.toContain('long enough');
    expect(await loadSyncKey()).toMatch(/^[A-Za-z0-9+/]{43}=$/);
  });

  it('keeps no key when another device created a passphrase first', async () => {
    const server = fakeFetch(jsonResponse(409, { error: 'key_exists' }));
    expect(await setUpPassphrase('long enough', { fetch: server.fetch, iterations: 1000 })).toEqual(
      { outcome: 'exists' },
    );
    expect(await loadSyncKey()).toBeNull();
  });

  it('unlocks with the right passphrase only', async () => {
    const { setup, rawKey } = await createKeySetup('the right one', 1000);
    expect(await unlockWithPassphrase(setup, 'the wrong one')).toBe(false);
    expect(await loadSyncKey()).toBeNull();
    expect(await unlockWithPassphrase(setup, 'the right one')).toBe(true);
    expect(await loadSyncKey()).toBe(rawKey);
  });

  it('keeps no key when the account was signed out while the key was derived', async () => {
    const { setup } = await createKeySetup('the right one', 1000);
    const unlocking = unlockWithPassphrase(setup, 'the right one');
    const signedOut = chrome.storage.local.remove(CLOUD_ACCOUNT_KEY);
    await expect(unlocking).rejects.toBeInstanceOf(CloudUnauthorizedError);
    await signedOut;
    expect(await loadSyncKey()).toBeNull();
  });

  it('keeps no key when another account signed in while the setup was being stored', async () => {
    const server = fakeFetch(() => {
      void chrome.storage.local.set({ [CLOUD_ACCOUNT_KEY]: { ...ACCOUNT, token: 'tok-b' } });
      return jsonResponse(201);
    });
    await expect(
      setUpPassphrase('long enough', { fetch: server.fetch, iterations: 1000 }),
    ).rejects.toBeInstanceOf(CloudUnauthorizedError);
    expect(await loadSyncKey()).toBeNull();
  });
});

describe('signing out without chrome.identity', () => {
  it('still signs out when the identity API is absent (no permission)', async () => {
    await chrome.storage.local.set({ [CLOUD_ACCOUNT_KEY]: ACCOUNT });
    // The fake is fresh for every test, so removing its identity API here touches nothing else.
    Reflect.deleteProperty(chrome, 'identity');
    expect(chrome.identity).toBeUndefined();
    await signOut({ fetch: fakeFetch(jsonResponse(204)).fetch });
    expect(await loadCloudAccount()).toBeNull();
  });
});
