import { randomBytes } from 'node:crypto';

import { createApp } from './app.js';
import type { Deps } from './context.js';
import { createNeonQuery } from './db/client.js';
import { createSqlStore, type Query } from './db/store.js';
import { listFromEnv, readEnv } from './env.js';
import { importKeyEncryptionKey } from './envelope.js';
import { createGoogleVerifier } from './google-auth.js';
import { withCors } from './middleware/cors.js';
import { error } from './responses.js';

/** What tests replace; production uses the defaults. */
export interface ProductionOptions {
  createQuery?: (databaseUrl: string) => Query;
  /** The id the key encryption key must have; `PINNED_KEY_ENCRYPTION_KEY_ID` by default. */
  pinnedKeyEncryptionKeyId?: string;
}

/**
 * The real dependencies: Neon over HTTP, Google's tokeninfo, the key encryption key, the clock and the system's
 * random bytes. The production check (`readEnv()`) runs first, before any client exists, so a
 * preview or an unpinned key encryption key never reaches the database.
 */
export async function createProductionDeps(
  env: NodeJS.ProcessEnv = process.env,
  options: ProductionOptions = {},
): Promise<Deps> {
  const config =
    options.pinnedKeyEncryptionKeyId === undefined
      ? readEnv(env)
      : readEnv(env, options.pinnedKeyEncryptionKeyId);
  const keyEncryptionKey = await importKeyEncryptionKey(config.keyEncryptionKey);
  config.keyEncryptionKey.fill(0);
  const verifyGoogleToken = createGoogleVerifier({ clientIds: config.googleClientIds });
  const createQuery = options.createQuery ?? createNeonQuery;
  return {
    store: createSqlStore(createQuery(config.databaseUrl)),
    verifyGoogleToken,
    keyEncryptionKey,
    now: () => Date.now(),
    randomBytes: (size) => new Uint8Array(randomBytes(size)),
    allowedOrigins: config.allowedOrigins,
  };
}

/**
 * The function's handler. It builds the app on first use, not at import, so a refused
 * configuration answers every request (OPTIONS and /v1 too) with a 500 and no query at all, and
 * is tried again on the next request.
 */
export function createServer(
  build: () => Deps | Promise<Deps> = () => createProductionDeps(),
  env: NodeJS.ProcessEnv = process.env,
): (request: Request) => Promise<Response> {
  let app: Promise<ReturnType<typeof createApp>> | undefined;
  return async (request) => {
    let ready: ReturnType<typeof createApp>;
    try {
      app ??= Promise.resolve().then(async () => createApp(await build()));
      ready = await app;
    } catch (err) {
      app = undefined;
      // The name only, as in answerThrown(): a configuration error can quote a secret it was given.
      console.error(
        'tabinet-server: configuration failed',
        err instanceof Error ? err.name : typeof err,
      );
      // There is no app to run the cors middleware, so the headers are added here.
      return withCors(
        error(500, 'internal'),
        request.headers.get('Origin'),
        listFromEnv(env.ALLOWED_ORIGINS),
        false,
      );
    }
    return ready.fetch(request);
  };
}
