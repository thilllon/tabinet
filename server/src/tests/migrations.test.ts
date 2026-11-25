import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { PGlite } from '@electric-sql/pglite';
import { describe, expect, it } from 'vitest';

import { migrationFiles, runMigrations } from '../db/migrations.js';
import { adapter, v1Database } from './helpers.js';

async function tables(db: PGlite): Promise<string[]> {
  const rows = await db.query<{ tablename: string }>(
    "SELECT tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename",
  );
  return rows.rows.map((r) => r.tablename);
}

describe('migrations', () => {
  it('lists the shipped files in order', async () => {
    expect(await migrationFiles()).toEqual([
      '001_init.sql',
      '002_notes_images.sql',
      '003_sync_v2.sql',
    ]);
  });

  it('applies every migration once on an empty database, with no flag, and records it', async () => {
    const db = new PGlite();
    expect(await runMigrations(adapter(db))).toEqual([
      '001_init.sql',
      '002_notes_images.sql',
      '003_sync_v2.sql',
    ]);
    expect(await runMigrations(adapter(db))).toEqual([]);
    expect(await tables(db)).toEqual([
      'account_records',
      'account_tokens',
      'accounts',
      'schema_migrations',
    ]);
    await db.close();
  });

  it('refuses 003 on a database with a v1 account, and leaves v1 intact', async () => {
    const db = await v1Database();
    await expect(runMigrations(adapter(db))).rejects.toThrow(
      '003 deletes every v1 account: run migrate with WIPE_V1=yes',
    );
    await db.exec('ROLLBACK');
    expect(await tables(db)).toEqual(['auth_tokens', 'records', 'schema_migrations', 'users']);
    expect((await db.query('SELECT count(*)::int AS n FROM users')).rows).toEqual([{ n: 1 }]);
    expect((await db.query('SELECT count(*)::int AS n FROM records')).rows).toEqual([{ n: 1 }]);
    expect((await db.query('SELECT name FROM schema_migrations ORDER BY name')).rows).toEqual([
      { name: '001_init.sql' },
      { name: '002_notes_images.sql' },
    ]);
    await db.close();
  });

  it('refuses another value of the flag too', async () => {
    const db = await v1Database();
    await expect(
      runMigrations(adapter(db), undefined, { settings: { 'tabinet.wipe_v1': 'no' } }),
    ).rejects.toThrow('WIPE_V1=yes');
    await db.exec('ROLLBACK');
    expect(await tables(db)).toContain('users');
    await db.close();
  });

  it('wipes v1 with the flag, once', async () => {
    const db = await v1Database();
    const settings = { 'tabinet.wipe_v1': 'yes' };
    expect(await runMigrations(adapter(db), undefined, { settings })).toEqual(['003_sync_v2.sql']);
    expect(await tables(db)).toEqual([
      'account_records',
      'account_tokens',
      'accounts',
      'schema_migrations',
    ]);
    for (const table of ['accounts', 'account_tokens', 'account_records']) {
      expect((await db.query(`SELECT count(*)::int AS n FROM ${table}`)).rows).toEqual([{ n: 0 }]);
    }
    const functions = await db.query<{ proname: string }>(
      "SELECT proname FROM pg_proc WHERE proname IN ('apply_image_record', 'apply_account_record')",
    );
    expect(functions.rows.map((r) => r.proname)).toEqual(['apply_account_record']);
    expect(await runMigrations(adapter(db), undefined, { settings })).toEqual([]);
    // The setting was local to the migration's transaction.
    expect((await db.query("SELECT current_setting('tabinet.wipe_v1', true) AS v")).rows).toEqual([
      { v: '' },
    ]);
    await db.close();
  });

  it.each([
    ['a quote in the value', { 'tabinet.wipe_v1': "yes'); DROP TABLE x; --" }],
    ['a capital in the name', { 'Tabinet.wipe_v1': 'yes' }],
    ['a space in the value', { 'tabinet.wipe_v1': 'y es' }],
    ['an empty value', { 'tabinet.wipe_v1': '' }],
  ])('refuses a setting with %s before running anything', async (_name, settings) => {
    const db = new PGlite();
    await expect(runMigrations(adapter(db), undefined, { settings })).rejects.toThrow(RangeError);
    expect(await tables(db)).toEqual([]);
    await db.close();
  });

  it('applies only the new file and ignores anything not named NNN_name.sql', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'tabinet-migrations-'));
    await writeFile(path.join(dir, '001_a.sql'), 'CREATE TABLE a (id int);');
    await writeFile(path.join(dir, 'notes.txt'), 'not sql');
    const db = new PGlite();
    expect(await runMigrations(adapter(db), dir)).toEqual(['001_a.sql']);
    await writeFile(path.join(dir, '002_b.sql'), 'CREATE TABLE b (id int);');
    expect(await runMigrations(adapter(db), dir)).toEqual(['002_b.sql']);
    await db.close();
  });

  it('rolls a failing migration back as a whole', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'tabinet-migrations-'));
    await writeFile(path.join(dir, '001_bad.sql'), 'CREATE TABLE c (id int);\nSELECT nope;');
    const db = new PGlite();
    await expect(runMigrations(adapter(db), dir)).rejects.toThrow();
    await db.exec('ROLLBACK');
    const rows = await db.query("SELECT 1 FROM pg_tables WHERE tablename = 'c'");
    expect(rows.rows).toEqual([]);
    expect((await db.query('SELECT name FROM schema_migrations')).rows).toEqual([]);
    await db.close();
  });

  it('passes the setting to each migration it applies', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'tabinet-migrations-'));
    await writeFile(
      path.join(dir, '001_read.sql'),
      "CREATE TABLE seen AS SELECT current_setting('tabinet.x', true) AS v;",
    );
    const db = new PGlite();
    await runMigrations(adapter(db), dir, { settings: { 'tabinet.x': 'on' } });
    expect((await db.query('SELECT v FROM seen')).rows).toEqual([{ v: 'on' }]);
    await db.close();
  });
});
