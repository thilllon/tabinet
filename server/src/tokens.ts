import { createHash } from 'node:crypto';

const TOKEN_BYTES = 32;

/** A new bearer token: 32 random bytes, base64url. Only its hash is ever stored. */
export function mintToken(randomBytes: (size: number) => Uint8Array): string {
  const bytes = randomBytes(TOKEN_BYTES);
  if (bytes.length !== TOKEN_BYTES) {
    throw new RangeError('randomBytes returned the wrong number of bytes');
  }
  return Buffer.from(bytes).toString('base64url');
}

/** The key a token is stored under: sha256 of the token text, base64url. */
export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('base64url');
}

/** The token from an `Authorization: Bearer <token>` header, or null. */
export function bearerToken(header: string | null): string | null {
  const match = /^Bearer ([A-Za-z0-9_-]{1,256})$/.exec(header ?? '');
  return match ? match[1] : null;
}
