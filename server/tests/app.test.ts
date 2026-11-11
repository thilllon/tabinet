import type { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { type Deps, handle } from '../src/app.js';
import { IMAGE_RECORD_LIMIT, type Query, type Store } from '../src/store.js';
import { TOKEN_TTL_MS } from '../src/tokens.js';
import type { StoredRecord } from '../src/types.js';
import {
  b64,
  createTestDb,
  createTestDeps,
  imageRecord,
  ORIGIN,
  request,
  resetDb,
  sessionRecord,
  tombstone,
  validKeySetup,
} from './helpers.js';

let db: PGlite;
let query: Query;
let store: Store;
let deps: Deps;
let clock: { now: number };

beforeAll(async () => {
  ({ db, query, store } = await createTestDb());
});

afterAll(async () => {
  await db.close();
});

beforeEach(async () => {
  await resetDb(db);
  ({ deps, clock } = createTestDeps(store));
});

/** Every field any route answers with; each test reads the ones its route sends. */
interface ApiBody {
  error: string;
  token: string;
  expiresAt: number;
  email: string;
  keySetup: unknown;
  records: StoredRecord[];
  next: number;
  hasMore: boolean;
  results: { kind: string; id: string; status: string; seq?: number; current: StoredRecord }[];
}

async function call(req: Request): Promise<{ status: number; body: ApiBody; res: Response }> {
  const res = await handle(req, deps);
  const text = await res.text();
  const body: unknown = text === '' ? undefined : JSON.parse(text);
  return { status: res.status, body: body as ApiBody, res };
}

async function signIn(sub = 'sub-1', email = 'a@example.com'): Promise<string> {
  const { status, body } = await call(
    request('POST', '/v1/auth/google', { body: { accessToken: `google:${sub}:${email}` } }),
  );
  expect(status).toBe(200);
  return body.token;
}

describe('POST /v1/auth/google', () => {
  it('creates the user and returns a token, its expiry, the email and no key setup', async () => {
    const { status, body } = await call(
      request('POST', '/v1/auth/google', { body: { accessToken: 'google:sub-1:a@example.com' } }),
    );
    expect(status).toBe(200);
    expect(body).toEqual({
      token: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/),
      expiresAt: clock.now + TOKEN_TTL_MS,
      email: 'a@example.com',
      keySetup: null,
    });
  });

  it('stores only the hash of the token', async () => {
    const token = await signIn();
    const rows = await query('SELECT token_hash FROM auth_tokens');
    expect(rows).toHaveLength(1);
    expect(rows[0].token_hash).not.toBe(token);
  });

  it('finds the same user again by sub and refreshes the email', async () => {
    await signIn('sub-1', 'old@example.com');
    const token = await signIn('sub-1', 'new@example.com');
    expect((await query('SELECT email FROM users')).map((r) => r.email)).toEqual([
      'new@example.com',
    ]);
    const { body } = await call(request('GET', '/v1/me', { token }));
    expect(body.email).toBe('new@example.com');
  });

  it('returns the existing key setup on a later sign-in', async () => {
    const token = await signIn();
    await call(request('PUT', '/v1/keys', { token, body: validKeySetup() }));
    const { body } = await call(
      request('POST', '/v1/auth/google', { body: { accessToken: 'google:sub-1:a@example.com' } }),
    );
    expect(body.keySetup).toEqual(validKeySetup());
  });

  it('refuses a token Google does not vouch for with 401', async () => {
    const { status, body } = await call(
      request('POST', '/v1/auth/google', { body: { accessToken: 'forged' } }),
    );
    expect(status).toBe(401);
    expect(body).toEqual({ error: 'unauthorized' });
    expect(await query('SELECT id FROM users')).toEqual([]);
  });

  it.each([
    ['no body', undefined],
    ['not JSON', '{'],
    ['no accessToken', '{}'],
    ['a number', '{"accessToken":5}'],
    ['an empty accessToken', '{"accessToken":""}'],
    ['an extra field', '{"accessToken":"google:a:b","x":1}'],
    ['a token over the length bound', JSON.stringify({ accessToken: 'x'.repeat(4097) })],
  ])('answers %s with 400', async (_name, rawBody) => {
    const { status, body } = await call(request('POST', '/v1/auth/google', { rawBody }));
    expect(status).toBe(400);
    expect(body).toEqual({ error: 'bad_request' });
  });

  it('answers 500 when Google cannot be reached, and logs no token', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    deps.verifyGoogleToken = async () => {
      throw new TypeError('fetch failed for secret-token');
    };
    const { status, body } = await call(
      request('POST', '/v1/auth/google', { body: { accessToken: 'google:a:b' } }),
    );
    expect(status).toBe(500);
    expect(body).toEqual({ error: 'internal' });
    expect(JSON.stringify(log.mock.calls)).not.toContain('secret-token');
    log.mockRestore();
  });
});

