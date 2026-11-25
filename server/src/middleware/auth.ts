import type { AppMiddleware, Deps } from '../context.js';
import { error } from '../responses.js';
import { bearerToken, hashToken } from '../tokens.js';

/** For a route that needs a signed-in caller: a missing, unknown or expired token is a 401. */
export function requireUser(deps: Deps): AppMiddleware {
  return async (c, next) => {
    const token = bearerToken(c.req.raw.headers.get('Authorization'));
    if (token === null) {
      return error(401, 'unauthorized');
    }
    const tokenHash = hashToken(token);
    const user = await deps.store.findUserByToken(tokenHash, deps.now());
    if (user === null) {
      return error(401, 'unauthorized');
    }
    c.set('user', user);
    c.set('tokenHash', tokenHash);
    await next();
  };
}
