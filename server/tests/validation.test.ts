import { describe, expect, it } from 'vitest';

import {
  base64Bytes,
  parseKeySetup,
  parseRecordsBody,
  parseRecordsQuery,
} from '../src/validation.js';
import { b64, sessionRecord, tombstone, validKeySetup } from './helpers.js';

describe('base64Bytes', () => {
  it('counts decoded bytes and refuses anything that is not padded base64', () => {
    expect(base64Bytes('')).toBe(0);
    expect(base64Bytes(b64(16))).toBe(16);
    expect(base64Bytes(b64(17))).toBe(17);
    expect(base64Bytes(b64(18))).toBe(18);
    for (const bad of ['abc', 'ab-_', 'a===', '====', 'AA=A', 5, null]) {
      expect(base64Bytes(bad)).toBeNull();
    }
  });
});

describe('parseKeySetup', () => {
  it('accepts a valid setup', () => {
    expect(parseKeySetup(validKeySetup())).toEqual(validKeySetup());
  });

  it.each([
    ['iterations below 100000', { iterations: 99_999 }],
    ['iterations above 10000000', { iterations: 10_000_001 }],
    ['fractional iterations', { iterations: 100_000.5 }],
    ['another kdf', { name: 'scrypt' }],
    ['another hash', { hash: 'SHA-1' }],
  ])('refuses %s', (_name, kdf) => {
    const setup = validKeySetup();
    expect(parseKeySetup({ ...setup, kdf: { ...setup.kdf, ...kdf } })).toBeNull();
  });

  it('accepts iterations at both bounds', () => {
    for (const iterations of [100_000, 10_000_000]) {
      const setup = validKeySetup();
      expect(parseKeySetup({ ...setup, kdf: { ...setup.kdf, iterations } })).not.toBeNull();
    }
  });

  it('wants a salt of 16 to 64 bytes', () => {
    expect(parseKeySetup({ ...validKeySetup(), salt: b64(15) })).toBeNull();
    expect(parseKeySetup({ ...validKeySetup(), salt: b64(16) })).not.toBeNull();
    expect(parseKeySetup({ ...validKeySetup(), salt: b64(64) })).not.toBeNull();
    expect(parseKeySetup({ ...validKeySetup(), salt: b64(65) })).toBeNull();
  });

  it('refuses missing, extra or mistyped fields', () => {
    const { check: _check, ...missing } = validKeySetup();
    expect(parseKeySetup(missing)).toBeNull();
    expect(parseKeySetup({ ...validKeySetup(), extra: 1 })).toBeNull();
    expect(parseKeySetup({ ...validKeySetup(), checkIv: 'not base64!' })).toBeNull();
    expect(parseKeySetup({ ...validKeySetup(), check: '' })).toBeNull();
    expect(parseKeySetup(null)).toBeNull();
    expect(parseKeySetup([])).toBeNull();
  });
});

describe('parseRecordsBody', () => {
  it('accepts records and tombstones', () => {
    const records = [sessionRecord('a', 1), tombstone('b', 2)];
    expect(parseRecordsBody({ records })).toEqual(records);
  });

  it('checks the id pattern', () => {
    for (const id of ['A-z_0', 'x'.repeat(64)]) {
      expect(parseRecordsBody({ records: [sessionRecord(id, 1)] })).not.toBeNull();
    }
    for (const id of ['', 'x'.repeat(65), 'a b', 'a/b', 'a.b', 'é']) {
      expect(parseRecordsBody({ records: [sessionRecord(id, 1)] })).toBeNull();
    }
  });

  it('refuses an unknown kind', () => {
    for (const kind of ['history', 'Session', 'images', '', 1]) {
      expect(parseRecordsBody({ records: [{ ...sessionRecord('a', 1), kind }] })).toBeNull();
    }
    for (const kind of ['settings', 'notes', 'image']) {
      expect(parseRecordsBody({ records: [{ ...sessionRecord('a', 1), kind }] })).not.toBeNull();
    }
  });

  it('wants updatedAt to be a non-negative safe integer', () => {
    for (const updatedAt of [-1, 1.5, '1', Number.MAX_SAFE_INTEGER + 1, null]) {
      expect(parseRecordsBody({ records: [{ ...sessionRecord('a', 1), updatedAt }] })).toBeNull();
    }
  });

  it('wants a tombstone to carry an iv and a ciphertext like a live record', () => {
    for (const patch of [
      { iv: '', ciphertext: '' },
      { iv: '' },
      { ciphertext: '' },
      { iv: b64(11) },
      { ciphertext: 'not base64' },
      { ciphertext: 'A'.repeat(1024 * 1024 + 4) },
    ]) {
      expect(parseRecordsBody({ records: [{ ...tombstone('a', 1), ...patch }] })).toBeNull();
    }
  });

  it('wants a live record to carry an iv and a non-empty base64 ciphertext', () => {
    for (const patch of [
      { iv: '' },
      { iv: b64(11) },
      { iv: b64(33) },
      { ciphertext: '' },
      { ciphertext: 'not base64' },
      { deleted: 'false' },
    ]) {
      expect(parseRecordsBody({ records: [{ ...sessionRecord('a', 1), ...patch }] })).toBeNull();
    }
  });

  it('caps a request at 100 records and a ciphertext at 1 MiB of base64', () => {
    const many = (n: number) => Array.from({ length: n }, (_, i) => sessionRecord(`r${i}`, 1));
    expect(parseRecordsBody({ records: many(100) })).toHaveLength(100);
    expect(parseRecordsBody({ records: many(101) })).toBeNull();
    const at = 'A'.repeat(1024 * 1024);
    expect(
      parseRecordsBody({ records: [{ ...sessionRecord('a', 1), ciphertext: at }] }),
    ).not.toBeNull();
    expect(
      parseRecordsBody({ records: [{ ...sessionRecord('a', 1), ciphertext: `${at}AAAA` }] }),
    ).toBeNull();
  });

  it('refuses extra fields on a record and on the body', () => {
    expect(parseRecordsBody({ records: [{ ...sessionRecord('a', 1), seq: 4 }] })).toBeNull();
    expect(parseRecordsBody({ records: [], more: true })).toBeNull();
  });
});

describe('parseRecordsQuery', () => {
  it('defaults since to 0 and limit to 500', () => {
    expect(parseRecordsQuery(new URLSearchParams())).toEqual({
      since: 0,
      limit: 500,
      kinds: ['session', 'settings'],
    });
  });

  it('lists only the kinds every client version knows unless asked for more', () => {
    expect(parseRecordsQuery(new URLSearchParams('kinds=session,settings,notes,image'))).toEqual({
      since: 0,
      limit: 500,
      kinds: ['session', 'settings', 'notes', 'image'],
    });
    expect(parseRecordsQuery(new URLSearchParams('kinds=image'))?.kinds).toEqual(['image']);
  });

  it('reads both', () => {
    expect(parseRecordsQuery(new URLSearchParams('since=12&limit=3'))).toEqual({
      since: 12,
      limit: 3,
      kinds: ['session', 'settings'],
    });
  });

  it.each([
    'since=-1',
    'since=x',
    'since=1e3',
    'limit=0',
    'limit=501',
    'limit=',
    'since=99999999999999999',
    'kinds=',
    'kinds=history',
    'kinds=notes,notes',
    'kinds=notes,',
    'kinds=Notes',
  ])('refuses %s', (search) => {
    expect(parseRecordsQuery(new URLSearchParams(search))).toBeNull();
  });
});
