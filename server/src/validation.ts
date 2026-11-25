import { POLICY } from '../../src/constants.js';
import type { KeyEnvelope, RecordIn, RecordKind } from './types.js';
import { RECORD_KINDS } from './types.js';

// One character class each, not groups: they stay linear on a whole ciphertext.
const BASE64_PATTERN = /^[A-Za-z0-9+/]*={0,2}$/;
const BASE64URL_PATTERN = /^[A-Za-z0-9_-]*$/;
const ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
const DOC_ID_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const SINCE_PATTERN = /^\d{1,16}$/;

/** The bytes of a key id (spec 3.2): 16, so 22 characters of base64url. */
export const KEY_ID_BYTES = 16;
/** The bytes of a write proof (spec 3.2): 32, so 44 characters of base64. */
export const PROOF_BYTES = 32;
/** An AES-GCM IV (spec 3.1). */
export const IV_BYTES = 12;
/** The least ciphertext there is: one byte and the 16-byte tag. */
export const MIN_CIPHERTEXT_BYTES = 17;
/** The envelope fields (spec 3.3). */
const SALT_BYTES = 16;
const WRAPPED_BYTES = 48;
const MAX_GENERATION = 2_147_483_647;

type Plain = Record<string, unknown>;

function isPlain(value: unknown): value is Plain {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

// Unknown fields are refused, not ignored: the client is ours, so an extra field is a bug.
function hasExactly(value: Plain, keys: readonly string[]): boolean {
  const own = Object.keys(value);
  return own.length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}

/**
 * The bytes of padded, canonical base64 (decoding and encoding again gives the same text), or
 * null when it is anything else.
 */
export function decodeBase64(value: unknown): Uint8Array<ArrayBuffer> | null {
  if (typeof value !== 'string' || value.length % 4 !== 0 || !BASE64_PATTERN.test(value)) {
    return null;
  }
  const bytes = Buffer.from(value, 'base64');
  return bytes.toString('base64') === value ? new Uint8Array(bytes) : null;
}

/** The bytes of unpadded, canonical base64url, or null when it is anything else. */
export function decodeBase64url(value: unknown): Uint8Array<ArrayBuffer> | null {
  if (typeof value !== 'string' || !BASE64URL_PATTERN.test(value)) {
    return null;
  }
  const bytes = Buffer.from(value, 'base64url');
  return bytes.toString('base64url') === value ? new Uint8Array(bytes) : null;
}

function base64Of(value: unknown, size: number): value is string {
  return decodeBase64(value)?.length === size;
}

/** A key id: canonical base64url of 16 bytes. */
export function isKeyId(value: unknown): value is string {
  return decodeBase64url(value)?.length === KEY_ID_BYTES;
}

/** The Google access token in a body `{ accessToken }`, or null. */
export function parseAccessToken(body: unknown): string | null {
  if (!isPlain(body) || !hasExactly(body, ['accessToken'])) {
    return null;
  }
  return accessTokenOf(body.accessToken);
}

function accessTokenOf(value: unknown): string | null {
  return typeof value === 'string' &&
    value.length > 0 &&
    value.length <= POLICY.request.maxAccessTokenChars
    ? value
    : null;
}

/** An envelope with exactly the fields and lengths of spec 3.3, or null. */
export function parseEnvelope(value: unknown): KeyEnvelope | null {
  if (
    !isPlain(value) ||
    !hasExactly(value, ['v', 'generation', 'keyId', 'salt', 'iv', 'wrapped'])
  ) {
    return null;
  }
  const { v, generation, keyId, salt, iv, wrapped } = value;
  if (
    v !== 2 ||
    typeof generation !== 'number' ||
    !Number.isInteger(generation) ||
    generation < 1 ||
    generation > MAX_GENERATION ||
    !isKeyId(keyId) ||
    !base64Of(salt, SALT_BYTES) ||
    !base64Of(iv, IV_BYTES) ||
    !base64Of(wrapped, WRAPPED_BYTES)
  ) {
    return null;
  }
  return { v: 2, generation, keyId, salt, iv, wrapped };
}

/** A write proof: canonical base64 of 32 bytes. */
export function isProof(value: unknown): value is string {
  return base64Of(value, PROOF_BYTES);
}

/** The body of `PUT /v2/keys`, or null. */
export function parseKeysBody(
  body: unknown,
): { accessToken: string; envelope: KeyEnvelope; proof: string } | null {
  if (!isPlain(body) || !hasExactly(body, ['accessToken', 'envelope', 'proof'])) {
    return null;
  }
  const accessToken = accessTokenOf(body.accessToken);
  const envelope = parseEnvelope(body.envelope);
  if (accessToken === null || envelope === null || !isProof(body.proof)) {
    return null;
  }
  return { accessToken, envelope, proof: body.proof };
}

function isRecordKind(value: unknown): value is RecordKind {
  return RECORD_KINDS.some((kind) => kind === value);
}

function isIdFor(kind: RecordKind, id: unknown): id is string {
  if (typeof id !== 'string' || !ID_PATTERN.test(id)) {
    return false;
  }
  if (kind === 'doc') {
    return DOC_ID_PATTERN.test(id);
  }
  return kind !== 'settings' || id === 'settings';
}

function isCiphertext(value: unknown, deleted: boolean): value is string {
  // Base64 is ASCII, so its length is its size in bytes. The length is checked first, so an
  // oversized one is never decoded.
  const maxChars = deleted ? POLICY.record.maxTombstoneChars : POLICY.record.maxCiphertextBytes;
  if (typeof value !== 'string' || value.length > maxChars) {
    return false;
  }
  const bytes = decodeBase64(value);
  return bytes !== null && bytes.length >= MIN_CIPHERTEXT_BYTES;
}

function isBaseSeq(value: unknown): value is number | null {
  return value === null || (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0);
}

function parseRecord(value: unknown): RecordIn | null {
  if (!isPlain(value) || !isRecordKind(value.kind)) {
    return null;
  }
  const { kind } = value;
  const fields = ['kind', 'id', 'updatedAt', 'deleted', 'iv', 'ciphertext'];
  if (!hasExactly(value, kind === 'doc' ? [...fields, 'baseSeq'] : fields)) {
    return null;
  }
  const { id, updatedAt, deleted, iv, ciphertext, baseSeq } = value;
  if (
    !isIdFor(kind, id) ||
    typeof updatedAt !== 'number' ||
    !Number.isSafeInteger(updatedAt) ||
    updatedAt < 0 ||
    typeof deleted !== 'boolean' ||
    (kind === 'settings' && deleted) ||
    !base64Of(iv, IV_BYTES) ||
    !isCiphertext(ciphertext, deleted)
  ) {
    return null;
  }
  if (kind !== 'doc') {
    return { kind, id, updatedAt, deleted, iv, ciphertext };
  }
  if (!isBaseSeq(baseSeq)) {
    return null;
  }
  return { kind, id, updatedAt, deleted, iv, ciphertext, baseSeq };
}

/**
 * The records of `POST /v2/records` (spec 4.5), or null when anything in the request is wrong: the
 * whole request is checked before any write.
 */
export function parseRecordsBody(body: unknown): RecordIn[] | null {
  if (!isPlain(body) || !hasExactly(body, ['records'])) {
    return null;
  }
  const { records } = body;
  if (!Array.isArray(records) || records.length > POLICY.request.maxRecordsPerPush) {
    return null;
  }
  const parsed: RecordIn[] = [];
  const seen = new Set<string>();
  for (const item of records) {
    const record = parseRecord(item);
    // The kind has no `|`, so the pair is one string without ambiguity.
    const key = record === null ? '' : `${record.kind}|${record.id}`;
    if (record === null || seen.has(key)) {
      return null;
    }
    seen.add(key);
    parsed.push(record);
  }
  return parsed;
}

/**
 * `since` of `GET /v2/records`: 1 to 16 decimal digits and a safe integer, 0 when absent, null
 * when malformed. Every other parameter is ignored (Vercel's rewrite adds `path`).
 */
export function parseSince(params: URLSearchParams): number | null {
  const since = params.get('since');
  if (since === null) {
    return 0;
  }
  if (!SINCE_PATTERN.test(since)) {
    return null;
  }
  const value = Number(since);
  return Number.isSafeInteger(value) ? value : null;
}

/**
 * What a row counts against its account: never less than a tombstone, so a tombstone over an
 * existing row never grows the account.
 */
export function storedBytesOf(record: Pick<RecordIn, 'ciphertext'>): number {
  return (
    Math.max(record.ciphertext.length, POLICY.record.maxTombstoneChars) +
    POLICY.record.overheadBytes
  );
}

/** Whether a stamp is further ahead of the server's clock than it accepts. */
export function isClockAhead(updatedAt: number, now: number): boolean {
  return updatedAt > now + POLICY.record.maxClockAheadMs;
}
