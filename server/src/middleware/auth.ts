import type { AppMiddleware, Deps } from '../context.js';
import { error } from '../responses.js';
import { bearerToken, hashToken } from '../tokens.js';

/**
 * For a route that needs a bearer: a missing, malformed, unknown or expired one is a 401, and
 * nothing else ever is. The account it reads is what the key header is checked against.
 */
export function requireAccount(deps: Deps): AppMiddleware {
  return async (c, next) => {
    const token = bearerToken(c.req.raw.headers.get('Authorization'));
    if (token === null) {
      return error(401, 'unauthorized');
    }
    const tokenHash = hashToken(token);
    const account = await deps.store.findAccountByToken(tokenHash, deps.now());
    if (account === null) {
      return error(401, 'unauthorized');
    }
    c.set('account', account);
    c.set('tokenHash', tokenHash);
    await next();
  };
}
