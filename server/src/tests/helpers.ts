import { randomBytes } from 'node:crypto';
import { copyFile, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { PGlite } from '@electric-sql/pglite';

import { createApp } from '../app.js';
import type { Deps } from '../context.js';
import { type MigrationDb, runMigrations } from '../db/migrations.js';
import { createSqlStore, type Query, type Store } from '../db/store.js';
import { importKeyEncryptionKey, type KeyEncryptionKey } from '../envelope.js';
import { GoogleUnavailableError } from '../google-auth.js';
import type { KeyEnvelope, RecordKind, RecordOut, Usage, WireKey, WriteResult } from '../types.js';

export const ORIGIN = 'chrome-extension://bmbpmnfhfbdjdjpblimidmbohgccmjdg';
const BASE = 'https://sync.example.test';
/** The access token the fake Google cannot answer for: a 503. */
export const GOOGLE_DOWN = 'google-down';

/** A test key encryption key. Never the vectors' one, and never pinned anywhere. */
export const TEST_KEY_ENCRYPTION_KEY_BYTES = new Uint8Array(32).fill(7);
export const TEST_KEY_ENCRYPTION_KEY: KeyEncryptionKey = await importKeyEncryptionKey(
  TEST_KEY_ENCRYPTION_KEY_BYTES,
);

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
  await db.exec('TRUNCATE accounts CASCADE');
}

/**
 * Test deps: a fake Google that accepts `google:<sub>:<email>` and cannot be reached for
 * `GOOGLE_DOWN`, the test key encryption key, a settable clock, counting bytes.
 */
