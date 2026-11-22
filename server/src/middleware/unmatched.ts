import type { NotFoundHandler } from 'hono';
import type { RouterRoute } from 'hono/types';

import type { AppEnv } from '../context.js';
import { error } from '../responses.js';

/**
 * The answer when no route matched: 405 with `Allow` for a known path, otherwise 404. `Allow` is
 * built from the routes themselves, so there is no second table of methods to keep in step.
 */
export function notFoundOrWrongMethod(routes: readonly RouterRoute[]): NotFoundHandler<AppEnv> {
  const methodsByPath = new Map<string, Set<string>>();
  for (const { method, path } of routes) {
    // ALL is the middleware from app.use(). A route has one entry per handler, hence the Set.
    if (method !== 'ALL') {
      methodsByPath.set(path, (methodsByPath.get(path) ?? new Set()).add(method));
    }
  }
  return (c) => {
    const methods = methodsByPath.get(c.req.path);
    if (methods === undefined) {
      return error(404, 'not_found');
    }
    const response = error(405, 'method_not_allowed');
    response.headers.set('Allow', [...methods].join(', '));
    return response;
  };
}

/**
 * Hono runs a HEAD as the GET route, before any middleware could refuse it. This API has no HEAD,
 * so it is passed on as a method no route has, and ends as a 405 (or a 404) like any other.
 */
export function withoutAutoHead(request: Request): Request {
  return request.method === 'HEAD' ? new Request(request, { method: 'HEAD-NOT-SERVED' }) : request;
}
