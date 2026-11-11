import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  apiUrl,
  authGoogle,
  CloudUnauthorizedError,
  deleteAccount,
  getRecords,
  isCloudKeySetup,
  logout,
  me,
  postRecords,
  putKeys,
} from '@/lib/cloud-api';
import { overrideCloudSyncConfig } from '@/lib/cloud-config';
import { ExplainedError, errorMessage } from '@/lib/error-message';
import { t } from '@/lib/i18n';
import type { CloudKeySetup, CloudRecordWithSeq } from '@/types';

import { fakeFetch, jsonResponse } from './cloud-fetch';

const API = 'https://sync.test';
const SETUP: CloudKeySetup = {
  kdf: { name: 'PBKDF2', hash: 'SHA-256', iterations: 600000 },
  salt: 'c2FsdHNhbHRzYWx0c2FsdA==',
  check: 'Y2hlY2s=',
  checkIv: 'aXZpdml2aXZpdml2',
};
const RECORD: CloudRecordWithSeq = {
  kind: 'session',
  id: 'abc-1',
  updatedAt: 1700000000000,
  deleted: false,
  iv: 'aXY=',
  ciphertext: 'Y3Q=',
  seq: 7,
};

beforeEach(() => {
  overrideCloudSyncConfig(() => ({ apiBase: `${API}/`, googleClientId: 'client.apps' }));
});

afterEach(() => {
  overrideCloudSyncConfig();
});

describe('apiUrl', () => {
  it('joins the base and the route without a double slash', () => {
    expect(apiUrl('https://sync.test/', '/v1/me')).toBe('https://sync.test/v1/me');
    expect(apiUrl('https://sync.test', '/v1/me')).toBe('https://sync.test/v1/me');
  });
});

describe('authGoogle', () => {
  it('posts the Google access token and reads the account, with no Authorization header', async () => {
    const server = fakeFetch(
      jsonResponse(200, { token: 'tok', expiresAt: 1800000000000, email: 'a@b.c', keySetup: null }),
    );
    const result = await authGoogle('ya29.access-token', { fetch: server.fetch });
    expect(result).toEqual({
      token: 'tok',
      expiresAt: 1800000000000,
      email: 'a@b.c',
      keySetup: null,
    });
    expect(server.requests[0]).toMatchObject({
      url: `${API}/v1/auth/google`,
      method: 'POST',
      body: { accessToken: 'ya29.access-token' },
    });
    expect(server.requests[0]?.headers.authorization).toBeUndefined();
    expect(server.requests[0]?.headers['content-type']).toBe('application/json');
  });

  it('reads an ISO expiry as milliseconds and keeps a key setup', async () => {
    const server = fakeFetch(
      jsonResponse(200, {
        token: 'tok',
        expiresAt: '2030-01-01T00:00:00.000Z',
        email: 'a@b.c',
        keySetup: SETUP,
      }),
    );
    const result = await authGoogle('x', { fetch: server.fetch });
    expect(result.expiresAt).toBe(Date.parse('2030-01-01T00:00:00.000Z'));
    expect(result.keySetup).toEqual(SETUP);
  });

  it('refuses an answer of the wrong shape', async () => {
    const server = fakeFetch(jsonResponse(200, { token: 'tok', email: 'a@b.c' }));
    const err: unknown = await authGoogle('x', { fetch: server.fetch }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ExplainedError);
    expect(errorMessage(err)).toBe(t('errorCloudBadResponse'));
  });

  it('explains a 401 as a failed sign-in, not as being signed out', async () => {
    const server = fakeFetch(jsonResponse(401, { error: 'unauthorized' }));
    const err: unknown = await authGoogle('x', { fetch: server.fetch }).catch((e: unknown) => e);
    expect(err).not.toBeInstanceOf(CloudUnauthorizedError);
    expect(errorMessage(err)).toBe(t('errorCloudSignInFailed'));
  });
});

