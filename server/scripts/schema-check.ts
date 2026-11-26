/**
 * What a database holds, read with SELECTs only: the applied migrations, the public tables and
 * their row counts. Never a row and never the connection string.
 *
 *   DATABASE_URL=... pnpm --filter tabinet-server schema:check
 */
import { pathToFileURL } from 'node:url';

import { createNeonQuery } from '../src/db/client.js';
import type { Query } from '../src/db/store.js';

const TABLE_NAME = /^[a-z_][a-z0-9_]*$/;

/** The report, line by line. Every statement it runs is a SELECT. */
export async function schemaReport(query: Query): Promise<string[]> {
  const lines: string[] = [];
  const [registered] = await query(
    "SELECT to_regclass('public.schema_migrations') IS NOT NULL AS present",
  );
  const migrations =
    registered?.present === true
      ? (await query('SELECT name FROM schema_migrations ORDER BY name')).map((row) =>
          String(row.name),
        )
      : [];
  lines.push(`Applied migrations: ${migrations.length > 0 ? migrations.join(', ') : 'none'}`);
  const tables = (
    await query("SELECT tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename")
  ).map((row) => String(row.tablename));
  lines.push(`Tables: ${tables.length > 0 ? tables.join(', ') : 'none'}`);
  for (const table of tables) {
    if (!TABLE_NAME.test(table)) {
      lines.push(`  ${JSON.stringify(table)}: not counted (unexpected name)`);
      continue;
    }
    const [row] = await query(`SELECT count(*)::bigint AS n FROM public."${table}"`);
    lines.push(`  ${table}: ${String(row?.n)} rows`);
  }
  return lines;
}

async function main(): Promise<void> {
  const url = process.env.DATABASE_URL;
  if (url === undefined || url === '' || !URL.canParse(url)) {
    console.error('Set DATABASE_URL to the Postgres connection string first.');
    process.exit(1);
  }
  try {
    for (const line of await schemaReport(createNeonQuery(url))) {
      console.log(line);
    }
  } catch (err) {
    // The name only: a driver error can quote the connection string.
    console.error('schema:check failed', err instanceof Error ? err.name : typeof err);
    process.exit(1);
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  await main();
}