describe('authentication', () => {
  const routes: [string, string][] = [
    ['POST', '/v1/auth/logout'],
    ['GET', '/v1/me'],
    ['PUT', '/v1/keys'],
    ['GET', '/v1/records'],
    ['POST', '/v1/records'],
    ['DELETE', '/v1/account'],
  ];

  it.each(routes)('%s %s needs a token', async (method, path) => {
    const { status, body } = await call(request(method, path));
    expect(status).toBe(401);
    expect(body).toEqual({ error: 'unauthorized' });
  });

  it.each(routes)('%s %s refuses an unknown token', async (method, path) => {
    await signIn();
    const { status } = await call(request(method, path, { token: 'A'.repeat(43) }));
    expect(status).toBe(401);
  });

  it('refuses a malformed Authorization header', async () => {
    const res = await handle(
      new Request('https://x.test/v1/me', { headers: { Authorization: 'Basic abc' } }),
      deps,
    );
    expect(res.status).toBe(401);
  });

  it('accepts a token until it expires, and refuses it from then on', async () => {
    const token = await signIn();
    clock.now += TOKEN_TTL_MS - 1;
    expect((await call(request('GET', '/v1/me', { token }))).status).toBe(200);
    clock.now += 1;
    const { status, body } = await call(request('GET', '/v1/me', { token }));
    expect(status).toBe(401);
    expect(body).toEqual({ error: 'unauthorized' });
  });

  it("drops the user's expired tokens at the next sign-in", async () => {
    await signIn();
    clock.now += TOKEN_TTL_MS + 1;
    await signIn();
    expect(await query('SELECT token_hash FROM auth_tokens')).toHaveLength(1);
  });
});

describe('POST /v1/auth/logout', () => {
  it('deletes only the presented token', async () => {
    const first = await signIn();
    const second = await signIn();
    const { status, body } = await call(request('POST', '/v1/auth/logout', { token: first }));
    expect(status).toBe(204);
    expect(body).toBeUndefined();
    expect((await call(request('GET', '/v1/me', { token: first }))).status).toBe(401);
    expect((await call(request('GET', '/v1/me', { token: second }))).status).toBe(200);
  });
});

describe('GET /v1/me', () => {
  it('returns the email and the key setup', async () => {
    const token = await signIn();
    expect((await call(request('GET', '/v1/me', { token }))).body).toEqual({
      email: 'a@example.com',
      keySetup: null,
    });
  });
});

describe('PUT /v1/keys', () => {
  it('sets the key setup once (201), then refuses another (409) and keeps the first', async () => {
    const token = await signIn();
    const first = await call(request('PUT', '/v1/keys', { token, body: validKeySetup() }));
    expect(first.status).toBe(201);
    const other = { ...validKeySetup(), salt: b64(16, 9) };
    const second = await call(request('PUT', '/v1/keys', { token, body: other }));
    expect(second.status).toBe(409);
    expect(second.body).toEqual({ error: 'key_exists' });
    expect((await call(request('GET', '/v1/me', { token }))).body.keySetup).toEqual(
      validKeySetup(),
    );
  });

  it("keeps each user's key setup apart", async () => {
    const a = await signIn('a', 'a@example.com');
    const b = await signIn('b', 'b@example.com');
    expect(
      (await call(request('PUT', '/v1/keys', { token: a, body: validKeySetup() }))).status,
    ).toBe(201);
    expect((await call(request('GET', '/v1/me', { token: b }))).body.keySetup).toBeNull();
  });

  it('refuses a bad key setup with 400', async () => {
    const token = await signIn();
    const bad = {
      ...validKeySetup(),
      kdf: { name: 'PBKDF2', hash: 'SHA-256', iterations: 99_999 },
    };
    const { status, body } = await call(request('PUT', '/v1/keys', { token, body: bad }));
    expect(status).toBe(400);
    expect(body).toEqual({ error: 'bad_request' });
    expect((await call(request('GET', '/v1/me', { token }))).body.keySetup).toBeNull();
  });
});

