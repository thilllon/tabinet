import { describe, expect, it } from 'vitest';

import { POLICY } from '@/constants';
import {
  CloudDecryptError,
  createKeySetup,
  decryptRecord,
  encryptRecord,
  fromBase64,
  recordAdditionalData,
  toBase64,
  unlockKeySetup,
} from '@/lib/cloud-crypto';
import { errorMessage } from '@/lib/error-message';
import { t } from '@/lib/i18n';

/** Few rounds keep the suite fast; one test below checks the real default. */
const FAST = 1000;

describe('base64', () => {
  it('round-trips every byte value', () => {
    const bytes = Uint8Array.from({ length: 256 }, (_, index) => index);
    expect([...fromBase64(toBase64(bytes))]).toEqual([...bytes]);
  });
});

describe('createKeySetup / unlockKeySetup', () => {
  it('describes PBKDF2-SHA-256 with 600000 rounds, a 16-byte salt and a 12-byte check iv', async () => {
    const { setup, rawKey } = await createKeySetup('correct horse battery staple');
    expect(setup.kdf).toEqual({
      name: 'PBKDF2',
      hash: 'SHA-256',
      iterations: POLICY.kdf.iterations,
    });
    expect(POLICY.kdf.iterations).toBe(600_000);
    expect(fromBase64(setup.salt)).toHaveLength(16);
    expect(fromBase64(setup.checkIv)).toHaveLength(12);
    expect(fromBase64(rawKey)).toHaveLength(32);
    // The check text plus the 16-byte GCM tag.
    expect(fromBase64(setup.check)).toHaveLength('tabinet-key-check-v1'.length + 16);
  });

  it('gives the same key back for the right passphrase', async () => {
    const { setup, rawKey } = await createKeySetup('correct horse battery staple', FAST);
    expect(await unlockKeySetup(setup, 'correct horse battery staple')).toBe(rawKey);
  });

  it('answers null for a wrong passphrase', async () => {
    const { setup } = await createKeySetup('correct horse battery staple', FAST);
    expect(await unlockKeySetup(setup, 'correct horse battery stapler')).toBeNull();
  });

  it('answers null when the check was tampered with', async () => {
    const { setup } = await createKeySetup('passphrase!', FAST);
    const check = fromBase64(setup.check);
    check[0] ^= 1;
    expect(await unlockKeySetup({ ...setup, check: toBase64(check) }, 'passphrase!')).toBeNull();
  });

  it('salts every setup, so the same passphrase never gives the same key', async () => {
    const first = await createKeySetup('same passphrase', FAST);
    const second = await createKeySetup('same passphrase', FAST);
    expect(first.setup.salt).not.toBe(second.setup.salt);
    expect(first.rawKey).not.toBe(second.rawKey);
  });
});

const META = { kind: 'session', id: 's1', updatedAt: 1_000, deleted: false } as const;

describe('encryptRecord / decryptRecord', () => {
  it('round-trips a value, with a fresh iv every time', async () => {
    const { rawKey } = await createKeySetup('passphrase!', FAST);
    const value = { name: 'Работа 作業 🗂', tabs: [{ url: 'https://example.com/?a=1&b=2' }] };
    const first = await encryptRecord(rawKey, META, value);
    const second = await encryptRecord(rawKey, META, value);
    expect(fromBase64(first.iv)).toHaveLength(12);
    expect(first.iv).not.toBe(second.iv);
    expect(first.ciphertext).not.toContain('example');
    expect(await decryptRecord(rawKey, META, first)).toEqual(value);
  });

  it('throws CloudDecryptError on a tampered ciphertext, explained to the person', async () => {
    const { rawKey } = await createKeySetup('passphrase!', FAST);
    const payload = await encryptRecord(rawKey, META, { a: 1 });
    const bytes = fromBase64(payload.ciphertext);
    bytes[bytes.length - 1] ^= 1;
    const tampered = decryptRecord(rawKey, META, { ...payload, ciphertext: toBase64(bytes) });
    await expect(tampered).rejects.toBeInstanceOf(CloudDecryptError);
    const err: unknown = await tampered.catch((caught: unknown) => caught);
    expect(errorMessage(err)).toBe(t('errorCloudDecrypt'));
  });

  it('throws CloudDecryptError under another key', async () => {
    const one = await createKeySetup('passphrase one', FAST);
    const two = await createKeySetup('passphrase two', FAST);
    const payload = await encryptRecord(one.rawKey, META, { a: 1 });
    await expect(decryptRecord(two.rawKey, META, payload)).rejects.toBeInstanceOf(
      CloudDecryptError,
    );
  });

  it('authenticates the metadata: another kind, id, updatedAt or deleted flag does not decrypt', async () => {
    const { rawKey } = await createKeySetup('passphrase!', FAST);
    const payload = await encryptRecord(rawKey, META, { a: 1 });
    const changed = [
      { ...META, kind: 'settings' as const },
      { ...META, id: 's2' },
      { ...META, updatedAt: 1_001 },
      { ...META, deleted: true },
    ];
    for (const meta of changed) {
      await expect(decryptRecord(rawKey, meta, payload)).rejects.toBeInstanceOf(CloudDecryptError);
    }
    expect(await decryptRecord(rawKey, { ...META }, payload)).toEqual({ a: 1 });
  });

  it('refuses an empty iv and ciphertext', async () => {
    const { rawKey } = await createKeySetup('passphrase!', FAST);
    const empty = decryptRecord(rawKey, { ...META, deleted: true }, { iv: '', ciphertext: '' });
    await expect(empty).rejects.toBeInstanceOf(CloudDecryptError);
  });

  it('writes the additional data as one canonical line', () => {
    const text = (meta: Parameters<typeof recordAdditionalData>[0]) =>
      new TextDecoder().decode(recordAdditionalData(meta));
    expect(text(META)).toBe('tabinet-record-v1|session|s1|1000|0');
    expect(text({ kind: 'settings', id: 'settings', updatedAt: 0, deleted: true })).toBe(
      'tabinet-record-v1|settings|settings|0|1',
    );
  });
});
