// The server draws every line at the POLICY value (src/constants.ts), and no server file restates
// a limit of its own.
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { POLICY } from '../../../src/constants.js';
import type { Store } from '../db/store.js';
import { isClockAhead, parseAccessToken, parseRecordsBody, storedBytesOf } from '../validation.js';
import { ciphertextOfChars, client, createTestDeps, rec, request } from './helpers.js';

const ROOT = path.resolve(import.meta.dirname, '../..');

describe('validation at each POLICY value', () => {
  const one = (record: unknown) => parseRecordsBody({ records: [record] }) !== null;

  it('takes maxRecordsPerPush records and refuses one more', () => {
    const records = (n: number) => Array.from({ length: n }, (_, i) => rec('session', `r${i}`, 1));
    expect(parseRecordsBody({ records: records(POLICY.request.maxRecordsPerPush) })).not.toBeNull();
    expect(parseRecordsBody({ records: records(POLICY.request.maxRecordsPerPush + 1) })).toBeNull();
  });

  it('takes a live ciphertext of maxCiphertextBytes characters and refuses a longer one', () => {
    const live = (chars: number) => ({
      ...rec('session', 's', 1),
      ciphertext: ciphertextOfChars(chars),
    });
    expect(one(live(POLICY.record.maxCiphertextBytes))).toBe(true);
    expect(one(live(POLICY.record.maxCiphertextBytes + 4))).toBe(false);
  });

  it('takes a tombstone of maxTombstoneChars characters and refuses a longer one', () => {
    const dead = (chars: number) => ({
      ...rec('session', 's', 1, { deleted: true }),
      ciphertext: ciphertextOfChars(chars),
    });
    expect(one(dead(POLICY.record.maxTombstoneChars))).toBe(true);
    expect(one(dead(POLICY.record.maxTombstoneChars + 4))).toBe(false);
  });

  it('takes an access token of maxAccessTokenChars and refuses one more', () => {
    const token = (n: number) => ({ accessToken: 'a'.repeat(n) });
    expect(parseAccessToken(token(POLICY.request.maxAccessTokenChars))).not.toBeNull();
    expect(parseAccessToken(token(POLICY.request.maxAccessTokenChars + 1))).toBeNull();
  });

  it('refuses a stamp more than maxClockAheadMs ahead', () => {
    expect(isClockAhead(1000 + POLICY.record.maxClockAheadMs, 1000)).toBe(false);
    expect(isClockAhead(1001 + POLICY.record.maxClockAheadMs, 1000)).toBe(true);
  });

  it('counts a row as max(ciphertext, maxTombstoneChars) + overheadBytes', () => {
    const { maxTombstoneChars, overheadBytes } = POLICY.record;
    expect(storedBytesOf({ ciphertext: 'A'.repeat(4) })).toBe(maxTombstoneChars + overheadBytes);
    expect(storedBytesOf({ ciphertext: 'A'.repeat(maxTombstoneChars + 4) })).toBe(
      maxTombstoneChars + 4 + overheadBytes,
    );
  });
});

describe('body limits at each POLICY value', () => {
  // A store whose every bearer is a signed-in account with a key, so only the body decides.
  const store = {
    findAccountByToken: async () => ({
      id: 'a',
      googleSub: 's',
      email: 'e',
      key: { keyId: 'AAAAAAAAAAAAAAAAAAAAAA', generation: 1 },
      usage: { bytes: 0, screenshots: 0 },
    }),
    usage: async () => ({ bytes: 0, screenshots: 0 }),
  } as unknown as Store;
  const { deps } = createTestDeps(store, { verifyGoogleToken: async () => null });

  it.each([
    ['POST', '/v2/auth/google', POLICY.request.maxSmallBodyBytes],
    ['POST', '/v2/keys/open', POLICY.request.maxSmallBodyBytes],
    ['PUT', '/v2/keys', POLICY.request.maxSmallBodyBytes],
    ['DELETE', '/v2/account', POLICY.request.maxSmallBodyBytes],
    ['POST', '/v2/records', POLICY.request.maxBodyBytes],
  ])('%s %s reads %i bytes and refuses one more', async (method, path, limit) => {
    const { call } = client(deps);
    const json = path === '/v2/records' ? '{"records":[]}' : '{"accessToken":"x"}';
    const options = { token: 'A'.repeat(43), keyId: 'AAAAAAAAAAAAAAAAAAAAAA' };
    const at = await call(request(method, path, { ...options, rawBody: json.padEnd(limit) }));
    expect(at.status).not.toBe(413);
    const over = await call(request(method, path, { ...options, rawBody: json.padEnd(limit + 1) }));
    expect([over.status, over.text]).toEqual([413, '{"error":"payload_too_large"}']);
  });
});

/** Code of a file without its comments, so a comment may name a number. */
function code(file: string): string {
  const text = readFileSync(file, 'utf8');
  return file.endsWith('.sql')
    ? text.replace(/--.*$/gm, '')
    : text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/.*$/gm, '$1');
}

function filesUnder(dir: string): string[] {
  return (
    readdirSync(path.join(ROOT, dir), { recursive: true, encoding: 'utf8' })
      // The Railway adaptor's drain and keep-alive are hosting of an adaptor that is not deployed,
      // not policy (spec section 7), and stay where they are.
      .filter((file) => /\.(ts|sql)$/.test(file) && !file.startsWith('tests'))
      .filter((file) => file !== 'railway.adaptor.ts')
      .map((file) => path.join(ROOT, dir, file))
  );
}

/** HTTP statuses: a server file names them, and 200 is also `POLICY.pull.batchRecords`. */
const HTTP_STATUSES = new Set([200, 201, 204, 400, 401, 403, 404, 405, 409, 410, 413, 500, 503]);

it('no server file restates a POLICY number', () => {
  const numbers = new Set<number>();
  const collect = (value: unknown) => {
    if (
      typeof value === 'number' &&
      value >= 128 &&
      Number.isInteger(value) &&
      !HTTP_STATUSES.has(value)
    ) {
      numbers.add(value);
    } else if (typeof value === 'object' && value !== null) {
      Object.values(value).forEach(collect);
    }
  };
  collect(POLICY);
  const files = [
    ...filesUnder('src'),
    ...filesUnder('api'),
    ...filesUnder('scripts'),
    ...filesUnder('migrations'),
  ];
  expect(files.length).toBeGreaterThan(20);
  for (const file of files) {
    const text = code(file);
    for (const n of numbers) {
      const spelled = [String(n), n.toLocaleString('en').replaceAll(',', '_')];
      for (const form of spelled) {
        expect(new RegExp(`(?<![\\w.])${form}(?![\\w.])`).test(text), `${file}: ${form}`).toBe(
          false,
        );
      }
    }
    expect(/1024\s*\*\s*1024|\d+\s*\*\s*1024\b/.test(text), `${file}: a size in KiB or MiB`).toBe(
      false,
    );
  }
});
