import type { AppContext, AppMiddleware } from '../context.js';
import { error } from '../responses.js';

/** The 500 for anything thrown. */
export function answerThrown(err: unknown, c: AppContext): Response {
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
