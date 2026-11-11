import { PGlite } from '@electric-sql/pglite';

import type { Deps } from '../src/app.js';
import { runMigrations } from '../src/migrations.js';
import { createSqlStore, type Query, type Store } from '../src/store.js';

export const ORIGIN = 'chrome-extension://bmbpmnfhfbdjdjpblimidmbohgccmjdg';
const BASE = 'https://sync.example.test';

/** A real Postgres (PGlite) with the real migrations applied. */
export async function createTestDb(): Promise<{ db: PGlite; query: Query; store: Store }> {
  const db = new PGlite();
  const query: Query = async (text, params) =>
    (await db.query<Record<string, unknown>>(text, params)).rows;
  await runMigrations({
    exec: async (sql) => {
      await db.exec(sql);
    },
    query,
  });
  return { db, query, store: createSqlStore(query) };
}

export async function resetDb(db: PGlite): Promise<void> {
  await db.exec('TRUNCATE users CASCADE');
}

/** Test deps: a fake Google that accepts `google:<sub>:<email>`, a settable clock, counting bytes. */
export function createTestDeps(store: Store, overrides: Partial<Deps> = {}) {
  const clock = { now: 1_800_000_000_000 };
  let counter = 0;
  const deps: Deps = {
    store,
    verifyGoogleToken: async (accessToken) => {
      const match = /^google:([^:]+):(.+)$/.exec(accessToken);
      return match ? { sub: match[1], email: match[2] } : null;
    },
    now: () => clock.now,
    randomBytes: (size) => {
      counter += 1;
      return new Uint8Array(size).fill(counter % 256);
    },
    allowedOrigins: [ORIGIN],
    ...overrides,
  };
  return { deps, clock };
}

export function request(
  method: string,
  path: string,
  options: { token?: string; body?: unknown; rawBody?: string; origin?: string } = {},
): Request {
  const headers = new Headers();
  if (options.token !== undefined) {
    headers.set('Authorization', `Bearer ${options.token}`);
  }
  if (options.origin !== undefined) {
    headers.set('Origin', options.origin);
  }
  let body: string | undefined;
  if (options.rawBody !== undefined) {
    body = options.rawBody;
  } else if (options.body !== undefined) {
    body = JSON.stringify(options.body);
    headers.set('Content-Type', 'application/json');
  }
  return new Request(`${BASE}${path}`, { method, headers, body });
}

/** `n` bytes as base64. */
export function b64(n: number, fill = 1): string {
  return Buffer.alloc(n, fill).toString('base64');
}

export function sessionRecord(id: string, updatedAt: number, fill = 1) {
  return { kind: 'session', id, updatedAt, deleted: false, iv: b64(12), ciphertext: b64(48, fill) };
}

export function tombstone(id: string, updatedAt: number) {
  return { kind: 'session', id, updatedAt, deleted: true, iv: b64(12), ciphertext: b64(32, 2) };
}

/** A live screenshot record (or its tombstone): an `image` record, which the per-account cap counts. */
export function imageRecord(id: string, updatedAt: number, deleted = false) {
  return { kind: 'image', id, updatedAt, deleted, iv: b64(12), ciphertext: b64(64, 3) };
}

export function validKeySetup() {
  return {
    kdf: { name: 'PBKDF2', hash: 'SHA-256', iterations: 600_000 },
    salt: b64(16),
    check: b64(32),
    checkIv: b64(12),
  };
}
