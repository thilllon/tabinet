import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';

/** A connection that can run a script of several statements (Neon's Pool, PGlite, pg). */
export interface MigrationDb {
  exec(sql: string): Promise<void>;
  query(text: string, params?: unknown[]): Promise<Record<string, unknown>[]>;
}

export interface MigrationOptions {
  /**
   * Settings each migration's transaction starts with, through `set_config(name, value, true)`:
   * `{ 'tabinet.wipe_v1': 'yes' }` lets 003 delete the v1 accounts.
   */
  settings?: Record<string, string>;
}

const FILE_PATTERN = /^\d{3}_[a-z0-9_]+\.sql$/;
/** A setting's name and value are inlined into the script, so only these characters pass. */
const SETTING_PATTERN = /^[a-z0-9_.]+$/;

const MIGRATIONS_DIR = path.resolve(import.meta.dirname, '../../migrations');

/** The migration files in order: `NNN_name.sql`, anything else in the folder ignored. */
export async function migrationFiles(dir = MIGRATIONS_DIR): Promise<string[]> {
  return (await readdir(dir)).filter((name) => FILE_PATTERN.test(name)).sort();
}

function settingsScript(settings: Record<string, string>): string {
  return Object.entries(settings)
    .map(([name, value]) => {
      if (!SETTING_PATTERN.test(name) || !SETTING_PATTERN.test(value)) {
        throw new RangeError('A migration setting has a character outside [a-z0-9_.]');
      }
      return `SELECT set_config('${name}', '${value}', true);\n`;
    })
    .join('');
}

/**
 * Applies every migration not yet recorded in `schema_migrations`, each in its own transaction
 * together with its bookkeeping row, and returns the names it applied.
 */
export async function runMigrations(
  db: MigrationDb,
  dir = MIGRATIONS_DIR,
  options: MigrationOptions = {},
): Promise<string[]> {
  // Checked before anything runs, so a bad setting changes nothing.
  const settings = settingsScript(options.settings ?? {});
  await db.exec(
    'CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())',
  );
  const done = new Set(
    (await db.query('SELECT name FROM schema_migrations')).map((row) => String(row.name)),
  );
  const applied: string[] = [];
  for (const name of await migrationFiles(dir)) {
    if (done.has(name)) {
      continue;
    }
    const sql = await readFile(path.join(dir, name), 'utf8');
    // The name matched FILE_PATTERN, so it is safe to inline: a script cannot take parameters.
    await db.exec(
      `BEGIN;\n${settings}${sql}\nINSERT INTO schema_migrations (name) VALUES ('${name}');\nCOMMIT;`,
    );
    applied.push(name);
  }
  return applied;
}
