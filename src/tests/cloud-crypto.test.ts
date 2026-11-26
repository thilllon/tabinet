import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  base64ByteLength,
  CloudDecryptError,
  createKey,
  decryptRecord,
  deriveWrapKey,
  docIdKeyOf,
  docRecordId,
  encryptRecord,
  fromBase64,
  fromBase64Url,
  keyIdOf,
  memoCopyId,
  parseEnvelope,
  recordAdditionalData,
  rewrapKey,
  toBase64,
  unwrapKey,
  unwrapWith,
  wrapAdditionalData,
  wrapWith,
  writeProofOf,
  writeVerifierOf,
} from '@/lib/cloud-crypto';
import type { KeyEnvelope } from '@/types';

interface Vectors {
  dek: string;
  docIdKey: string;
  keyId: string;
  writeProof: string;
  writeVerifier: string;
  passphrase: string;
  passphraseNfcUtf8: string;
  passphraseNfdUtf8: string;
  wrapKey: string;
  wrapAad: string;
  envelope: KeyEnvelope;
  docIds: { memo: string; youtubeNote: string };
  record: { iv: string; aad: string; plaintext: string; ciphertext: string };
  memoCopyId: string;
}

const vectors = JSON.parse(readFileSync(join(__dirname, 'key-vectors.json'), 'utf8')) as Vectors;
const DATA_ID = '00000000-0000-4000-8000-000000000001';

