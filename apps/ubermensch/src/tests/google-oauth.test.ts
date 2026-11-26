import { describe, expect, it } from 'vitest';

import {
  AuthError,
  buildAuthUrl,
  isCancelledFlow,
  isSignInConfigured,
  overrideOAuthConfig,
  parseAuthRedirect,
  signIn,
} from '@/lib/google-oauth';
import { readToken } from '@/lib/token-store';

import { FAKE_EXTENSION_ID } from './chrome-fake';
import { createFakeDrive } from './drive-fetch';
import { getChromeFake } from './setup';

const REDIRECT = `https://${FAKE_EXTENSION_ID}.chromiumapp.org/`;

describe('buildAuthUrl', () => {
  it('asks for an implicit token with the metadata scope and the page account as hint', () => {
    const url = new URL(
      buildAuthUrl({
        clientId: 'client.apps.googleusercontent.com',
        redirectUri: REDIRECT,
        scopes: ['https://www.googleapis.com/auth/drive.metadata.readonly'],
        state: 's1',
        hint: { email: 'kim@example.com', index: 1 },
      }),
    );
    expect(url.origin + url.pathname).toBe('https://accounts.google.com/o/oauth2/v2/auth');
    expect(Object.fromEntries(url.searchParams)).toEqual({
      client_id: 'client.apps.googleusercontent.com',
      response_type: 'token',
      redirect_uri: REDIRECT,
      scope: 'https://www.googleapis.com/auth/drive.metadata.readonly',
      state: 's1',
      include_granted_scopes: 'true',
      login_hint: 'kim@example.com',
    });
  });

  it('falls back to the account index when the page gave no address', () => {
    const url = new URL(
      buildAuthUrl({
        clientId: 'c',
        redirectUri: REDIRECT,
        scopes: ['s'],
        state: 's',
        hint: { index: 2 },
      }),
    );
    expect(url.searchParams.get('authuser')).toBe('2');
    expect(url.searchParams.has('login_hint')).toBe(false);
  });
});

describe('parseAuthRedirect', () => {
  it('reads the token and its expiry', () => {
    expect(
      parseAuthRedirect(
        `${REDIRECT}#access_token=tok&token_type=Bearer&expires_in=3599&state=s1`,
        's1',
        1000,
      ),
    ).toEqual({
      accessToken: 'tok',
      expiresAt: 1000 + 3_599_000,
    });
  });

  it('refuses a wrong state, an error and a malformed answer', () => {
    const reason = (redirect: string): string => {
      try {
        parseAuthRedirect(redirect, 's1', 0);
        return 'accepted';
      } catch (err) {
        return err instanceof AuthError ? err.reason : 'other';
      }
    };
    expect(reason(`${REDIRECT}#access_token=tok&expires_in=10&state=other`)).toBe('state');
    expect(reason(`${REDIRECT}#error=access_denied&state=s1`)).toBe('denied');
    expect(reason(`${REDIRECT}#state=s1&expires_in=10`)).toBe('malformed');
    expect(reason(`${REDIRECT}#access_token=tok&state=s1&expires_in=abc`)).toBe('malformed');
    expect(reason('nonsense')).toBe('malformed');
  });

  it('recognises Chrome closing the window', () => {
    expect(isCancelledFlow(new Error('The user did not approve access.'))).toBe(true);
    expect(isCancelledFlow(new Error('Authorization page could not be loaded.'))).toBe(false);
  });
});

describe('signIn', () => {
  const answerWithToken = (url: string): string => {
    const state = new URL(url).searchParams.get('state') ?? '';
    return `${REDIRECT}#access_token=token-1&expires_in=3600&state=${state}`;
  };

  it('is dormant without a client id', () => {
    overrideOAuthConfig(() => ({ clientId: '', scopes: [] }));
    expect(isSignInConfigured()).toBe(false);
    overrideOAuthConfig(() => ({ clientId: 'c', scopes: [] }));
    expect(isSignInConfigured()).toBe(true);
  });

  it('stores the token under the address Drive reports and the page index', async () => {
    overrideOAuthConfig(() => ({ clientId: 'c', scopes: ['s'] }));
    const fake = getChromeFake();
    fake.state.authAnswer = answerWithToken;
    const drive = createFakeDrive([], { email: 'Kim@example.com' });
    const result = await signIn({ index: 1 }, drive.fetch, () => 0);
    expect(result.outcome).toBe('signed-in');
    expect((await readToken('e.kim@example.com', 0))?.accessToken).toBe('token-1');
    expect((await readToken('u.1', 0))?.accessToken).toBe('token-1');
    expect(new URL(fake.state.authRequests[0] ?? '').searchParams.get('redirect_uri')).toBe(
      REDIRECT,
    );
  });

  it('reports another account than the page uses, and keeps it apart', async () => {
    overrideOAuthConfig(() => ({ clientId: 'c', scopes: ['s'] }));
    getChromeFake().state.authAnswer = answerWithToken;
    const drive = createFakeDrive([], { email: 'other@example.com' });
    const result = await signIn({ email: 'kim@example.com', index: 0 }, drive.fetch, () => 0);
    expect(result.outcome).toBe('wrong-account');
    expect(await readToken('e.kim@example.com', 0)).toBeUndefined();
    expect(await readToken('u.0', 0)).toBeUndefined();
    expect(await readToken('e.other@example.com', 0)).toBeDefined();
  });

  it('turns a closed window into a cancelled sign-in', async () => {
    overrideOAuthConfig(() => ({ clientId: 'c', scopes: ['s'] }));
    await expect(signIn({}, createFakeDrive().fetch, () => 0)).rejects.toMatchObject({
      reason: 'cancelled',
    });
  });
});
