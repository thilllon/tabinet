/**
 * The key envelope on the server (spec 3.3 and 3.4). A device sends its envelope (its data key
 * wrapped under the passphrase); the server seals it under the KEK, bound to the account's Google
 * `sub` as the verified Google answer of that request gives it, and stores only the sealed text.
 * So a copy of the database cannot test a passphrase, and a sealed envelope moved to another row,
 * or opened for another Google account, does not open.
 */
import { createHash, hkdfSync, randomBytes } from 'node:crypto';

import type { KeyEnvelope } from './types.js';
import { decodeBase64, decodeBase64url, IV_BYTES } from './validation.js';

export { parseEnvelope } from './validation.js';

/** The KEK: 32 bytes (AES-256). */
export const KEK_BYTES = 32;
const KEK_ID_BYTES = 8;
const ENVELOPE_VERSION = 2;
/** version(1) + generation(4) + keyId(16) + salt(16) + wrap IV(12) + wrapped(48). */
const PLAINTEXT_BYTES = 97;
const TAG_BYTES = 16;
const SEALED_BYTES = IV_BYTES + PLAINTEXT_BYTES + TAG_BYTES;

/** The configured KEK, as `Deps['kek']`: its id and the key itself, never extractable. */
export interface Kek {
  id: string;
  key: CryptoKey;
}

/** A row's key columns, as `open()` needs them. */
export interface SealedRow {
  kekId: string;
  keyId: string;
  generation: number;
  sealed: string;
}

const encoder = new TextEncoder();

/** `HKDF(kek, "tabinet-kek-id-v2", 8)` as lowercase hex. Synchronous, for the production check. */
export function kekIdOfSync(kek: Uint8Array): string {
  if (kek.length !== KEK_BYTES) {
    throw new RangeError('A KEK is 32 bytes');
  }
  return Buffer.from(
    hkdfSync('sha256', kek, new Uint8Array(0), 'tabinet-kek-id-v2', KEK_ID_BYTES),
  ).toString('hex');
}

export async function kekIdOf(kek: Uint8Array): Promise<string> {
  return kekIdOfSync(kek);
}

/** The KEK as `Deps['kek']`. The raw bytes are not kept. */
export async function importKek(kek: Uint8Array): Promise<Kek> {
  const id = kekIdOfSync(kek);
  const key = await crypto.subtle.importKey('raw', new Uint8Array(kek), 'AES-GCM', false, [
    'encrypt',
    'decrypt',
  ]);
  return { id, key };
}

/** The 97 bytes of spec 3.4 for a valid envelope. */
export function envelopeBytes(envelope: KeyEnvelope): Uint8Array<ArrayBuffer> {
  const keyId = decodeBase64url(envelope.keyId);
  const salt = decodeBase64(envelope.salt);
  const iv = decodeBase64(envelope.iv);
  const wrapped = decodeBase64(envelope.wrapped);
  if (
    keyId?.length !== 16 ||
    salt?.length !== 16 ||
    iv?.length !== IV_BYTES ||
    wrapped?.length !== 48 ||
    !Number.isInteger(envelope.generation) ||
    envelope.generation < 1
  ) {
    throw new RangeError('Not a valid envelope');
  }
  const bytes = new Uint8Array(PLAINTEXT_BYTES);
  bytes[0] = ENVELOPE_VERSION;
  new DataView(bytes.buffer).setUint32(1, envelope.generation, false);
  bytes.set(keyId, 5);
  bytes.set(salt, 21);
  bytes.set(iv, 37);
  bytes.set(wrapped, 49);
  return bytes;
}

function envelopeFromBytes(bytes: Uint8Array): KeyEnvelope | null {
  if (bytes.length !== PLAINTEXT_BYTES || bytes[0] !== ENVELOPE_VERSION) {
    return null;
  }
  const b64 = (start: number, end: number) => Buffer.from(bytes.subarray(start, end));
  return {
    v: 2,
    generation: new DataView(bytes.buffer, bytes.byteOffset).getUint32(1, false),
    keyId: b64(5, 21).toString('base64url'),
    salt: b64(21, 37).toString('base64'),
    iv: b64(37, 49).toString('base64'),
    wrapped: b64(49, 97).toString('base64'),
  };
}

function sealAad(
  sub: string,
  kekId: string,
  keyId: string,
  generation: number,
): Uint8Array<ArrayBuffer> {
  return encoder.encode(JSON.stringify(['tabinet-envelope-v2', sub, kekId, keyId, generation]));
}

/**
 * Seals an envelope under the KEK for `sub`, the one Google verified in this request. `iv` is for
 * the test vectors only; a real seal always takes a fresh random one.
 */
export async function seal(
  kek: Kek,
  sub: string,
  envelope: KeyEnvelope,
  iv: Uint8Array = new Uint8Array(randomBytes(IV_BYTES)),
): Promise<string> {
  if (iv.length !== IV_BYTES) {
    throw new RangeError('A seal IV is 12 bytes');
  }
  const ciphertext = await crypto.subtle.encrypt(
    {
      name: 'AES-GCM',
      iv: new Uint8Array(iv),
      additionalData: sealAad(sub, kek.id, envelope.keyId, envelope.generation),
    },
    kek.key,
    envelopeBytes(envelope),
  );
  return Buffer.concat([iv, new Uint8Array(ciphertext)]).toString('base64');
}

/**
 * Opens a row's sealed envelope for `sub`, the one Google verified in this request (never one
 * read from the database). Null for anything that does not open into exactly the row's key: a
 * row sealed under another KEK, for another sub, with an edited key id, generation or blob.
 */
export async function open(kek: Kek, row: SealedRow, sub: string): Promise<KeyEnvelope | null> {
  if (row.kekId !== kek.id) {
    return null;
  }
  const sealed = decodeBase64(row.sealed);
  if (sealed === null || sealed.length !== SEALED_BYTES) {
    return null;
  }
  let plaintext: ArrayBuffer;
  try {
    plaintext = await crypto.subtle.decrypt(
      {
        name: 'AES-GCM',
        iv: sealed.slice(0, IV_BYTES),
        additionalData: sealAad(sub, row.kekId, row.keyId, row.generation),
      },
      kek.key,
      sealed.slice(IV_BYTES),
    );
  } catch {
    return null;
  }
  const envelope = envelopeFromBytes(new Uint8Array(plaintext));
  if (envelope === null || envelope.keyId !== row.keyId || envelope.generation !== row.generation) {
    return null;
  }
  return envelope;
}

/** `SHA-256(writeProof bytes)` as lowercase hex: what the server keeps in place of the proof. */
export function writeVerifierOf(proof: string): string {
  const bytes = decodeBase64(proof);
  if (bytes === null) {
    throw new RangeError('Not a write proof');
  }
  return createHash('sha256').update(bytes).digest('hex');
}
