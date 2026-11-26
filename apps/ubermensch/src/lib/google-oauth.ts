import { GOOGLE_OAUTH } from '@/constants';
import { type FetchLike, getAccountEmail } from '@/lib/drive-api';
import { accountKey, saveToken, tokenKeysFor } from '@/lib/token-store';
import type { AccountHint, StoredToken } from '@/types';

/**
 * Sign-in with Google's implicit token flow in `chrome.identity.launchWebAuthFlow`, never
 * `getAuthToken` (which is bound to the Chrome profile's account): the page's own account is
 * passed as `login_hint`, so a `/u/1/` document asks for the second account. Only ever started by
 * a click; the token is kept in `chrome.storage.session` (src/lib/token-store.ts).
 */

export interface OAuthConfig {
  clientId: string;
  scopes: readonly string[];
}

let configOverride: (() => OAuthConfig) | undefined;

/** The OAuth client in use: `GOOGLE_OAUTH`, or what a test set. */
export function oauthConfig(): OAuthConfig {
  return configOverride?.() ?? GOOGLE_OAUTH;
}

/** For tests: point sign-in at another client (or at an empty one); no argument restores it. */
export function overrideOAuthConfig(getter?: () => OAuthConfig): void {
  configOverride = getter;
}

/** Whether this build can sign in at all (a client id is set). */
export function isSignInConfigured(): boolean {
  return oauthConfig().clientId.trim() !== '';
}

export type AuthFailure = 'cancelled' | 'denied' | 'state' | 'malformed';

export class AuthError extends Error {
  readonly reason: AuthFailure;
  constructor(reason: AuthFailure) {
    super(`Sign-in failed: ${reason}`);
    this.name = 'AuthError';
    this.reason = reason;
  }
}

export interface AuthRequest {
  clientId: string;
  redirectUri: string;
  scopes: readonly string[];
  state: string;
  hint: AccountHint;
}

/** Google's authorization address for an implicit-flow token. */
export function buildAuthUrl(request: AuthRequest): string {
  const params = new URLSearchParams({
    client_id: request.clientId,
    response_type: 'token',
    redirect_uri: request.redirectUri,
    scope: request.scopes.join(' '),
    state: request.state,
    include_granted_scopes: 'true',
  });
  const email = request.hint.email?.trim();
  if (email !== undefined && email !== '') {
    params.set('login_hint', email);
  } else if (request.hint.index !== undefined) {
    // Without an address, the account index is the hint Google's sign-in pages read themselves.
    params.set('authuser', String(request.hint.index));
  }
  return `https://accounts.google.com/o/oauth2/v2/auth?${params}`;
}

/** The token in the redirect Google sent back, checked against the `state` that was sent. */
export function parseAuthRedirect(
  redirect: string,
  expectedState: string,
  now: number,
): { accessToken: string; expiresAt: number } {
  let url: URL;
  try {
    url = new URL(redirect);
  } catch {
    throw new AuthError('malformed');
  }
  const params = new URLSearchParams(url.hash.replace(/^#/, ''));
  const error = params.get('error') ?? url.searchParams.get('error');
  if (error !== null) {
    throw new AuthError(error === 'access_denied' ? 'denied' : 'malformed');
  }
  if (params.get('state') !== expectedState) {
    throw new AuthError('state');
  }
  const accessToken = params.get('access_token');
  const expiresIn = Number(params.get('expires_in'));
  if (accessToken === null || accessToken === '' || !Number.isFinite(expiresIn) || expiresIn <= 0) {
    throw new AuthError('malformed');
  }
  return { accessToken, expiresAt: now + expiresIn * 1000 };
}

/** Chrome's wording when the person closed the sign-in window. */
export function isCancelledFlow(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return /did not approve|user cancel|closed by the user/i.test(message);
}

function randomState(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

export type SignInResult =
  | { outcome: 'signed-in'; token: StoredToken; account: string }
  | { outcome: 'wrong-account'; token: StoredToken };

/**
 * Opens Google's sign-in for the account in `hint`, reads which address the token belongs to and
 * stores it. A token for another address than the page's is still stored (under that address) but
 * reported as `wrong-account`, so the page never shows another account's folders.
 */
export async function signIn(
  hint: AccountHint,
  fetchImpl: FetchLike,
  now: () => number,
): Promise<SignInResult> {
  const config = oauthConfig();
  const state = randomState();
  const url = buildAuthUrl({
    clientId: config.clientId,
    redirectUri: chrome.identity.getRedirectURL(),
    scopes: config.scopes,
    state,
    hint,
  });
  let redirect: string | undefined;
  try {
    redirect = await chrome.identity.launchWebAuthFlow({ url, interactive: true });
  } catch (err) {
    throw new AuthError(isCancelledFlow(err) ? 'cancelled' : 'denied');
  }
  if (redirect === undefined) {
    throw new AuthError('cancelled');
  }
  const { accessToken, expiresAt } = parseAuthRedirect(redirect, state, now());
  const email = await getAccountEmail(accessToken, fetchImpl);
  const token: StoredToken = { accessToken, expiresAt, email };
  const wanted = hint.email?.trim().toLowerCase();
  if (wanted !== undefined && wanted !== '' && wanted !== email.toLowerCase()) {
    await saveToken([accountKey({ email })], token);
    return { outcome: 'wrong-account', token };
  }
  await saveToken(tokenKeysFor(email, hint), token);
  return { outcome: 'signed-in', token, account: accountKey(hint) };
}
