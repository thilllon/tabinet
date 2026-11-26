// How deployments of other versions fail closed (spec 6.3): after migration 003 every statement of
// every shipped v1 store fails without reading or writing, and the v2 statements fail on a
// database migration 003 has not reached.
import type { PGlite } from '@electric-sql/pglite';
import { describe, expect, it } from 'vitest';

import { runMigrations } from '../db/migrations.js';
import { createSqlStore, type Query } from '../db/store.js';
import { hashToken } from '../tokens.js';
import { adapter, docId, rec, TEST_KEY_ENCRYPTION_KEY, v1Database } from './helpers.js';
import { V1_C824F443, V1_MAIN, V1_V8_3_0, V1_V9_1_0, type V1Statement } from './v1-statements.js';

function queryOf(db: PGlite): Query {
  return async (text, params) => (await db.query<Record<string, unknown>>(text, params)).rows;
}

/** The SQLSTATE a statement fails with, or 'ok' when it ran. */
async function outcome(db: PGlite, statement: V1Statement): Promise<string> {
  try {
    await db.query(statement.text, statement.params);
    return 'ok';
  } catch (err) {
    return String((err as { code?: string }).code);
  }
}

async function snapshot(db: PGlite): Promise<string> {
  const tables = ['accounts', 'account_tokens', 'account_records'];
  const rows = [];
  for (const table of tables) {
    rows.push((await db.query(`SELECT row_to_json(t)::text AS r FROM ${table} t ORDER BY 1`)).rows);
  }
  return JSON.stringify(rows);
}

describe('after migration 003', () => {
  it.each([
    ['824f443', V1_C824F443],
    ['v8.3.0', V1_V8_3_0],
    ['v9.1.0', V1_V9_1_0],
    ['main 9f47150', V1_MAIN],
  ])(
    'every statement of the %s store fails with 42P01 or 42883 and writes nothing',
    async (_name, statements) => {
      const db = await v1Database();
      // The v1 statements run first as they shipped, so the fixture's parameters are valid.
      for (const statement of statements) {
        expect([statement.text, await outcome(db, statement)]).toEqual([statement.text, 'ok']);
      }
      await runMigrations(adapter(db), undefined, { settings: { 'tabinet.wipe_v1': 'yes' } });

      // Some v2 data, which the old statements must not touch.
      const store = createSqlStore(queryOf(db));
      const account = await store.signIn('sub-v1', 'v1@example.com', hashToken('t'), 2e12, 1e12);
      await db.query(
        "UPDATE accounts SET key_id = 'AAAAAAAAAAAAAAAAAAAAAA', key_generation = 1, write_verifier = repeat('a', 64), key_encryption_key_id = $2, sealed_envelope = repeat('A', 168) WHERE id = $1",
        [account.id, TEST_KEY_ENCRYPTION_KEY.id],
      );
      const record = rec('doc', docId(1), 1) as Parameters<typeof store.applyRecord>[2];
      await store.applyRecord(account.id, 'AAAAAAAAAAAAAAAAAAAAAA', record, 640);
      const before = await snapshot(db);

      for (const statement of statements) {
        const code = await outcome(db, statement);
        expect(['42P01', '42883'], statement.text).toContain(code);
      }
      expect(await snapshot(db)).toBe(before);
      await db.close();
    },
  );
});

describe('before migration 003', () => {
  it('every v2 statement fails without writing', async () => {
    const db = await v1Database();
    const store = createSqlStore(queryOf(db));
    const countV1 = async () =>
      JSON.stringify([
        (await db.query('SELECT row_to_json(u) AS r FROM users u')).rows,
        (await db.query('SELECT row_to_json(t) AS r FROM auth_tokens t')).rows,
        (await db.query('SELECT row_to_json(r) AS r FROM records r')).rows,
      ]);
    const before = await countV1();
    const id = '00000000-0000-4000-8000-000000000001';
    const keyId = 'AAAAAAAAAAAAAAAAAAAAAA';
    const calls: [string, () => Promise<unknown>][] = [
      ['signIn', () => store.signIn('sub-v1', 'e', 'h', 2e12, 1e12)],
      ['findAccountByToken', () => store.findAccountByToken('hash', 1e12)],
      ['deleteToken', () => store.deleteToken('hash')],
      ['readSealed', () => store.readSealed(id)],
      [
        'writeKey',
        () =>
          store.writeKey(id, 'sub-v1', {
            keyId,
            generation: 1,
            writeVerifier: 'a'.repeat(64),
            keyEncryptionKeyId: TEST_KEY_ENCRYPTION_KEY.id,
            sealed: 'A'.repeat(168),
          }),
      ],
      ['readKeyState', () => store.readKeyState(id)],
      ['streamStart', () => store.streamStart(id, keyId)],
      ['streamBatch', () => store.streamBatch(id, keyId, 0, 10, 10, 1000)],
      ['applyRecord', () => store.applyRecord(id, keyId, rec('session', 's', 5) as never, 640)],
      ['readRecord', () => store.readRecord(id, 'session', 's')],
      ['usage', () => store.usage(id)],
      ['deleteAccount', () => store.deleteAccount(id, 'sub-v1')],
    ];
    for (const [name, run] of calls) {
      const err = await run().then(
        () => null,
        (e: unknown) => e,
      );
      expect([name, (err as { code?: string } | null)?.code]).toEqual([
        name,
        name === 'applyRecord' ? '42883' : '42P01',
      ]);
    }
    expect(await countV1()).toBe(before);
    await db.close();
  });
});
