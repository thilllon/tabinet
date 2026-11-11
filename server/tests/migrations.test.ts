import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { PGlite } from '@electric-sql/pglite';
import { describe, expect, it } from 'vitest';

import { migrationFiles, type MigrationDb, runMigrations } from '../src/migrations.js';

function adapter(db: PGlite): MigrationDb {
  return {
    exec: async (sql) => {
      await db.exec(sql);
    },
    query: async (text, params) => (await db.query<Record<string, unknown>>(text, params)).rows,
  };
}

describe('migrations', () => {
  it('lists the shipped files in order', async () => {
    expect(await migrationFiles()).toEqual(['001_init.sql', '002_notes_images.sql']);
  });

  it('applies every migration once and records it', async () => {
    const db = new PGlite();
    expect(await runMigrations(adapter(db))).toEqual(['001_init.sql', '002_notes_images.sql']);
    expect(await runMigrations(adapter(db))).toEqual([]);
    const tables = await db.query<{ tablename: string }>(
      "SELECT tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename",
    );
    expect(tables.rows.map((r) => r.tablename)).toEqual([
      'auth_tokens',
      'records',
      'schema_migrations',
      'users',
    ]);
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
    const tables = await db.query("SELECT 1 FROM pg_tables WHERE tablename = 'c'");
    expect(tables.rows).toEqual([]);
    expect((await db.query('SELECT name FROM schema_migrations')).rows).toEqual([]);
    await db.close();
  });
});
