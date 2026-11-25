// Every SQL statement of the shipped v1 stores, with valid parameters: server/src/store.ts at
// 824f443 (the first deployment), v8.3.0 and v9.1.0, and server/src/db/store.ts at main 9f47150.
// v8.4.0 and v9.0.0 shipped the statements of v8.3.0. Data, copied from those revisions with
// `${RECORD_COLUMNS}` written out; fail-closed.test.ts runs each against a migrated database.

/** The v1 user every statement names; v1Database() in helpers.ts seeds it. */
const USER = '00000000-0000-4000-8000-000000000001';
const LATER = '2030-01-01T00:00:00.000Z';

export interface V1Statement {
  text: string;
  params: unknown[];
}

export const V1_C824F443: V1Statement[] = [
  {
    text: "WITH applied AS ( INSERT INTO records (user_id, kind, id, updated_at, deleted, iv, ciphertext) VALUES ($1, $2, $3, $4, $5, $6, $7) ON CONFLICT (user_id, kind, id) DO UPDATE SET updated_at = EXCLUDED.updated_at, deleted = EXCLUDED.deleted, iv = EXCLUDED.iv, ciphertext = EXCLUDED.ciphertext, seq = nextval('record_seq') WHERE records.updated_at < EXCLUDED.updated_at RETURNING seq ) SELECT true AS applied, seq, NULL::text AS kind, NULL::text AS id, NULL::bigint AS updated_at, NULL::boolean AS deleted, NULL::text AS iv, NULL::text AS ciphertext FROM applied UNION ALL SELECT false, r.seq, r.kind, r.id, r.updated_at, r.deleted, r.iv, r.ciphertext FROM records r WHERE r.user_id = $1 AND r.kind = $2 AND r.id = $3 AND NOT EXISTS (SELECT 1 FROM applied)",
    params: [USER, 'session', 's', 2, false, 'aXY=', 'Y3Q='],
  },
  {
    text: 'INSERT INTO users (google_sub, email) VALUES ($1, $2) ON CONFLICT (google_sub) DO UPDATE SET email = EXCLUDED.email RETURNING id, email, key_setup',
    params: ['sub-new', 'n@example.com'],
  },
  {
    text: 'DELETE FROM auth_tokens WHERE user_id = $1 AND expires_at <= $2',
    params: [USER, LATER],
  },
  {
    text: 'INSERT INTO auth_tokens (token_hash, user_id, expires_at, created_at) VALUES ($1, $2, $3, $4)',
    params: ['hash2', USER, LATER, LATER],
  },
  {
    text: 'SELECT u.id, u.email, u.key_setup FROM auth_tokens t JOIN users u ON u.id = t.user_id WHERE t.token_hash = $1 AND t.expires_at > $2',
    params: ['hash', LATER],
  },
  {
    text: 'DELETE FROM auth_tokens WHERE token_hash = $1',
    params: ['hash'],
  },
  {
    text: 'UPDATE users SET key_setup = $2::jsonb WHERE id = $1 AND key_setup IS NULL RETURNING id',
    params: [USER, '{"salt":"y"}'],
  },
  {
    text: 'SELECT kind, id, updated_at, deleted, iv, ciphertext, seq FROM records WHERE user_id = $1 AND seq > $2 ORDER BY seq LIMIT $3',
    params: [USER, 0, 500],
  },
  {
    text: 'SELECT kind, id, updated_at, deleted, iv, ciphertext, seq FROM records WHERE user_id = $1 AND kind = $2 AND id = $3',
    params: [USER, 'session', 's'],
  },
  {
    text: 'DELETE FROM users WHERE id = $1',
    params: [USER],
  },
];

