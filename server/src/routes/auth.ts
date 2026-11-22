import type { AppHandler, Deps } from '../context.js';
import { error, json, noContent } from '../responses.js';
import { hashToken, mintToken, TOKEN_TTL_MS } from '../tokens.js';
import { parseAccessToken } from '../validation.js';

export function signInWithGoogle(deps: Deps): AppHandler {
  return async (c) => {
    const accessToken = parseAccessToken(c.get('body'));
    if (accessToken === null) {
      return error(400, 'bad_request');
    }
    const identity = await deps.verifyGoogleToken(accessToken);
    if (identity === null) {
      return error(401, 'unauthorized');
    }
    const user = await deps.store.upsertUser(identity.sub, identity.email);
    const token = mintToken(deps.randomBytes);
    const now = deps.now();
    const expiresAt = now + TOKEN_TTL_MS;
    await deps.store.createToken(hashToken(token), user.id, expiresAt, now);
    return json(200, { token, expiresAt, email: user.email, keySetup: user.keySetup });
  };
}

export function logout(deps: Deps): AppHandler {
  return async (c) => {
    await deps.store.deleteToken(c.get('tokenHash'));
    return noContent();
  };
}
