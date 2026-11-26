// Replaces fetch, so the real production deps run with no network: Neon's HTTP protocol with one
// signed-in account that has a key, and a Google that refuses every token. Imported by
// adaptors.test.ts and preloaded into the server it starts, where it also pins the test key encryption key's id
// in place of the empty PINNED_KEY_ENCRYPTION_KEY_ID (a loader hook), so the production check passes there.
import { register } from 'node:module';

import { keyEncryptionKeyIdOfSync } from '../envelope.js';

const FAKE_KEY_ENCRYPTION_KEY = new Uint8Array(32).fill(0x5a);
/** The id the fake environment's key encryption key has, pinned in the tests in place of `PINNED_KEY_ENCRYPTION_KEY_ID`. */
export const FAKE_KEY_ENCRYPTION_KEY_ID = keyEncryptionKeyIdOfSync(FAKE_KEY_ENCRYPTION_KEY);

export const FAKE_ENV = {
  VERCEL_ENV: 'production',
  TABINET_KEY_ENCRYPTION_KEY: Buffer.from(FAKE_KEY_ENCRYPTION_KEY).toString('base64'),
  DATABASE_URL: 'postgres://user:hunter2-password@db.invalid/tabinet',
  GOOGLE_CLIENT_IDS: 'client',
  ALLOWED_ORIGINS: 'chrome-extension://bmbpmnfhfbdjdjpblimidmbohgccmjdg',
};
export const FAKE_TOKEN = 'A'.repeat(43);
export const FAKE_KEY_ID = 'AAAAAAAAAAAAAAAAAAAAAA';
/** Enough that the operating system's socket buffers cannot hold the answer to a pull. */
export const RECORD_COUNT = 24;
export const RECORD_BYTES = 1024 * 1024;

const TEXT = 25;

function rowsFor(sql: string, params: unknown[]): Record<string, string | null>[] {
  if (sql.includes('FROM account_tokens t JOIN accounts a')) {
    return [
      {
        id: '1',
        google_sub: 'sub',
        email: 'a@example.com',
        key_id: FAKE_KEY_ID,
        key_generation: '1',
        storage_bytes: '0',
        screenshots: '0',
      },
    ];
  }
  if (sql.includes('SELECT last_seq')) {
    return [{ last_seq: String(RECORD_COUNT), storage_bytes: '0', screenshots: '0' }];
  }
  if (sql.includes('WITH account AS')) {
    // One batch of everything from the start, then the one row of nulls that means "no more".
    if (String(params[2]) !== '0') {
      return [
        {
          kind: null,
          id: null,
          updated_at: null,
          deleted: null,
          iv: null,
          ciphertext: null,
          seq: null,
        },
      ];
    }
    return Array.from({ length: RECORD_COUNT }, (_, i) => ({
      kind: 'session',
      id: `s${i}`,
      updated_at: '1',
      deleted: 'f',
      iv: 'AAAAAAAAAAAAAAAA',
      ciphertext: 'A'.repeat(RECORD_BYTES),
      seq: String(i + 1),
    }));
  }
  return [];
}

globalThis.fetch = async (input, init) => {
  const url = String(input);
  if (new URL(url).hostname === 'oauth2.googleapis.com') {
    return new Response('{}', { status: 400 });
  }
  if (!new URL(url).hostname.endsWith('.invalid')) {
    throw new Error('The tests have no network');
  }
  const { query, params } = JSON.parse(String(init?.body)) as { query: string; params: unknown[] };
  const rows = rowsFor(query, params ?? []);
  return Response.json({
    command: 'SELECT',
    rowCount: rows.length,
    rowAsArray: true,
    fields: Object.keys(rows[0] ?? {}).map((name) => ({ name, dataTypeID: TEXT })),
    rows: rows.map((row) => Object.values(row)),
  });
};

// In the server process only (vitest mocks the module itself): key-encryption-key-id.js becomes the fake pin.
if (process.env.VITEST === undefined) {
  const pinned = `export const PINNED_KEY_ENCRYPTION_KEY_ID = ${JSON.stringify(FAKE_KEY_ENCRYPTION_KEY_ID)};`;
  const hooks = `
    export async function resolve(specifier, context, next) {
      if (/(^|\\/)key-encryption-key-id\\.(js|ts)$/.test(specifier)) {
        return { url: ${JSON.stringify(`data:text/javascript,${encodeURIComponent(pinned)}`)}, shortCircuit: true };
      }
      return next(specifier, context);
    }`;
  register(`data:text/javascript,${encodeURIComponent(hooks)}`);
}
