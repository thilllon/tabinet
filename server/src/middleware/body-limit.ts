import type { AppMiddleware } from '../context.js';
import { error } from '../responses.js';
import { MAX_BODY_BYTES } from '../validation.js';

/**
 * Reads the body as JSON into `c.get('body')` (undefined when it is not JSON, which the handler's
 * parser answers with 400), or answers 413 over `MAX_BODY_BYTES`. Not Hono's bodyLimit: that one
 * trusts Content-Length when it is there, and the real byte count has to be checked too.
 */
export const readJsonBody: AppMiddleware = async (c, next) => {
  const request = c.req.raw;
  // Content-Length first, so an honest oversized request is refused without reading it.
  if (Number(request.headers.get('Content-Length') ?? 0) > MAX_BODY_BYTES) {
    return error(413, 'payload_too_large');
  }
  const text = await request.text();
  if (new TextEncoder().encode(text).length > MAX_BODY_BYTES) {
    return error(413, 'payload_too_large');
  }
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    body = undefined;
  }
  c.set('body', body);
  await next();
};
