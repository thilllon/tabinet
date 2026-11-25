/**
 * Applies the SQL files in server/migrations/ that the database has not seen yet:
 * `DATABASE_URL=... pnpm --filter tabinet-server migrate`. Uses Neon's Pool (a WebSocket session),
 * because a migration is several statements in one transaction, which the HTTP driver cannot run.
 *
 * 003 deletes every v1 account and refuses to run on a database that has one, unless the
 * environment says `WIPE_V1=yes`, which this passes on to the migration as `tabinet.wipe_v1`.
 */
import { Pool } from '@neondatabase/serverless';

import { runMigrations } from '../src/db/migrations.js';

const connectionString = process.env.DATABASE_URL;
if (connectionString === undefined || connectionString === '') {
  console.error('Set DATABASE_URL to the Postgres connection string first.');
  process.exit(1);
}

const pool = new Pool({ connectionString });
try {
  const applied = await runMigrations(
    {
      exec: async (sql) => {
        await pool.query(sql);
      },
      query: async (text, params) => (await pool.query(text, params)).rows,
    },
    undefined,
    { settings: process.env.WIPE_V1 === 'yes' ? { 'tabinet.wipe_v1': 'yes' } : {} },
  );
  console.log(applied.length > 0 ? `Applied: ${applied.join(', ')}` : 'Already up to date.');
} finally {
  await pool.end();
}
