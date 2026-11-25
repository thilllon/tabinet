import { describe, expect, it, vi } from 'vitest';

import { POLICY } from '../../../src/constants.js';
import {
  createGoogleVerifier,
  GOOGLE_TOKENINFO_URL,
  GoogleUnavailableError,
  identityFromTokenInfo,
  issuedToUs,
  verifySameAccount,
} from '../google-auth.js';

const CLIENT_ID = 'client-1.apps.googleusercontent.com';
const CLIENT_IDS = ['other-client', CLIENT_ID];
const TOKEN = 'ya29.secret-access-token';

/** What Google's tokeninfo answers for a good access token of ours. */
function goodInfo(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    azp: CLIENT_ID,
    aud: CLIENT_ID,
    sub: '1234',
    scope: 'openid https://www.googleapis.com/auth/userinfo.email',
    exp: '1800000000',
    expires_in: '3599',
    email: 'a@example.com',
    email_verified: 'true',
    access_type: 'online',
    ...overrides,
  };
}

interface Call {
  url: string;
  init: RequestInit | undefined;
}

function fakeGoogle(answer: Response | Error | (() => Promise<Response>)) {
  const calls: Call[] = [];
  const responses: Response[] = [];
  const fetchFn: typeof fetch = async (input, init) => {
    calls.push({ url: String(input), init });
    if (answer instanceof Error) {
      throw answer;
    }
    if (typeof answer === 'function') {
      return answer();
    }
    // A fresh Response per call, like a real fetch. Not clone(): a cloned body is one branch of a
    // tee, and cancelling one branch waits for the other.
    const response = new Response(await answer.clone().arrayBuffer(), {
      status: answer.status,
      headers: answer.headers,
    });
    responses.push(response);
    return response;
  };
  return { calls, responses, fetchFn };
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('issuedToUs', () => {
  it('requires aud to be ours when it is there, whatever azp says', () => {
    expect(issuedToUs({ aud: CLIENT_ID, azp: CLIENT_ID }, CLIENT_IDS)).toBe(true);
    expect(issuedToUs({ aud: 'someone-else', azp: CLIENT_ID }, CLIENT_IDS)).toBe(false);
    expect(issuedToUs({ aud: '', azp: CLIENT_ID }, CLIENT_IDS)).toBe(false);
    expect(issuedToUs({ aud: 5, azp: CLIENT_ID }, CLIENT_IDS)).toBe(false);
  });

  it('falls back to azp only when aud is absent', () => {
    expect(issuedToUs({ azp: CLIENT_ID }, CLIENT_IDS)).toBe(true);
    expect(issuedToUs({ azp: 'someone-else' }, CLIENT_IDS)).toBe(false);
    expect(issuedToUs({}, CLIENT_IDS)).toBe(false);
  });
});

describe('identityFromTokenInfo', () => {
  it('reads sub and email from a good answer', () => {
    expect(identityFromTokenInfo(goodInfo(), CLIENT_IDS)).toEqual({
      sub: '1234',
      email: 'a@example.com',
    });
    expect(
      identityFromTokenInfo(goodInfo({ email_verified: true, expires_in: 10 }), CLIENT_IDS),
    ).toEqual({ sub: '1234', email: 'a@example.com' });
  });

  it('refuses a token issued to another app', () => {
    expect(identityFromTokenInfo(goodInfo({ aud: 'x', azp: 'x' }), CLIENT_IDS)).toBeNull();
    expect(identityFromTokenInfo(goodInfo({ aud: 'x' }), CLIENT_IDS)).toBeNull();
  });

  it('refuses an unverified, missing or empty email, and a missing sub', () => {
    for (const email_verified of [false, 'false', undefined, 1]) {
      expect(identityFromTokenInfo(goodInfo({ email_verified }), CLIENT_IDS)).toBeNull();
    }
    expect(identityFromTokenInfo(goodInfo({ email: undefined }), CLIENT_IDS)).toBeNull();
    expect(identityFromTokenInfo(goodInfo({ email: '' }), CLIENT_IDS)).toBeNull();
    expect(identityFromTokenInfo(goodInfo({ sub: undefined }), CLIENT_IDS)).toBeNull();
    expect(identityFromTokenInfo(goodInfo({ sub: '' }), CLIENT_IDS)).toBeNull();
  });

  it('refuses an expired or unparsable expires_in', () => {
    for (const expires_in of ['0', '-5', 'soon', undefined, 0]) {
      expect(identityFromTokenInfo(goodInfo({ expires_in }), CLIENT_IDS)).toBeNull();
    }
  });

  it('refuses something that is not an object', () => {
    expect(identityFromTokenInfo(null, CLIENT_IDS)).toBeNull();
    expect(identityFromTokenInfo([goodInfo()], CLIENT_IDS)).toBeNull();
    expect(identityFromTokenInfo('ok', CLIENT_IDS)).toBeNull();
  });
});

describe('createGoogleVerifier', () => {
  it('posts the token in a form body, never in the URL, and accepts a good answer', async () => {
    const google = fakeGoogle(json(200, goodInfo()));
    const verify = createGoogleVerifier({ clientIds: CLIENT_IDS, fetch: google.fetchFn });
    expect(await verify(TOKEN)).toEqual({ sub: '1234', email: 'a@example.com' });
    expect(google.calls).toHaveLength(1);
    const [call] = google.calls;
    expect(call?.url).toBe(GOOGLE_TOKENINFO_URL);
    expect(call?.url).not.toContain(TOKEN);
    expect(call?.init?.method).toBe('POST');
    expect(new Headers(call?.init?.headers).get('Content-Type')).toBe(
      'application/x-www-form-urlencoded',
    );
    expect(new URLSearchParams(String(call?.init?.body)).get('access_token')).toBe(TOKEN);
    expect(call?.init?.signal).toBeInstanceOf(AbortSignal);
  });

  it('refuses a token issued to another app', async () => {
    const google = fakeGoogle(json(200, goodInfo({ aud: 'evil', azp: 'evil' })));
    const verify = createGoogleVerifier({ clientIds: CLIENT_IDS, fetch: google.fetchFn });
    expect(await verify(TOKEN)).toBeNull();
  });

  it('answers null when Google refuses the token (400 or 401)', async () => {
    for (const status of [400, 401]) {
      const google = fakeGoogle(json(status, { error: 'invalid_token' }));
      const verify = createGoogleVerifier({ clientIds: CLIENT_IDS, fetch: google.fetchFn });
      expect(await verify(TOKEN)).toBeNull();
    }
  });

  it('is unavailable, not a refusal, on any other 4xx, such as 429 or 408', async () => {
    for (const status of [429, 408, 403]) {
      const verify = createGoogleVerifier({
        clientIds: CLIENT_IDS,
        fetch: fakeGoogle(json(status, { error: 'rate_limit_exceeded' })).fetchFn,
      });
      await expect(verify(TOKEN)).rejects.toThrow(GoogleUnavailableError);
      await expect(verify(TOKEN)).rejects.toThrow(String(status));
    }
  });

  it('cancels the body of a non-200 answer, so the connection is released', async () => {
    for (const status of [400, 429, 503]) {
      const google = fakeGoogle(json(status, { error: 'x' }));
      const verify = createGoogleVerifier({ clientIds: CLIENT_IDS, fetch: google.fetchFn });
      await verify(TOKEN).catch(() => undefined);
      expect(google.responses.map((response) => response.bodyUsed)).toEqual([true]);
    }
  });

  it('is unavailable, not a refusal, on a network failure, a 5xx or a non-JSON answer', async () => {
    const offline = createGoogleVerifier({
      clientIds: CLIENT_IDS,
      fetch: fakeGoogle(new TypeError(`fetch failed for ${TOKEN}`)).fetchFn,
    });
    await expect(offline(TOKEN)).rejects.toThrow(GoogleUnavailableError);
    await expect(offline(TOKEN)).rejects.not.toThrow(TOKEN);
    const down = createGoogleVerifier({
      clientIds: CLIENT_IDS,
      fetch: fakeGoogle(json(503, {})).fetchFn,
    });
    await expect(down(TOKEN)).rejects.toThrow(GoogleUnavailableError);
    await expect(down(TOKEN)).rejects.toThrow('503');
    const garbled = createGoogleVerifier({
      clientIds: CLIENT_IDS,
      fetch: fakeGoogle(new Response('<html>', { status: 200 })).fetchFn,
    });
    await expect(garbled(TOKEN)).rejects.toThrow(GoogleUnavailableError);
  });

  it('gives up after the timeout as unavailable', async () => {
    const slow: typeof fetch = (_input, init) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(init.signal?.reason));
      });
    const verify = createGoogleVerifier({ clientIds: CLIENT_IDS, fetch: slow, timeoutMs: 10 });
    await expect(verify(TOKEN)).rejects.toThrow(GoogleUnavailableError);
  });

  it('waits POLICY.request.googleTimeoutMs by default', async () => {
    const timeout = vi.spyOn(AbortSignal, 'timeout');
    const verify = createGoogleVerifier({
      clientIds: CLIENT_IDS,
      fetch: fakeGoogle(json(200, goodInfo())).fetchFn,
    });
    await verify(TOKEN);
    expect(timeout).toHaveBeenCalledWith(POLICY.request.googleTimeoutMs);
    timeout.mockRestore();
  });

  it('never puts the token into an error message', async () => {
    const down = createGoogleVerifier({
      clientIds: CLIENT_IDS,
      fetch: fakeGoogle(json(502, {})).fetchFn,
    });
    const err: unknown = await down(TOKEN).catch((e: unknown) => e);
    expect(String(err)).not.toContain(TOKEN);
  });

  it('cannot be built without a client id, a configuration error rather than a refusal', () => {
    const google = fakeGoogle(json(200, goodInfo()));
    expect(() => createGoogleVerifier({ clientIds: [], fetch: google.fetchFn })).toThrow(
      'client id',
    );
    expect(google.calls).toEqual([]);
  });
});

describe('verifySameAccount', () => {
  it('tells a refused token, another account and the same account apart', async () => {
    const verify = async (token: string) => (token === 'ok' ? { sub: 's1', email: 'e' } : null);
    expect(await verifySameAccount(verify, 'no', 's1')).toBe('refused');
    expect(await verifySameAccount(verify, 'ok', 's2')).toBe('mismatch');
    expect(await verifySameAccount(verify, 'ok', 's1')).toEqual({ sub: 's1', email: 'e' });
  });
});
