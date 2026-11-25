import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  accountState,
  cancelAccountSwitch,
  changePassphrase,
  confirmAccount,
  createPassphrase,
  deleteCloudData,
  newPassphraseProblem,
  refreshMe,
  signIn,
  signOut,
  unlockWithPassphrase,
  uploadConfirmedFor,
} from '@/lib/cloud-auth';
import { overrideCloudSyncConfig } from '@/lib/cloud-config';
import { overrideKdfIterations } from '@/lib/cloud-crypto';
import {
  CLOUD_ACCOUNT_KEY,
  CLOUD_KEY_KEY,
  CLOUD_OWNER_KEY,
  CLOUD_SYNC_META_KEY,
  upgradeCloudStorage,
} from '@/lib/cloud-storage';
import type { AccountInput, CloudAccountV2, CloudKeyV2 } from '@/types';

import { getChromeFake } from './chrome-fake';
import { fakeSyncServer, type FakeSyncServer } from './cloud-fetch';

let server: FakeSyncServer;
const API = { apiBase: 'https://sync.test', inWorker: false } as const;
const local = () => getChromeFake().state.local;
const stored = <T>(key: string) => local().get(key) as T | undefined;
const google = (sub: string) => {
  getChromeFake().state.authTokenAnswer = `google:${sub}`;
};

beforeEach(() => {
  overrideCloudSyncConfig(() => ({ apiBase: 'https://sync.test', googleClientId: 'cid' }));
  overrideKdfIterations(1000);
  server = fakeSyncServer();
  vi.stubGlobal('fetch', server.fetch);
  google('person');
});

afterEach(() => {
  overrideCloudSyncConfig();
  overrideKdfIterations();
  vi.unstubAllGlobals();
});

async function signedInWithKey(passphrase = 'long passphrase') {
  expect((await signIn(API)).outcome).toBe('signedIn');
  expect(await createPassphrase(passphrase, API)).toEqual({ outcome: 'created' });
  return {
    account: stored<CloudAccountV2>(CLOUD_ACCOUNT_KEY)!,
    key: stored<CloudKeyV2>(CLOUD_KEY_KEY)!,
  };
}

/** A second device of the same profile: the server stays, this device's storage starts empty. */
function secondDevice(): void {
  local().clear();
}

describe('accountState', () => {
  const account: CloudAccountV2 = {
    accountId: 'a',
    token: 't',
    expiresAt: 100,
    email: 'e',
    uploadConfirmed: true,
  };
  const key: CloudKeyV2 = { accountId: 'a', keyId: 'K'.repeat(22), generation: 1, dek: 'd' };
  const base: AccountInput = {
    configured: true,
    loaded: true,
    now: 50,
    account,
    key,
    server: undefined,
  };
  const server = { keyId: key.keyId, generation: 1 };

  it.each<[string, Partial<AccountInput>, string]>([
    ['unconfigured', { configured: false }, 'unconfigured'],
    ['loading', { loaded: false }, 'loading'],
    ['signed out', { account: null, key: null }, 'signedOut'],
    ['expired without a key', { now: 200, key: null }, 'signedOut'],
    ['expired with a key', { now: 200 }, 'expired'],
    ['not confirmed', { account: { ...account, uploadConfirmed: false } }, 'confirmAccount'],
    ['mine, server unknown', {}, 'ready'],
    ['mine, server agrees', { server }, 'ready'],
    ['mine, server has none', { server: null }, 'keyMismatch'],
    ['mine, server has another', { server: { ...server, keyId: 'L'.repeat(22) } }, 'keyMismatch'],
    ['another account, unknown', { key: { ...key, accountId: 'b' } }, 'unknown'],
    ['no key, server has none', { key: null, server: null }, 'needsCreate'],
    ['no key, server has one', { key: null, server }, 'needsUnlock'],
  ])('%s', (_name, input, state) => {
    expect(accountState({ ...base, ...input })).toBe(state);
  });
});

