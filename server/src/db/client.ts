import { neon } from '@neondatabase/serverless';

import type { Query } from './store.js';

/** Neon's HTTP driver as a `Query`. Production only: dev and the tests use PGlite. */
export function createNeonQuery(databaseUrl: string): Query {
  const sql = neon(databaseUrl);
  return (text, params) => sql.query(text, params);
}
