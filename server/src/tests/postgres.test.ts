// Concurrency on a real Postgres with two connections, which PGlite (one connection, serialized)
// cannot show: the last place under each cap, compare and swap, seq in commit order, and an account
// deleted during a write. CI provides a postgres service and TEST_DATABASE_URL; without it this
// file is skipped. It refuses any host but localhost, and works in a schema of its own.
import { randomBytes } from 'node:crypto';

import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { POLICY } from '../../../src/constants.js';
import { runMigrations } from '../db/migrations.js';

const URL_TEXT = process.env.TEST_DATABASE_URL;
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);

function localUrl(text: string): string {
  const url = new URL(text);
  if (!LOCAL_HOSTS.has(url.hostname)) {
    throw new Error('TEST_DATABASE_URL must point at localhost');
  }
  return text;
}

const MIN_ROW = POLICY.record.maxTombstoneChars + POLICY.record.overheadBytes;
const KEY_ID = 'AAAAAAAAAAAAAAAAAAAAAA';
const APPLY =
  'SELECT outcome, new_seq FROM apply_account_record($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)';

describe.skipIf(URL_TEXT === undefined || URL_TEXT === '')('real Postgres, two connections', () => {
  const schema = `tabinet_test_${randomBytes(6).toString('hex')}`;
  let admin: pg.Client;
  let a: pg.Client;
  let b: pg.Client;
  let account: string;

  const connect = async () => {
    const client = new pg.Client({
      connectionString: localUrl(URL_TEXT ?? ''),
      options: `-c search_path=${schema}`,
    });
    await client.connect();
    return client;
  };

  beforeAll(async () => {
    admin = await connect();
    await admin.query(`CREATE SCHEMA ${schema}`);
    await runMigrations({
      exec: async (sql) => {
        await admin.query(sql);
      },
      query: async (text, params) => (await admin.query(text, params)).rows,
    });
    a = await connect();
    b = await connect();
  });

  afterAll(async () => {
    await a?.end();
    await b?.end();
    await admin?.query(`DROP SCHEMA ${schema} CASCADE`);
    await admin?.end();
  });

  beforeEach(async () => {
    await admin.query('TRUNCATE accounts CASCADE');
    const { rows } = await admin.query(
      `INSERT INTO accounts (google_sub, email, key_id, key_generation, write_verifier, key_encryption_key_id, sealed_envelope)
       VALUES ('sub', 'e', $1, 1, repeat('a', 64), repeat('b', 16), repeat('A', 168)) RETURNING id`,
      [KEY_ID],
    );
    account = String(rows[0].id);
  });

  const apply = (
    client: pg.Client,
    kind: string,
    id: string,
    updatedAt: number,
    options: { deleted?: boolean; baseSeq?: number | null; bytes?: number } = {},
  ) =>
    client.query(APPLY, [
      account,
      KEY_ID,
      kind,
      id,
      updatedAt,
      options.deleted ?? false,
      'AAAAAAAAAAAAAAAA',
      'AAAAAAAAAAAAAAAAAAAAAAAA',
      kind === 'doc' ? (options.baseSeq ?? null) : null,
      options.bytes ?? MIN_ROW,
      POLICY.account.storageBytes,
      POLICY.account.screenshots,
    ]);

  /** Runs `first` in an open transaction on `a`, starts `second` on `b`, then commits `a`. */
  async function race<T>(first: () => Promise<unknown>, second: () => Promise<T>) {
    await a.query('BEGIN');
    await first();
    let done = false;
    const waiting = second().then((value) => {
      done = true;
      return value;
    });
    await new Promise((resolve) => setTimeout(resolve, 200));
    const blocked = !done;
    await a.query('COMMIT');
    return { blocked, result: await waiting };
  }

  it('gives the last storage place to exactly one of two simultaneous writers', async () => {
    await admin.query('UPDATE accounts SET storage_bytes = $2 WHERE id = $1', [
      account,
      POLICY.account.storageBytes - MIN_ROW,
    ]);
    const [x, y] = await Promise.all([apply(a, 'session', 'x', 1), apply(b, 'session', 'y', 1)]);
    expect([x.rows[0].outcome, y.rows[0].outcome].sort()).toEqual(['applied', 'storage_limit']);
    const { rows } = await admin.query('SELECT storage_bytes FROM accounts WHERE id = $1', [
      account,
    ]);
    expect(Number(rows[0].storage_bytes)).toBe(POLICY.account.storageBytes);
  });

  it('gives the last screenshot place to exactly one of two, even when one waits', async () => {
    await admin.query('UPDATE accounts SET screenshots = $2 WHERE id = $1', [
      account,
      POLICY.account.screenshots - 1,
    ]);
    const { blocked, result } = await race(
      () => apply(a, 'image', 'one', 1),
      () => apply(b, 'image', 'two', 1),
    );
    expect(blocked).toBe(true);
    expect(result.rows[0].outcome).toBe('image_limit');
  });

  it('lets one of two compare-and-swap writers on the same base win', async () => {
    const created = await apply(admin, 'doc', 'd'.padEnd(43, 'x'), 1);
    const base = Number(created.rows[0].new_seq);
    const id = 'd'.padEnd(43, 'x');
    const { blocked, result } = await race(
      () => apply(a, 'doc', id, 2, { baseSeq: base }),
      () => apply(b, 'doc', id, 3, { baseSeq: base }),
    );
    expect(blocked).toBe(true);
    expect(result.rows[0].outcome).toBe('stale');
  });

  it("orders an account's seq by commit: the waiting writer gets the higher seq", async () => {
    let firstSeq = 0;
    const { blocked, result } = await race(
      async () => {
        firstSeq = Number((await apply(a, 'session', 'first', 1)).rows[0].new_seq);
      },
      () => apply(b, 'session', 'second', 1),
    );
    expect(blocked).toBe(true);
    expect(Number(result.rows[0].new_seq)).toBeGreaterThan(firstSeq);
    const { rows } = await admin.query('SELECT last_seq FROM accounts WHERE id = $1', [account]);
    expect(Number(rows[0].last_seq)).toBe(Number(result.rows[0].new_seq));
  });

  it('a write waiting on a deletion finds no account and writes nothing', async () => {
    const { blocked, result } = await race(
      () => a.query('DELETE FROM accounts WHERE id = $1', [account]),
      () => apply(b, 'session', 's', 1),
    );
    expect(blocked).toBe(true);
    expect(result.rows[0].outcome).toBe('no_account');
    expect((await admin.query('SELECT count(*)::int AS n FROM account_records')).rows).toEqual([
      { n: 0 },
    ]);
  });

  it('a deletion waiting on a write removes the row it wrote', async () => {
    const { blocked } = await race(
      () => apply(a, 'session', 's', 1),
      () => b.query('DELETE FROM accounts WHERE id = $1', [account]),
    );
    expect(blocked).toBe(true);
    expect((await admin.query('SELECT count(*)::int AS n FROM account_records')).rows).toEqual([
      { n: 0 },
    ]);
  });
});

it('refuses a TEST_DATABASE_URL that is not localhost', () => {
  expect(() => localUrl('postgres://u:p@db.example.com/x')).toThrow('localhost');
  expect(localUrl('postgres://u:p@127.0.0.1:5432/x')).toContain('127.0.0.1');
});
