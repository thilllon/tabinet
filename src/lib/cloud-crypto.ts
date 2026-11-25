/**
 * End-to-end encryption for cloud sync v2, WebCrypto only (spec sections 3.1 to 3.5). The first
 * device makes a random 32-byte data key (DEK); every record is AES-GCM under it. The DEK is
 * wrapped on the device under a key PBKDF2 derives from the passphrase (`KeyEnvelope`); the
 * server only ever holds that envelope, sealed again under a key of its own. Every other use of
 * the DEK is separated by HKDF: the key id, the write proof and the doc record ids.
 *
 * The DEK stays on this device, b64, under `chrome.storage.local` `cloudKeyV2`
 * (`src/lib/cloud-storage.ts`). Nothing here touches `chrome.*`.
 */
import { POLICY } from '@/constants';
import { ExplainedError } from '@/lib/error-message';
import type { EncryptedPayload, KeyEnvelope, RecordKind } from '@/types';

export const IV_BYTES = 12;
export const DEK_BYTES = 32;
const KEY_ID_BYTES = 16;
const WRAPPED_BYTES = DEK_BYTES + 16;
const MAX_GENERATION = 2_147_483_647;

/** HKDF info strings (spec 3.2): format constants, not policy. */
const INFO_KEY_ID = 'tabinet-key-id-v2';
const INFO_WRITE_PROOF = 'tabinet-envelope-write-v2';
const INFO_DOC_ID = 'tabinet-doc-id-v2';
const WRAP_AAD_LABEL = 'tabinet-wrap-v2';
const MEMO_COPY_LABEL = 'tabinet-memo-copy-v1';

/** A record that does not decrypt (tampered, cut short, or made with another key). */
export class CloudDecryptError extends ExplainedError {
  constructor(message: string) {
    super(message, 'errorCloudDecrypt');
    this.name = 'CloudDecryptError';
  }
}

// ---------------------------------------------------------------------------
// Encodings (3.1)
// ---------------------------------------------------------------------------

export function toBase64(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary);
}

