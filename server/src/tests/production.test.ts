import { afterEach, describe, expect, it, vi } from 'vitest';

import { createProductionDeps, createServer, listFromEnv } from '../production.js';
import { createTestDeps, ORIGIN, request } from './helpers.js';

const SECRET = 'hunter2-password';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('listFromEnv', () => {
  it('splits on commas and drops blanks', () => {
    expect(listFromEnv(' a, ,b ,')).toEqual(['a', 'b']);
    expect(listFromEnv(undefined)).toEqual([]);
  });
});

describe('createProductionDeps', () => {
  it('names a malformed DATABASE_URL without quoting it', () => {
    const build = () =>
      createProductionDeps({
        DATABASE_URL: `"postgres://user:${SECRET}@host/db"`,
        GOOGLE_CLIENT_IDS: 'client',
      });
    expect(build).toThrow('Environment variable DATABASE_URL is not a valid URL');
    expect(build).not.toThrow(SECRET);
  });

  it('names a missing variable', () => {
    expect(() => createProductionDeps({})).toThrow('Missing environment variable DATABASE_URL');
  });
});

describe('createServer', () => {
  it('answers 500 with CORS when the deps cannot be built, and logs no secret', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    const serve = createServer(
      () => {
        throw new Error(`connection string postgres://user:${SECRET}@host/db`);
      },
      { ALLOWED_ORIGINS: ORIGIN },
    );
    const res = await serve(request('GET', '/v1/me', { origin: ORIGIN }));
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
    const serve = createServer(() => {
      calls += 1;
      if (calls === 1) {
        throw new Error('not yet');
      }
      return deps;
    }, {});
    expect((await serve(request('GET', '/v1/nowhere'))).status).toBe(500);
    expect((await serve(request('GET', '/v1/nowhere'))).status).toBe(404);
    expect((await serve(request('GET', '/v1/nowhere'))).status).toBe(404);
    expect(calls).toBe(2);
  });
});
