import type { AppMiddleware } from '../context.js';
import { error } from '../responses.js';
import { isKeyId } from '../validation.js';

/** The header a records request names the key it encrypted under with. */
export const KEY_HEADER = 'Tabinet-Key-Id';

/**
 * For the records routes, after the bearer and before the body: the key the request was made for
 * must be the account's, as the bearer lookup already read it, so a 409 never reads the body.
 */
export const requireKeyHeader: AppMiddleware = async (c, next) => {
  const keyId = c.req.raw.headers.get(KEY_HEADER);
  if (!isKeyId(keyId)) {
    return error(400, 'bad_request');
  }
  const { key } = c.get('account');
  if (key === null) {
    return error(409, 'key_missing');
  }
  if (key.keyId !== keyId) {
    return error(409, 'key_mismatch');
  }
  c.set('keyId', keyId);
  await next();
};
