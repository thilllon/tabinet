import { POLICY } from '../../../src/constants.js';
import type { AppHandler, Deps } from '../context.js';
import { error, json, noContent } from '../responses.js';
import { hashToken, mintToken } from '../tokens.js';
import { parseAccessToken } from '../validation.js';

/** `POST /v2/auth/google`: a bearer for the Google account. Never an envelope, never the KEK. */
export function signInWithGoogle(deps: Deps): AppHandler {
  return async (c) => {
    const accessToken = parseAccessToken(c.get('body'));
    if (accessToken === null) {
      return error(400, 'bad_request');
    }
    const identity = await deps.verifyGoogleToken(accessToken);
    if (identity === null) {
      return error(403, 'google_refused');
    }
    const token = mintToken(deps.randomBytes);
    const now = deps.now();
    const expiresAt = now + POLICY.signIn.tokenLifetimeMs;
    const account = await deps.store.signIn(
      identity.sub,
      identity.email,
      hashToken(token),
      expiresAt,
      now,
    );
    return json(200, {
      token,
      expiresAt,
      accountId: account.id,
      email: account.email,
      key: account.key,
    });
  };
}

/** `POST /v2/auth/logout`: forgets the presented bearer and no other. */
export function logout(deps: Deps): AppHandler {
  return async (c) => {
    await deps.store.deleteToken(c.get('tokenHash'));
    return noContent();
  };
}
