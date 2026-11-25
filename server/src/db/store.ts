import { POLICY } from '../../../src/constants.js';
import type { SealedRow } from '../envelope.js';
import type { Account, RecordIn, RecordKind, RecordOut, Usage, WireKey } from '../types.js';

/**
 * Runs one parameterised statement and returns its rows. Neon over HTTP in production, PGlite in
 * the tests and in dev. `signal` bounds the statement: every call of the store passes one.
 */
export type Query = (
  text: string,
  params?: unknown[],
  options?: { signal?: AbortSignal },
) => Promise<Record<string, unknown>[]>;

/** The key columns a key write stores. The plain envelope never reaches SQL. */
export interface KeyWrite {
  keyId: string;
  generation: number;
  writeVerifier: string;
  kekId: string;
  sealed: string;
}

export type SealedState =
  | { status: 'no_account' }
  | { status: 'no_key' }
  | { status: 'key'; row: SealedRow };

/** What a key write that changed nothing is classified by. Null: the account is gone. */
export type KeyState = {
  keyId: string | null;
  generation: number | null;
  writeVerifier: string | null;
} | null;

export type ApplyOutcome =
  | { outcome: 'applied'; seq: number }
  | {
      outcome:
        | 'stale'
        | 'absent'
        | 'image_limit'
        | 'storage_limit'
        | 'no_account'
        | 'key_missing'
        | 'key_mismatch';
    };

/** One batch of a pull: `fenced` when the account or its key is no longer the one asked for. */
export type StreamBatch = { status: 'fenced' } | { status: 'rows'; records: RecordOut[] };

/** Everything the handlers need from the database (every statement of spec 5.3). */
export interface Store {
  /**
   * Creates the account on its first sign-in or refreshes its email, drops its expired bearers and
   * stores the new bearer's hash. Times are ms since the epoch.
   */
  signIn(
    googleSub: string,
    email: string,
    tokenHash: string,
    expiresAt: number,
    now: number,
  ): Promise<{ id: string; email: string; key: WireKey }>;
  /** The account of a live bearer at `now`, or null. */
  findAccountByToken(tokenHash: string, now: number): Promise<Account | null>;
  deleteToken(tokenHash: string): Promise<void>;
  /** The sealed envelope's row, for `open()`. */
  readSealed(accountId: string): Promise<SealedState>;
  /**
   * The one conditional UPDATE: creates the key (generation 1, no key and no record yet) or
   * replaces it (same key id, same verifier, generation one up). Null when it changed nothing.
   */
  writeKey(accountId: string, googleSub: string, write: KeyWrite): Promise<WireKey>;
  readKeyState(accountId: string): Promise<KeyState>;
  /** `through` and usage for a pull, under the key fence; null when the fence fails. */
  streamStart(accountId: string, keyId: string): Promise<{ through: number; usage: Usage } | null>;
  /**
   * The rows with `cursor < seq <= through`, ascending, at most `maxRecords`, ending at
   * `maxBytes` of what they count, always at least one. Account and key fenced.
   */
  streamBatch(
    accountId: string,
    keyId: string,
    cursor: number,
    through: number,
    maxRecords: number,
    maxBytes: number,
  ): Promise<StreamBatch>;
  /** One `apply_account_record()` call, with the caps of `POLICY.account`. */
  applyRecord(
    accountId: string,
    keyId: string,
    record: RecordIn,
    storedBytes: number,
  ): Promise<ApplyOutcome>;
  /** The stored row, in a statement of its own (a fresh snapshot after the write). */
  readRecord(accountId: string, kind: RecordKind, id: string): Promise<RecordOut | null>;
  usage(accountId: string): Promise<Usage | null>;
  /** Deletes the account; its bearers and records go with it (ON DELETE CASCADE). */
  deleteAccount(accountId: string, googleSub: string): Promise<void>;
}

const RECORD_COLUMNS = 'kind, id, updated_at, deleted, iv, ciphertext, seq';

const KEY_WRITE_SQL = `
UPDATE accounts a SET
  key_id = $3,
  key_generation = $4::integer,
  write_verifier = $5,
  kek_id = $6,
  sealed_envelope = $7
WHERE a.id = $1 AND a.google_sub = $2 AND (
  (a.key_id IS NULL AND $4::integer = 1
    AND NOT EXISTS (SELECT 1 FROM account_records r WHERE r.account_id = a.id))
  OR (a.key_id = $3 AND a.write_verifier = $5 AND a.key_generation = $4::integer - 1)
)
RETURNING a.key_id, a.key_generation`;

