import { describe, expect, it, vi } from 'vitest';

import { getChromeFake } from './setup';

vi.mock('../content-script.ts?iife', () => ({ default: 'assets/content-script.js' }));

/** A fresh worker on this test's fake; the OAuth client is set on the same fresh module graph. */
async function loadWorker(clientId = ''): Promise<void> {
  vi.resetModules();
  const oauth = await import('@/lib/google-oauth');
  oauth.overrideOAuthConfig(() => ({ clientId, scopes: ['s'] }));
  await import('@/service-worker');
}

const DOCS_SENDER = {
  id: 'abcdefghijklmnopabcdefghijklmnop',
  url: 'https://docs.google.com/document/d/x/edit',
};
const REQUEST = {
  type: 'ubermensch:get-path',
  doc: { kind: 'document', fileId: '1AbCdEfGhIjKlMnOp' },
  account: {},
};

describe('the service worker', () => {
  it('registers the content script on install only when access is granted', async () => {
    await loadWorker();
    const fake = getChromeFake();
    fake.fire.installed();
    await vi.waitFor(() => {
      expect(fake.state.registered.size).toBe(0);
    });
    await chrome.permissions.request({ origins: ['https://docs.google.com/*'] });
    await vi.waitFor(() => {
      expect(fake.state.registered.get('drive-path')?.js).toEqual(['assets/content-script.js']);
    });
    await chrome.permissions.remove({ origins: ['https://docs.google.com/*'] });
    await vi.waitFor(() => {
      expect(fake.state.registered.size).toBe(0);
    });
  });

  it('opens the options page on an icon click', async () => {
    await loadWorker();
    getChromeFake().fire.actionClicked();
    expect(getChromeFake().state.optionsOpened).toBe(1);
  });

  it('answers its own content script on Docs and ignores everyone else', async () => {
    await loadWorker('');
    const fake = getChromeFake();
    expect(await fake.fire.message(REQUEST, DOCS_SENDER)).toEqual({ state: 'not-configured' });
    expect(
      await fake.fire.message(REQUEST, { ...DOCS_SENDER, url: 'https://example.com/' }),
    ).toBeUndefined();
    expect(await fake.fire.message({ type: 'nope' }, DOCS_SENDER)).toBeUndefined();
  });

  it('asks for a sign-in, and never opens one, for a plain request', async () => {
    await loadWorker('client');
    const fake = getChromeFake();
    expect(await fake.fire.message(REQUEST, DOCS_SENDER)).toEqual({ state: 'needs-sign-in' });
    expect(fake.state.authRequests).toEqual([]);
  });
});