describe('records', () => {
  async function post(token: string, records: unknown[]) {
    return call(request('POST', '/v1/records', { token, body: { records } }));
  }

  async function get(token: string, query = '') {
    return call(request('GET', `/v1/records${query}`, { token }));
  }

  it('stores records and lists them back with their seq', async () => {
    const token = await signIn();
    const { status, body } = await post(token, [sessionRecord('a', 10), sessionRecord('b', 20)]);
    expect(status).toBe(200);
    expect(body.results).toEqual([
      { kind: 'session', id: 'a', status: 'applied', seq: expect.any(Number) },
      { kind: 'session', id: 'b', status: 'applied', seq: expect.any(Number) },
    ]);
    const listed = await get(token);
    expect(listed.status).toBe(200);
    expect(listed.body.records).toEqual([
      { ...sessionRecord('a', 10), seq: body.results[0].seq },
      { ...sessionRecord('b', 20), seq: body.results[1].seq },
    ]);
    expect(listed.body.next).toBe(body.results[1].seq);
    expect(listed.body.hasMore).toBe(false);
  });

  it('accepts an empty list', async () => {
    const token = await signIn();
    expect((await post(token, [])).body).toEqual({ results: [] });
  });

  it('returns next = since when nothing is newer', async () => {
    const token = await signIn();
    expect((await get(token, '?since=42')).body).toEqual({ records: [], next: 42, hasMore: false });
  });

  it('pages with since and limit', async () => {
    const token = await signIn();
    await post(
      token,
      Array.from({ length: 5 }, (_, i) => sessionRecord(`r${i}`, i + 1)),
    );
    const ids: string[] = [];
    let since = 0;
    let pages = 0;
    for (;;) {
      const { body } = await get(token, `?since=${since}&limit=2`);
      pages += 1;
      ids.push(...body.records.map((r: { id: string }) => r.id));
      expect(body.records.length).toBeLessThanOrEqual(2);
      since = body.next;
      if (!body.hasMore) {
        break;
      }
    }
    expect(pages).toBe(3);
    expect(ids).toEqual(['r0', 'r1', 'r2', 'r3', 'r4']);
  });

  it('says hasMore is false when the last page is exactly full', async () => {
    const token = await signIn();
    await post(token, [sessionRecord('a', 1), sessionRecord('b', 2)]);
    const { body } = await get(token, '?limit=2');
    expect(body.records).toHaveLength(2);
    expect(body.hasMore).toBe(false);
  });

  it('moves a changed record to the end of the feed', async () => {
    const token = await signIn();
    const first = await post(token, [sessionRecord('a', 1), sessionRecord('b', 1)]);
    const lastSeq = first.body.results[1].seq;
    await post(token, [sessionRecord('a', 2, 7)]);
    const { body } = await get(token, `?since=${lastSeq}`);
    expect(body.records.map((r: { id: string }) => r.id)).toEqual(['a']);
    expect(body.records[0].ciphertext).toBe(b64(48, 7));
  });

  it('applies a newer write and refuses an older one or a tie with the current record', async () => {
    const token = await signIn();
    await post(token, [sessionRecord('a', 100, 1)]);
    const newer = await post(token, [sessionRecord('a', 200, 2)]);
    expect(newer.body.results[0].status).toBe('applied');
    const current = { ...sessionRecord('a', 200, 2), seq: newer.body.results[0].seq };

    const tie = await post(token, [sessionRecord('a', 200, 3)]);
    expect(tie.body.results).toEqual([{ kind: 'session', id: 'a', status: 'stale', current }]);
    const older = await post(token, [sessionRecord('a', 150, 4)]);
    expect(older.body.results).toEqual([{ kind: 'session', id: 'a', status: 'stale', current }]);
    expect((await get(token)).body.records).toEqual([current]);
  });

  it('applies records of one request in order', async () => {
    const token = await signIn();
    const { body } = await post(token, [sessionRecord('a', 5, 1), sessionRecord('a', 4, 2)]);
    expect(body.results.map((r: { status: string }) => r.status)).toEqual(['applied', 'stale']);
  });

  it('keeps kinds apart: the same id in session and settings are two records', async () => {
    const token = await signIn();
    const { body } = await post(token, [
      sessionRecord('x', 1),
      { ...sessionRecord('x', 1), kind: 'settings' },
    ]);
    expect(body.results.map((r: { status: string }) => r.status)).toEqual(['applied', 'applied']);
  });

  it('lists notes and image records only to a client that asks for them', async () => {
    const token = await signIn();
    const notes = { ...sessionRecord('dQw4w9WgXcQ', 2), kind: 'notes' };
    const { body } = await post(token, [sessionRecord('a', 1), notes, imageRecord('img-1', 3)]);
    expect(body.results.map((r: { status: string }) => r.status)).toEqual([
      'applied',
      'applied',
      'applied',
    ]);
    // An older client asks with no kinds and must never see a kind it would refuse.
    const legacy = await get(token);
    expect(legacy.body.records.map((r: { id: string }) => r.id)).toEqual(['a']);
    expect(legacy.body.next).toBe(body.results[0].seq);
    const all = await get(token, '?kinds=session,settings,notes,image');
    expect(all.body.records.map((r: { kind: string }) => r.kind)).toEqual([
      'session',
      'notes',
      'image',
    ]);
    expect((await get(token, '?kinds=image')).body.records).toEqual([
      { ...imageRecord('img-1', 3), seq: body.results[2].seq },
    ]);
    expect((await get(token, '?kinds=photos')).status).toBe(400);
  });

  it('refuses a live image over the per-account cap, record by record, and always takes tombstones', async () => {
    const token = await signIn();
    const full = Array.from({ length: IMAGE_RECORD_LIMIT }, (_, i) => imageRecord(`img${i}`, 1));
    expect(
      (await post(token, full)).body.results.every(
        (r: { status: string }) => r.status === 'applied',
      ),
    ).toBe(true);
    const { body } = await post(token, [
      imageRecord('one-more', 1),
      sessionRecord('a', 1),
      imageRecord('img0', 2),
    ]);
    expect(body.results).toEqual([
      { kind: 'image', id: 'one-more', status: 'rejected', reason: 'image_limit' },
      { kind: 'session', id: 'a', status: 'applied', seq: expect.any(Number) },
      // Already live: rewriting it adds nothing to the count.
      { kind: 'image', id: 'img0', status: 'applied', seq: expect.any(Number) },
    ]);
    const listed = await get(token, '?kinds=image');
    expect(listed.body.records.some((r: { id: string }) => r.id === 'one-more')).toBe(false);
    // A deletion makes room, and the refused picture goes through on the next try.
    const deleted = await post(token, [imageRecord('img1', 2, true), imageRecord('one-more', 1)]);
    expect(deleted.body.results.map((r: { status: string }) => r.status)).toEqual([
      'applied',
      'applied',
    ]);
    expect((await post(token, [imageRecord('two-more', 1)])).body.results[0].status).toBe(
      'rejected',
    );
    // A tombstone for a picture the server never had is taken too, over the cap.
    expect((await post(token, [imageRecord('never-sent', 5, true)])).body.results[0].status).toBe(
      'applied',
    );
  });

  it('answers an older image write stale, not rejected, even at the cap', async () => {
    const token = await signIn();
    await post(
      token,
      Array.from({ length: IMAGE_RECORD_LIMIT }, (_, i) => imageRecord(`img${i}`, 5)),
    );
    const { body } = await post(token, [imageRecord('img0', 4, true)]);
    expect(body.results[0]).toMatchObject({
      status: 'stale',
      current: { id: 'img0', updatedAt: 5 },
    });
  });

  it('stores a tombstone, which a stale write cannot bring back', async () => {
    const token = await signIn();
    await post(token, [sessionRecord('a', 1)]);
    const deleted = await post(token, [tombstone('a', 2)]);
    expect(deleted.body.results[0].status).toBe('applied');
    const { body } = await get(token);
    expect(body.records).toEqual([{ ...tombstone('a', 2), seq: deleted.body.results[0].seq }]);
    const revived = await post(token, [sessionRecord('a', 2)]);
    expect(revived.body.results[0].status).toBe('stale');
    expect(revived.body.results[0].current.deleted).toBe(true);
  });

  it('lets a newer write replace a tombstone', async () => {
    const token = await signIn();
    await post(token, [tombstone('a', 2)]);
    expect((await post(token, [sessionRecord('a', 3)])).body.results[0].status).toBe('applied');
  });

  it("never shows one user's records to another", async () => {
    const a = await signIn('a', 'a@example.com');
    const b = await signIn('b', 'b@example.com');
    await post(a, [sessionRecord('same', 5)]);
    expect((await get(b)).body.records).toEqual([]);
    expect((await post(b, [sessionRecord('same', 1)])).body.results[0].status).toBe('applied');
  });

  it.each([
    ['since negative', '?since=-1'],
    ['since not a number', '?since=abc'],
    ['since fractional', '?since=1.5'],
    ['limit 0', '?limit=0'],
    ['limit 501', '?limit=501'],
    ['limit empty', '?limit='],
  ])('refuses %s with 400', async (_name, query) => {
    const token = await signIn();
    const { status, body } = await get(token, query);
    expect(status).toBe(400);
    expect(body).toEqual({ error: 'bad_request' });
  });

  it('accepts limit 1 and limit 500', async () => {
    const token = await signIn();
    expect((await get(token, '?limit=1')).status).toBe(200);
    expect((await get(token, '?limit=500')).status).toBe(200);
  });

  it('refuses a whole request with one bad record, storing none of it', async () => {
    const token = await signIn();
    const { status } = await post(token, [sessionRecord('good', 1), sessionRecord('bad id', 1)]);
    expect(status).toBe(400);
    expect((await get(token)).body.records).toEqual([]);
  });

  it('refuses 101 records and accepts 100', async () => {
    const token = await signIn();
    const make = (n: number) => Array.from({ length: n }, (_, i) => sessionRecord(`r${i}`, 1));
    expect((await post(token, make(101))).status).toBe(400);
    expect((await post(token, make(100))).status).toBe(200);
  });

  it('accepts a ciphertext of exactly 1 MiB of base64 and refuses one longer', async () => {
    const token = await signIn();
    const max = 'A'.repeat(1024 * 1024);
    expect((await post(token, [{ ...sessionRecord('a', 1), ciphertext: max }])).status).toBe(200);
    expect(
      (await post(token, [{ ...sessionRecord('b', 1), ciphertext: `${max}AAAA` }])).status,
    ).toBe(400);
  });

  it('refuses a body over 4 MiB with 413 and CORS, storing none of it, and accepts one under', async () => {
    const token = await signIn();
    const max = 'A'.repeat(1024 * 1024);
    const make = (n: number) =>
      Array.from({ length: n }, (_, i) => ({ ...sessionRecord(`r${i}`, 1), ciphertext: max }));
    const over = await call(
      request('POST', '/v1/records', { token, body: { records: make(4) }, origin: ORIGIN }),
    );
    expect(over.status).toBe(413);
    expect(over.body).toEqual({ error: 'payload_too_large' });
    expect(over.res.headers.get('Access-Control-Allow-Origin')).toBe(ORIGIN);
    expect((await get(token)).body.records).toEqual([]);
    expect((await post(token, make(3))).status).toBe(200);
  });

  it('refuses a body whose Content-Length is over 4 MiB without reading it', async () => {
    const token = await signIn();
    const req = request('POST', '/v1/records', { token, body: { records: [] } });
    req.headers.set('Content-Length', String(4 * 1024 * 1024 + 1));
    expect((await call(req)).status).toBe(413);
  });

  it('refuses a body that is not { records: [...] }', async () => {
    const token = await signIn();
    for (const rawBody of ['[]', '{"records":{}}', '{}', 'null', '{"records":[],"x":1}']) {
      expect((await call(request('POST', '/v1/records', { token, rawBody }))).status).toBe(400);
    }
  });
});