export function createTestDeps(store: Store, overrides: Partial<Deps> = {}) {
  const clock = { now: 1_800_000_000_000 };
  let counter = 0;
  const deps: Deps = {
    store,
    verifyGoogleToken: async (accessToken) => {
      if (accessToken === GOOGLE_DOWN) {
        throw new GoogleUnavailableError('Google tokeninfo could not be reached');
      }
      const match = /^google:([^:]+):(.+)$/.exec(accessToken);
      return match ? { sub: match[1], email: match[2] } : null;
    },
    keyEncryptionKey: TEST_KEY_ENCRYPTION_KEY,
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

export interface RequestOptions {
  token?: string;
  keyId?: string;
  body?: unknown;
  rawBody?: string;
  origin?: string;
  headers?: Record<string, string>;
}

export function request(method: string, path: string, options: RequestOptions = {}): Request {
  const headers = new Headers(options.headers);
  if (options.token !== undefined) {
    headers.set('Authorization', `Bearer ${options.token}`);
  }
  if (options.keyId !== undefined) {
    headers.set('Tabinet-Key-Id', options.keyId);
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

export function randomB64(n: number): string {
  return randomBytes(n).toString('base64');
}

/** The access token the fake Google accepts for this account. */
export function google(sub = 'sub-1', email = 'a@example.com'): string {
  return `google:${sub}:${email}`;
}

/** A fresh envelope and proof, as a device would make them (the server checks only their form). */
export function newKey(generation = 1): { envelope: KeyEnvelope; proof: string } {
  return {
    envelope: {
      v: 2,
      generation,
      keyId: randomBytes(16).toString('base64url'),
      salt: randomB64(16),
      iv: randomB64(12),
      wrapped: randomB64(48),
    },
    proof: randomB64(32),
  };
}

/** The same key, rewrapped one generation up: a new salt, IV and wrapped key, the same proof. */
export function rewrapped(
  envelope: KeyEnvelope,
  generation = envelope.generation + 1,
): KeyEnvelope {
  return {
    ...envelope,
    generation,
    salt: randomB64(16),
    iv: randomB64(12),
    wrapped: randomB64(48),
  };
}

/** A doc record id: 43 characters of base64url. */
export function docId(n: number | string): string {
  return `d${n}`.padEnd(43, 'x');
}

export interface RecordOptions {
  deleted?: boolean;
  /** Bytes of ciphertext before base64. */
  bytes?: number;
  fill?: number;
  baseSeq?: number | null;
}

/** A record as a client sends it; a doc gets `baseSeq` (null by default). */
export function rec(kind: RecordKind, id: string, updatedAt: number, options: RecordOptions = {}) {
  const deleted = options.deleted ?? false;
  const record: Record<string, unknown> = {
    kind,
    id,
    updatedAt,
    deleted,
    iv: b64(12),
    ciphertext: b64(options.bytes ?? (deleted ? 32 : 48), options.fill ?? 1),
  };
  if (kind === 'doc') {
    record.baseSeq = options.baseSeq ?? null;
  }
  return record;
}

/** A base64 ciphertext of exactly `chars` characters (a multiple of 4). */
export function ciphertextOfChars(chars: number): string {
  return b64((chars / 4) * 3);
}

/** Every field any route answers with; each test reads the ones its route sends. */
export interface ApiBody {
  error: string;
  token: string;
  expiresAt: number;
  accountId: string;
  email: string;
  key: WireKey;
  usage: Usage;
  envelope: KeyEnvelope;
  results: (WriteResult & { seq?: number; current?: RecordOut | null; reason?: string })[];
}

/** The app over deps, with a JSON helper. */
export function client(deps: Deps) {
  const app = createApp(deps);
  return {
    app,
    async call(req: Request) {
      const res = await app.fetch(req);
      const text = await res.text();
      const body = (text === '' ? undefined : JSON.parse(text)) as ApiBody;
      return { status: res.status, body, res, text };
    },
  };
}

/** Signs in and creates a key, as a new device does: the bearer, the key id and its proof. */
export async function signUp(
  deps: Deps,
  sub = 'sub-1',
  email = `${sub}@example.com`,
): Promise<{
  token: string;
  accountId: string;
  keyId: string;
  envelope: KeyEnvelope;
  proof: string;
  accessToken: string;
}> {
  const { call } = client(deps);
  const accessToken = google(sub, email);
  const signIn = await call(request('POST', '/v2/auth/google', { body: { accessToken } }));
  if (signIn.status !== 200) {
    throw new Error(`sign-in answered ${signIn.status}`);
  }
  const key = newKey();
  const put = await call(
    request('PUT', '/v2/keys', {
      token: signIn.body.token,
      body: { accessToken, envelope: key.envelope, proof: key.proof },
    }),
  );
  if (put.status !== 201) {
    throw new Error(`key create answered ${put.status}`);
  }
  return {
    token: signIn.body.token,
    accountId: signIn.body.accountId,
    keyId: key.envelope.keyId,
    envelope: key.envelope,
    proof: key.proof,
    accessToken,
  };
}

/** Reads an NDJSON body whole into its lines. */
export async function readLines(res: Response): Promise<Record<string, unknown>[]> {
  const text = await res.text();
  return text === ''
    ? []
    : text
        .split('\n')
        .filter((line) => line !== '')
        .map((line) => JSON.parse(line) as Record<string, unknown>);
}

const SHIPPED = path.resolve(import.meta.dirname, '../../migrations');

/** A migration connection over PGlite. */
export function adapter(db: PGlite): MigrationDb {
  return {
    exec: async (sql) => {
      await db.exec(sql);
    },
    query: async (text, params) => (await db.query<Record<string, unknown>>(text, params)).rows,
  };
}

/** A database as v1 left it: 001 and 002 applied, with one user, a token and a record. */
export async function v1Database(): Promise<PGlite> {
  const dir = await mkdtemp(path.join(tmpdir(), 'tabinet-v1-'));
  for (const name of ['001_init.sql', '002_notes_images.sql']) {
    await copyFile(path.join(SHIPPED, name), path.join(dir, name));
  }
  const db = new PGlite();
  await runMigrations(adapter(db), dir);
  await db.exec(`
    INSERT INTO users (id, google_sub, email, key_setup)
      VALUES ('00000000-0000-4000-8000-000000000001', 'sub-v1', 'v1@example.com', '{"salt":"x"}');
    INSERT INTO auth_tokens (token_hash, user_id, expires_at)
      VALUES ('hash', '00000000-0000-4000-8000-000000000001', now() + interval '1 day');
    INSERT INTO records (user_id, kind, id, updated_at, deleted, iv, ciphertext, seq)
      VALUES ('00000000-0000-4000-8000-000000000001', 'session', 's', 1, false, 'aXY=', 'Y3Q=', 1);
  `);
  return db;
}
