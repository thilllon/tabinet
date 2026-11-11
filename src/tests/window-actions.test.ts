import { beforeEach, describe, expect, it, vi } from 'vitest';

import { t } from '@/lib/i18n';
import {
  closeTab,
  closeTabs,
  closeWindow,
  currentWindowTarget,
  goToTab,
  openTabInBackground,
  openVideoAt,
} from '@/lib/window-actions';

import { fakeMedia, getChromeFake } from './chrome-fake';

beforeEach(() => {
  // A rejected action logs Chrome's original message; the page shows it in the UI language.
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});

describe('goToTab', () => {
  it('activates the tab and focuses its window', async () => {
    const fake = getChromeFake();
    const other = await chrome.windows.create({ url: 'https://other.example/' });
    const target = await chrome.tabs.create({
      windowId: 1,
      url: 'https://target.example/',
      active: false,
    });
    if (other?.id === undefined || target.id === undefined) {
      throw new Error('expected ids');
    }

    expect(await goToTab(target.id, 1)).toEqual({ ok: true });

    expect(fake.state.tabs.get(target.id)?.active).toBe(true);
    expect(fake.state.windows.get(1)?.focused).toBe(true);
    expect(fake.state.windows.get(other.id)?.focused).toBe(false);
  });

  it('reports a tab that is already gone instead of throwing', async () => {
    expect(await goToTab(4242, 1)).toEqual({
      ok: false,
      reason: 'That tab or window is no longer open.',
    });
  });
});

describe('closeTabs', () => {
  async function open(url: string): Promise<number> {
    const created = await chrome.tabs.create({ url, active: false });
    if (created.id === undefined) {
      throw new Error('expected id');
    }
    return created.id;
  }

  it('removes every tab given and leaves the others', async () => {
    const fake = getChromeFake();
    const keep = await open('https://keep.example/');
    const first = await open('https://first.example/');
    const second = await open('https://second.example/');

    expect(await closeTabs([first, second])).toEqual({ ok: true });

    expect(fake.state.tabs.has(first)).toBe(false);
    expect(fake.state.tabs.has(second)).toBe(false);
    expect(fake.state.tabs.has(keep)).toBe(true);
  });

  it('still closes the open ones when one of the tabs has already gone', async () => {
    const fake = getChromeFake();
    const first = await open('https://first.example/');
    const second = await open('https://second.example/');

    expect(await closeTabs([4242, first, second])).toEqual({ ok: true });

    expect(fake.state.tabs.has(first)).toBe(false);
    expect(fake.state.tabs.has(second)).toBe(false);
  });

  it('does nothing for an empty list', async () => {
    expect(await closeTabs([])).toEqual({ ok: true });
  });
});

describe('closeTab', () => {
  it('removes the tab', async () => {
    const fake = getChromeFake();
    const keep = await chrome.tabs.create({ url: 'https://keep.example/', active: false });
    const doomed = await chrome.tabs.create({ url: 'https://doomed.example/', active: false });
    if (doomed.id === undefined) {
      throw new Error('expected id');
    }

    expect(await closeTab(doomed.id)).toEqual({ ok: true });

    expect(fake.state.tabs.has(doomed.id)).toBe(false);
    expect(fake.state.tabs.has(keep.id ?? -1)).toBe(true);
  });

  it('reports a rejection as { ok: false }', async () => {
    expect(await closeTab(4242)).toEqual({
      ok: false,
      reason: 'That tab or window is no longer open.',
    });
  });
});

describe('closeWindow', () => {
  it('removes the window and every tab in it', async () => {
    const fake = getChromeFake();
    const win = await chrome.windows.create({ url: 'https://a.example/' });
    if (win?.id === undefined) {
      throw new Error('expected window');
    }
    await chrome.tabs.create({ windowId: win.id, url: 'https://b.example/', active: false });

    expect(await closeWindow(win.id)).toEqual({ ok: true });

    expect(fake.state.windows.has(win.id)).toBe(false);
    expect([...fake.state.tabs.values()].some((tab) => tab.windowId === win.id)).toBe(false);
  });

  it('reports a rejection as { ok: false }', async () => {
    expect(await closeWindow(4242)).toEqual({
      ok: false,
      reason: 'That tab or window is no longer open.',
    });
  });
});

describe('currentWindowTarget', () => {
  it('targets the window the dashboard is in', async () => {
    const win = await chrome.windows.create({ url: 'https://a.example/', focused: true });

    expect(await currentWindowTarget()).toEqual({ kind: 'window', windowId: win?.id });
  });
});

