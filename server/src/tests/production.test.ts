// The production check (spec 6.2): outside Vercel Production, without the pinned key encryption key, or with any
// other key encryption key, nothing is built, no query is made, and every request is a 500.
import { randomBytes } from 'node:crypto';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { listFromEnv, readEnv } from '../env.js';
import { keyEncryptionKeyIdOfSync } from '../envelope.js';
import { PINNED_KEY_ENCRYPTION_KEY_ID } from '../key-encryption-key-id.js';
import { createProductionDeps, createServer } from '../production.js';
import { createTestDeps, ORIGIN, request } from './helpers.js';

const SECRET = 'hunter2-password';
const KEY_ENCRYPTION_KEY = randomBytes(32);
const KEY_ENCRYPTION_KEY_B64 = KEY_ENCRYPTION_KEY.toString('base64');
const PIN = keyEncryptionKeyIdOfSync(KEY_ENCRYPTION_KEY);

const GOOD = {
  VERCEL_ENV: 'production',
  TABINET_KEY_ENCRYPTION_KEY: KEY_ENCRYPTION_KEY_B64,
  DATABASE_URL: `postgres://user:${SECRET}@db.invalid/tabinet`,
  GOOGLE_CLIENT_IDS: 'client',
  ALLOWED_ORIGINS: ORIGIN,
};

afterEach(() => {
  vi.restoreAllMocks();
});

describe('listFromEnv', () => {
  it('splits on commas and drops blanks', () => {
    expect(listFromEnv(' a, ,b ,')).toEqual(['a', 'b']);
    expect(listFromEnv(undefined)).toEqual([]);
  });
});

describe('the production check', () => {
  it('pins a production id that is never the test vectors one', () => {
    expect(PINNED_KEY_ENCRYPTION_KEY_ID).toMatch(/^[0-9a-f]{16}$/);
    expect(PINNED_KEY_ENCRYPTION_KEY_ID).not.toBe('2e8440d4467793dd');
    expect(() => readEnv(GOOD)).toThrow('not the pinned key encryption key');
  });

  it('passes for Vercel Production with the pinned key encryption key', async () => {
    const createQuery = vi.fn(() => async () => []);
    const deps = await createProductionDeps(GOOD, { createQuery, pinnedKeyEncryptionKeyId: PIN });
    expect(deps.keyEncryptionKey.id).toBe(PIN);
    expect(deps.allowedOrigins).toEqual([ORIGIN]);
    expect(createQuery).toHaveBeenCalledOnce();
  });

  const other = randomBytes(32);
  it.each([
    ['no VERCEL_ENV', { VERCEL_ENV: undefined }, PIN, 'VERCEL_ENV is not production'],
    ['VERCEL_ENV=preview', { VERCEL_ENV: 'preview' }, PIN, 'VERCEL_ENV is not production'],
    ['VERCEL_ENV=development', { VERCEL_ENV: 'development' }, PIN, 'VERCEL_ENV is not production'],
    ['an empty pin', {}, '', 'no key encryption key id is pinned'],
    [
      'no key encryption key',
      { TABINET_KEY_ENCRYPTION_KEY: undefined },
      PIN,
      'Missing environment variable TABINET_KEY_ENCRYPTION_KEY',
    ],
    [
      'an empty key encryption key',
      { TABINET_KEY_ENCRYPTION_KEY: '' },
      PIN,
      'Missing environment variable TABINET_KEY_ENCRYPTION_KEY',
    ],
    [
      'a key encryption key of 31 bytes',
      { TABINET_KEY_ENCRYPTION_KEY: randomBytes(31).toString('base64') },
      PIN,
      'not base64 of 32',
    ],
    [
      'a key encryption key that is not base64',
      { TABINET_KEY_ENCRYPTION_KEY: `${KEY_ENCRYPTION_KEY_B64.slice(0, -2)}!=` },
      PIN,
      'not base64 of 32',
    ],
    [
      'a key encryption key with a newline',
      { TABINET_KEY_ENCRYPTION_KEY: `${KEY_ENCRYPTION_KEY_B64}\n` },
      PIN,
      'not base64 of 32',
    ],
    [
      'a key encryption key in base64url',
      { TABINET_KEY_ENCRYPTION_KEY: KEY_ENCRYPTION_KEY.toString('base64url') },
      PIN,
      'not base64 of 32',
    ],
    [
      'another key encryption key',
      { TABINET_KEY_ENCRYPTION_KEY: other.toString('base64') },
      PIN,
      'not the pinned key encryption key',
    ],
    [
      'the vectors key encryption key id pinned for another',
      {},
      '2e8440d4467793dd',
      'not the pinned key encryption key',
    ],
  ])('refuses %s, before any client exists', async (_name, change, pin, message) => {
    const createQuery = vi.fn(() => async () => []);
    const env = { ...GOOD, ...change };
    const build = createProductionDeps(env, { createQuery, pinnedKeyEncryptionKeyId: pin });
    await expect(build).rejects.toThrow(message);
    await expect(build).rejects.not.toThrow(SECRET);
    await expect(build).rejects.not.toThrow(KEY_ENCRYPTION_KEY_B64);
    expect(createQuery).not.toHaveBeenCalled();
  });

  it('checks VERCEL_ENV even when nothing else is set', () => {
    expect(() => readEnv({}, PIN)).toThrow('VERCEL_ENV is not production');
  });

  it('then names a missing or malformed variable without quoting it', () => {
    expect(() => readEnv({ ...GOOD, DATABASE_URL: undefined }, PIN)).toThrow(
      'Missing environment variable DATABASE_URL',
    );
    const bad = () => readEnv({ ...GOOD, DATABASE_URL: `"postgres://u:${SECRET}@h/db"` }, PIN);
    expect(bad).toThrow('Environment variable DATABASE_URL is not a valid URL');
    expect(bad).not.toThrow(SECRET);
  });
});

