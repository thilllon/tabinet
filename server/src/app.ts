import { Hono } from 'hono';

import type { AppEnv, Deps } from './context.js';
import { requireUser } from './middleware/auth.js';
import { readJsonBody } from './middleware/body-limit.js';
import { cors } from './middleware/cors.js';
import { answerThrown, catchNonErrors } from './middleware/errors.js';
import { notFoundOrWrongMethod, withoutAutoHead } from './middleware/unmatched.js';
import { deleteAccount, me } from './routes/account.js';
import { logout, signInWithGoogle } from './routes/auth.js';
import { putKeys } from './routes/keys.js';
import { getRecords, postRecords } from './routes/records.js';

/** The whole API: one web-standard handler, used in production, in dev and by the tests. */
export function createApp(deps: Deps): { fetch: (request: Request) => Promise<Response> } {
  // The exact pathname. Hono's own getPath decodes it, which would serve /v1/%6De as /v1/me.
  const app = new Hono<AppEnv>({ getPath: (request) => new URL(request.url).pathname });
  const signedIn = requireUser(deps);

  // Every request. cors is outermost, so every answer gets its headers and any OPTIONS ends there.
  app.use(cors(deps));
  app.use(catchNonErrors);

  // The API. Left to right is the order things run in: the token is checked before a body is read.
  // A path's methods appear in its Allow header in the order they are listed here.
  app.post('/v1/auth/google', readJsonBody, signInWithGoogle(deps));
  app.post('/v1/auth/logout', signedIn, logout(deps));
  app.get('/v1/me', signedIn, me);
  app.put('/v1/keys', signedIn, readJsonBody, putKeys(deps));
  app.get('/v1/records', signedIn, getRecords(deps));
  app.post('/v1/records', signedIn, readJsonBody, postRecords(deps));
  app.delete('/v1/account', signedIn, deleteAccount(deps));

  // Everything else: 405 for a path above, otherwise 404, both without looking at the token.
  // It reads the routes registered so far, so it stays below them.
  app.notFound(notFoundOrWrongMethod(app.routes));
  app.onError(answerThrown);

  return { fetch: async (request) => app.fetch(withoutAutoHead(request)) };
}
