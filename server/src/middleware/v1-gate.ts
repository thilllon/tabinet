import type { AppMiddleware } from '../context.js';
import { error } from '../responses.js';
import { NO_AUTO_HEAD } from './unmatched.js';

/**
 * Protocol v1 is closed: `/v1` and everything under it, every method but OPTIONS (which the cors
 * middleware has answered already), is 410 before a bearer, a body or the database is looked at.
 * A HEAD gets its 410 without a body.
 */
export const v1Gate: AppMiddleware = async (c, next) => {
  const { pathname } = new URL(c.req.url);
  if (pathname === '/v1' || pathname.startsWith('/v1/')) {
    return error(410, 'upgrade_required', c.req.method !== NO_AUTO_HEAD);
  }
  await next();
};
