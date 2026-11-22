import { describe, expect, it } from 'vitest';

import { bearerToken, hashToken, mintToken } from '../tokens.js';

describe('tokens', () => {
  it('mints 32 random bytes as base64url', () => {
    const token = mintToken((n) => new Uint8Array(n).fill(255));
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(Buffer.from(token, 'base64url')).toHaveLength(32);
  });

  it('refuses a short random source', () => {
    expect(() => mintToken(() => new Uint8Array(8))).toThrow(RangeError);
  });

  it('hashes with sha256 into base64url, never the token itself', () => {
    const hash = hashToken('abc');
    expect(hash).toBe('ungWv48Bz-pBQUDeXa4iI7ADYaOWF3qctBD_YfIAFa0');
    expect(hash).not.toContain('abc');
  });

  it('reads a bearer token and nothing else', () => {
    expect(bearerToken('Bearer abc_-1')).toBe('abc_-1');
    expect(bearerToken(null)).toBeNull();
    expect(bearerToken('bearer abc')).toBeNull();
    expect(bearerToken('Bearer ')).toBeNull();
    expect(bearerToken('Bearer a b')).toBeNull();
    expect(bearerToken(`Bearer ${'a'.repeat(257)}`)).toBeNull();
  });
});