describe('newPassphraseProblem', () => {
  it('counts code points after NFC', () => {
    const vectors = JSON.parse(readFileSync(join(__dirname, 'key-vectors.json'), 'utf8')) as {
      passphrase: string;
    };
    const nfd = vectors.passphrase.normalize('NFD');
    expect(newPassphraseProblem(nfd, vectors.passphrase)).toBeNull();
    expect(newPassphraseProblem('1234567', '1234567')).toBe('short');
    expect(newPassphraseProblem('한글한글한글한', '한글한글한글한')).toBe('short');
    expect(newPassphraseProblem('한글한글한글한글', '한글한글한글한글')).toBeNull();
    expect(newPassphraseProblem('', '')).toBe('empty');
    expect(newPassphraseProblem('12345678', '12345679')).toBe('mismatch');
    expect(newPassphraseProblem(' 1234567', '1234567')).toBe('mismatch');
  });
});

describe('uploadConfirmedFor', () => {
  it('asks only for another account', () => {
    expect(uploadConfirmedFor(null, 'a', 'e@x')).toBe(true);
    expect(uploadConfirmedFor({ accountId: 'a', email: 'e@x' }, 'a', 'e@x')).toBe(true);
    expect(uploadConfirmedFor({ accountId: null, email: 'E@X' }, 'b', 'e@x')).toBe(true);
    expect(uploadConfirmedFor({ accountId: 'a', email: 'e@x' }, 'b', 'e@x')).toBe(false);
    expect(uploadConfirmedFor({ accountId: null, email: 'o@x' }, 'b', 'e@x')).toBe(false);
  });
});

describe('the Google token', () => {
  it('comes from the click, is dropped on success and on failure, and is never stored', async () => {
    await signedInWithKey();
    const { authTokenRequests, removedAuthTokens } = getChromeFake().state;
    expect(authTokenRequests.every((request) => request.interactive === true)).toBe(true);
    expect(removedAuthTokens).toEqual(['google:person', 'google:person']);
    server.intercept = () => new Response(JSON.stringify({ error: 'internal' }), { status: 500 });
    await expect(changePassphrase('another passphrase', API)).rejects.toMatchObject({
      status: 500,
    });
    expect(removedAuthTokens).toHaveLength(3);
    for (const value of local().values()) {
      expect(JSON.stringify(value)).not.toContain('google:person');
    }
  });

  it('a closed consent window is cancelled for every action', async () => {
    await signedInWithKey();
    getChromeFake().state.authTokenAnswer = new Error('The user did not approve access.');
    const before = new Map(local());
    expect(await signIn(API)).toEqual({ outcome: 'cancelled' });
    expect(await createPassphrase('long passphrase', API)).toEqual({ outcome: 'cancelled' });
    expect(await unlockWithPassphrase('long passphrase', API)).toEqual({ outcome: 'cancelled' });
    expect(await changePassphrase('long passphrase', API)).toEqual({ outcome: 'cancelled' });
    expect(await deleteCloudData(API)).toEqual({ outcome: 'cancelled' });
    expect(new Map(local())).toEqual(before);
  });
});