export const V1_V8_3_0: V1Statement[] = [
  {
    text: "WITH locked AS ( SELECT id FROM users WHERE id = $1 FOR NO KEY UPDATE ) INSERT INTO records (user_id, kind, id, updated_at, deleted, iv, ciphertext, seq) SELECT locked.id, $2, $3, $4, $5, $6, $7, nextval('record_seq') FROM locked ON CONFLICT (user_id, kind, id) DO UPDATE SET updated_at = EXCLUDED.updated_at, deleted = EXCLUDED.deleted, iv = EXCLUDED.iv, ciphertext = EXCLUDED.ciphertext, seq = nextval('record_seq') WHERE records.updated_at < EXCLUDED.updated_at RETURNING seq",
    params: [USER, 'session', 's', 2, false, 'aXY=', 'Y3Q='],
  },
  {
    text: 'INSERT INTO users (google_sub, email) VALUES ($1, $2) ON CONFLICT (google_sub) DO UPDATE SET email = EXCLUDED.email RETURNING id, email, key_setup',
    params: ['sub-new', 'n@example.com'],
  },
  {
    text: 'DELETE FROM auth_tokens WHERE user_id = $1 AND expires_at <= $2',
    params: [USER, LATER],
  },
  {
    text: 'INSERT INTO auth_tokens (token_hash, user_id, expires_at, created_at) VALUES ($1, $2, $3, $4)',
    params: ['hash2', USER, LATER, LATER],
  },
  {
    text: 'SELECT u.id, u.email, u.key_setup FROM auth_tokens t JOIN users u ON u.id = t.user_id WHERE t.token_hash = $1 AND t.expires_at > $2',
    params: ['hash', LATER],
  },
  {
    text: 'DELETE FROM auth_tokens WHERE token_hash = $1',
    params: ['hash'],
  },
  {
    text: 'UPDATE users SET key_setup = $2::jsonb WHERE id = $1 AND key_setup IS NULL RETURNING id',
    params: [USER, '{"salt":"y"}'],
  },
  {
    text: 'SELECT kind, id, updated_at, deleted, iv, ciphertext, seq FROM records WHERE user_id = $1 AND seq > $2 ORDER BY seq LIMIT $3',
    params: [USER, 0, 500],
  },
  {
    text: 'SELECT kind, id, updated_at, deleted, iv, ciphertext, seq FROM records WHERE user_id = $1 AND kind = $2 AND id = $3',
    params: [USER, 'session', 's'],
  },
  {
    text: 'DELETE FROM users WHERE id = $1',
    params: [USER],
  },
];

export const V1_V9_1_0: V1Statement[] = [
  {
    text: "WITH locked AS ( SELECT id FROM users WHERE id = $1 FOR NO KEY UPDATE ) INSERT INTO records (user_id, kind, id, updated_at, deleted, iv, ciphertext, seq) SELECT locked.id, $2, $3, $4, $5, $6, $7, nextval('record_seq') FROM locked ON CONFLICT (user_id, kind, id) DO UPDATE SET updated_at = EXCLUDED.updated_at, deleted = EXCLUDED.deleted, iv = EXCLUDED.iv, ciphertext = EXCLUDED.ciphertext, seq = nextval('record_seq') WHERE records.updated_at < EXCLUDED.updated_at RETURNING seq",
    params: [USER, 'session', 's', 2, false, 'aXY=', 'Y3Q='],
  },
  {
    text: 'SELECT outcome, new_seq FROM apply_image_record($1, $2, $3, $4, $5, $6, $7)',
    params: [USER, 'i', 2, false, 'aXY=', 'Y3Q=', 100],
  },
  {
    text: 'SELECT kind, id, updated_at, deleted, iv, ciphertext, seq FROM records WHERE user_id = $1 AND kind = $2 AND id = $3',
    params: [USER, 'session', 's'],
  },
  {
    text: 'INSERT INTO users (google_sub, email) VALUES ($1, $2) ON CONFLICT (google_sub) DO UPDATE SET email = EXCLUDED.email RETURNING id, email, key_setup',
    params: ['sub-new', 'n@example.com'],
  },
  {
    text: 'DELETE FROM auth_tokens WHERE user_id = $1 AND expires_at <= $2',
    params: [USER, LATER],
  },
  {
    text: 'INSERT INTO auth_tokens (token_hash, user_id, expires_at, created_at) VALUES ($1, $2, $3, $4)',
    params: ['hash2', USER, LATER, LATER],
  },
  {
    text: 'SELECT u.id, u.email, u.key_setup FROM auth_tokens t JOIN users u ON u.id = t.user_id WHERE t.token_hash = $1 AND t.expires_at > $2',
    params: ['hash', LATER],
  },
  {
    text: 'DELETE FROM auth_tokens WHERE token_hash = $1',
    params: ['hash'],
  },
  {
    text: 'UPDATE users SET key_setup = $2::jsonb WHERE id = $1 AND key_setup IS NULL RETURNING id',
    params: [USER, '{"salt":"y"}'],
  },
  {
    text: 'SELECT kind, id, updated_at, deleted, iv, ciphertext, seq FROM records WHERE user_id = $1 AND seq > $2 AND kind = ANY($4::text[]) ORDER BY seq LIMIT $3',
    params: [USER, 0, 500, ['session', 'settings']],
  },
  {
    text: 'DELETE FROM users WHERE id = $1',
    params: [USER],
  },
];

