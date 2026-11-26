// The parts of the HTTP contract that Hono would change by default, so an upgrade cannot either.
import { afterEach, describe, expect, it, vi } from 'vitest';

import { POLICY } from '../../../src/constants.js';
import { createApp } from '../app.js';
import type { Deps } from '../context.js';
import type { Store } from '../db/store.js';
import { createServer } from '../production.js';
import { createTestDeps, ORIGIN, rec, request } from './helpers.js';

const TOKEN = 'A'.repeat(43);
const KEY_ID = 'AAAAAAAAAAAAAAAAAAAAAA';
const JSON_TYPE = 'application/json; charset=utf-8';

afterEach(() => {
  vi.restoreAllMocks();
});

/** An app over a store that knows every token and counts what it is asked. */
function setUp(overrides: Partial<Store> = {}, depsOverrides: Partial<Deps> = {}) {
  const store = {
    findAccountByToken: vi.fn(async () => ({
      id: '1',
      googleSub: 'sub',
      email: 'a@example.com',
      key: { keyId: KEY_ID, generation: 1 },
      usage: { bytes: 0, screenshots: 0 },
    })),
    applyRecord: vi.fn(async () => ({ outcome: 'applied', seq: 1 })),
    usage: vi.fn(async () => ({ bytes: 0, screenshots: 0 })),
    streamStart: vi.fn(async () => ({ through: 0, usage: { bytes: 0, screenshots: 0 } })),
    streamBatch: vi.fn(async () => ({ status: 'rows', records: [] })),
    ...overrides,
  };
  const { deps } = createTestDeps(store as unknown as Store, depsOverrides);
  return { store, app: createApp(deps) };
}

/** Every header of an answer, so a header added or lost anywhere fails the test. */
function headersOf(res: Response): Record<string, string> {
  return Object.fromEntries(res.headers);
}

const JSON_HEADERS = {
  'access-control-allow-origin': ORIGIN,
  'cache-control': 'no-store',
  'content-type': JSON_TYPE,
  vary: 'Origin',
};

const ALLOW = [
  ['/v2/auth/google', 'POST'],
  ['/v2/auth/logout', 'POST'],
  ['/v2/me', 'GET'],
  ['/v2/keys/open', 'POST'],
  ['/v2/keys', 'PUT'],
  ['/v2/records', 'GET, POST'],
  ['/v2/account', 'DELETE'],
] as const;