describe('DELETE /v1/account', () => {
  it("deletes the user, every token and every record, and no one else's", async () => {
    const token = await signIn('a', 'a@example.com');
    await signIn('a', 'a@example.com');
    const other = await signIn('b', 'b@example.com');
    await call(request('PUT', '/v1/keys', { token, body: validKeySetup() }));
    await call(
      request('POST', '/v1/records', { token, body: { records: [sessionRecord('x', 1)] } }),
    );
    await call(
      request('POST', '/v1/records', { token: other, body: { records: [sessionRecord('y', 1)] } }),
    );

    const { status } = await call(request('DELETE', '/v1/account', { token }));
    expect(status).toBe(204);
    expect((await call(request('GET', '/v1/me', { token }))).status).toBe(401);
    expect(await query('SELECT email FROM users')).toEqual([{ email: 'b@example.com' }]);
    expect(await query('SELECT count(*)::int AS n FROM auth_tokens')).toEqual([{ n: 1 }]);
    expect(await query('SELECT id FROM records')).toEqual([{ id: 'y' }]);

    // Signing in again starts from nothing.
    const again = await signIn('a', 'a@example.com');
    expect((await call(request('GET', '/v1/me', { token: again }))).body.keySetup).toBeNull();
    expect((await call(request('GET', '/v1/records', { token: again }))).body.records).toEqual([]);
  });
});