describe('isCloudKeySetup', () => {
  const withKdf = (iterations: number) => ({ ...SETUP, kdf: { ...SETUP.kdf, iterations } });

  it('accepts a setup within the bounds the server enforces', () => {
    expect(isCloudKeySetup(SETUP)).toBe(true);
    expect(isCloudKeySetup(withKdf(100_000))).toBe(true);
    expect(isCloudKeySetup(withKdf(10_000_000))).toBe(true);
  });

  it('refuses a round count PBKDF2 should never be asked for', () => {
    expect(isCloudKeySetup(withKdf(1000))).toBe(false);
    expect(isCloudKeySetup(withKdf(10_000_001))).toBe(false);
    expect(isCloudKeySetup(withKdf(Number.MAX_SAFE_INTEGER))).toBe(false);
  });

  it('refuses text that is not base64, a short or long salt, and an iv that is not 12 bytes', () => {
    expect(isCloudKeySetup({ ...SETUP, salt: 'not base64!' })).toBe(false);
    expect(isCloudKeySetup({ ...SETUP, salt: btoa('x'.repeat(15)) })).toBe(false);
    expect(isCloudKeySetup({ ...SETUP, salt: btoa('x'.repeat(65)) })).toBe(false);
    expect(isCloudKeySetup({ ...SETUP, check: '' })).toBe(false);
    expect(isCloudKeySetup({ ...SETUP, check: 'Y2hlY2s' })).toBe(false);
    expect(isCloudKeySetup({ ...SETUP, checkIv: btoa('x'.repeat(16)) })).toBe(false);
  });

  it('makes such an answer a bad response before anything is derived', async () => {
    const server = fakeFetch(jsonResponse(200, { email: 'a@b.c', keySetup: withKdf(2 ** 52) }));
    const err: unknown = await me('tok', { fetch: server.fetch }).catch((e: unknown) => e);
    expect(errorMessage(err)).toBe(t('errorCloudBadResponse'));
  });
});

describe('statuses', () => {
  it('turns a 401 into CloudUnauthorizedError, explained as signed out', async () => {
    const server = fakeFetch(jsonResponse(401, { error: 'unauthorized' }));
    const err: unknown = await me('tok', { fetch: server.fetch }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CloudUnauthorizedError);
    expect(errorMessage(err)).toBe(t('errorCloudSignedOut'));
  });

  it('explains a 5xx as a server problem and a 4xx as a refusal', async () => {
    const down = fakeFetch(jsonResponse(503, { error: 'unavailable' }));
    expect(errorMessage(await me('tok', { fetch: down.fetch }).catch((e: unknown) => e))).toBe(
      t('errorCloudServer'),
    );
    const bad = fakeFetch(jsonResponse(400, { error: 'bad_request' }));
    expect(errorMessage(await me('tok', { fetch: bad.fetch }).catch((e: unknown) => e))).toBe(
      t('errorCloudRejected'),
    );
  });

  it('explains a network failure as unreachable, without the token in the message', async () => {
    const offline = fakeFetch(new TypeError('Failed to fetch'));
    const err: unknown = await logout('secret-token', { fetch: offline.fetch }).catch(
      (e: unknown) => e,
    );
    expect(errorMessage(err)).toBe(t('errorCloudUnreachable'));
    expect(String(err)).not.toContain('secret-token');
  });
});

