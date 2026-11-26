import { describe, expect, it } from 'vitest';

import { DOCS_CONTENT_MATCHES } from '@/constants';
import {
  CONTENT_SCRIPT_ID,
  hasDocsAccess,
  injectIntoOpenDocs,
  requestDocsAccess,
  syncContentScript,
  touchesDocsAccess,
} from '@/lib/docs-access';

import { getChromeFake } from './setup';

describe('docs.google.com access', () => {
  it('registers the content script only while access is granted', async () => {
    const fake = getChromeFake();
    expect(await syncContentScript('cs.js')).toBe('unregistered');
    expect(fake.state.registered.size).toBe(0);

    expect(await requestDocsAccess()).toBe(true);
    expect(await hasDocsAccess()).toBe(true);
    expect(await syncContentScript('cs.js')).toBe('registered');
    expect(fake.state.registered.get(CONTENT_SCRIPT_ID)).toMatchObject({
      js: ['cs.js'],
      matches: [...DOCS_CONTENT_MATCHES],
      persistAcrossSessions: true,
    });
    // Again: updated in place, never a duplicate id.
    expect(await syncContentScript('cs2.js')).toBe('registered');
    expect(fake.state.registered.get(CONTENT_SCRIPT_ID)?.js).toEqual(['cs2.js']);

    await chrome.permissions.remove({ origins: ['https://docs.google.com/*'] });
    expect(await syncContentScript('cs2.js')).toBe('unregistered');
    expect(fake.state.registered.size).toBe(0);
  });

  it('a declined prompt grants nothing', async () => {
    getChromeFake().state.permissionAnswer = false;
    expect(await requestDocsAccess()).toBe(false);
    expect(await hasDocsAccess()).toBe(false);
  });

  it('injects into the Docs tabs already open, skipping what refuses', async () => {
    const fake = getChromeFake();
    fake.state.tabs = [
      { id: 1, url: 'https://docs.google.com/document/d/abc/edit' },
      { id: 2, url: 'https://docs.google.com/spreadsheets/d/abc/edit', discarded: true },
      { id: 3, url: 'https://example.com/' },
      { id: 4, url: 'https://docs.google.com/presentation/d/abc/edit' },
    ];
    await requestDocsAccess();
    expect(await injectIntoOpenDocs('cs.js')).toBe(2);
    expect(fake.state.injected.map((entry) => entry.tabId)).toEqual([1, 4]);
  });

  it('recognises a change of this permission', () => {
    expect(touchesDocsAccess({ origins: ['https://docs.google.com/*'] })).toBe(true);
    expect(touchesDocsAccess({ origins: ['https://example.com/*'] })).toBe(false);
    expect(touchesDocsAccess({ permissions: ['storage'] })).toBe(false);
  });
});
