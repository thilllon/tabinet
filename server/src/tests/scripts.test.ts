// The owner's scripts: kek, schema:check and stream-check (against the real app on PGlite).
import { mkdtempSync, readFileSync, statSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { kekIdOfFile, newKek, outsideRepository, REPOSITORY } from '../../scripts/kek.js';
import { schemaReport } from '../../scripts/schema-check.js';
import { runStreamCheck } from '../../scripts/stream-check.js';
import { createApp } from '../app.js';
import { importKek, kekIdOfSync } from '../envelope.js';
import { createTestDb, createTestDeps, signUp } from './helpers.js';

describe('kek', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'tabinet-kek-'));

  it('writes base64 of 32 bytes, no newline, mode 0600, and prints only the id', () => {
    const file = path.join(dir, 'a.kek');
    const id = newKek(file);
    const text = readFileSync(file, 'utf8');
    expect(text).toMatch(/^[A-Za-z0-9+/]{43}=$/);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(id).toBe(kekIdOfSync(new Uint8Array(Buffer.from(text, 'base64'))));
    expect(id).toMatch(/^[0-9a-f]{16}$/);
    expect(kekIdOfFile(file)).toBe(id);
  });

  it('never overwrites a file', () => {
    const file = path.join(dir, 'b.kek');
    newKek(file);
    const before = readFileSync(file, 'utf8');
    expect(() => newKek(file)).toThrow();
    expect(readFileSync(file, 'utf8')).toBe(before);
  });

  it('refuses a relative path and any path inside the repository, links resolved', () => {
    expect(() => newKek('a.kek')).toThrow('absolute path');
    expect(() => newKek(path.join(REPOSITORY, 'server', 'x.kek'))).toThrow('inside the repository');
    expect(() => outsideRepository(REPOSITORY)).toThrow('inside the repository');
    const link = path.join(dir, 'into-repo');
    symlinkSync(path.join(REPOSITORY, 'server'), link);
    expect(() => newKek(path.join(link, 'y.kek'))).toThrow('inside the repository');
  });

  it('refuses a file that is not a KEK', async () => {
    const { writeFileSync } = await import('node:fs');
    const file = path.join(dir, 'bad.kek');
    writeFileSync(file, `${Buffer.alloc(32).toString('base64')}\n`);
    expect(() => kekIdOfFile(file)).toThrow('base64 of 32 bytes');
  });
});

describe('schema:check', () => {
  it('reports migrations, tables and counts with SELECTs only, never a row', async () => {
    const { db, query } = await createTestDb();
    await db.query(
      "INSERT INTO accounts (google_sub, email) VALUES ('secret-sub', 'secret@example.com')",
    );
    const statements: string[] = [];
    const lines = await schemaReport(async (text, params) => {
      statements.push(text);
      return query(text, params);
    });
    expect(lines).toEqual([
      'Applied migrations: 001_init.sql, 002_notes_images.sql, 003_sync_v2.sql',
      'Tables: account_records, account_tokens, accounts, schema_migrations',
      '  account_records: 0 rows',
      '  account_tokens: 0 rows',
      '  accounts: 1 rows',
      '  schema_migrations: 3 rows',
    ]);
    expect(statements.every((text) => /^SELECT\b/.test(text))).toBe(true);
    expect(lines.join('\n')).not.toMatch(/secret/);
    await db.close();
  });
});

describe('stream-check', () => {
  let close: () => Promise<void>;
  let deps: ReturnType<typeof createTestDeps>['deps'];

  beforeAll(async () => {
    const test = await createTestDb();
    close = () => test.db.close();
    deps = createTestDeps(test.store, {
      now: () => Date.now(),
      kek: await importKek(new Uint8Array(32).fill(3)),
    }).deps;
  });

  afterAll(async () => {
    await close();
  });

  it('writes 40 MiB of junk, cuts, resumes, cancels and tombstones it all', async () => {
    const account = await signUp(deps);
    const app = createApp(deps);
    const lines: string[] = [];
    await runStreamCheck({
      apiBase: 'https://sync.example.test',
      token: account.token,
      keyId: account.keyId,
      fetch: async (input, init) => app.fetch(new Request(String(input), init)),
      log: (line) => lines.push(line),
    });
    expect(lines).toHaveLength(6);
    expect(lines[1]).toMatch(/^Wrote 40 records/);
    expect(lines[2]).toMatch(/^Cut a pull after \d+ bytes/);
    expect(lines[3]).toMatch(/^Resumed and completed/);
    expect(lines[4]).toMatch(/^Cancelled a pull after its first batch: 1 records/);
    expect(lines[5]).toMatch(/^Tombstoned 40 of 40/);
    expect(lines.join('\n')).not.toContain(account.token);
    const me = await app.fetch(
      new Request('https://sync.example.test/v2/me', {
        headers: { Authorization: `Bearer ${account.token}` },
      }),
    );
    const { usage } = (await me.json()) as { usage: { bytes: number } };
    expect(usage.bytes).toBe(40 * 640);
  }, 60_000);

  it('refuses an account already holding more than 5 MiB, writing nothing', async () => {
    const account = await signUp(deps, 'sub-full');
    const app = createApp(deps);
    const posts: string[] = [];
    const fetchFn: typeof fetch = async (input, init) => {
      const req = new Request(String(input), init);
      if (req.method === 'POST') {
        posts.push(req.url);
      }
      const res = await app.fetch(req);
      if (req.url.endsWith('/v2/me')) {
        const body = (await res.json()) as { usage: { bytes: number } };
        body.usage.bytes = 5 * 2 ** 20 + 1;
        return Response.json(body);
      }
      return res;
    };
    await expect(
      runStreamCheck({
        apiBase: 'https://x.test',
        token: account.token,
        keyId: account.keyId,
        fetch: fetchFn,
        log: () => {},
      }),
    ).rejects.toThrow('more than 5 MiB');
    expect(posts).toEqual([]);
  });
});
