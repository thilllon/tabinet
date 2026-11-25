import type { AppHandler, Deps } from '../context.js';
import { error, json, noContent } from '../responses.js';
import { parseAccessToken } from '../validation.js';
import { sameAccount } from './keys.js';

/** `GET /v2/me`: what the bearer lookup read. */
export const me: AppHandler = (c) => {
  const { id, email, key, usage } = c.get('account');
  return json(200, { accountId: id, email, key, usage });
};

/**
 * `DELETE /v2/account`: needs a live Google token of the account, so a bearer alone deletes
 * nothing. Bearers and records go with it by cascade. No KEK use.
 */
export function deleteAccount(deps: Deps): AppHandler {
  return async (c) => {
    const accessToken = parseAccessToken(c.get('body'));
    if (accessToken === null) {
      return error(400, 'bad_request');
    }
    const account = c.get('account');
    const identity = await sameAccount(deps, accessToken, account.googleSub);
    if (identity instanceof Response) {
      return identity;
    }
    await deps.store.deleteAccount(account.id, identity.sub);
    return noContent();
  };
}
