import type { AppContext, AppMiddleware } from '../context.js';
import { GoogleUnavailableError } from '../google-auth.js';
import { error } from '../responses.js';

/** The 503 for Google being unavailable, the 500 for anything else thrown. */
export function answerThrown(err: unknown, c: AppContext): Response {
  if (err instanceof GoogleUnavailableError) {
    console.error('tabinet-server: Google unavailable', c.req.method, err.name);
    return error(503, 'google_unavailable');
  }
  // The name only: a message or stack could carry a token, a hash or a record's ciphertext.
  console.error(
    'tabinet-server: request failed',
    c.req.method,
    err instanceof Error ? err.name : typeof err,
  );
  return error(500, 'internal');
}

// Hono gives onError only instances of Error and rethrows everything else (a string, null).
export const catchNonErrors: AppMiddleware = async (c, next) => {
  try {
    await next();
  } catch (err) {
    return answerThrown(err, c);
  }
};
