// Replaces fetch, so the real production deps run with no network: Neon's HTTP protocol with one
// signed-in user, and a Google that refuses every token. Imported by adaptors.test.ts and preloaded
// into the server it starts.
export const FAKE_ENV = {
  DATABASE_URL: 'postgres://user:hunter2-password@db.invalid/tabinet',
  GOOGLE_CLIENT_IDS: 'client',
  ALLOWED_ORIGINS: 'chrome-extension://bmbpmnfhfbdjdjpblimidmbohgccmjdg',
};
export const FAKE_TOKEN = 'A'.repeat(43);
/** Enough that the operating system's socket buffers cannot hold the answer to a pull. */
export const RECORD_COUNT = 24;
export const RECORD_BYTES = 1024 * 1024;

const TEXT = 25;

function rowsFor(sql: string): Record<string, string | null>[] {
  if (sql.includes('FROM auth_tokens t JOIN users')) {
    return [{ id: '1', email: 'a@example.com', key_setup: null }];
  }
  if (sql.includes('FROM records')) {
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
  const rows = rowsFor((JSON.parse(String(init?.body)) as { query: string }).query);
  return Response.json({
    command: 'SELECT',
    rowCount: rows.length,
    rowAsArray: true,
    fields: Object.keys(rows[0] ?? {}).map((name) => ({ name, dataTypeID: TEXT })),
    rows: rows.map((row) => Object.values(row)),
  });
};
