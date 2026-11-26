// Environment parsing. An error names the variable and never quotes its value.
import { KEY_ENCRYPTION_KEY_BYTES, keyEncryptionKeyIdOfSync } from './envelope.js';
import { PINNED_KEY_ENCRYPTION_KEY_ID } from './key-encryption-key-id.js';
import { decodeBase64 } from './validation.js';

/** A comma-separated environment variable as a list, blanks dropped. */
export function listFromEnv(value: string | undefined): string[] {
  return (value ?? '')
    .split(',')
    .map((item) => item.trim())
    .filter((item) => item !== '');
}

function requireEnv(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name];
  if (value === undefined || value === '') {
    throw new Error(`Missing environment variable ${name}`);
  }
  return value;
}

// neon() puts the whole connection string, password included, into the message of the error it
// throws for one it cannot parse. Check it here first and name only the variable.
function requireUrl(env: NodeJS.ProcessEnv, name: string): string {
  const value = requireEnv(env, name);
  if (!URL.canParse(value)) {
    throw new Error(`Environment variable ${name} is not a valid URL`);
  }
  return value;
}

/** What production runs with. */
export interface ProductionEnv {
  databaseUrl: string;
  googleClientIds: string[];
  allowedOrigins: string[];
  /** The raw key encryption key, checked against the pinned id. */
  keyEncryptionKey: Uint8Array;
}

/**
 * What production needs from the environment, after the production check: Vercel Production, a
 * pinned key encryption key id, and `TABINET_KEY_ENCRYPTION_KEY` being exactly that key. The check runs first and always, with no
 * "only on Vercel" branch (a missing system variable must not skip it), so a preview, a local run
 * or the Railway adaptor never gets as far as a database client. `pinnedKeyEncryptionKeyId` is for tests.
 */
export function readEnv(
  env: NodeJS.ProcessEnv,
  pinnedKeyEncryptionKeyId: string = PINNED_KEY_ENCRYPTION_KEY_ID,
): ProductionEnv {
  if (env.VERCEL_ENV !== 'production') {
    throw new Error('Refusing to run: VERCEL_ENV is not production');
  }
  if (pinnedKeyEncryptionKeyId === '') {
    throw new Error(
      'Refusing to run: no key encryption key id is pinned in key-encryption-key-id.ts',
    );
  }
  const keyEncryptionKey = decodeBase64(requireEnv(env, 'TABINET_KEY_ENCRYPTION_KEY'));
  if (keyEncryptionKey === null || keyEncryptionKey.length !== KEY_ENCRYPTION_KEY_BYTES) {
    throw new Error('Environment variable TABINET_KEY_ENCRYPTION_KEY is not base64 of 32 bytes');
  }
  if (keyEncryptionKeyIdOfSync(keyEncryptionKey) !== pinnedKeyEncryptionKeyId) {
    throw new Error(
      'Environment variable TABINET_KEY_ENCRYPTION_KEY is not the pinned key encryption key',
    );
  }
  return {
    databaseUrl: requireUrl(env, 'DATABASE_URL'),
    googleClientIds: listFromEnv(requireEnv(env, 'GOOGLE_CLIENT_IDS')),
    allowedOrigins: listFromEnv(env.ALLOWED_ORIGINS),
    keyEncryptionKey,
  };
}

/** The port Railway gives the server in PORT. Vercel has none, so `readEnv()` does not ask for it. */
export function readPort(env: NodeJS.ProcessEnv): number {
  const value = requireEnv(env, 'PORT');
  if (!/^\d+$/.test(value) || Number(value) > 65_535) {
    throw new Error('Environment variable PORT is not a port');
  }
  return Number(value);
}