describe('routing', () => {
  it('answers an unknown path with 404', async () => {
    for (const path of ['/', '/v1', '/v2/me', '/v1/me/', '/v1/constructor', '/v1/__proto__']) {
      const { status, body } = await call(request('GET', path));
      expect(status).toBe(404);
      expect(body).toEqual({ error: 'not_found' });
    }
  });

  it('answers a known path with the wrong method with 405 and Allow', async () => {
    const { status, body, res } = await call(request('DELETE', '/v1/records'));
    expect(status).toBe(405);
    expect(body).toEqual({ error: 'method_not_allowed' });
    expect(res.headers.get('Allow')).toBe('GET, POST');
  });

  it('answers 500 without detail when the database fails', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    const token = await signIn();
    deps.store = { ...store, listRecords: async () => Promise.reject(new Error('boom')) };
    const { status, body } = await call(request('GET', '/v1/records', { token }));
    expect(status).toBe(500);
    expect(body).toEqual({ error: 'internal' });
    expect(JSON.stringify(log.mock.calls)).not.toContain(token);
    log.mockRestore();
  });

  it('marks every answer as not cacheable', async () => {
    const token = await signIn();
    const { res } = await call(request('GET', '/v1/me', { token }));
    expect(res.headers.get('Cache-Control')).toBe('no-store');
    expect(res.headers.get('Content-Type')).toContain('application/json');
  });
});

