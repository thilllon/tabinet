import { randomBytes } from 'node:crypto';

import { createApp } from './app.js';
import type { Deps } from './context.js';
import { createNeonQuery } from './db/client.js';
import { createSqlStore } from './db/store.js';
import { listFromEnv, readEnv } from './env.js';
import { createGoogleVerifier } from './google-auth.js';
import { withCors } from './middleware/cors.js';
import { error } from './responses.js';

/** The real dependencies: Neon over HTTP, Google's keys, the clock and the system's random bytes. */
export function createProductionDeps(env: NodeJS.ProcessEnv = process.env): Deps {
  const { databaseUrl, googleClientIds, allowedOrigins } = readEnv(env);
  return {
    store: createSqlStore(createNeonQuery(databaseUrl)),
    verifyGoogleToken: createGoogleVerifier({ clientIds: googleClientIds }),
    now: () => Date.now(),
    randomBytes: (size) => new Uint8Array(randomBytes(size)),
    allowedOrigins,
  };
}

/**
 * The function's handler. It builds the app on first use, not at import, so a bad environment
 * fails each request with a 500 instead of the cold start, and is tried again on the next one.
 */
export function createServer(
  build: () => Deps = createProductionDeps,
  env: NodeJS.ProcessEnv = process.env,
): (request: Request) => Promise<Response> {
  let app: ReturnType<typeof createApp> | undefined;
  return async (request) => {
    try {
      app ??= createApp(build());
    } catch (err) {
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
    return app.fetch(request);
  };
}