describe('create and unlock', () => {
  it('creates the key, and stores key and owner only after the 201', async () => {
    const { account, key } = await signedInWithKey();
    expect(key).toMatchObject({ accountId: account.accountId, generation: 1 });
    expect(stored(CLOUD_OWNER_KEY)).toEqual({ accountId: account.accountId, email: account.email });
    expect(server.account().key?.keyId).toBe(key.keyId);
  });

  it('answers exists for a second create, and for a lost answer when the server has one', async () => {
    await signedInWithKey();
    secondDevice();
    await signIn(API);
    expect(await createPassphrase('other passphrase', API)).toEqual({ outcome: 'exists' });
    expect(stored(CLOUD_KEY_KEY)).toBeUndefined();

    const fresh = fakeSyncServer();
    vi.stubGlobal('fetch', fresh.fetch);
    secondDevice();
    await signIn(API);
    // The key is stored, and the answer is lost on the way back.
    vi.stubGlobal('fetch', async (...args: Parameters<typeof fetch>) => {
      const response = await fresh.fetch(...args);
      if (args[1]?.method === 'PUT') {
        throw new TypeError('Failed to fetch');
      }
      return response;
    });
    expect(await createPassphrase('long passphrase', API)).toEqual({ outcome: 'exists' });
    expect(stored(CLOUD_KEY_KEY)).toBeUndefined();
  });

  it('unlocks on a second device, NFD spelling too, and a wrong one writes nothing', async () => {
    const vectors = JSON.parse(readFileSync(join(__dirname, 'key-vectors.json'), 'utf8')) as {
      passphrase: string;
    };
    const { key } = await signedInWithKey(vectors.passphrase);
    secondDevice();
    await signIn(API);
    expect(await unlockWithPassphrase('not it', API)).toEqual({ outcome: 'wrongPassphrase' });
    expect(stored(CLOUD_KEY_KEY)).toBeUndefined();
    expect(await unlockWithPassphrase('x', API)).toEqual({ outcome: 'wrongPassphrase' });
    expect(await unlockWithPassphrase(vectors.passphrase.normalize('NFD'), API)).toEqual({
      outcome: 'unlocked',
    });
    expect(stored<CloudKeyV2>(CLOUD_KEY_KEY)).toEqual(key);
  });

  it('refuses an envelope whose keyId or generation is not the account key', async () => {
    await signedInWithKey();
    secondDevice();
    await signIn(API);
    const real = server.account().key!;
    server.account().key = { ...real, generation: 5 };
    await expect(unlockWithPassphrase('long passphrase', API)).rejects.toMatchObject({
      userKey: 'errorCloudKeyChanged',
    });
    expect(stored(CLOUD_KEY_KEY)).toBeUndefined();
  });

  it('key_unavailable stays needsUnlock and says to change the passphrase elsewhere', async () => {
    await signedInWithKey();
    secondDevice();
    await signIn(API);
    server.intercept = (request) =>
      request.url.endsWith('/v2/keys/open')
        ? new Response(JSON.stringify({ error: 'key_unavailable' }), { status: 500 })
        : undefined;
    await expect(unlockWithPassphrase('long passphrase', API)).rejects.toMatchObject({
      userKey: 'errorCloudKeyUnavailable',
    });
    expect(stored(CLOUD_KEY_KEY)).toBeUndefined();
  });
});

describe('change and reset', () => {
  it('changes without the old passphrase and keeps unlocked devices working', async () => {
    const { key } = await signedInWithKey();
    expect(await changePassphrase('a new passphrase', API)).toEqual({
      outcome: 'changed',
      generation: 2,
    });
    expect(stored<CloudKeyV2>(CLOUD_KEY_KEY)).toEqual({ ...key, generation: 2 });
    secondDevice();
    await signIn(API);
    expect(await unlockWithPassphrase('long passphrase', API)).toEqual({
      outcome: 'wrongPassphrase',
    });
    expect(await unlockWithPassphrase('a new passphrase', API)).toEqual({ outcome: 'unlocked' });
    expect(stored<CloudKeyV2>(CLOUD_KEY_KEY)?.dek).toBe(key.dek);
  });

  it('fails without Google and reports a concurrent change as a conflict', async () => {
    await signedInWithKey();
    google('someone-else');
    await expect(changePassphrase('a new passphrase', API)).rejects.toMatchObject({
      code: 'google_account_mismatch',
    });
    expect(getChromeFake().state.authTokenCacheClears).toBe(1);
    google('person');
    server.intercept = (request) =>
      request.method === 'PUT'
        ? new Response(JSON.stringify({ error: 'generation_conflict' }), { status: 409 })
        : undefined;
    expect(await changePassphrase('a new passphrase', API)).toEqual({ outcome: 'conflict' });
    expect(stored<CloudKeyV2>(CLOUD_KEY_KEY)?.generation).toBe(1);
  });

  it('after a rollback warning (seen 5, server 2) a change sets 3 and the warning stops', async () => {
    const { account, key } = await signedInWithKey();
    server.account().key = { ...server.account().key!, generation: 2 };
    local().set(CLOUD_KEY_KEY, { ...key, generation: 5 });
    expect((await refreshMe(account, API)).rollback).toBe(true);
    expect(stored<CloudKeyV2>(CLOUD_KEY_KEY)?.generation).toBe(5);
    expect(await changePassphrase('a new passphrase', API)).toEqual({
      outcome: 'changed',
      generation: 3,
    });
    expect(stored<CloudKeyV2>(CLOUD_KEY_KEY)?.generation).toBe(3);
    expect((await refreshMe(account, API)).rollback).toBe(false);
  });

  it('a higher generation in me raises the stored one', async () => {
    const { account, key } = await signedInWithKey();
    server.account().key = { ...server.account().key!, generation: 4 };
    await refreshMe(account, API);
    expect(stored<CloudKeyV2>(CLOUD_KEY_KEY)).toEqual({ ...key, generation: 4 });
  });
});