describe('CORS', () => {
  it('answers an allowed origin', async () => {
    const token = await signIn();
    const { res } = await call(request('GET', '/v1/me', { token, origin: ORIGIN }));
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe(ORIGIN);
    expect(res.headers.get('Vary')).toBe('Origin');
  });

  it('puts the header on errors too, so the extension can read them', async () => {
    const { status, res } = await call(request('GET', '/v1/me', { origin: ORIGIN }));
    expect(status).toBe(401);
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe(ORIGIN);
  });

  it('gives any other origin no CORS headers', async () => {
    const token = await signIn();
    for (const origin of ['https://evil.example', 'chrome-extension://otherid', 'null']) {
      const { res } = await call(request('GET', '/v1/me', { token, origin }));
      const cors = [...res.headers.keys()].filter((name) => name.startsWith('access-control-'));
      expect(cors).toEqual([]);
    }
  });

  it('answers an allowed preflight with methods, headers and Vary', async () => {
    const res = await handle(request('OPTIONS', '/v1/records', { origin: ORIGIN }), deps);
    expect(res.status).toBe(204);
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe(ORIGIN);
    expect(res.headers.get('Access-Control-Allow-Methods')).toBe('GET, POST, PUT, DELETE');
    expect(res.headers.get('Access-Control-Allow-Headers')).toBe('Authorization, Content-Type');
    expect(res.headers.get('Vary')).toBe('Origin');
  });

  it('answers a preflight from another origin without CORS headers and without auth', async () => {
    const res = await handle(
      request('OPTIONS', '/v1/records', { origin: 'https://evil.example' }),
      deps,
    );
    expect(res.status).toBe(204);
    expect(res.headers.get('Access-Control-Allow-Origin')).toBeNull();
    expect(res.headers.get('Access-Control-Allow-Methods')).toBeNull();
  });

  it('answers nothing when no origin is configured', async () => {
    deps.allowedOrigins = [];
    const res = await handle(request('OPTIONS', '/v1/me', { origin: ORIGIN }), deps);
    expect(res.headers.get('Access-Control-Allow-Origin')).toBeNull();
  });
});