export const V1_MAIN: V1Statement[] = [
  {
    text: "WITH locked AS ( SELECT id FROM users WHERE id = $1 FOR NO KEY UPDATE ) INSERT INTO records (user_id, kind, id, updated_at, deleted, iv, ciphertext, seq) SELECT locked.id, $2, $3, $4, $5, $6, $7, nextval('record_seq') FROM locked ON CONFLICT (user_id, kind, id) DO UPDATE SET updated_at = EXCLUDED.updated_at, deleted = EXCLUDED.deleted, iv = EXCLUDED.iv, ciphertext = EXCLUDED.ciphertext, seq = nextval('record_seq') WHERE records.updated_at < EXCLUDED.updated_at RETURNING seq",
    params: [USER, 'session', 's', 2, false, 'aXY=', 'Y3Q='],
  },
  {
    text: 'SELECT outcome, new_seq FROM apply_image_record($1, $2, $3, $4, $5, $6, $7)',
    params: [USER, 'i', 2, false, 'aXY=', 'Y3Q=', 100],
  },
  {
    text: 'SELECT kind, id, updated_at, deleted, iv, ciphertext, seq FROM records WHERE user_id = $1 AND kind = $2 AND id = $3',
    params: [USER, 'session', 's'],
  },
  {
    text: 'INSERT INTO users (google_sub, email) VALUES ($1, $2) ON CONFLICT (google_sub) DO UPDATE SET email = EXCLUDED.email RETURNING id, email, key_setup',
    params: ['sub-new', 'n@example.com'],
  },
  {
    text: 'DELETE FROM auth_tokens WHERE user_id = $1 AND expires_at <= $2',
    params: [USER, LATER],
  },
  {
    text: 'INSERT INTO auth_tokens (token_hash, user_id, expires_at, created_at) VALUES ($1, $2, $3, $4)',
    params: ['hash2', USER, LATER, LATER],
  },
  {
    text: 'SELECT u.id, u.email, u.key_setup FROM auth_tokens t JOIN users u ON u.id = t.user_id WHERE t.token_hash = $1 AND t.expires_at > $2',
    params: ['hash', LATER],
  },
  {
    text: 'DELETE FROM auth_tokens WHERE token_hash = $1',
    params: ['hash'],
  },
  {
    text: 'UPDATE users SET key_setup = $2::jsonb WHERE id = $1 AND key_setup IS NULL RETURNING id',
    params: [USER, '{"salt":"y"}'],
  },
  {
    text: 'SELECT kind, id, updated_at, deleted, iv, ciphertext, seq FROM records WHERE user_id = $1 AND seq > $2 AND kind = ANY($4::text[]) ORDER BY seq LIMIT $3',
    params: [USER, 0, 500, ['session', 'settings']],
  },
  {
    text: 'DELETE FROM users WHERE id = $1',
    params: [USER],
  },
];
