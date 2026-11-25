// The v2 routes against a real Postgres (PGlite, the real migrations): sign-in, bearer, me,
// logout, account deletion, the key header, the order of the checks, the closed /v1, CORS.
import type { PGlite } from '@electric-sql/pglite';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { POLICY } from '../../../src/constants.js';
import type { Deps } from '../context.js';
import type { Query, Store } from '../db/store.js';
import { hashToken } from '../tokens.js';
import {
  b64,
  client,
  createTestDb,
  createTestDeps,
  google,
  GOOGLE_DOWN,
  newKey,
  ORIGIN,
  rec,
  request,
  resetDb,
  signUp,
} from './helpers.js';

let db: PGlite;
let query: Query;
let store: Store;
let deps: Deps;
let clock: { now: number };
/** Every store method called, by name, since the test started. */
let calls: string[];

beforeAll(async () => {
  ({ db, query, store } = await createTestDb());
});

afterAll(async () => {
  await db.close();
});

beforeEach(async () => {
  await resetDb(db);
  calls = [];
  const counted = new Proxy(store, {
    get(target, name: keyof Store) {
      const method = target[name];
      return (...args: unknown[]) => {
        calls.push(String(name));
        return (method as (...a: unknown[]) => unknown).apply(target, args);
      };
    },
  });
  ({ deps, clock } = createTestDeps(counted));
});

afterEach(() => {
  vi.restoreAllMocks();
});

const call = (req: Request) => client(deps).call(req);

async function signIn(sub = 'sub-1', email = 'a@example.com') {
  const { status, body } = await call(
    request('POST', '/v2/auth/google', { body: { accessToken: google(sub, email) } }),
  );
  expect(status).toBe(200);
  return body;
}

describe('POST /v2/auth/google', () => {
  it('creates the account and answers its bearer, expiry, id, email and no key', async () => {
    const { status, body, res } = await call(
      request('POST', '/v2/auth/google', { body: { accessToken: google() } }),
    );
    expect(status).toBe(200);
    expect(res.headers.get('Content-Type')).toBe('application/json; charset=utf-8');
    expect(res.headers.get('Cache-Control')).toBe('no-store');
    expect(Object.keys(body).sort()).toEqual(['accountId', 'email', 'expiresAt', 'key', 'token']);
    expect(body.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(body.expiresAt).toBe(clock.now + POLICY.signIn.tokenLifetimeMs);
    expect(body.accountId).toMatch(/^[0-9a-f-]{36}$/);
    expect(body.email).toBe('a@example.com');
    expect(body.key).toBeNull();
  });

  it('stores only the hash of the bearer', async () => {
    const { token } = await signIn();
    const rows = await query('SELECT token_hash FROM account_tokens');
    expect(rows).toEqual([{ token_hash: hashToken(token) }]);
    expect(JSON.stringify(await query('SELECT * FROM account_tokens'))).not.toContain(token);
  });

  it('finds the same account again by sub, refreshes the email and answers the key', async () => {
    const first = await signUp(deps, 'sub-1', 'old@example.com');
    const again = await signIn('sub-1', 'new@example.com');
    expect(again.accountId).toBe(first.accountId);
    expect(again.email).toBe('new@example.com');
    expect(again.key).toEqual({ keyId: first.keyId, generation: 1 });
    expect(await query('SELECT count(*)::int AS n FROM accounts')).toEqual([{ n: 1 }]);
  });

  it("drops the account's expired bearers, and only those", async () => {
    const old = await signIn();
    clock.now += POLICY.signIn.tokenLifetimeMs / 2;
    const middle = await signIn();
    clock.now += POLICY.signIn.tokenLifetimeMs / 2;
    await signIn();
    const hashes = (await query('SELECT token_hash FROM account_tokens')).map((r) => r.token_hash);
    expect(hashes).not.toContain(hashToken(old.token));
    expect(hashes).toContain(hashToken(middle.token));
    expect(hashes).toHaveLength(2);
  });

  it('answers a token Google refuses with 403 google_refused, writing nothing', async () => {
    const { status, text } = await call(
      request('POST', '/v2/auth/google', { body: { accessToken: 'not-google' } }),
    );
    expect(status).toBe(403);
    expect(text).toBe('{"error":"google_refused"}');
    expect(calls).toEqual([]);
  });

  it('answers 503 google_unavailable when Google cannot answer, and logs no token', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { status, text } = await call(
      request('POST', '/v2/auth/google', { body: { accessToken: GOOGLE_DOWN } }),
    );
    expect(status).toBe(503);
    expect(text).toBe('{"error":"google_unavailable"}');
    expect(JSON.stringify(log.mock.calls)).not.toContain(GOOGLE_DOWN);
    expect(calls).toEqual([]);
  });

  it.each([
    ['no body', undefined],
    ['not an object', ['x']],
    ['an extra field', { accessToken: google(), key: 1 }],
    ['an empty token', { accessToken: '' }],
    ['a token over the limit', { accessToken: 'a'.repeat(POLICY.request.maxAccessTokenChars + 1) }],
    ['a number', { accessToken: 7 }],
  ])('answers %s with 400', async (_name, body) => {
    const { status, text } = await call(request('POST', '/v2/auth/google', { body }));
    expect(status).toBe(400);
    expect(text).toBe('{"error":"bad_request"}');
  });
});

