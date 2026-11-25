import { POLICY } from '../../src/constants.js';
import type { GoogleIdentity } from './types.js';

/** Google's token information endpoint. The token goes in a POST body, never in this URL. */
export const GOOGLE_TOKENINFO_URL = 'https://oauth2.googleapis.com/tokeninfo';

/**
 * Google could not say whether it accepts the token: a timeout, a network failure, or an answer
 * that says nothing about the token (408, 429, a 5xx, something other than JSON). The route
 * answers 503 `google_unavailable`, never a refusal. The message never holds the token.
 */
export class GoogleUnavailableError extends Error {
  override name = 'GoogleUnavailableError';
}

/** The statuses tokeninfo answers for a token it does not accept (invalid, expired, revoked). */
const TOKEN_REFUSED_STATUSES: ReadonlySet<number> = new Set([400, 401]);

/** The identity Google vouches for, null when it refuses the token; throws `GoogleUnavailableError`. */
export type VerifyGoogleToken = (accessToken: string) => Promise<GoogleIdentity | null>;

function nonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value !== '';
}

/**
 * Whether the token was issued to one of our OAuth clients. Google's answer for an access token
 * carries `aud` (the client the token is for) and usually `azp` (the client that asked for it);
 * for a Chrome extension client both are its client id. When `aud` is there it must be ours, even
 * if `azp` is: a token minted for another app's audience is refused whoever requested it. Only
 * when `aud` is absent does `azp` decide. Either way a token another app obtained for the same
 * Google account is refused, which is the point: without this check any site the person signed
 * in to with Google could replay its own access token here and act as them.
 */
export function issuedToUs(info: Record<string, unknown>, clientIds: readonly string[]): boolean {
  if (info.aud !== undefined) {
    return nonEmptyString(info.aud) && clientIds.includes(info.aud);
  }
  return nonEmptyString(info.azp) && clientIds.includes(info.azp);
}

/**
 * The identity in a tokeninfo answer, or null when it does not vouch for a live token issued to
 * one of our clients with a verified email. Pure.
 */
export function identityFromTokenInfo(
  info: unknown,
  clientIds: readonly string[],
): GoogleIdentity | null {
  if (typeof info !== 'object' || info === null || Array.isArray(info)) {
    return null;
  }
  const record = info as Record<string, unknown>;
  const verified = record.email_verified === true || record.email_verified === 'true';
  const expiresIn =
    typeof record.expires_in === 'number' ? record.expires_in : Number(record.expires_in);
  if (
    !issuedToUs(record, clientIds) ||
    !verified ||
    !nonEmptyString(record.email) ||
    !nonEmptyString(record.sub) ||
    !Number.isFinite(expiresIn) ||
    expiresIn <= 0
  ) {
    return null;
  }
  return { sub: record.sub, email: record.email };
}

/**
 * Verifies a Google OAuth access token by asking Google about it (the tokeninfo endpoint, the
 * token in a form body). Returns null for a token Google refuses (400 or 401, its answers for an
 * invalid or expired token) or one that fails `identityFromTokenInfo()`. Anything else throws
 * `GoogleUnavailableError`, a 503 rather than a false refusal: a failure to reach Google, a
 * timeout after `POLICY.request.googleTimeoutMs`, a 5xx, other 4xx such as 429 (rate limited) or
 * 408, which say nothing about the token, and an answer that is not JSON. The token is never
 * logged. Building one with no client id throws, because that is a configuration error (a 500 from
 * `createServer()`), not a refused sign-in.
 */
export function createGoogleVerifier(options: {
  clientIds: readonly string[];
  fetch?: typeof fetch;
  timeoutMs?: number;
}): VerifyGoogleToken {
  const clientIds = [...options.clientIds];
  if (clientIds.length === 0) {
    throw new Error('No Google OAuth client id configured');
  }
  const send = options.fetch ?? fetch;
  const timeoutMs = options.timeoutMs ?? POLICY.request.googleTimeoutMs;
  return async (accessToken) => {
    let response: Response;
    try {
      response = await send(GOOGLE_TOKENINFO_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ access_token: accessToken }).toString(),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch {
      // Not the cause: a network error's text is not ours to vouch for.
      throw new GoogleUnavailableError('Google tokeninfo could not be reached');
    }
    if (response.status !== 200) {
      // Release the connection: an unread body holds it until garbage collection.
      await response.body?.cancel().catch(() => undefined);
      if (TOKEN_REFUSED_STATUSES.has(response.status)) {
        return null;
      }
      throw new GoogleUnavailableError(`Google tokeninfo answered HTTP ${response.status}`);
    }
    let info: unknown;
    try {
      info = await response.json();
    } catch {
      throw new GoogleUnavailableError('Google tokeninfo answered with something other than JSON');
    }
    return identityFromTokenInfo(info, clientIds);
  };
}

/**
 * Whether the access token is a live Google token of this account: `refused` when Google does not
 * vouch for it, `mismatch` when it is another Google account's. Throws what the verifier throws.
 */
export async function verifySameAccount(
  verify: VerifyGoogleToken,
  accessToken: string,
  googleSub: string,
): Promise<GoogleIdentity | 'refused' | 'mismatch'> {
  const identity = await verify(accessToken);
  if (identity === null) {
    return 'refused';
  }
  return identity.sub === googleSub ? identity : 'mismatch';
}
