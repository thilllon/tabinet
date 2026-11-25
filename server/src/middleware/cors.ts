import type { AppMiddleware, Deps } from '../context.js';
import { noContent } from '../responses.js';

const ALLOWED_METHODS = 'GET, POST, PUT, DELETE';
const ALLOWED_HEADERS = 'Authorization, Content-Type';

/** Whether a request's Origin is one we answer with CORS headers (exact match only). */
function isAllowedOrigin(origin: string | null, allowed: readonly string[]): origin is string {
  return origin !== null && allowed.includes(origin);
}

/**
 * Adds the CORS headers for an allowed origin. Any other origin gets none, so the browser blocks
 * the response. `Vary: Origin` is always set, because the answer depends on it.
 */
export function withCors(
  response: Response,
  origin: string | null,
  allowed: readonly string[],
  preflight: boolean,
): Response {
  response.headers.append('Vary', 'Origin');
  if (!isAllowedOrigin(origin, allowed)) {
    return response;
  }
  response.headers.set('Access-Control-Allow-Origin', origin);
  if (preflight) {
    response.headers.set('Access-Control-Allow-Methods', ALLOWED_METHODS);
    response.headers.set('Access-Control-Allow-Headers', ALLOWED_HEADERS);
    response.headers.set('Access-Control-Max-Age', '600');
  }
  return response;
}

/**
 * The outermost middleware: answers every OPTIONS, whatever the path, and puts the headers on
 * every other answer, errors included. The headers are set on the response itself, because
 * assigning or setting them through the context would make Hono rebuild it.
 */
export function cors(deps: Deps): AppMiddleware {
  return async (c, next) => {
    const origin = c.req.raw.headers.get('Origin');
    if (c.req.method === 'OPTIONS') {
      return withCors(noContent(), origin, deps.allowedOrigins, true);
    }
    await next();
    withCors(c.res, origin, deps.allowedOrigins, false);
  };
}
