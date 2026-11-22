/**
 * Applies the SQL files in server/migrations/ that the database has not seen yet:
 * `DATABASE_URL=... pnpm --filter tabinet-server migrate`. Uses Neon's Pool (a WebSocket session),
 * because a migration is several statements in one transaction, which the HTTP driver cannot run.
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
  const applied = await runMigrations({
    exec: async (sql) => {
      await pool.query(sql);
    },
    query: async (text, params) => (await pool.query(text, params)).rows,
  });
  console.log(applied.length > 0 ? `Applied: ${applied.join(', ')}` : 'Already up to date.');
} finally {
  await pool.end();
}