describe('createServer', () => {
  it.each([
    ['no VERCEL_ENV', { VERCEL_ENV: undefined }],
    ['a preview with a valid pinned key encryption key', { VERCEL_ENV: 'preview' }],
  ])(
    'with %s answers 500 on every route, OPTIONS and /v1 too, and queries nothing',
    async (_name, change) => {
      const log = vi.spyOn(console, 'error').mockImplementation(() => {});
      const createQuery = vi.fn(() => async () => []);
      const env = { ...GOOD, ...change };
      const serve = createServer(
        () => createProductionDeps(env, { createQuery, pinnedKeyEncryptionKeyId: PIN }),
        env,
      );
      for (const [method, path] of [
        ['POST', '/v2/auth/google'],
        ['GET', '/v2/me'],
        ['GET', '/v2/records'],
        ['POST', '/v2/records'],
        ['PUT', '/v2/keys'],
        ['DELETE', '/v2/account'],
        ['OPTIONS', '/v2/records'],
        ['GET', '/v1/me'],
        ['HEAD', '/v2/me'],
        ['GET', '/nowhere'],
      ]) {
        const res = await serve(request(method, path, { origin: ORIGIN }));
        expect(res.status).toBe(500);
        expect(await res.text()).toBe('{"error":"internal"}');
        expect(res.headers.get('Access-Control-Allow-Origin')).toBe(ORIGIN);
      }
      expect(createQuery).not.toHaveBeenCalled();
      expect(
        log.mock.calls.every(
          ([text, name]) => text === 'tabinet-server: configuration failed' && name === 'Error',
        ),
      ).toBe(true);
      expect(JSON.stringify(log.mock.calls)).not.toContain(SECRET);
    },
  );

  it('answers 500 with CORS when the deps cannot be built, and logs no secret', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    const serve = createServer(
      () => {
        throw new Error(`connection string postgres://user:${SECRET}@host/db`);
      },
      { ALLOWED_ORIGINS: ORIGIN },
    );
    const res = await serve(request('GET', '/v2/me', { origin: ORIGIN }));
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: 'internal' });
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe(ORIGIN);
    expect(log).toHaveBeenCalledWith('tabinet-server: configuration failed', 'Error');
    expect(JSON.stringify(log.mock.calls)).not.toContain(SECRET);
  });

  it('tries again on the next request and then keeps the deps it built', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const { deps } = createTestDeps({} as never);
    let calls = 0;
    const serve = createServer(async () => {
      calls += 1;
      if (calls === 1) {
        throw new Error('not yet');
      }
      return deps;
    }, {});
    expect((await serve(request('GET', '/v2/nowhere'))).status).toBe(500);
    expect((await serve(request('GET', '/v2/nowhere'))).status).toBe(404);
    expect((await serve(request('GET', '/v2/nowhere'))).status).toBe(404);
    expect(calls).toBe(2);
  });

  it('is not built until the first request', () => {
    const build = vi.fn();
    createServer(build, {});
    expect(build).not.toHaveBeenCalled();
  });
});