describe('the bearer', () => {
  it.each([
    ['no header', {}],
    ['another scheme', { headers: { Authorization: 'Basic abc' } }],
    ['a bad character', { headers: { Authorization: 'Bearer a+b' } }],
    ['an unknown bearer', { token: 'A'.repeat(43) }],
  ])('%s is 401 unauthorized', async (_name, options) => {
    const { status, text } = await call(request('GET', '/v2/me', options));
    expect(status).toBe(401);
    expect(text).toBe('{"error":"unauthorized"}');
  });

  it('is accepted until it expires, and refused from then on', async () => {
    const { token } = await signIn();
    clock.now += POLICY.signIn.tokenLifetimeMs - 1;
    expect((await call(request('GET', '/v2/me', { token }))).status).toBe(200);
    clock.now += 1;
    expect((await call(request('GET', '/v2/me', { token }))).status).toBe(401);
  });
});

describe('GET /v2/me and logout', () => {
  it('answers the account, its key and its usage', async () => {
    const account = await signUp(deps);
    await call(
      request('POST', '/v2/records', {
        token: account.token,
        keyId: account.keyId,
        body: { records: [rec('image', 'i1', 1), rec('session', 's1', 1)] },
      }),
    );
    const { status, body } = await call(request('GET', '/v2/me', { token: account.token }));
    expect(status).toBe(200);
    expect(body).toEqual({
      accountId: account.accountId,
      email: 'sub-1@example.com',
      key: { keyId: account.keyId, generation: 1 },
      usage: {
        bytes: 2 * (POLICY.record.maxTombstoneChars + POLICY.record.overheadBytes),
        screenshots: 1,
      },
    });
  });

  it('logs out the presented bearer only', async () => {
    const a = await signIn();
    const b = await signIn();
    const res = await call(request('POST', '/v2/auth/logout', { token: a.token }));
    expect(res.status).toBe(204);
    expect(res.text).toBe('');
    expect((await call(request('GET', '/v2/me', { token: a.token }))).status).toBe(401);
    expect((await call(request('GET', '/v2/me', { token: b.token }))).status).toBe(200);
  });
});

describe('DELETE /v2/account', () => {
  it("deletes the account, its bearers and records, and no one else's", async () => {
    const a = await signUp(deps, 'sub-a');
    const b = await signUp(deps, 'sub-b');
    for (const account of [a, b]) {
      await call(
        request('POST', '/v2/records', {
          token: account.token,
          keyId: account.keyId,
          body: { records: [rec('session', 's', 1)] },
        }),
      );
    }
    const res = await call(
      request('DELETE', '/v2/account', { token: a.token, body: { accessToken: a.accessToken } }),
    );
    expect(res.status).toBe(204);
    expect((await call(request('GET', '/v2/me', { token: a.token }))).status).toBe(401);
    expect((await call(request('GET', '/v2/me', { token: b.token }))).status).toBe(200);
    expect(await query('SELECT count(*)::int AS n FROM account_records')).toEqual([{ n: 1 }]);
    // Signing in again makes a new account, with a new id and no key.
    const again = await signIn('sub-a');
    expect(again.accountId).not.toBe(a.accountId);
    expect(again.key).toBeNull();
  });

  it('needs a Google token of the account: a bearer alone deletes nothing', async () => {
    const a = await signUp(deps, 'sub-a');
    await signUp(deps, 'sub-b');
    const cases: [object | undefined, number, string][] = [
      [undefined, 400, 'bad_request'],
      [{}, 400, 'bad_request'],
      [{ accessToken: 'refused' }, 403, 'google_refused'],
      [{ accessToken: google('sub-b') }, 403, 'google_account_mismatch'],
      [{ accessToken: GOOGLE_DOWN }, 503, 'google_unavailable'],
    ];
    vi.spyOn(console, 'error').mockImplementation(() => {});
    for (const [body, status, code] of cases) {
      const res = await call(request('DELETE', '/v2/account', { token: a.token, body }));
      expect([res.status, res.body.error]).toEqual([status, code]);
    }
    expect(await query('SELECT count(*)::int AS n FROM accounts')).toEqual([{ n: 2 }]);
  });
});

