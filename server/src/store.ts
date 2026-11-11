import {
  type ApplyResult,
  type KeySetup,
  RECORD_KINDS,
  type RecordInput,
  type RecordKind,
  type StoredRecord,
  type User,
} from './types.js';

/**
 * The most live screenshots (`image` records that are not tombstones) one account may keep. A
 * write that would add one more is answered `rejected` with `image_limit`, and the picture stays
 * on the device that sent it. Tombstones are always accepted, so deleting makes room.
 */
export const IMAGE_RECORD_LIMIT = 100;

/** Runs one parameterised statement and returns its rows. Neon in production, PGlite in tests. */
export type Query = (text: string, params?: unknown[]) => Promise<Record<string, unknown>[]>;

/** Everything the handlers need from the database. */
export interface Store {
  /** Creates the user on first sign-in, or refreshes the email of an existing one. */
  upsertUser(googleSub: string, email: string): Promise<User>;
  /** Stores a new token hash and drops the user's expired ones. Times are ms since the epoch. */
  createToken(tokenHash: string, userId: string, expiresAt: number, now: number): Promise<void>;
  /** The user a token belongs to, or null when it is unknown or expired at `now`. */
  findUserByToken(tokenHash: string, now: number): Promise<User | null>;
  deleteToken(tokenHash: string): Promise<void>;
  /** Sets the key setup when it is still null; false when one already exists. */
  setKeySetup(userId: string, keySetup: KeySetup): Promise<boolean>;
  /** The user's records of `kinds` (every kind when omitted) with `seq > since`, ascending, at most `limit`. */
  listRecords(
    userId: string,
    since: number,
    limit: number,
    kinds?: readonly RecordKind[],
  ): Promise<StoredRecord[]>;
  /**
   * Last writer wins: applies the record only when its `updatedAt` is newer than the stored one.
   * A live image over `IMAGE_RECORD_LIMIT` is `rejected`.
   */
  applyRecord(userId: string, record: RecordInput): Promise<ApplyResult>;
  /** Deletes the user; their tokens and records go with them (ON DELETE CASCADE). */
  deleteUser(userId: string): Promise<void>;
}

const RECORD_COLUMNS = 'kind, id, updated_at, deleted, iv, ciphertext, seq';

// A bigint column comes back as a string from Neon and as a number from PGlite.
function toNumber(value: unknown): number {
  const n = Number(value);
  if (!Number.isSafeInteger(n)) {
    throw new RangeError('Database returned a non-integer where an integer was expected');
  }
  return n;
}

function toUser(row: Record<string, unknown>): User {
  return {
    id: String(row.id),
    email: String(row.email),
    keySetup: (row.key_setup ?? null) as KeySetup | null,
  };
}

function toRecord(row: Record<string, unknown>): StoredRecord {
  return {
    kind: row.kind as StoredRecord['kind'],
    id: String(row.id),
    updatedAt: toNumber(row.updated_at),
    deleted: row.deleted === true,
    iv: String(row.iv),
    ciphertext: String(row.ciphertext),
    seq: toNumber(row.seq),
  };
}

// One statement, so one transaction. It first locks the user's row, so a user's writes run one
// after another and each takes its seq only after the one before it has committed: the seq order
// of a user's records is their commit order. Without the lock two writes could take seq 10 and 11
// and commit 11 first, and a reader that paged past 11 would never see 10. The upsert only
// overwrites an older row (the WHERE on the conflict branch runs under the row lock, so two
// writers cannot both win). It returns the new seq, or no row when the write did not apply.
const APPLY_SQL = `
WITH locked AS (
  SELECT id FROM users WHERE id = $1 FOR NO KEY UPDATE
)
INSERT INTO records (user_id, kind, id, updated_at, deleted, iv, ciphertext, seq)
SELECT locked.id, $2, $3, $4, $5, $6, $7, nextval('record_seq') FROM locked
ON CONFLICT (user_id, kind, id) DO UPDATE SET
  updated_at = EXCLUDED.updated_at,
  deleted = EXCLUDED.deleted,
  iv = EXCLUDED.iv,
  ciphertext = EXCLUDED.ciphertext,
  seq = nextval('record_seq')
WHERE records.updated_at < EXCLUDED.updated_at
RETURNING seq`;

