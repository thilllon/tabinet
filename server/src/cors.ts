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
