// Environment parsing. An error names the variable and never quotes its value.
import { KEK_BYTES, kekIdOfSync } from './envelope.js';
import { PINNED_KEK_ID } from './kek-id.js';
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
  /** The raw KEK, checked against the pinned id. */
  kek: Uint8Array;
}

/**
 * What production needs from the environment, after the production check: Vercel Production, a
 * pinned KEK id, and `TABINET_KEK` being exactly that key. The check runs first and always, with no
 * "only on Vercel" branch (a missing system variable must not skip it), so a preview, a local run
 * or the Railway adaptor never gets as far as a database client. `pinnedKekId` is for tests.
 */
export function readEnv(
  env: NodeJS.ProcessEnv,
  pinnedKekId: string = PINNED_KEK_ID,
): ProductionEnv {
  if (env.VERCEL_ENV !== 'production') {
    throw new Error('Refusing to run: VERCEL_ENV is not production');
  }
  if (pinnedKekId === '') {
    throw new Error('Refusing to run: no KEK id is pinned in kek-id.ts');
  }
  const kek = decodeBase64(requireEnv(env, 'TABINET_KEK'));
  if (kek === null || kek.length !== KEK_BYTES) {
    throw new Error('Environment variable TABINET_KEK is not base64 of 32 bytes');
  }
  if (kekIdOfSync(kek) !== pinnedKekId) {
    throw new Error('Environment variable TABINET_KEK is not the pinned KEK');
  }
  return {
    databaseUrl: requireUrl(env, 'DATABASE_URL'),
    googleClientIds: listFromEnv(requireEnv(env, 'GOOGLE_CLIENT_IDS')),
    allowedOrigins: listFromEnv(env.ALLOWED_ORIGINS),
    kek,
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
