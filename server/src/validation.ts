import {
  DEFAULT_LISTED_KINDS,
  type KeySetup,
  RECORD_KINDS,
  type RecordInput,
  type RecordKind,
} from './types.js';

const MAX_RECORDS_PER_REQUEST = 100;
/**
 * The largest request body accepted, in bytes (4 MiB). Vercel refuses a body over 4.5 MB before
 * the function runs, with no CORS headers and no JSON, so the limit a client sizes its batches to
 * sits below that: up to 100 records and 4 MiB, whichever comes first.
 */
export const MAX_BODY_BYTES = 4 * 1024 * 1024;
/** The longest ciphertext accepted, counted in base64 characters (1 MiB). */
const MAX_CIPHERTEXT_CHARS = 1024 * 1024;
const MIN_ITERATIONS = 100_000;
const MAX_ITERATIONS = 10_000_000;
const DEFAULT_RECORDS_LIMIT = 500;

const ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
// One character class, not a group of four: it stays linear on a 1 MiB string.
const BASE64_PATTERN = /^[A-Za-z0-9+/]*={0,2}$/;
const DIGITS = /^\d{1,16}$/;

type Plain = Record<string, unknown>;

function isPlain(value: unknown): value is Plain {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

// Unknown fields are refused, not ignored: the client is ours, so an extra field is a bug.
function hasExactly(value: Plain, keys: readonly string[]): boolean {
  const own = Object.keys(value);
  return own.length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}

/** The number of bytes a padded base64 string decodes to, or null when it is not one. */
export function base64Bytes(value: unknown): number | null {
  if (typeof value !== 'string' || value.length % 4 !== 0 || !BASE64_PATTERN.test(value)) {
    return null;
  }
  const padding = value.endsWith('==') ? 2 : value.endsWith('=') ? 1 : 0;
  return (value.length / 4) * 3 - padding;
}

function base64Within(value: unknown, min: number, max: number): value is string {
  const bytes = base64Bytes(value);
  return bytes !== null && bytes >= min && bytes <= max;
}

/** The longest access token accepted. Google documents up to 2048 bytes; this leaves room. */
const MAX_ACCESS_TOKEN_LENGTH = 4096;

/** The Google access token in a sign-in body `{ accessToken }`, or null. */
export function parseAccessToken(body: unknown): string | null {
  if (!isPlain(body) || !hasExactly(body, ['accessToken'])) {
    return null;
  }
  const { accessToken } = body;
  return typeof accessToken === 'string' &&
    accessToken.length > 0 &&
    accessToken.length <= MAX_ACCESS_TOKEN_LENGTH
    ? accessToken
    : null;
}

export function parseKeySetup(body: unknown): KeySetup | null {
  if (!isPlain(body) || !hasExactly(body, ['kdf', 'salt', 'check', 'checkIv'])) {
    return null;
  }
  const { kdf, salt, check, checkIv } = body;
  if (!isPlain(kdf) || !hasExactly(kdf, ['name', 'hash', 'iterations'])) {
    return null;
  }
  const { iterations } = kdf;
  if (
    kdf.name !== 'PBKDF2' ||
    kdf.hash !== 'SHA-256' ||
    typeof iterations !== 'number' ||
    !Number.isSafeInteger(iterations) ||
    iterations < MIN_ITERATIONS ||
    iterations > MAX_ITERATIONS ||
    !base64Within(salt, 16, 64) ||
    !base64Within(check, 1, 1024) ||
    !base64Within(checkIv, 12, 32)
  ) {
    return null;
  }
  return { kdf: { name: 'PBKDF2', hash: 'SHA-256', iterations }, salt, check, checkIv };
}

function isRecordKind(value: unknown): value is RecordKind {
  return RECORD_KINDS.some((kind) => kind === value);
}

function parseRecord(value: unknown): RecordInput | null {
  if (
    !isPlain(value) ||
    !hasExactly(value, ['kind', 'id', 'updatedAt', 'deleted', 'iv', 'ciphertext'])
  ) {
    return null;
  }
  const { kind, id, updatedAt, deleted, iv, ciphertext } = value;
  if (
    !isRecordKind(kind) ||
    typeof id !== 'string' ||
    !ID_PATTERN.test(id) ||
    typeof updatedAt !== 'number' ||
    !Number.isSafeInteger(updatedAt) ||
    updatedAt < 0 ||
    typeof deleted !== 'boolean' ||
    typeof iv !== 'string' ||
    typeof ciphertext !== 'string'
  ) {
    return null;
  }
  // A tombstone carries an iv and a ciphertext like a live record: the client encrypts the
  // deletion with the record's metadata, so the server cannot forge one.
  if (
    !base64Within(iv, 12, 32) ||
    ciphertext.length > MAX_CIPHERTEXT_CHARS ||
    !base64Within(ciphertext, 1, Number.MAX_SAFE_INTEGER)
  ) {
    return null;
  }
  return { kind, id, updatedAt, deleted, iv, ciphertext };
}

export function parseRecordsBody(body: unknown): RecordInput[] | null {
  if (!isPlain(body) || !hasExactly(body, ['records'])) {
    return null;
  }
  const { records } = body;
  if (!Array.isArray(records) || records.length > MAX_RECORDS_PER_REQUEST) {
    return null;
  }
  const parsed: RecordInput[] = [];
  for (const item of records) {
    const record = parseRecord(item);
    if (record === null) {
      return null;
    }
    parsed.push(record);
  }
  return parsed;
}

export interface RecordsQuery {
  since: number;
  limit: number;
  /** The kinds to list: the request's `kinds`, or `DEFAULT_LISTED_KINDS`. */
  kinds: RecordKind[];
}

/**
 * `kinds`: a comma-separated list of known kinds without repeats, e.g. `session,settings,notes`.
 * Absent, the kinds every client version understands. Null when anything is wrong.
 */
function parseKinds(value: string | null): RecordKind[] | null {
  if (value === null) {
    return [...DEFAULT_LISTED_KINDS];
  }
  const parts = value.split(',');
  const kinds: RecordKind[] = [];
  for (const part of parts) {
    if (!isRecordKind(part) || kinds.includes(part)) {
      return null;
    }
    kinds.push(part);
  }
  return kinds;
}

/** `since` (default 0), `limit` (1..500, default 500) and `kinds` from the query string, or null. */
export function parseRecordsQuery(params: URLSearchParams): RecordsQuery | null {
  const since = params.get('since') ?? '0';
  const limit = params.get('limit') ?? String(DEFAULT_RECORDS_LIMIT);
  if (!DIGITS.test(since) || !DIGITS.test(limit)) {
    return null;
  }
  const sinceValue = Number(since);
  const limitValue = Number(limit);
  if (!Number.isSafeInteger(sinceValue) || limitValue < 1 || limitValue > DEFAULT_RECORDS_LIMIT) {
    return null;
  }
  const kinds = parseKinds(params.get('kinds'));
  if (kinds === null) {
    return null;
  }
  return { since: sinceValue, limit: limitValue, kinds };
}
