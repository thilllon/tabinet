import { readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  envelopeBytes,
  importKeyEncryptionKey,
  keyEncryptionKeyIdOf,
  open,
  parseEnvelope,
  seal,
  writeVerifierOf,
} from '../envelope.js';
import { PINNED_KEY_ENCRYPTION_KEY_ID } from '../key-encryption-key-id.js';
import type { KeyEnvelope } from '../types.js';

/** The shared test vectors (spec 3.6), the same file the extension's tests read. */
const vectors = JSON.parse(
  readFileSync(path.resolve(import.meta.dirname, '../../../src/tests/key-vectors.json'), 'utf8'),
) as {
  keyEncryptionKey: string;
  keyEncryptionKeyId: string;
  writeProof: string;
  writeVerifier: string;
  envelope: KeyEnvelope;
  envelopeBytes: string;
  sub: string;
  sealIv: string;
  sealed: string;
};

const keyEncryptionKeyBytes = new Uint8Array(Buffer.from(vectors.keyEncryptionKey, 'base64'));
const keyEncryptionKey = await importKeyEncryptionKey(keyEncryptionKeyBytes);
const row = {
  keyEncryptionKeyId: vectors.keyEncryptionKeyId,
  keyId: vectors.envelope.keyId,
  generation: vectors.envelope.generation,
  sealed: vectors.sealed,
};

/** The sealed text with one bit of byte `index` flipped. */
function flipped(sealed: string, index: number): string {
  const bytes = Buffer.from(sealed, 'base64');
  bytes[index] ^= 1;
  return bytes.toString('base64');
}

describe('the test vectors, server half', () => {
  it('derives the key encryption key id', async () => {
    expect(await keyEncryptionKeyIdOf(keyEncryptionKeyBytes)).toBe(vectors.keyEncryptionKeyId);
    expect(keyEncryptionKey.id).toBe(vectors.keyEncryptionKeyId);
  });

  it('never pins the vectors key encryption key', () => {
    expect(PINNED_KEY_ENCRYPTION_KEY_ID).not.toBe(vectors.keyEncryptionKeyId);
  });

  it('derives the write verifier from the proof', () => {
    expect(writeVerifierOf(vectors.writeProof)).toBe(vectors.writeVerifier);
  });

  it('lays out the envelope bytes', () => {
    expect(Buffer.from(envelopeBytes(vectors.envelope)).toString('hex')).toBe(
      vectors.envelopeBytes,
    );
  });

  it('seals byte for byte with the vector IV', async () => {
    const iv = new Uint8Array(Buffer.from(vectors.sealIv, 'base64'));
    const sealed = await seal(keyEncryptionKey, vectors.sub, vectors.envelope, iv);
    expect(sealed).toBe(vectors.sealed);
    expect(sealed).toHaveLength(168);
  });

  it('opens the vector', async () => {
    expect(await open(keyEncryptionKey, row, vectors.sub)).toEqual(vectors.envelope);
  });

  it('seals with a fresh IV each time, which still opens', async () => {
    const a = await seal(keyEncryptionKey, vectors.sub, vectors.envelope);
    const b = await seal(keyEncryptionKey, vectors.sub, vectors.envelope);
    expect(a).not.toBe(b);
    expect(await open(keyEncryptionKey, { ...row, sealed: a }, vectors.sub)).toEqual(
      vectors.envelope,
    );
  });
});