describe('failures keep the data key', () => {
  it.each([401, 403, 409, 410, 500, 503])('a %i', async (status) => {
    const { account, key } = await signedInWithKey();
    const code = {
      401: 'unauthorized',
      403: 'google_refused',
      409: 'key_mismatch',
      410: 'upgrade_required',
      500: 'internal',
      503: 'google_unavailable',
    }[status];
    server.intercept = () => new Response(JSON.stringify({ error: code }), { status });
    await expect(refreshMe(account, API)).rejects.toMatchObject({ status });
    expect(stored(CLOUD_KEY_KEY)).toEqual(key);
    expect(stored(CLOUD_ACCOUNT_KEY) === undefined).toBe(status === 401);
  });

  it('an old 401 does not remove a newer sign-in', async () => {
    const { account } = await signedInWithKey();
    local().set(CLOUD_ACCOUNT_KEY, { ...account, token: 'newer' });
    server.intercept = () =>
      new Response(JSON.stringify({ error: 'unauthorized' }), { status: 401 });
    await expect(refreshMe(account, API)).rejects.toMatchObject({ status: 401 });
    expect(stored<CloudAccountV2>(CLOUD_ACCOUNT_KEY)?.token).toBe('newer');
  });

  it('a sign-out during PBKDF2 makes the late result write nothing', async () => {
    await signIn(API);
    // Signed out while the key is derived: the PUT is answered, the late result is not stored.
    vi.stubGlobal('fetch', async (...args: Parameters<typeof fetch>) => {
      if (args[1]?.method === 'PUT') {
        local().delete(CLOUD_ACCOUNT_KEY);
      }
      return server.fetch(...args);
    });
    const pending = createPassphrase('long passphrase', API);
    await expect(pending).rejects.toBeDefined();
    expect(stored(CLOUD_KEY_KEY)).toBeUndefined();
  });
});

