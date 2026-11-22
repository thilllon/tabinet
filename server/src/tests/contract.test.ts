// The parts of the HTTP contract that Hono would change by default, so an upgrade cannot either.
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createApp } from '../app.js';
import type { Deps } from '../context.js';
import type { Store } from '../db/store.js';
import { createServer } from '../production.js';
import { MAX_BODY_BYTES } from '../validation.js';
import { createTestDeps, ORIGIN, request, sessionRecord } from './helpers.js';

const TOKEN = 'A'.repeat(43);
const JSON_TYPE = 'application/json; charset=utf-8';

afterEach(() => {
  vi.restoreAllMocks();
});

/** An app over a store that knows every token and counts what it is asked. */
function setUp(overrides: Partial<Store> = {}, depsOverrides: Partial<Deps> = {}) {
  const store = {
    findUserByToken: vi.fn(async () => ({ id: '1', email: 'a@example.com', keySetup: null })),
    applyRecord: vi.fn(async () => ({ status: 'applied', seq: 1 })),
    listRecords: vi.fn(async () => []),
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
  ['/v1/auth/google', 'POST'],
  ['/v1/auth/logout', 'POST'],
  ['/v1/me', 'GET'],
  ['/v1/keys', 'PUT'],
  ['/v1/records', 'GET, POST'],
  ['/v1/account', 'DELETE'],
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
    expect(store.findUserByToken).not.toHaveBeenCalled();
  });

  it('is decided without a token', async () => {
    const res = await setUp().app.fetch(request('PUT', '/v1/me'));
    expect(res.status).toBe(405);
  });

  it('keeps a query out of it', async () => {
    const res = await setUp().app.fetch(request('HEAD', '/v1/records?since=1'));
    expect(res.status).toBe(405);
    expect(res.headers.get('Allow')).toBe('GET, POST');
  });
});

describe('paths', () => {
  it.each([
    '/',
    '/v1',
    '/v1/',
    '/v1/me/',
    '/v1//me',
    '//v1/me',
    '/v1/ME',
    '/v1/%6De',
    '/%761/me',
    '/v1%2Fme',
    '/v1/records%3Fsince=1',
    '/v1/me%20',
    '/v1/%',
    '/v1/%E0%A4%A',
    '/api/vercel.adaptor',
  ])('%s is 404 for any method, without looking at the token', async (path) => {
    const { app, store } = setUp();
    for (const method of ['GET', 'POST', 'HEAD', 'PATCH']) {
      const res = await app.fetch(request(method, path, { token: TOKEN, origin: ORIGIN }));
      expect(res.status).toBe(404);
      expect(await res.text()).toBe('{"error":"not_found"}');
      expect(headersOf(res)).toEqual(JSON_HEADERS);
    }
    expect(store.findUserByToken).not.toHaveBeenCalled();
  });

  it.each(['/v1/./me', '/v1/x/../me', '/v1/%2e/me', '/v1/me?', '/v1/me?x=%zz', '/v1/me#part'])(
    '%s is /v1/me, as URL reads it',
    async (path) => {
      expect((await setUp().app.fetch(request('GET', path, { token: TOKEN }))).status).toBe(200);
    },
  );
});

describe('OPTIONS', () => {
  it.each(['/', '/v1/me', '/v1/records?limit=x', '/v1/nowhere', '/v1/me/', '/v1/%6De'])(
    '%s is the same 204',
    async (path) => {
      const { app, store } = setUp();
      const res = await app.fetch(request('OPTIONS', path, { origin: ORIGIN }));
      expect(res.status).toBe(204);
      expect(res.body).toBeNull();
      expect(headersOf(res)).toEqual({
        'access-control-allow-headers': 'Authorization, Content-Type',
        'access-control-allow-methods': 'GET, POST, PUT, DELETE',
        'access-control-allow-origin': ORIGIN,
        'access-control-max-age': '600',
        'cache-control': 'no-store',
        vary: 'Origin',
      });
      expect(store.findUserByToken).not.toHaveBeenCalled();
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
    for (const method of ['findUserByToken', 'listRecords'] as const) {
      const log = vi.spyOn(console, 'error').mockImplementation(() => {});
      log.mockClear();
      const { app } = setUp({ [method]: fail });
      const res = await app.fetch(request('GET', '/v1/records', { token: TOKEN, origin: ORIGIN }));
      expect(res.status).toBe(500);
      expect(await res.text()).toBe('{"error":"internal"}');
      expect(headersOf(res)).toEqual(JSON_HEADERS);
      expect(log.mock.calls).toEqual([['tabinet-server: request failed', 'GET', logged]]);
    }
  });

  it('is caught when thrown before the first await', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const { app } = setUp({
      findUserByToken: () => {
        throw 'secret';
      },
    });
    expect((await app.fetch(request('GET', '/v1/me', { token: TOKEN }))).status).toBe(500);
  });

  it('covers a body that cannot be read', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    const body = new ReadableStream({ start: (controller) => controller.error('aborted') });
    const req = new Request('https://x.test/v1/records', {
      method: 'POST',
      headers: { Authorization: `Bearer ${TOKEN}` },
      body,
      duplex: 'half',
    });
    expect((await setUp().app.fetch(req)).status).toBe(500);
    expect(log.mock.calls).toEqual([['tabinet-server: request failed', 'POST', 'string']]);
  });
});