const WRONG = ALLOW.flatMap(([path, allow]) =>
  ['HEAD', 'GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'QUERY', 'PROPFIND', 'ALL', 'get-all']
    .filter((method) => !allow.split(', ').includes(method))
    .map((method) => [method, path, allow] as const),
);

describe('wrong method', () => {
  it.each(WRONG)('%s %s is 405 with Allow: %s', async (method, path, allow) => {
    const { app, store } = setUp();
    const res = await app.fetch(request(method, path, { token: TOKEN, origin: ORIGIN }));
    expect(res.status).toBe(405);
    expect(await res.text()).toBe('{"error":"method_not_allowed"}');
    expect(headersOf(res)).toEqual({ ...JSON_HEADERS, allow });
    expect(store.findAccountByToken).not.toHaveBeenCalled();
  });

  it('is decided without a token', async () => {
    const res = await setUp().app.fetch(request('PUT', '/v2/me'));
    expect(res.status).toBe(405);
  });

  it('keeps a query out of it', async () => {
    const res = await setUp().app.fetch(request('HEAD', '/v2/records?since=1'));
    expect(res.status).toBe(405);
    expect(res.headers.get('Allow')).toBe('GET, POST');
  });
});

describe('paths', () => {
  it.each([
    '/',
    '/v2',
    '/v2/',
    '/v2/me/',
    '/v2//me',
    '//v2/me',
    '/v2/ME',
    '/v2/%6De',
    '/%762/me',
    '/v2%2Fme',
    '/v2/records%3Fsince=1',
    '/v2/me%20',
    '/v2/%',
    '/v2/%E0%A4%A',
    '/v2/keys/open/',
    '/v2/keys/',
    '/api/vercel.adaptor',
  ])('%s is 404 for any method, without looking at the token', async (path) => {
    const { app, store } = setUp();
    for (const method of ['GET', 'POST', 'HEAD', 'PATCH']) {
      const res = await app.fetch(request(method, path, { token: TOKEN, origin: ORIGIN }));
      expect(res.status).toBe(404);
      expect(await res.text()).toBe('{"error":"not_found"}');
      expect(headersOf(res)).toEqual(JSON_HEADERS);
    }
    expect(store.findAccountByToken).not.toHaveBeenCalled();
  });

  it.each(['/v2/./me', '/v2/x/../me', '/v2/%2e/me', '/v2/me?', '/v2/me?x=%zz', '/v2/me#part'])(
    '%s is /v2/me, as URL reads it',
    async (path) => {
      expect((await setUp().app.fetch(request('GET', path, { token: TOKEN }))).status).toBe(200);
    },
  );
});

describe('OPTIONS', () => {
  it.each(['/', '/v2/me', '/v2/records?since=x', '/v2/nowhere', '/v2/me/', '/v2/%6De', '/v1/me'])(
    '%s is the same 204',
    async (path) => {
      const { app, store } = setUp();
      const res = await app.fetch(request('OPTIONS', path, { origin: ORIGIN }));
      expect(res.status).toBe(204);
      expect(res.body).toBeNull();
      expect(headersOf(res)).toEqual({
        'access-control-allow-headers': 'Authorization, Content-Type, Tabinet-Key-Id',
        'access-control-allow-methods': 'GET, POST, PUT, DELETE',
        'access-control-allow-origin': ORIGIN,
        'access-control-max-age': '600',
        'cache-control': 'no-store',
        vary: 'Origin',
      });
      expect(store.findAccountByToken).not.toHaveBeenCalled();
    },
  );
});

describe('anything thrown', () => {
  it.each([
    ['an Error', new TypeError('secret'), 'TypeError'],
    ['a string', 'secret', 'string'],
    ['a number', 7, 'number'],
    ['null', null, 'object'],
    ['undefined', undefined, 'undefined'],
    ['an object', { message: 'secret' }, 'object'],
    ['a Response', new Response('secret', { status: 418 }), 'object'],
    [
      'an object posing as an HTTPException',
      Object.assign(new Error('secret'), { getResponse: () => new Response('secret') }),
      'Error',
    ],
  ])('%s, in auth or in a handler, is a JSON 500', async (_name, thrown, logged) => {
    const fail = async () => {
      throw thrown;
    };
    for (const method of ['findAccountByToken', 'streamStart'] as const) {
      const log = vi.spyOn(console, 'error').mockImplementation(() => {});
      log.mockClear();
      const { app } = setUp({ [method]: fail });
      const res = await app.fetch(
        request('GET', '/v2/records', { token: TOKEN, keyId: KEY_ID, origin: ORIGIN }),
      );
      expect(res.status).toBe(500);
      expect(await res.text()).toBe('{"error":"internal"}');
      expect(headersOf(res)).toEqual(JSON_HEADERS);
      expect(log.mock.calls).toEqual([['tabinet-server: request failed', 'GET', logged]]);
    }
  });

  it('is caught when thrown before the first await', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const { app } = setUp({
      findAccountByToken: () => {
        throw 'secret';
      },
    });
    expect((await app.fetch(request('GET', '/v2/me', { token: TOKEN }))).status).toBe(500);
  });

  it('covers a body that cannot be read', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    const body = new ReadableStream({ start: (controller) => controller.error('aborted') });
    const req = new Request('https://x.test/v2/records', {
      method: 'POST',
      headers: { Authorization: `Bearer ${TOKEN}`, 'Tabinet-Key-Id': KEY_ID },
      body,
      duplex: 'half',
    });
    expect((await setUp().app.fetch(req)).status).toBe(500);
    expect(log.mock.calls).toEqual([['tabinet-server: request failed', 'POST', 'string']]);
  });
});

/** The body limit of a route (spec 4.1). */
function limitOf(path: string): number {
  return path === '/v2/records' ? POLICY.request.maxBodyBytes : POLICY.request.maxSmallBodyBytes;
}

function methodOf(path: string): string {
  return path === '/v2/keys' ? 'PUT' : path === '/v2/account' ? 'DELETE' : 'POST';
}

const BODY_ROUTES = ['/v2/auth/google', '/v2/keys/open', '/v2/keys', '/v2/records', '/v2/account'];