describe('another account', () => {
  it('asks; no means zero record requests and the old key intact', async () => {
    const { key } = await signedInWithKey();
    local().delete(CLOUD_ACCOUNT_KEY);
    google('other');
    await signIn(API);
    expect(stored<CloudAccountV2>(CLOUD_ACCOUNT_KEY)?.uploadConfirmed).toBe(false);
    await cancelAccountSwitch(API);
    expect(stored(CLOUD_ACCOUNT_KEY)).toBeUndefined();
    expect(stored(CLOUD_KEY_KEY)).toEqual(key);
    expect(server.requests.filter((request) => request.url.includes('/v2/records'))).toEqual([]);
  });

  it('yes confirms the upload, which waits for the key', async () => {
    await signedInWithKey();
    local().delete(CLOUD_ACCOUNT_KEY);
    google('other');
    await signIn(API);
    await confirmAccount();
    expect(stored<CloudAccountV2>(CLOUD_ACCOUNT_KEY)?.uploadConfirmed).toBe(true);
  });

  it('the same account never asks; delete here then recreate does not ask here', async () => {
    const { account } = await signedInWithKey();
    local().delete(CLOUD_ACCOUNT_KEY);
    await signIn(API);
    expect(stored<CloudAccountV2>(CLOUD_ACCOUNT_KEY)?.uploadConfirmed).toBe(true);
    local().set(CLOUD_SYNC_META_KEY, { accountId: account.accountId });
    expect(await deleteCloudData(API)).toEqual({ outcome: 'deleted' });
    expect(stored(CLOUD_KEY_KEY)).toBeUndefined();
    expect(stored(CLOUD_SYNC_META_KEY)).toBeUndefined();
    expect(stored(CLOUD_OWNER_KEY)).toEqual({ accountId: null, email: account.email });
    await signIn(API);
    expect(stored<CloudAccountV2>(CLOUD_ACCOUNT_KEY)?.uploadConfirmed).toBe(true);
    expect(stored<CloudAccountV2>(CLOUD_ACCOUNT_KEY)?.accountId).not.toBe(account.accountId);
  });

  it('a device that synced with the deleted account asks after it was recreated', async () => {
    const { account } = await signedInWithKey();
    const other = new Map(local());
    await deleteCloudData(API);
    await signIn(API);
    local().clear();
    for (const [key, value] of other) {
      local().set(key, value);
    }
    local().delete(CLOUD_ACCOUNT_KEY);
    await signIn(API);
    expect(stored<CloudAccountV2>(CLOUD_ACCOUNT_KEY)?.uploadConfirmed).toBe(false);
    expect(stored<CloudAccountV2>(CLOUD_ACCOUNT_KEY)?.accountId).not.toBe(account.accountId);
  });
});

describe('sign-out', () => {
  it('removes the account and this account’s key, keeps the owner', async () => {
    const { account } = await signedInWithKey();
    await signOut(API);
    expect(stored(CLOUD_ACCOUNT_KEY)).toBeUndefined();
    expect(stored(CLOUD_KEY_KEY)).toBeUndefined();
    expect(stored(CLOUD_OWNER_KEY)).toEqual({ accountId: account.accountId, email: account.email });
    expect(getChromeFake().state.authTokenCacheClears).toBe(1);
  });

  it('keeps another account’s key while a confirmation is pending', async () => {
    const { key } = await signedInWithKey();
    local().delete(CLOUD_ACCOUNT_KEY);
    google('other');
    await signIn(API);
    await signOut(API);
    expect(stored(CLOUD_KEY_KEY)).toEqual(key);
  });
});

describe('upgradeCloudStorage', () => {
  it('removes the v1 keys, keeps their email as a legacy owner, and is idempotent', async () => {
    local().set('cloudAccount', { token: 'v1', expiresAt: 1, email: 'old@example.com' });
    local().set('cloudSyncKey', 'abc');
    local().set('cloudSyncMeta', { owner: 'meta@example.com' });
    expect(await upgradeCloudStorage()).toBe(true);
    expect([...local().keys()]).toEqual([CLOUD_OWNER_KEY]);
    expect(stored(CLOUD_OWNER_KEY)).toEqual({
      accountId: null,
      email: 'old@example.com',
      legacy: true,
    });
    expect(await upgradeCloudStorage()).toBe(false);
    local().set('cloudSyncMeta', { owner: 'meta@example.com' });
    await upgradeCloudStorage();
    expect(stored(CLOUD_OWNER_KEY)).toEqual({
      accountId: null,
      email: 'old@example.com',
      legacy: true,
    });
  });

  it('takes the bookkeeping’s owner when v1 was signed out, and reads nothing unconfigured', async () => {
    local().set('cloudSyncMeta', { owner: 'meta@example.com' });
    overrideCloudSyncConfig(() => ({ apiBase: '', googleClientId: 'cid' }));
    expect(await upgradeCloudStorage()).toBe(false);
    expect(local().has('cloudSyncMeta')).toBe(true);
    overrideCloudSyncConfig(() => ({ apiBase: 'https://sync.test', googleClientId: 'cid' }));
    await upgradeCloudStorage();
    expect(stored(CLOUD_OWNER_KEY)).toEqual({
      accountId: null,
      email: 'meta@example.com',
      legacy: true,
    });
  });
});