/** Base64 to bytes; throws on text that is not base64. */
export function fromBase64(text: string): Uint8Array<ArrayBuffer> {
  const binary = atob(text);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

/** base64url without padding. */
export function toBase64Url(bytes: Uint8Array): string {
  return toBase64(bytes).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** The bytes of canonical base64url text, else `undefined`. Pure. */
export function fromBase64Url(text: string): Uint8Array<ArrayBuffer> | undefined {
  if (!/^[A-Za-z0-9_-]*$/.test(text) || text.length % 4 === 1) {
    return undefined;
  }
  const padded = text.replace(/-/g, '+').replace(/_/g, '/');
  try {
    const bytes = fromBase64(padded + '='.repeat((4 - (padded.length % 4)) % 4));
    return toBase64Url(bytes) === text ? bytes : undefined;
  } catch {
    return undefined;
  }
}

/** The length in bytes of `text` when it is canonical base64, else `undefined`. Pure. */
export function base64ByteLength(text: string): number | undefined {
  if (text.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(text)) {
    return undefined;
  }
  try {
    const bytes = fromBase64(text);
    return toBase64(bytes) === text ? bytes.length : undefined;
  } catch {
    return undefined;
  }
}

function hex(bytes: Uint8Array): string {
  return [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

const utf8 = (text: string): Uint8Array<ArrayBuffer> => new TextEncoder().encode(text);

function randomBytes(length: number): Uint8Array<ArrayBuffer> {
  return crypto.getRandomValues(new Uint8Array(length));
}

// ---------------------------------------------------------------------------
// Derivations (3.2)
// ---------------------------------------------------------------------------

async function hkdf(
  ikm: Uint8Array<ArrayBuffer>,
  info: string,
  length: number,
): Promise<Uint8Array<ArrayBuffer>> {
  const material = await crypto.subtle.importKey('raw', ikm, 'HKDF', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits(
    { name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(0), info: utf8(info) },
    material,
    length * 8,
  );
  return new Uint8Array(bits);
}

/** The DEK's bytes, or a decrypt error for a stored value that is not one. */
function dekBytes(dek: string): Uint8Array<ArrayBuffer> {
  const length = base64ByteLength(dek);
  if (length !== DEK_BYTES) {
    throw new CloudDecryptError('The stored data key is not 32 bytes of base64');
  }
  return fromBase64(dek);
}

/** `HKDF(dek, "tabinet-key-id-v2", 16)` as b64u, 22 characters. */
export async function keyIdOf(dek: string): Promise<string> {
  return toBase64Url(await hkdf(dekBytes(dek), INFO_KEY_ID, KEY_ID_BYTES));
}

/** `HKDF(dek, "tabinet-envelope-write-v2", 32)` as b64, sent only to `PUT /v2/keys`. */
export async function writeProofOf(dek: string): Promise<string> {
  return toBase64(await hkdf(dekBytes(dek), INFO_WRITE_PROOF, 32));
}

/** `SHA-256(writeProof bytes)` as hex: what the server stores. Pure over WebCrypto. */
export async function writeVerifierOf(proof: string): Promise<string> {
  return hex(new Uint8Array(await crypto.subtle.digest('SHA-256', fromBase64(proof))));
}

/** The doc id key, in memory only (as hex, for the test vectors). */
export async function docIdKeyOf(dek: string): Promise<string> {
  return hex(await hkdf(dekBytes(dek), INFO_DOC_ID, 32));
}

/** `HMAC-SHA-256(docIdKey, utf8(type) || 0x00 || utf8(id))` as b64u, 43 characters. */
export async function docRecordId(dek: string, type: string, id: string): Promise<string> {
  const keyBytes = await hkdf(dekBytes(dek), INFO_DOC_ID, 32);
  const key = await crypto.subtle.importKey(
    'raw',
    keyBytes,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const typeBytes = utf8(type);
  const idBytes = utf8(id);
  const message = new Uint8Array(typeBytes.length + 1 + idBytes.length);
  message.set(typeBytes, 0);
  message.set(idBytes, typeBytes.length + 1);
  return toBase64Url(new Uint8Array(await crypto.subtle.sign('HMAC', key, message)));
}

/** `b64u(SHA-256(utf8(json(["tabinet-memo-copy-v1", originalId, text, n]))))` (11.4). */
export async function memoCopyId(originalId: string, text: string, n: number): Promise<string> {
  const digest = await crypto.subtle.digest(
    'SHA-256',
    utf8(JSON.stringify([MEMO_COPY_LABEL, originalId, text, n])),
  );
  return toBase64Url(new Uint8Array(digest));
}

/** `b64u(SHA-256(utf8(text)))`: the fingerprint hash of a doc's sent version. */
export async function sha256Base64Url(text: string): Promise<string> {
  return toBase64Url(new Uint8Array(await crypto.subtle.digest('SHA-256', utf8(text))));
}

// ---------------------------------------------------------------------------
// The passphrase and the envelope (3.3)
// ---------------------------------------------------------------------------

let kdfIterations: number = POLICY.kdf.iterations;

/**
 * Tests only: PBKDF2 with `iterations` rounds, or `POLICY.kdf.iterations` again when omitted. The
 * rounds are part of envelope version 2 and never travel, so an envelope made under an override
 * opens only under the same override.
 */
export function overrideKdfIterations(iterations?: number): void {
  kdfIterations = iterations ?? POLICY.kdf.iterations;
}

/** The passphrase as it is stretched: NFC, never trimmed. */
export function normalizePassphrase(passphrase: string): string {
  return passphrase.normalize('NFC');
}

/** `PBKDF2-SHA-256(utf8(NFC passphrase), salt, 600000, 32)`, as raw bytes. */
export async function deriveWrapKey(
  passphrase: string,
  salt: string,
): Promise<Uint8Array<ArrayBuffer>> {
  const material = await crypto.subtle.importKey(
    'raw',
    utf8(normalizePassphrase(passphrase)),
    'PBKDF2',
    false,
    ['deriveBits'],
  );
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', hash: 'SHA-256', salt: fromBase64(salt), iterations: kdfIterations },
    material,
    256,
  );
  return new Uint8Array(bits);
}

/** `utf8(json(["tabinet-wrap-v2", generation, keyId, saltB64]))`. Pure. */
export function wrapAdditionalData(
  envelope: Pick<KeyEnvelope, 'generation' | 'keyId' | 'salt'>,
): Uint8Array<ArrayBuffer> {
  return utf8(JSON.stringify([WRAP_AAD_LABEL, envelope.generation, envelope.keyId, envelope.salt]));
}

function aesKey(raw: Uint8Array<ArrayBuffer>, usages: KeyUsage[]): Promise<CryptoKey> {
  return crypto.subtle.importKey('raw', raw, 'AES-GCM', false, usages);
}

/** Whether `value` is exactly an envelope of version 2 (fields, types and lengths). Pure. */
export function parseEnvelope(value: unknown): KeyEnvelope | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return null;
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort().join(',');
  if (keys !== 'generation,iv,keyId,salt,v,wrapped') {
    return null;
  }
  const { v, generation, keyId, salt, iv, wrapped } = record;
  if (
    v !== 2 ||
    typeof generation !== 'number' ||
    !Number.isInteger(generation) ||
    generation < 1 ||
    generation > MAX_GENERATION ||
    typeof keyId !== 'string' ||
    fromBase64Url(keyId)?.length !== KEY_ID_BYTES ||
    typeof salt !== 'string' ||
    base64ByteLength(salt) !== POLICY.kdf.saltBytes ||
    typeof iv !== 'string' ||
    base64ByteLength(iv) !== IV_BYTES ||
    typeof wrapped !== 'string' ||
    base64ByteLength(wrapped) !== WRAPPED_BYTES
  ) {
    return null;
  }
  return { v, generation, keyId, salt, iv, wrapped };
}

/**
 * The envelope of `dek` under `wrapKey` (raw), at `generation`, with the given salt and iv (the
 * test vectors fix them; everything else passes fresh random ones).
 */
export async function wrapWith(
  dek: string,
  wrapKey: Uint8Array<ArrayBuffer>,
  generation: number,
  salt: string,
  iv: string,
): Promise<KeyEnvelope> {
  const keyId = await keyIdOf(dek);
  const additionalData = wrapAdditionalData({ generation, keyId, salt });
  const cipher = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv: fromBase64(iv), additionalData },
    await aesKey(wrapKey, ['encrypt']),
    dekBytes(dek),
  );
  return { v: 2, generation, keyId, salt, iv, wrapped: toBase64(new Uint8Array(cipher)) };
}

/** The DEK in `envelope` under `wrapKey`, or `null` (wrong key, tampered, keyId mismatch). */
export async function unwrapWith(
  envelope: KeyEnvelope,
  wrapKey: Uint8Array<ArrayBuffer>,
): Promise<string | null> {
  try {
    const plain = await crypto.subtle.decrypt(
      {
        name: 'AES-GCM',
        iv: fromBase64(envelope.iv),
        additionalData: wrapAdditionalData(envelope),
      },
      await aesKey(wrapKey, ['decrypt']),
      fromBase64(envelope.wrapped),
    );
    const dek = toBase64(new Uint8Array(plain));
    return (await keyIdOf(dek)) === envelope.keyId ? dek : null;
  } catch {
    return null;
  }
}

/** A fresh envelope of `dek` under `passphrase` at `generation`: new salt, new iv. */
async function wrapDek(dek: string, passphrase: string, generation: number): Promise<KeyEnvelope> {
  const salt = toBase64(randomBytes(POLICY.kdf.saltBytes));
  const iv = toBase64(randomBytes(IV_BYTES));
  return wrapWith(dek, await deriveWrapKey(passphrase, salt), generation, salt, iv);
}

/** A new data key, its id, its envelope at generation 1 and the write proof. */
export async function createKey(
  passphrase: string,
): Promise<{ dek: string; keyId: string; envelope: KeyEnvelope; proof: string }> {
  const dek = toBase64(randomBytes(DEK_BYTES));
  const envelope = await wrapDek(dek, passphrase, 1);
  return { dek, keyId: envelope.keyId, envelope, proof: await writeProofOf(dek) };
}

/** The same data key under a new passphrase: new salt and iv, the given generation. */
export async function rewrapKey(
  dek: string,
  passphrase: string,
  generation: number,
): Promise<{ envelope: KeyEnvelope; proof: string }> {
  return { envelope: await wrapDek(dek, passphrase, generation), proof: await writeProofOf(dek) };
}

/** The data key, or `null`: a wrong passphrase or a keyId check that failed (one message). */
export async function unwrapKey(envelope: KeyEnvelope, passphrase: string): Promise<string | null> {
  return unwrapWith(envelope, await deriveWrapKey(passphrase, envelope.salt));
}

// ---------------------------------------------------------------------------
// Records (3.5)
// ---------------------------------------------------------------------------

/** What a record says about itself outside its ciphertext: all of it is authenticated. */
export interface CloudRecordMeta {
  kind: RecordKind;
  id: string;
  updatedAt: number;
  deleted: boolean;
}

/** The prefix of every record's additional data, unchanged from v1. */
const RECORD_AAD_VERSION = 'tabinet-record-v1';

/** `tabinet-record-v1|<kind>|<id>|<updatedAt>|<0 or 1>`, UTF-8. Pure. */
export function recordAdditionalData(meta: CloudRecordMeta): Uint8Array<ArrayBuffer> {
  return utf8(
    [RECORD_AAD_VERSION, meta.kind, meta.id, String(meta.updatedAt), meta.deleted ? '1' : '0'].join(
      '|',
    ),
  );
}

/** `value` as JSON, AES-GCM under the DEK with a fresh iv and `meta` as additional data. */
export async function encryptRecord(
  rawKey: string,
  meta: CloudRecordMeta,
  value: unknown,
): Promise<EncryptedPayload> {
  const iv = randomBytes(IV_BYTES);
  const cipher = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv, additionalData: recordAdditionalData(meta) },
    await aesKey(dekBytes(rawKey), ['encrypt']),
    utf8(JSON.stringify(value)),
  );
  return { iv: toBase64(iv), ciphertext: toBase64(new Uint8Array(cipher)) };
}

/**
 * The inverse of `encryptRecord` for a record whose metadata is `meta`; `CloudDecryptError` on
 * anything that does not decrypt (metadata other than it was encrypted with included).
 */
export async function decryptRecord(
  rawKey: string,
  meta: CloudRecordMeta,
  payload: EncryptedPayload,
): Promise<unknown> {
  let plain: ArrayBuffer;
  try {
    plain = await crypto.subtle.decrypt(
      {
        name: 'AES-GCM',
        iv: fromBase64(payload.iv),
        additionalData: recordAdditionalData(meta),
      },
      await aesKey(dekBytes(rawKey), ['decrypt']),
      fromBase64(payload.ciphertext),
    );
  } catch {
    throw new CloudDecryptError('AES-GCM refused the record (tampered, moved or another key)');
  }
  try {
    const value: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(plain));
    return value;
  } catch {
    throw new CloudDecryptError('The record decrypted to something that is not JSON');
  }
}