describe('routes', () => {
  it('sends the bearer token to me, logout and deleteAccount', async () => {
    const server = fakeFetch(
      jsonResponse(200, { email: 'a@b.c', keySetup: SETUP }),
      jsonResponse(204),
      jsonResponse(204),
    );
    expect(await me('tok', { fetch: server.fetch })).toEqual({ email: 'a@b.c', keySetup: SETUP });
    await logout('tok', { fetch: server.fetch });
    await deleteAccount('tok', { fetch: server.fetch });
    expect(server.requests.map((r) => `${r.method} ${r.url}`)).toEqual([
      `GET ${API}/v1/me`,
      `POST ${API}/v1/auth/logout`,
      `DELETE ${API}/v1/account`,
    ]);
    for (const request of server.requests) {
      expect(request.headers.authorization).toBe('Bearer tok');
    }
  });

  it('putKeys: 201 is created, 409 key_exists is exists, another 409 is a refusal', async () => {
    const server = fakeFetch(
      jsonResponse(201),
      jsonResponse(409, { error: 'key_exists' }),
      jsonResponse(409, { error: 'conflict' }),
    );
    expect(await putKeys('tok', SETUP, { fetch: server.fetch })).toBe('created');
    expect(server.requests[0]).toMatchObject({ method: 'PUT', url: `${API}/v1/keys`, body: SETUP });
    expect(await putKeys('tok', SETUP, { fetch: server.fetch })).toBe('exists');
    const err: unknown = await putKeys('tok', SETUP, { fetch: server.fetch }).catch(
      (e: unknown) => e,
    );
    expect(errorMessage(err)).toBe(t('errorCloudRejected'));
  });

  it('getRecords asks with since and limit and checks every record', async () => {
    const server = fakeFetch(
      jsonResponse(200, { records: [RECORD], next: 7, hasMore: false }),
      jsonResponse(200, { records: [{ ...RECORD, kind: 'tabs' }], next: 7, hasMore: false }),
    );
    expect(await getRecords('tok', 3, 50, { fetch: server.fetch })).toEqual({
      records: [RECORD],
      next: 7,
      hasMore: false,
    });
    expect(server.requests[0]?.url).toBe(
      `${API}/v1/records?since=3&kinds=session%2Csettings%2Cnotes%2Cimage&limit=50`,
    );
    const err: unknown = await getRecords('tok', 3, undefined, { fetch: server.fetch }).catch(
      (e: unknown) => e,
    );
    expect(errorMessage(err)).toBe(t('errorCloudBadResponse'));
    expect(server.requests[1]?.url).toBe(
      `${API}/v1/records?since=3&kinds=session%2Csettings%2Cnotes%2Cimage`,
    );
  });

  it('postRecords sends the records and reads applied and stale results', async () => {
    const { seq: _seq, ...record } = RECORD;
    const results = [
      { kind: 'session', id: 'abc-1', status: 'applied', seq: 8 },
      {
        kind: 'settings',
        id: 'main',
        status: 'stale',
        current: { ...RECORD, kind: 'settings', id: 'main' },
      },
    ];
    const server = fakeFetch(jsonResponse(200, { results }));
    expect(await postRecords('tok', [record], { fetch: server.fetch })).toEqual(results);
    expect(server.requests[0]).toMatchObject({
      method: 'POST',
      url: `${API}/v1/records`,
      body: { records: [record] },
    });
  });

  it('reads notes and screenshot records, and a screenshot refused over the cap', async () => {
    const page = {
      records: [
        { ...RECORD, kind: 'notes', id: 'dQw4w9WgXcQ' },
        { ...RECORD, kind: 'image', id: 'img-1' },
      ],
      next: 9,
      hasMore: false,
    };
    const get = fakeFetch(jsonResponse(200, page));
    expect((await getRecords('tok', 0, undefined, { fetch: get.fetch })).records).toEqual(
      page.records,
    );
    const refused = [{ kind: 'image', id: 'img-1', status: 'rejected', reason: 'image_limit' }];
    const post = fakeFetch(jsonResponse(200, { results: refused }));
    const { seq: _seq, ...record } = RECORD;
    expect(await postRecords('tok', [record], { fetch: post.fetch })).toEqual(refused);
    // A kind this version does not know is still a bad answer.
    const odd = fakeFetch(jsonResponse(200, { ...page, records: [{ ...RECORD, kind: 'photo' }] }));
    await expect(getRecords('tok', 0, undefined, { fetch: odd.fetch })).rejects.toThrow();
  });
});
