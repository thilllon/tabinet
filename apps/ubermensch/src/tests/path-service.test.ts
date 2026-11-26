import { describe, expect, it } from 'vitest';

import { POLICY } from '@/constants';
import { overrideOAuthConfig } from '@/lib/google-oauth';
import { answerPath, signInAndAnswer } from '@/lib/path-service';
import { readToken, saveToken } from '@/lib/token-store';
import type { DocRef } from '@/types';

import { FAKE_EXTENSION_ID } from './chrome-fake';
import { createFakeDrive, type FakeDrive } from './drive-fetch';
import { getChromeFake } from './setup';

const DOC: DocRef = { kind: 'document', fileId: 'doc-1234567890' };
const HINT = { email: 'kim@example.com' };

function myDrive(): FakeDrive {
  return createFakeDrive(
    [
      { id: 'doc-1234567890', name: 'Plan', parents: ['f1'] },
      { id: 'f1', name: 'Projects', parents: ['root-id'] },
      { id: 'root-id', name: 'My Drive' },
    ],
    { email: 'kim@example.com' },
  );
}

async function signedIn(drive: FakeDrive): Promise<void> {
  await saveToken(['e.kim@example.com'], {
    accessToken: drive.token,
    email: drive.email,
    expiresAt: 10 * 60 * 60 * 1000,
  });
}

function setup(): {
  drive: FakeDrive;
  clock: { now: number };
  deps: { fetch: FakeDrive['fetch']; now: () => number };
} {
  overrideOAuthConfig(() => ({ clientId: 'client', scopes: ['s'] }));
  const drive = myDrive();
  const clock = { now: 1000 };
  return { drive, clock, deps: { fetch: drive.fetch, now: () => clock.now } };
}

describe('answerPath', () => {
  it('says so when sign-in is not configured, without touching storage or the network', async () => {
    overrideOAuthConfig(() => ({ clientId: '', scopes: [] }));
    const drive = myDrive();
    expect(await answerPath(DOC, HINT, { fetch: drive.fetch, now: () => 0 })).toEqual({
      state: 'not-configured',
    });
    expect(drive.requests).toEqual([]);
  });

  it('asks for a sign-in when the account has no token, and never opens one itself', async () => {
    const { drive, deps } = setup();
    expect(await answerPath(DOC, HINT, deps)).toEqual({ state: 'needs-sign-in' });
    expect(getChromeFake().state.authRequests).toEqual([]);
    expect(drive.requests).toEqual([]);
  });

  it('resolves the path and then serves it from the cache until it expires', async () => {
    const { drive, clock, deps } = setup();
    await signedIn(drive);
    const first = await answerPath(DOC, HINT, deps);
    expect(first).toEqual({
      state: 'ready',
      path: {
        kind: 'path',
        partial: false,
        segments: [
          { id: 'root-id', name: 'My Drive', kind: 'my-drive' },
          { id: 'f1', name: 'Projects', kind: 'folder' },
        ],
      },
    });
    const asked = drive.requests.length;
    expect(
      drive.requests.every((url) => url.startsWith('https://www.googleapis.com/drive/v3/')),
    ).toBe(true);
    expect(drive.requests[0]).toContain(
      'fields=id%2Cname%2Cparents%2CdriveId%2Cowners%28displayName%29%2CmimeType',
    );
    expect(drive.requests[0]).toContain('supportsAllDrives=true');

    expect(await answerPath(DOC, HINT, deps)).toEqual(first);
    expect(drive.requests.length).toBe(asked);

    clock.now += POLICY.cache.fileTtlMs;
    await answerPath(DOC, HINT, deps);
    // The file's own entry expired; the folders are still fresh, so only the file is asked again.
    expect(drive.requests.length).toBe(asked + 1);
  });

  it('drops a refused token and asks for a sign-in again', async () => {
    const { drive, deps } = setup();
    await signedIn(drive);
    drive.token = 'rotated';
    expect(await answerPath(DOC, HINT, deps)).toEqual({ state: 'needs-sign-in' });
    expect(await readToken('e.kim@example.com', 0)).toBeUndefined();
  });

  it('reports a network failure and caches nothing', async () => {
    const { drive, deps } = setup();
    await signedIn(drive);
    drive.failNetwork = true;
    expect(await answerPath(DOC, HINT, deps)).toEqual({ state: 'error', reason: 'network' });
    drive.failNetwork = false;
    expect((await answerPath(DOC, HINT, deps)).state).toBe('ready');
  });

  it('hides the location of a file the account cannot read', async () => {
    const { drive, deps } = setup();
    await signedIn(drive);
    drive.forbidden.add('doc-1234567890');
    expect(await answerPath(DOC, HINT, deps)).toEqual({ state: 'ready', path: { kind: 'hidden' } });
  });

  it('keeps what one account sees apart from another', async () => {
    const { drive, deps } = setup();
    await signedIn(drive);
    await answerPath(DOC, HINT, deps);
    expect(await answerPath(DOC, { email: 'lee@example.com' }, deps)).toEqual({
      state: 'needs-sign-in',
    });
  });
});

describe('signInAndAnswer', () => {
  it('signs in for the page account, then answers', async () => {
    const { deps } = setup();
    getChromeFake().state.authAnswer = (url) =>
      `https://${FAKE_EXTENSION_ID}.chromiumapp.org/#access_token=token-1&expires_in=3600&state=${new URL(url).searchParams.get('state') ?? ''}`;
    const answer = await signInAndAnswer(DOC, HINT, { ...deps, now: () => 1000 });
    expect(answer.state).toBe('ready');
    expect(
      new URL(getChromeFake().state.authRequests[0] ?? '').searchParams.get('login_hint'),
    ).toBe('kim@example.com');
  });

  it('reports a cancelled window, and a sign-in to another account', async () => {
    const { deps } = setup();
    expect(await signInAndAnswer(DOC, HINT, deps)).toEqual({ state: 'error', reason: 'cancelled' });
    getChromeFake().state.authAnswer = (url) =>
      `https://${FAKE_EXTENSION_ID}.chromiumapp.org/#access_token=token-1&expires_in=3600&state=${new URL(url).searchParams.get('state') ?? ''}`;
    expect(await signInAndAnswer(DOC, { email: 'someone-else@example.com' }, deps)).toEqual({
      state: 'error',
      reason: 'wrong-account',
    });
  });

  it('does nothing without a client id', async () => {
    overrideOAuthConfig(() => ({ clientId: '', scopes: [] }));
    expect(await signInAndAnswer(DOC, HINT, { fetch: myDrive().fetch, now: () => 0 })).toEqual({
      state: 'not-configured',
    });
    expect(getChromeFake().state.authRequests).toEqual([]);
  });
});