// No row: the fence failed. One row of nulls: nothing left. The window sum ends a batch at
// `maxBytes` of stored_bytes, but always keeps its first row, so a largest record goes alone.
const STREAM_BATCH_SQL = `
WITH account AS (
  SELECT id FROM accounts WHERE id = $1 AND key_id = $2
), candidate AS (
  SELECT r.seq, r.stored_bytes
  FROM account_records r JOIN account a ON a.id = r.account_id
  WHERE r.seq > $3 AND r.seq <= $4
  ORDER BY r.seq
  LIMIT $5
), bounded AS (
  SELECT seq,
    sum(stored_bytes) OVER (ORDER BY seq) AS running,
    row_number() OVER (ORDER BY seq) AS position
  FROM candidate
), page AS (
  SELECT seq FROM bounded WHERE running <= $6 OR position = 1
)
SELECT r.kind, r.id, r.updated_at, r.deleted, r.iv, r.ciphertext, r.seq
FROM account a
LEFT JOIN LATERAL (
  SELECT x.* FROM account_records x JOIN page p ON p.seq = x.seq
  WHERE x.account_id = a.id
) r ON true
ORDER BY r.seq`;

const APPLY_SQL =
  'SELECT outcome, new_seq FROM apply_account_record($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)';

const APPLY_OUTCOMES = [
  'stale',
  'absent',
  'image_limit',
  'storage_limit',
  'no_account',
  'key_missing',
  'key_mismatch',
] as const;

// A bigint column comes back as a string from Neon and as a number from PGlite.
function toNumber(value: unknown): number {
  const n = typeof value === 'string' && value !== '' ? Number(value) : value;
  if (typeof n !== 'number' || !Number.isSafeInteger(n)) {
    throw new RangeError('Database returned a non-integer where an integer was expected');
  }
  return n;
}

function nullableNumber(value: unknown): number | null {
  return value === null || value === undefined ? null : toNumber(value);
}

function nullableString(value: unknown): string | null {
  return value === null || value === undefined ? null : String(value);
}

// Neon's HTTP driver gives a boolean as a boolean, and the fake in the tests as 't' or 'f'.
function toBoolean(value: unknown): boolean {
  return value === true || value === 't';
}

function toKey(keyId: unknown, generation: unknown): WireKey {
  return keyId === null || keyId === undefined
    ? null
    : { keyId: String(keyId), generation: toNumber(generation) };
}

function toRecord(row: Record<string, unknown>): RecordOut {
  return {
    kind: String(row.kind) as RecordKind,
    id: String(row.id),
    updatedAt: toNumber(row.updated_at),
    deleted: toBoolean(row.deleted),
    iv: String(row.iv),
    ciphertext: String(row.ciphertext),
    seq: toNumber(row.seq),
  };
}

function toUsage(row: Record<string, unknown>): Usage {
  return { bytes: toNumber(row.storage_bytes), screenshots: toNumber(row.screenshots) };
}