describe('body', () => {
  /** A request whose body records whether anything pulled on it. */
  function watched(path: string, headers: Record<string, string> = {}) {
    const pull = vi.fn((controller: ReadableStreamDefaultController) => controller.close());
    const body = new ReadableStream({ pull }, { highWaterMark: 0 });
    const req = new Request(`https://x.test${path}`, {
      method: methodOf(path),
      headers,
      body,
      duplex: 'half',
    });
    return { req, pull };
  }

  it.each(['/v2/auth/logout', '/v2/keys/open', '/v2/keys', '/v2/records', '/v2/account'])(
    '%s answers 401 before reading it, even over the limit',
    async (path) => {
      const { req, pull } = watched(path, {
        'Content-Length': String(POLICY.request.maxBodyBytes + 1),
      });
      const res = await setUp().app.fetch(req);
      expect(res.status).toBe(401);
      expect(pull).not.toHaveBeenCalled();
    },
  );

  it.each(BODY_ROUTES)(
    '%s refuses a Content-Length over the limit before reading',
    async (path) => {
      const { req, pull } = watched(path, {
        Authorization: `Bearer ${TOKEN}`,
        'Tabinet-Key-Id': KEY_ID,
        'Content-Length': String(limitOf(path) + 1),
        Origin: ORIGIN,
      });
      const res = await setUp().app.fetch(req);
      expect(res.status).toBe(413);
      expect(await res.text()).toBe('{"error":"payload_too_large"}');
      expect(headersOf(res)).toEqual(JSON_HEADERS);
      expect(pull).not.toHaveBeenCalled();
    },
  );

  it.each(BODY_ROUTES)(
    '%s answers once a body is over the limit, then discards the rest',
    async (path) => {
      const chunk = new Uint8Array(64 * 1024).fill(32);
      let sent = 0;
      let readToTheEnd = false;
      const body = new ReadableStream<Uint8Array>(
        {
          async pull(controller) {
            // As from a socket: each chunk is a turn of the event loop.
            await new Promise((resolve) => setImmediate(resolve));
            // Ends far over the limit, so a reader without one fails here instead of running out of memory.
            if (sent > limitOf(path) * 4 + 4 * chunk.length) {
              controller.close();
              readToTheEnd = true;
              return;
            }
            controller.enqueue(chunk);
            sent += chunk.length;
          },
        },
        { highWaterMark: 0 },
      );
      const req = new Request(`https://x.test${path}`, {
        method: methodOf(path),
        headers: { Authorization: `Bearer ${TOKEN}`, 'Tabinet-Key-Id': KEY_ID },
        body,
        duplex: 'half',
      });
      expect((await setUp().app.fetch(req)).status).toBe(413);
      // Reading stopped within one chunk of the limit, whatever was still coming.
      expect(sent).toBeLessThanOrEqual(limitOf(path) + 2 * chunk.length);
      // Left unread, it blocks the next request on the connection.
      await vi.waitFor(() => expect(readToTheEnd).toBe(true));
    },
  );

  it.each([
    ['a byte order mark is not counted', [0xef, 0xbb, 0xbf], POLICY.request.maxBodyBytes, 400],
    [
      'a byte order mark does not hide a byte too many',
      [0xef, 0xbb, 0xbf],
      POLICY.request.maxBodyBytes + 1,
      413,
    ],
    ['an invalid byte counts as its replacement', [0xff], POLICY.request.maxBodyBytes - 1, 413],
  ])('%s', async (_name, start, spaces, status) => {
    const bytes = new Uint8Array(start.length + spaces).fill(32);
    bytes.set(start);
    const req = new Request('https://x.test/v2/records', {
      method: 'POST',
      headers: { Authorization: `Bearer ${TOKEN}`, 'Tabinet-Key-Id': KEY_ID },
      body: bytes,
    });
    expect((await setUp().app.fetch(req)).status).toBe(status);
  });

  it('counts the bytes whatever Content-Length says', async () => {
    const { app } = setUp();
    const json = JSON.stringify({ records: [rec('session', 'a', 1)] });
    for (const [size, status] of [
      [POLICY.request.maxBodyBytes, 200],
      [POLICY.request.maxBodyBytes + 1, 413],
    ] as const) {
      const req = request('POST', '/v2/records', {
        token: TOKEN,
        keyId: KEY_ID,
        rawBody: json.padEnd(size),
      });
      req.headers.set('Content-Length', '2');
      expect((await app.fetch(req)).status).toBe(status);
    }
  });

  it('counts bytes, not characters', async () => {
    const rawBody = 'é'.repeat(POLICY.request.maxBodyBytes / 2 + 1);
    const req = request('POST', '/v2/records', { token: TOKEN, keyId: KEY_ID, rawBody });
    expect((await setUp().app.fetch(req)).status).toBe(413);
  });

  it.each(['', '{', 'undefined', '\u0000'])('answers %j with 400', async (rawBody) => {
    const res = await setUp().app.fetch(
      request('POST', '/v2/records', { token: TOKEN, keyId: KEY_ID, rawBody }),
    );
    expect(res.status).toBe(400);
    expect(res.headers.get('Content-Type')).toBe(JSON_TYPE);
  });
});

describe('a configuration failure', () => {
  it.each(['GET', 'POST', 'OPTIONS', 'HEAD'])('%s is the same JSON 500', async (method) => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    const serve = createServer(
      () => {
        throw 'secret';
      },
      { ALLOWED_ORIGINS: ORIGIN },
    );
    const res = await serve(request(method, '/v2/me', { origin: ORIGIN }));
    expect(res.status).toBe(500);
    expect(await res.text()).toBe('{"error":"internal"}');
    expect(headersOf(res)).toEqual(JSON_HEADERS);
    expect(log.mock.calls).toEqual([['tabinet-server: configuration failed', 'string']]);
  });

  it('is not built until the first request', () => {
    const build = vi.fn();
    createServer(build, {});
    expect(build).not.toHaveBeenCalled();
  });
});