describe('openTabInBackground', () => {
  it('refuses an unsupported url without calling tabs.create', async () => {
    const result = await openTabInBackground('data:text/html,<h1>hi</h1>');

    expect(result).toEqual({ ok: false, reason: 'This tab cannot be opened (unsupported URL).' });
    expect(getChromeFake().state.createdTabs).toEqual([]);
  });

  it('refuses a foreign extension page but allows our own', async () => {
    const foreign = await openTabInBackground('chrome-extension://otherextid/page.html');
    expect(foreign.ok).toBe(false);
    expect(getChromeFake().state.createdTabs).toEqual([]);

    const own = await openTabInBackground('chrome-extension://fakeextid/app.html');
    expect(own).toEqual({ ok: true });
    expect(getChromeFake().state.createdTabs).toHaveLength(1);
  });

  it('opens an http url in an inactive background tab', async () => {
    // A decoy occupies "active": the fake always activates the sole tab of a window.
    await chrome.tabs.create({ url: 'https://decoy.test' });
    const fake = getChromeFake();
    fake.state.createdTabs.length = 0;

    const result = await openTabInBackground('https://example.com/a');

    expect(result).toEqual({ ok: true });
    expect(fake.state.createdTabs).toEqual([{ url: 'https://example.com/a', active: false }]);
    const created = [...fake.state.tabs.values()].find(
      (tab) => tab.url === 'https://example.com/a',
    );
    expect(created?.active).toBe(false);
  });

  it('unwraps a suspended url before opening it', async () => {
    const fake = getChromeFake();

    const result = await openTabInBackground(
      'chrome-extension://abcdefghijklmnopabcdefghijklmnop/suspended.html#uri=https://real.example/x',
    );

    expect(result).toEqual({ ok: true });
    expect(fake.state.createdTabs).toEqual([{ url: 'https://real.example/x', active: false }]);
  });

  it('reports a rejected tabs.create instead of throwing', async () => {
    getChromeFake().failNext('tabs.create', 1, 'Tabs cannot be edited right now');
    vi.spyOn(console, 'error').mockImplementation(() => undefined);

    const result = await openTabInBackground('https://example.com/a');

    // Chrome's English message is shown in the UI language; the original goes to the console.
    expect(result).toEqual({ ok: false, reason: t('errorTabsBusy') });
  });
});

describe('openVideoAt', () => {
  const ID = 'dQw4w9WgXcQ';

  async function videoTab(url = `https://www.youtube.com/watch?v=${ID}`) {
    const other = await chrome.windows.create({ url: 'https://other.example/' });
    const tab = await chrome.tabs.create({ windowId: 1, url, active: false });
    if (tab.id === undefined || other?.id === undefined) {
      throw new Error('expected ids');
    }
    return tab.id;
  }

  it('opens the video at that second in a background tab when it is not open', async () => {
    await chrome.tabs.create({ url: 'https://decoy.test' });
    const fake = getChromeFake();
    fake.state.createdTabs.length = 0;

    expect(await openVideoAt(ID, 83.7)).toEqual({ ok: true, switched: false });
    expect(fake.state.createdTabs).toEqual([
      { url: `https://www.youtube.com/watch?v=${ID}&t=83s`, active: false },
    ]);
  });

  it('loads the time into the open tab and brings it forward without access to YouTube', async () => {
    const tabId = await videoTab(`https://youtu.be/${ID}`);
    const fake = getChromeFake();
    fake.state.createdTabs.length = 0;

    expect(await openVideoAt(ID, 12)).toEqual({ ok: true, switched: true });
    const tab = fake.state.tabs.get(tabId);
    expect(tab?.url).toBe(`https://www.youtube.com/watch?v=${ID}&t=12s`);
    expect(tab?.active).toBe(true);
    expect(fake.state.windows.get(1)?.focused).toBe(true);
    expect(fake.state.createdTabs).toEqual([]);
  });

  it('moves the playing video instead of reloading it with access to YouTube', async () => {
    const tabId = await videoTab();
    const fake = getChromeFake();
    fake.state.grantedOrigins.add('https://*.youtube.com/*');
    const video = fakeMedia('VIDEO', { currentTime: 400, duration: 600 });
    fake.state.pageMedia.set(tabId, [video]);

    expect(await openVideoAt(ID, 30)).toEqual({ ok: true, switched: true });
    expect(video.currentTime).toBe(30);
    expect(fake.state.tabs.get(tabId)?.url).toBe(`https://www.youtube.com/watch?v=${ID}`);
    expect(fake.state.tabs.get(tabId)?.active).toBe(true);
  });

  it('loads the time into a frozen tab that does not answer the seek', async () => {
    const tabId = await videoTab();
    const fake = getChromeFake();
    fake.state.grantedOrigins.add('https://*.youtube.com/*');
    fake.state.pageMedia.set(tabId, [fakeMedia('VIDEO', { currentTime: 400, duration: 600 })]);
    fake.freezeTab(tabId);

    expect(await openVideoAt(ID, 30, { timeoutMs: 5 })).toEqual({ ok: true, switched: true });
    expect(fake.state.tabs.get(tabId)?.url).toBe(`https://www.youtube.com/watch?v=${ID}&t=30s`);
    expect(fake.state.tabs.get(tabId)?.active).toBe(true);
  });

  it('only brings an open video forward when no time is given', async () => {
    const tabId = await videoTab();
    const fake = getChromeFake();

    expect(await openVideoAt(ID)).toEqual({ ok: true, switched: true });
    expect(fake.state.tabs.get(tabId)?.url).toBe(`https://www.youtube.com/watch?v=${ID}`);
    expect(fake.state.tabs.get(tabId)?.active).toBe(true);
  });
});