/** The store over `query`. Every statement is bounded by `POLICY.request.databaseTimeoutMs`. */
export function createSqlStore(query: Query): Store {
  const run = (text: string, params: unknown[]) =>
    query(text, params, { signal: AbortSignal.timeout(POLICY.request.databaseTimeoutMs) });
  const iso = (ms: number) => new Date(ms).toISOString();

  return {
    async signIn(googleSub, email, tokenHash, expiresAt, now) {
      const rows = await run(
        `INSERT INTO accounts (google_sub, email) VALUES ($1, $2)
         ON CONFLICT (google_sub) DO UPDATE SET email = EXCLUDED.email
         RETURNING id, email, key_id, key_generation`,
        [googleSub, email],
      );
      if (rows.length !== 1) {
        throw new Error('Sign-in wrote no account');
      }
      const id = String(rows[0].id);
      await run('DELETE FROM account_tokens WHERE account_id = $1 AND expires_at <= $2', [
        id,
        iso(now),
      ]);
      await run(
        'INSERT INTO account_tokens (token_hash, account_id, expires_at, created_at) VALUES ($1, $2, $3, $4)',
        [tokenHash, id, iso(expiresAt), iso(now)],
      );
      return {
        id,
        email: String(rows[0].email),
        key: toKey(rows[0].key_id, rows[0].key_generation),
      };
    },

    async findAccountByToken(tokenHash, now) {
      const rows = await run(
        `SELECT a.id, a.google_sub, a.email, a.key_id, a.key_generation, a.storage_bytes, a.screenshots
         FROM account_tokens t JOIN accounts a ON a.id = t.account_id
         WHERE t.token_hash = $1 AND t.expires_at > $2`,
        [tokenHash, iso(now)],
      );
      if (rows.length === 0) {
        return null;
      }
      const row = rows[0];
      return {
        id: String(row.id),
        googleSub: String(row.google_sub),
        email: String(row.email),
        key: toKey(row.key_id, row.key_generation),
        usage: toUsage(row),
      };
    },

    async deleteToken(tokenHash) {
      await run('DELETE FROM account_tokens WHERE token_hash = $1', [tokenHash]);
    },

    async readSealed(accountId) {
      const rows = await run(
        'SELECT key_id, key_generation, kek_id, sealed_envelope FROM accounts WHERE id = $1',
        [accountId],
      );
      if (rows.length === 0) {
        return { status: 'no_account' };
      }
      const row = rows[0];
      if (row.key_id === null || row.key_id === undefined) {
        return { status: 'no_key' };
      }
      return {
        status: 'key',
        row: {
          keyId: String(row.key_id),
          generation: toNumber(row.key_generation),
          kekId: String(row.kek_id),
          sealed: String(row.sealed_envelope),
        },
      };
    },

    async writeKey(accountId, googleSub, write) {
      const rows = await run(KEY_WRITE_SQL, [
        accountId,
        googleSub,
        write.keyId,
        write.generation,
        write.writeVerifier,
        write.kekId,
        write.sealed,
      ]);
      return rows.length === 0 ? null : toKey(rows[0].key_id, rows[0].key_generation);
    },

    async readKeyState(accountId) {
      const rows = await run(
        'SELECT key_id, key_generation, write_verifier FROM accounts WHERE id = $1',
        [accountId],
      );
      if (rows.length === 0) {
        return null;
      }
      return {
        keyId: nullableString(rows[0].key_id),
        generation: nullableNumber(rows[0].key_generation),
        writeVerifier: nullableString(rows[0].write_verifier),
      };
    },

    async streamStart(accountId, keyId) {
      const rows = await run(
        'SELECT last_seq, storage_bytes, screenshots FROM accounts WHERE id = $1 AND key_id = $2',
        [accountId, keyId],
      );
      return rows.length === 0
        ? null
        : { through: toNumber(rows[0].last_seq), usage: toUsage(rows[0]) };
    },

    async streamBatch(accountId, keyId, cursor, through, maxRecords, maxBytes) {
      const rows = await run(STREAM_BATCH_SQL, [
        accountId,
        keyId,
        cursor,
        through,
        maxRecords,
        maxBytes,
      ]);
      if (rows.length === 0) {
        return { status: 'fenced' };
      }
      return {
        status: 'rows',
        records: rows.filter((row) => row.kind !== null && row.kind !== undefined).map(toRecord),
      };
    },

    async applyRecord(accountId, keyId, record, storedBytes) {
      const rows = await run(APPLY_SQL, [
        accountId,
        keyId,
        record.kind,
        record.id,
        record.updatedAt,
        record.deleted,
        record.iv,
        record.ciphertext,
        record.kind === 'doc' ? (record.baseSeq ?? null) : null,
        storedBytes,
        POLICY.account.storageBytes,
        POLICY.account.screenshots,
      ]);
      if (rows.length !== 1) {
        throw new Error('apply_account_record answered no outcome');
      }
      const { outcome } = rows[0];
      if (outcome === 'applied') {
        return { outcome, seq: toNumber(rows[0].new_seq) };
      }
      const known = APPLY_OUTCOMES.find((name) => name === outcome);
      if (known === undefined) {
        throw new Error('apply_account_record answered an unknown outcome');
      }
      return { outcome: known };
    },

    async readRecord(accountId, kind, id) {
      const rows = await run(
        `SELECT ${RECORD_COLUMNS} FROM account_records WHERE account_id = $1 AND kind = $2 AND id = $3`,
        [accountId, kind, id],
      );
      return rows.length === 0 ? null : toRecord(rows[0]);
    },

    async usage(accountId) {
      const rows = await run('SELECT storage_bytes, screenshots FROM accounts WHERE id = $1', [
        accountId,
      ]);
      return rows.length === 0 ? null : toUsage(rows[0]);
    },

    async deleteAccount(accountId, googleSub) {
      await run('DELETE FROM accounts WHERE id = $1 AND google_sub = $2', [accountId, googleSub]);
    },
  };
}