describe('body', () => {
  /** A request whose body records whether anything pulled on it. */
  function watched(path: string, headers: Record<string, string> = {}) {
    const pull = vi.fn((controller: ReadableStreamDefaultController) => controller.close());
    const body = new ReadableStream({ pull }, { highWaterMark: 0 });
    const method = path === '/v1/keys' ? 'PUT' : 'POST';
    const req = new Request(`https://x.test${path}`, { method, headers, body, duplex: 'half' });
    return { req, pull };
  }

  it.each(['/v1/auth/logout', '/v1/keys', '/v1/records'])(
    '%s answers 401 before reading it, even over the limit',
    async (path) => {
      const { req, pull } = watched(path, { 'Content-Length': String(MAX_BODY_BYTES + 1) });
      const res = await setUp().app.fetch(req);
      expect(res.status).toBe(401);
      expect(pull).not.toHaveBeenCalled();
    },
  );

  it.each(['/v1/auth/google', '/v1/keys', '/v1/records'])(
    '%s refuses a Content-Length over the limit before reading',
    async (path) => {
      const { req, pull } = watched(path, {
        Authorization: `Bearer ${TOKEN}`,
        'Content-Length': String(MAX_BODY_BYTES + 1),
        Origin: ORIGIN,
      });
      const res = await setUp().app.fetch(req);
      expect(res.status).toBe(413);
      expect(await res.text()).toBe('{"error":"payload_too_large"}');
      expect(headersOf(res)).toEqual(JSON_HEADERS);
      expect(pull).not.toHaveBeenCalled();
    },
  );

  it.each(['/v1/auth/google', '/v1/keys', '/v1/records'])(
    '%s stops reading a body that never ends',
    async (path) => {
      const chunk = new Uint8Array(64 * 1024).fill(32);
      let sent = 0;
      const body = new ReadableStream<Uint8Array>(
        {
          pull(controller) {
            // Ends far over the limit, so a reader without one fails here instead of running out of memory.
            if (sent > MAX_BODY_BYTES * 4) {
              controller.close();
              return;
            }
            controller.enqueue(chunk);
            sent += chunk.length;
          },
        },
        { highWaterMark: 0 },
      );
      const req = new Request(`https://x.test${path}`, {
        method: path === '/v1/keys' ? 'PUT' : 'POST',
        headers: { Authorization: `Bearer ${TOKEN}` },
        body,
        duplex: 'half',
      });
      expect((await setUp().app.fetch(req)).status).toBe(413);
      expect(sent).toBeLessThanOrEqual(MAX_BODY_BYTES + 2 * chunk.length);
    },
  );

  it.each([
    ['a byte order mark is not counted', [0xef, 0xbb, 0xbf], MAX_BODY_BYTES, 400],
    [
      'a byte order mark does not hide a byte too many',
      [0xef, 0xbb, 0xbf],
      MAX_BODY_BYTES + 1,
      413,
    ],
    ['an invalid byte counts as its replacement', [0xff], MAX_BODY_BYTES - 1, 413],
  ])('%s', async (_name, start, spaces, status) => {
    const bytes = new Uint8Array(start.length + spaces).fill(32);
    bytes.set(start);
    const req = new Request('https://x.test/v1/records', {
      method: 'POST',
      headers: { Authorization: `Bearer ${TOKEN}` },
      body: bytes,
    });
    expect((await setUp().app.fetch(req)).status).toBe(status);
  });

  it('counts the bytes whatever Content-Length says', async () => {
    const { app } = setUp();
    const json = JSON.stringify({ records: [sessionRecord('a', 1)] });
    for (const [size, status] of [
      [MAX_BODY_BYTES, 200],
      [MAX_BODY_BYTES + 1, 413],
    ] as const) {
      const req = request('POST', '/v1/records', { token: TOKEN, rawBody: json.padEnd(size) });
      req.headers.set('Content-Length', '2');
      expect((await app.fetch(req)).status).toBe(status);
    }
  });

  it('counts bytes, not characters', async () => {
    const rawBody = 'é'.repeat(MAX_BODY_BYTES / 2 + 1);
    const req = request('POST', '/v1/records', { token: TOKEN, rawBody });
    expect((await setUp().app.fetch(req)).status).toBe(413);
  });

  it.each(['', '{', 'undefined', '\u0000'])('answers %j with 400', async (rawBody) => {
    const res = await setUp().app.fetch(request('POST', '/v1/records', { token: TOKEN, rawBody }));
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
    const res = await serve(request(method, '/v1/me', { origin: ORIGIN }));
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