describe('the key header', () => {
  it.each([
    ['missing', undefined],
    ['too short', 'AAAA'],
    ['base64, not base64url', 'AAAAAAAAAAAAAAAAAAAA+/'],
    ['not canonical', 'AAAAAAAAAAAAAAAAAAAAAB'],
  ])('%s is 400', async (_name, keyId) => {
    const a = await signUp(deps);
    for (const method of ['GET', 'POST']) {
      const res = await call(
        request(method, '/v2/records', {
          token: a.token,
          keyId,
          body: method === 'POST' ? { records: [] } : undefined,
        }),
      );
      expect([res.status, res.text]).toEqual([400, '{"error":"bad_request"}']);
    }
  });

  it('is 409 key_missing before a key exists, and key_mismatch for another key', async () => {
    const { token } = await signIn();
    const other = newKey().envelope.keyId;
    expect((await call(request('GET', '/v2/records', { token, keyId: other }))).text).toBe(
      '{"error":"key_missing"}',
    );
    const a = await signUp(deps, 'sub-2');
    const res = await call(request('GET', '/v2/records', { token: a.token, keyId: other }));
    expect([res.status, res.text]).toEqual([409, '{"error":"key_mismatch"}']);
  });

  it('answers 409 without reading the body, however large', async () => {
    const a = await signUp(deps);
    const pull = vi.fn((controller: ReadableStreamDefaultController) => controller.close());
    const body = new ReadableStream({ pull }, { highWaterMark: 0 });
    const res = await client(deps).app.fetch(
      new Request('https://x.test/v2/records', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${a.token}`,
          'Tabinet-Key-Id': newKey().envelope.keyId,
          'Content-Length': String(POLICY.request.maxBodyBytes * 2),
        },
        body,
        duplex: 'half',
      }),
    );
    expect(res.status).toBe(409);
    expect(pull).not.toHaveBeenCalled();
  });
});

describe('the order of the checks (spec 4.1)', () => {
  it('decides 404 and 405 before the bearer', async () => {
    expect((await call(request('GET', '/v2/nowhere', { token: 'x' }))).status).toBe(404);
    const res = await call(request('PATCH', '/v2/records', { token: 'x' }));
    expect([res.status, res.res.headers.get('Allow')]).toEqual([405, 'GET, POST']);
    expect(calls).toEqual([]);
  });

  it('decides the bearer before the key header and the body', async () => {
    const res = await call(request('POST', '/v2/records', { keyId: 'bad', rawBody: '{' }));
    expect(res.status).toBe(401);
  });

  it('decides the body before Google, and Google before the database', async () => {
    const { token } = await signIn();
    const verify = vi.fn(deps.verifyGoogleToken);
    deps.verifyGoogleToken = verify;
    const oversized = { accessToken: 'a'.repeat(POLICY.request.maxSmallBodyBytes) };
    for (const [method, path] of [
      ['POST', '/v2/keys/open'],
      ['PUT', '/v2/keys'],
      ['DELETE', '/v2/account'],
    ]) {
      calls = [];
      const res = await call(request(method, path, { token, body: oversized }));
      expect(res.status).toBe(413);
      expect(calls).toEqual(['findAccountByToken']);
      const refused = await call(
        request(method, path, {
          token,
          body:
            path === '/v2/keys' ? { accessToken: 'refused', ...newKey() } : { accessToken: 'x' },
        }),
      );
      expect(refused.status).toBe(403);
      // Only the bearer lookup: Google refused before anything else was read or written.
      expect(calls).toEqual(['findAccountByToken', 'findAccountByToken']);
    }
    expect(verify).toHaveBeenCalledTimes(3);
  });
});

describe('/v1 is closed', () => {
  const PATHS = [
    '/v1',
    '/v1/',
    '/v1/me',
    '/v1/auth/google',
    '/v1/auth/logout',
    '/v1/keys',
    '/v1/records',
    '/v1/records?since=0&limit=500',
    '/v1/account',
    '/v1/nowhere/at/all',
    '/v1/%6De',
  ];

  it.each(PATHS)(
    '%s answers 410 to every method, with or without a bearer and a body',
    async (path) => {
      const { token } = await signIn();
      calls = [];
      for (const method of ['GET', 'POST', 'PUT', 'DELETE', 'PATCH']) {
        for (const options of [
          {},
          { token },
          { token, rawBody: '{"records":[]}' },
          { rawBody: 'x'.repeat(POLICY.request.maxBodyBytes + 1) },
        ]) {
          if (method === 'GET' && 'rawBody' in options) {
            continue; // a GET cannot carry a body
          }
          const res = await call(request(method, path, { ...options, origin: ORIGIN }));
          expect(res.status).toBe(410);
          expect(res.text).toBe('{"error":"upgrade_required"}');
          expect(res.res.headers.get('Access-Control-Allow-Origin')).toBe(ORIGIN);
        }
      }
      expect(calls).toEqual([]);
    },
  );

  it('answers HEAD with a 410 and no body, and OPTIONS with the usual 204', async () => {
    const head = await client(deps).app.fetch(request('HEAD', '/v1/me'));
    expect(head.status).toBe(410);
    expect(head.body).toBeNull();
    const options = await call(request('OPTIONS', '/v1/me', { origin: ORIGIN }));
    expect(options.status).toBe(204);
    expect(calls).toEqual([]);
  });

  it('leaves look-alike paths to the router', async () => {
    for (const path of ['/v10/me', '/v1me', '/V1/me', '/v2/v1/me']) {
      expect((await call(request('GET', path))).status).toBe(404);
    }
  });
});

describe('GET /v2/records query', () => {
  it('ignores a parameter it does not name, such as the path Vercel adds', async () => {
    const a = await signUp(deps);
    const res = await client(deps).app.fetch(
      request('GET', '/v2/records?path=records&limit=1&kinds=x', {
        token: a.token,
        keyId: a.keyId,
      }),
    );
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toBe('application/x-ndjson; charset=utf-8');
    await res.body?.cancel();
  });

  it.each(['-1', '1.5', ' 1', '', '1e3', '0x1', '12345678901234567', '9007199254740992', '١'])(
    'refuses since=%j with 400',
    async (since) => {
      const a = await signUp(deps);
      const res = await call(
        request('GET', `/v2/records?since=${encodeURIComponent(since)}`, {
          token: a.token,
          keyId: a.keyId,
        }),
      );
      expect([res.status, res.text]).toEqual([400, '{"error":"bad_request"}']);
    },
  );

  it('takes 16 digits that are a safe integer', async () => {
    const a = await signUp(deps);
    const res = await client(deps).app.fetch(
      request('GET', '/v2/records?since=9007199254740991', { token: a.token, keyId: a.keyId }),
    );
    expect(res.status).toBe(200);
    await res.body?.cancel();
  });
});

describe('CORS', () => {
  it('puts the headers on errors too, and lists Tabinet-Key-Id in a preflight', async () => {
    const res = await call(request('GET', '/v2/me', { origin: ORIGIN }));
    expect(res.status).toBe(401);
    expect(res.res.headers.get('Access-Control-Allow-Origin')).toBe(ORIGIN);
    expect(res.res.headers.get('Vary')).toBe('Origin');
    const preflight = await call(request('OPTIONS', '/v2/records', { origin: ORIGIN }));
    expect(preflight.res.headers.get('Access-Control-Allow-Headers')).toBe(
      'Authorization, Content-Type, Tabinet-Key-Id',
    );
    expect(preflight.res.headers.get('Access-Control-Allow-Methods')).toBe(
      'GET, POST, PUT, DELETE',
    );
    expect(preflight.res.headers.get('Access-Control-Max-Age')).toBe('600');
  });

  it('gives another origin no CORS headers', async () => {
    const res = await call(request('GET', '/v2/me', { origin: 'https://evil.test' }));
    expect(res.res.headers.get('Access-Control-Allow-Origin')).toBeNull();
    expect(res.res.headers.get('Vary')).toBe('Origin');
  });
});

describe('a database failure', () => {
  it('is a 500 internal that logs a name only', async () => {
    const a = await signUp(deps);
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    deps.store = {
      ...store,
      findAccountByToken: async () => {
        throw new Error(`relation for ${a.token} does not exist`);
      },
    };
    const res = await call(request('GET', '/v2/me', { token: a.token }));
    expect([res.status, res.text]).toEqual([500, '{"error":"internal"}']);
    expect(log.mock.calls).toEqual([['tabinet-server: request failed', 'GET', 'Error']]);
  });
});

it('answers an unknown base64 body field shape with 400 on records', async () => {
  const a = await signUp(deps);
  const res = await call(
    request('POST', '/v2/records', {
      token: a.token,
      keyId: a.keyId,
      body: { records: [{ ...rec('session', 's', 1), ciphertext: b64(16) }] },
    }),
  );
  expect(res.status).toBe(400);
});
