import { Hono } from 'hono';

import { POLICY } from '../../src/constants.js';
import type { AppEnv, Deps } from './context.js';
import { requireAccount } from './middleware/auth.js';
import { readJsonBody } from './middleware/body-limit.js';
import { cors } from './middleware/cors.js';
import { answerThrown, catchNonErrors } from './middleware/errors.js';
import { requireKeyHeader } from './middleware/key-header.js';
import { notFoundOrWrongMethod, withoutAutoHead } from './middleware/unmatched.js';
import { v1Gate } from './middleware/v1-gate.js';
import { deleteAccount, me } from './routes/account.js';
import { logout, signInWithGoogle } from './routes/auth.js';
import { openKey, putKey } from './routes/keys.js';
import { getRecords, postRecords } from './routes/records.js';

/** The whole API: one web-standard handler, used in production, in dev and by the tests. */
export function createApp(deps: Deps): { fetch: (request: Request) => Promise<Response> } {
  // The exact pathname. Hono's own getPath decodes it, which would serve /v2/%6De as /v2/me.
  const app = new Hono<AppEnv>({ getPath: (request) => new URL(request.url).pathname });
  const bearer = requireAccount(deps);
  const smallBody = readJsonBody(POLICY.request.maxSmallBodyBytes);
  const recordsBody = readJsonBody(POLICY.request.maxBodyBytes);

  // Every request, in this order: cors (outermost, so every answer gets its headers and any
  // OPTIONS ends there), then the closed /v1, then the routes.
  app.use(cors(deps));
  app.use(catchNonErrors);
  app.use(v1Gate);

  // The API. Left to right is the order things run in (spec 4.1): bearer, key header, body,
  // Google, database. A path's methods appear in its Allow header in the order they are listed.
  app.post('/v2/auth/google', smallBody, signInWithGoogle(deps));
  app.post('/v2/auth/logout', bearer, logout(deps));
  app.get('/v2/me', bearer, me);
  app.post('/v2/keys/open', bearer, smallBody, openKey(deps));
  app.put('/v2/keys', bearer, smallBody, putKey(deps));
  app.get('/v2/records', bearer, requireKeyHeader, getRecords(deps));
  app.post('/v2/records', bearer, requireKeyHeader, recordsBody, postRecords(deps));
  app.delete('/v2/account', bearer, smallBody, deleteAccount(deps));

  // Everything else: 405 for a path above, otherwise 404, both without looking at the bearer.
  // It reads the routes registered so far, so it stays below them.
  app.notFound(notFoundOrWrongMethod(app.routes));
  app.onError(answerThrown);

  return { fetch: async (request) => app.fetch(withoutAutoHead(request)) };
}