// The cap needs a count that sees every committed write, which one statement cannot give (see
// migrations/002_notes_images.sql), so image records go through a function of their own.
async function applyImage(query: Query, userId: string, record: RecordInput): Promise<ApplyResult> {
  const rows = await query(
    'SELECT outcome, new_seq FROM apply_image_record($1, $2, $3, $4, $5, $6, $7)',
    [
      userId,
      record.id,
      record.updatedAt,
      record.deleted,
      record.iv,
      record.ciphertext,
      IMAGE_RECORD_LIMIT,
    ],
  );
  if (rows.length === 0) {
    throw new Error('Record neither applied nor found');
  }
  const { outcome } = rows[0];
  if (outcome === 'applied') {
    return { status: 'applied', seq: toNumber(rows[0].new_seq) };
  }
  if (outcome === 'rejected') {
    return { status: 'rejected', reason: 'image_limit' };
  }
  // Stale: read the row that won, in a statement of its own as for every other kind.
  const current = await query(
    `SELECT ${RECORD_COLUMNS} FROM records WHERE user_id = $1 AND kind = $2 AND id = $3`,
    [userId, record.kind, record.id],
  );
  if (current.length === 0) {
    throw new Error('Record neither applied nor found');
  }
  return { status: 'stale', current: toRecord(current[0]) };
}

export function createSqlStore(query: Query): Store {
  return {
    async upsertUser(googleSub, email) {
      const rows = await query(
        `INSERT INTO users (google_sub, email) VALUES ($1, $2)
         ON CONFLICT (google_sub) DO UPDATE SET email = EXCLUDED.email
         RETURNING id, email, key_setup`,
        [googleSub, email],
      );
      return toUser(rows[0]);
    },

    async createToken(tokenHash, userId, expiresAt, now) {
      await query('DELETE FROM auth_tokens WHERE user_id = $1 AND expires_at <= $2', [
        userId,
        new Date(now).toISOString(),
      ]);
      await query(
        'INSERT INTO auth_tokens (token_hash, user_id, expires_at, created_at) VALUES ($1, $2, $3, $4)',
        [tokenHash, userId, new Date(expiresAt).toISOString(), new Date(now).toISOString()],
      );
    },

    async findUserByToken(tokenHash, now) {
      const rows = await query(
        `SELECT u.id, u.email, u.key_setup FROM auth_tokens t JOIN users u ON u.id = t.user_id
         WHERE t.token_hash = $1 AND t.expires_at > $2`,
        [tokenHash, new Date(now).toISOString()],
      );
      return rows.length > 0 ? toUser(rows[0]) : null;
    },

    async deleteToken(tokenHash) {
      await query('DELETE FROM auth_tokens WHERE token_hash = $1', [tokenHash]);
    },

    async setKeySetup(userId, keySetup) {
      const rows = await query(
        'UPDATE users SET key_setup = $2::jsonb WHERE id = $1 AND key_setup IS NULL RETURNING id',
        [userId, JSON.stringify(keySetup)],
      );
      return rows.length > 0;
    },

    async listRecords(userId, since, limit, kinds = RECORD_KINDS) {
      const rows = await query(
        `SELECT ${RECORD_COLUMNS} FROM records
         WHERE user_id = $1 AND seq > $2 AND kind = ANY($4::text[]) ORDER BY seq LIMIT $3`,
        [userId, since, limit, [...kinds]],
      );
      return rows.map(toRecord);
    },

    async applyRecord(userId, record) {
      if (record.kind === 'image') {
        return applyImage(query, userId, record);
      }
      const params = [
        userId,
        record.kind,
        record.id,
        record.updatedAt,
        record.deleted,
        record.iv,
        record.ciphertext,
      ];
      const rows = await query(APPLY_SQL, params);
      if (rows.length > 0) {
        return { status: 'applied', seq: toNumber(rows[0].seq) };
      }
      // A statement of its own, so a fresh snapshot: under READ COMMITTED the upsert's snapshot
      // predates its wait for the locks, and could show a row older than the one that stopped it.
      const current = await query(
        `SELECT ${RECORD_COLUMNS} FROM records WHERE user_id = $1 AND kind = $2 AND id = $3`,
        [userId, record.kind, record.id],
      );
      if (current.length === 0) {
        // Only when the user was deleted while the write waited for the lock.
        throw new Error('Record neither applied nor found');
      }
      return { status: 'stale', current: toRecord(current[0]) };
    },

    async deleteUser(userId) {
      await query('DELETE FROM users WHERE id = $1', [userId]);
    },
  };
}