const hexOf = (bytes: Uint8Array) =>
  [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('');
const fromHex = (text: string) =>
  new TextDecoder().decode(Uint8Array.from(text.match(/../g)!.map((pair) => parseInt(pair, 16))));

/** `text` (b64) with one bit of byte `index` flipped. */
function flipBit(text: string, index = 0): string {
  const bytes = fromBase64(text);
  bytes[index]! ^= 1;
  return toBase64(bytes);
}

describe('the derivations match the vectors', () => {
  it('derives keyId, write proof, verifier and doc id key', async () => {
    expect(await keyIdOf(vectors.dek)).toBe(vectors.keyId);
    expect(await writeProofOf(vectors.dek)).toBe(vectors.writeProof);
    expect(await writeVerifierOf(vectors.writeProof)).toBe(vectors.writeVerifier);
    expect(await docIdKeyOf(vectors.dek)).toBe(vectors.docIdKey);
  });

  it('derives the doc record ids and the memo copy id', async () => {
    expect(await docRecordId(vectors.dek, 'memo', DATA_ID)).toBe(vectors.docIds.memo);
    expect(await docRecordId(vectors.dek, 'youtubeNote', DATA_ID)).toBe(vectors.docIds.youtubeNote);
    expect(await memoCopyId(DATA_ID, 'hello\n', 0)).toBe(vectors.memoCopyId);
    expect(await memoCopyId(DATA_ID, 'hello\n', 1)).not.toBe(vectors.memoCopyId);
  });

  it('spells the passphrase in NFC and derives the wrap key from it, NFD too', async () => {
    expect(hexOf(new TextEncoder().encode(vectors.passphrase.normalize('NFC')))).toBe(
      vectors.passphraseNfcUtf8,
    );
    const nfd = fromHex(vectors.passphraseNfdUtf8);
    expect(nfd).not.toBe(vectors.passphrase);
    expect(hexOf(await deriveWrapKey(vectors.passphrase, vectors.envelope.salt))).toBe(
      vectors.wrapKey,
    );
    expect(hexOf(await deriveWrapKey(nfd, vectors.envelope.salt))).toBe(vectors.wrapKey);
  });

  it('wraps byte for byte and unwraps with either spelling', async () => {
    const { envelope } = vectors;
    expect(new TextDecoder().decode(wrapAdditionalData(envelope))).toBe(vectors.wrapAad);
    const wrapKey = await deriveWrapKey(vectors.passphrase, envelope.salt);
    expect(await wrapWith(vectors.dek, wrapKey, 1, envelope.salt, envelope.iv)).toEqual(envelope);
    expect(await unwrapKey(envelope, vectors.passphrase)).toBe(vectors.dek);
    expect(await unwrapKey(envelope, fromHex(vectors.passphraseNfdUtf8))).toBe(vectors.dek);
  });

  it('decrypts the record vector under its additional data', async () => {
    const meta = { kind: 'doc', id: vectors.docIds.memo, updatedAt: 1_800_000_000_001 } as const;
    expect(new TextDecoder().decode(recordAdditionalData({ ...meta, deleted: false }))).toBe(
      vectors.record.aad,
    );
    const payload = { iv: vectors.record.iv, ciphertext: vectors.record.ciphertext };
    expect(await decryptRecord(vectors.dek, { ...meta, deleted: false }, payload)).toEqual(
      JSON.parse(vectors.record.plaintext),
    );
    await expect(
      decryptRecord(vectors.dek, { ...meta, deleted: true }, payload),
    ).rejects.toBeInstanceOf(CloudDecryptError);
  });
});

describe('unwrapping refuses', () => {
  const { envelope } = vectors;

  it('a wrong passphrase', async () => {
    expect(await unwrapKey(envelope, 'not the passphrase')).toBeNull();
  });

  it('one flipped bit in each field, another generation, salt or keyId', async () => {
    const wrapKey = await deriveWrapKey(vectors.passphrase, envelope.salt);
    const variants: KeyEnvelope[] = [
      { ...envelope, iv: flipBit(envelope.iv) },
      { ...envelope, wrapped: flipBit(envelope.wrapped) },
      { ...envelope, wrapped: flipBit(envelope.wrapped, 47) },
      { ...envelope, salt: flipBit(envelope.salt) },
      { ...envelope, generation: 2 },
      { ...envelope, keyId: 'A'.repeat(21) + 'A' },
    ];
    for (const variant of variants) {
      expect(await unwrapWith(variant, wrapKey)).toBeNull();
    }
    expect(await unwrapWith(envelope, wrapKey)).toBe(vectors.dek);
  });

  it('an envelope whose keyId is not that of the key inside', async () => {
    const other = await wrapWith(
      toBase64(new Uint8Array(32).fill(7)),
      await deriveWrapKey('x', envelope.salt),
      1,
      envelope.salt,
      envelope.iv,
    );
    // The same wrapped key under another keyId's additional data cannot be built without the
    // wrap key; one built honestly but relabelled fails the check after unwrapping.
    expect(
      await unwrapWith({ ...other, keyId: vectors.keyId }, await deriveWrapKey('x', envelope.salt)),
    ).toBeNull();
  });
});

describe('parseEnvelope', () => {
  const { envelope } = vectors;

  it('takes exactly the fields and lengths of version 2', () => {
    expect(parseEnvelope(envelope)).toEqual(envelope);
    expect(parseEnvelope({ ...envelope, extra: 1 })).toBeNull();
    expect(parseEnvelope({ ...envelope, v: 1 })).toBeNull();
    expect(parseEnvelope({ ...envelope, generation: 0 })).toBeNull();
    expect(parseEnvelope({ ...envelope, generation: 2_147_483_648 })).toBeNull();
    expect(parseEnvelope({ ...envelope, generation: 1.5 })).toBeNull();
    expect(parseEnvelope({ ...envelope, keyId: `${envelope.keyId}A` })).toBeNull();
    expect(parseEnvelope({ ...envelope, salt: toBase64(new Uint8Array(17)) })).toBeNull();
    expect(parseEnvelope({ ...envelope, iv: toBase64(new Uint8Array(16)) })).toBeNull();
    expect(parseEnvelope({ ...envelope, wrapped: toBase64(new Uint8Array(32)) })).toBeNull();
    expect(parseEnvelope(null)).toBeNull();
    expect(parseEnvelope([envelope])).toBeNull();
  });

  it('refuses base64 that is not canonical', () => {
    expect(base64ByteLength('QQ==')).toBe(1);
    expect(base64ByteLength('QR==')).toBeUndefined();
    expect(fromBase64Url(vectors.keyId)?.length).toBe(16);
    expect(fromBase64Url(`${vectors.keyId.slice(0, -1)}h`)).toBeUndefined();
  });
});

describe('fresh keys', () => {
  it('creates a key whose envelope opens with the passphrase', async () => {
    const created = await createKey('a long passphrase');
    expect(created.keyId).toBe(await keyIdOf(created.dek));
    expect(created.envelope.generation).toBe(1);
    expect(parseEnvelope(created.envelope)).toEqual(created.envelope);
    expect(created.proof).toBe(await writeProofOf(created.dek));
    expect(await unwrapKey(created.envelope, 'a long passphrase')).toBe(created.dek);
  });

  it('rewraps the same key under a new passphrase at the given generation', async () => {
    const rewrapped = await rewrapKey(vectors.dek, 'another passphrase', 6);
    expect(rewrapped.envelope.generation).toBe(6);
    expect(rewrapped.envelope.keyId).toBe(vectors.keyId);
    expect(rewrapped.envelope.salt).not.toBe(vectors.envelope.salt);
    expect(rewrapped.proof).toBe(vectors.writeProof);
    expect(await unwrapKey(rewrapped.envelope, 'another passphrase')).toBe(vectors.dek);
    expect(await unwrapKey(rewrapped.envelope, vectors.passphrase)).toBeNull();
  });

  it('round-trips a record and binds every field of its metadata', async () => {
    const meta = { kind: 'session', id: 's1', updatedAt: 5, deleted: false } as const;
    const payload = await encryptRecord(vectors.dek, meta, { a: 1 });
    expect(await decryptRecord(vectors.dek, meta, payload)).toEqual({ a: 1 });
    for (const moved of [
      { ...meta, kind: 'doc' as const },
      { ...meta, id: 's2' },
      { ...meta, updatedAt: 6 },
      { ...meta, deleted: true },
    ]) {
      await expect(decryptRecord(vectors.dek, moved, payload)).rejects.toBeInstanceOf(
        CloudDecryptError,
      );
    }
  });
});
