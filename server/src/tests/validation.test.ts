import { describe, expect, it } from 'vitest';

import {
  decodeBase64,
  decodeBase64url,
  isKeyId,
  parseAccessToken,
  parseKeysBody,
  parseRecordsBody,
  parseSince,
} from '../validation.js';
import { b64, docId, newKey, rec } from './helpers.js';

describe('base64', () => {
  it('takes canonical padded base64 only', () => {
    expect(decodeBase64('AAAA')?.length).toBe(3);
    expect(decodeBase64('AA==')?.length).toBe(1);
    expect(decodeBase64('')?.length).toBe(0);
    for (const value of ['AAA', 'AB==', 'A===', 'AA=A', 'AA-_', ' AAAA', 'AAAA\n', 7, null]) {
      expect(decodeBase64(value)).toBeNull();
    }
  });

  it('takes canonical unpadded base64url only', () => {
    expect(decodeBase64url('AAAA')?.length).toBe(3);
    expect(decodeBase64url('AA')?.length).toBe(1);
    for (const value of ['AA==', 'AB', 'A', 'AA+/', 'AA.A']) {
      expect(decodeBase64url(value)).toBeNull();
    }
  });

  it('knows a key id: 16 bytes of base64url', () => {
    expect(isKeyId(newKey().envelope.keyId)).toBe(true);
    expect(isKeyId('t5Je7_rzOWLofjmcQnKr6g')).toBe(true);
    expect(isKeyId('t5Je7_rzOWLofjmcQnKr6')).toBe(false);
    expect(isKeyId(null)).toBe(false);
  });
});

describe('parseAccessToken and parseKeysBody', () => {
  it('want exactly the named fields', () => {
    expect(parseAccessToken({ accessToken: 't' })).toBe('t');
    expect(parseAccessToken({ accessToken: 't', x: 1 })).toBeNull();
    const { envelope, proof } = newKey();
    expect(parseKeysBody({ accessToken: 't', envelope, proof })).toEqual({
      accessToken: 't',
      envelope,
      proof,
    });
    expect(parseKeysBody({ accessToken: 't', envelope })).toBeNull();
    expect(parseKeysBody({ accessToken: '', envelope, proof })).toBeNull();
    expect(parseKeysBody({ accessToken: 't', envelope, proof: `${proof}=` })).toBeNull();
  });
});

describe('parseRecordsBody', () => {
  const ok = (records: unknown[]) => parseRecordsBody({ records }) !== null;

  it('takes every kind, live and deleted, and an empty list', () => {
    expect(ok([])).toBe(true);
    expect(
      ok([
        rec('session', 's', 1),
        rec('session', 't', 1, { deleted: true }),
        rec('settings', 'settings', 1),
        rec('image', 'i', 1),
        rec('doc', docId(1), 1),
        rec('doc', docId(2), 1, { deleted: true, baseSeq: 7 }),
      ]),
    ).toBe(true);
  });

  it('refuses a repeated kind and id, but not the same id under two kinds', () => {
    expect(ok([rec('session', 's', 1), rec('session', 's', 2)])).toBe(false);
    expect(ok([rec('session', 's', 1), rec('image', 's', 1)])).toBe(true);
  });

  it.each([
    ['an unknown kind', { kind: 'notes' }],
    ['an empty id', { id: '' }],
    ['an id of 65', { id: 'a'.repeat(65) }],
    ['an id with a dot', { id: 'a.b' }],
    ['settings under another id', { kind: 'settings', id: 's' }],
    ['a negative updatedAt', { updatedAt: -1 }],
    ['a fractional updatedAt', { updatedAt: 1.5 }],
    ['an unsafe updatedAt', { updatedAt: 2 ** 53 }],
    ['a string updatedAt', { updatedAt: '1' }],
    ['a deleted flag that is not a boolean', { deleted: 0 }],
    ['an iv of 16 bytes', { iv: b64(16) }],
    ['an iv in base64url', { iv: 'AAAAAAAAAAAAAAA-' }],
    ['a ciphertext of 16 bytes', { ciphertext: b64(16) }],
    ['a ciphertext that is not base64', { ciphertext: 'A'.repeat(23) }],
    ['a baseSeq on a session', { baseSeq: null }],
  ])('refuses %s', (_name, change) => {
    expect(ok([{ ...rec('session', 's', 1), ...change }])).toBe(false);
  });

  it('wants a settings record live, and a doc id of exactly 43 with a baseSeq', () => {
    expect(ok([rec('settings', 'settings', 1, { deleted: true })])).toBe(false);
    expect(ok([rec('doc', 'a'.repeat(42), 1)])).toBe(false);
    expect(ok([rec('doc', 'a'.repeat(44), 1)])).toBe(false);
    const { baseSeq: _, ...noBase } = rec('doc', docId(1), 1);
    expect(ok([noBase])).toBe(false);
    for (const baseSeq of [-1, 1.5, '1', 2 ** 53]) {
      expect(ok([rec('doc', docId(1), 1, { baseSeq: baseSeq as number })])).toBe(false);
    }
    expect(ok([rec('doc', docId(1), 1, { baseSeq: 0 })])).toBe(true);
  });

  it('refuses a body that is not exactly { records: [...] }', () => {
    for (const body of [[], {}, { records: {} }, { records: [], more: 1 }, null, 'x']) {
      expect(parseRecordsBody(body)).toBeNull();
    }
  });
});

describe('parseSince', () => {
  it('reads since, 0 when absent, and ignores every other parameter', () => {
    expect(parseSince(new URLSearchParams(''))).toBe(0);
    expect(parseSince(new URLSearchParams('since=42&path=records&limit=x&kinds=y'))).toBe(42);
    expect(parseSince(new URLSearchParams('since=0000000000000001'))).toBe(1);
    expect(parseSince(new URLSearchParams('since=-1'))).toBeNull();
  });
});
