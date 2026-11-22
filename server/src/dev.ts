/**
 * Local entry point: `pnpm --filter tabinet-server dev`. It cannot reach production: the database
 * is always an empty in-memory PGlite with the real migrations, it reads no .env file and no
 * connection string, and it listens on 127.0.0.1 only. Nothing that is deployed imports it.
 *
 * Optional, from the shell: PORT (8787), ALLOWED_ORIGINS, and GOOGLE_CLIENT_IDS to check sign-ins
 * with Google as production does. Without client ids every sign-in is refused.
 */
import { randomBytes } from 'node:crypto';

import { PGlite } from '@electric-sql/pglite';
import { serve } from '@hono/node-server';

import { createApp } from './app.js';
import { runMigrations } from './db/migrations.js';
import { createSqlStore, type Query } from './db/store.js';
import { listFromEnv } from './env.js';
import { createGoogleVerifier } from './google-auth.js';

const HOST = '127.0.0.1';

const db = new PGlite('memory://');
const query: Query = async (text, params) =>
  (await db.query<Record<string, unknown>>(text, params)).rows;
await runMigrations({
  exec: async (sql) => {
    await db.exec(sql);
  },
  query,
});

const clientIds = listFromEnv(process.env.GOOGLE_CLIENT_IDS);
const app = createApp({
  store: createSqlStore(query),
  verifyGoogleToken: clientIds.length > 0 ? createGoogleVerifier({ clientIds }) : async () => null,
  now: () => Date.now(),
  randomBytes: (size) => new Uint8Array(randomBytes(size)),
  allowedOrigins: listFromEnv(process.env.ALLOWED_ORIGINS),
});

const server = serve(
  { fetch: app.fetch, hostname: HOST, port: Number(process.env.PORT ?? 8787) },
  ({ port }) => {
    console.log(`tabinet-server dev: http://${HOST}:${port} (in-memory database, empty each run)`);
    if (clientIds.length === 0) {
      console.log('Sign-in is refused until GOOGLE_CLIENT_IDS is set in the shell.');
    }
  },
);

function stop(): void {
  server.close();
  void db.close().finally(() => process.exit(0));
}
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