describe('open fails closed', () => {
  it('for another sub', async () => {
    expect(await open(keyEncryptionKey, row, '100000000000000000002')).toBeNull();
  });

  it('for another keyEncryptionKeyId on the row, and for another key encryption key', async () => {
    expect(
      await open(keyEncryptionKey, { ...row, keyEncryptionKeyId: '0000000000000000' }, vectors.sub),
    ).toBeNull();
    const other = await importKeyEncryptionKey(new Uint8Array(32).fill(9));
    expect(await open(other, row, vectors.sub)).toBeNull();
    // Another key encryption key that the row claims: the id matches, the key does not open it.
    expect(await open(other, { ...row, keyEncryptionKeyId: other.id }, vectors.sub)).toBeNull();
  });

  it('for another keyId or generation on the row', async () => {
    expect(
      await open(keyEncryptionKey, { ...row, keyId: 'AAAAAAAAAAAAAAAAAAAAAA' }, vectors.sub),
    ).toBeNull();
    expect(await open(keyEncryptionKey, { ...row, generation: 2 }, vectors.sub)).toBeNull();
  });

  it('for a truncated or padded blob, and for one that is not base64', async () => {
    const bytes = Buffer.from(vectors.sealed, 'base64');
    for (const sealed of [
      bytes.subarray(0, 124).toString('base64'),
      Buffer.concat([bytes, Buffer.alloc(1)]).toString('base64'),
      '',
      `${vectors.sealed.slice(0, -1)}!`,
    ]) {
      expect(await open(keyEncryptionKey, { ...row, sealed }, vectors.sub)).toBeNull();
    }
  });

  it.each([
    ['the IV', 0],
    ['the IV, last byte', 11],
    ['the ciphertext', 12],
    ['the ciphertext, last byte', 108],
    ['the tag', 109],
    ['the tag, last byte', 124],
  ])('for a flipped bit in %s', async (_name, index) => {
    expect(
      await open(keyEncryptionKey, { ...row, sealed: flipped(vectors.sealed, index) }, vectors.sub),
    ).toBeNull();
  });

  it('when the sealed bytes hold another key id or generation than the row', async () => {
    // Sealed honestly for generation 2 under the same AAD fields the row will claim.
    const other = { ...vectors.envelope, generation: 2 };
    const sealed = await seal(keyEncryptionKey, vectors.sub, other);
    expect(await open(keyEncryptionKey, { ...row, generation: 2, sealed }, vectors.sub)).toEqual(
      other,
    );
    expect(await open(keyEncryptionKey, { ...row, generation: 1, sealed }, vectors.sub)).toBeNull();
  });
});

describe('parseEnvelope', () => {
  it('takes the vector', () => {
    expect(parseEnvelope(vectors.envelope)).toEqual(vectors.envelope);
  });

  it.each([
    ['v 1', { v: 1 }],
    ['v "2"', { v: '2' }],
    ['generation 0', { generation: 0 }],
    ['generation over 2^31 - 1', { generation: 2_147_483_648 }],
    ['generation 1.5', { generation: 1.5 }],
    ['a short keyId', { keyId: 't5Je7_rzOWLofjmcQnKr6' }],
    ['a padded keyId', { keyId: 't5Je7_rzOWLofjmcQnKr6g==' }],
    ['a non-canonical keyId', { keyId: 't5Je7_rzOWLofjmcQnKr6h' }],
    ['a base64 keyId', { keyId: 't5Je7/rzOWLofjmcQnKr6g' }],
    ['a salt of 15 bytes', { salt: Buffer.alloc(15).toString('base64') }],
    ['a salt of 17 bytes', { salt: Buffer.alloc(17).toString('base64') }],
    ['an unpadded salt', { salt: 'QEFCQ0RFRkdISUpLTE1OTw' }],
    ['an iv of 16 bytes', { iv: Buffer.alloc(16).toString('base64') }],
    ['a wrapped of 47 bytes', { wrapped: Buffer.alloc(47).toString('base64') }],
    ['a non-canonical salt', { salt: 'QEFCQ0RFRkdISUpLTE1OTx==' }],
  ])('refuses %s', (_name, change) => {
    expect(parseEnvelope({ ...vectors.envelope, ...change })).toBeNull();
  });

  it('refuses a missing or an extra field, and anything not an object', () => {
    const { wrapped: _, ...missing } = vectors.envelope;
    expect(parseEnvelope(missing)).toBeNull();
    expect(parseEnvelope({ ...vectors.envelope, kdf: 'PBKDF2' })).toBeNull();
    for (const value of [null, [], 'envelope', 2]) {
      expect(parseEnvelope(value)).toBeNull();
    }
  });
});
