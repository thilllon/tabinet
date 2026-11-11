import { readFileSync } from 'node:fs';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { STORE_EXTENSION_ID } from '@/constants';
import { HISTORY_ALARM, HISTORY_FIRST_ALARM } from '@/lib/history-snapshots';
import { toCatalog } from '@/lib/i18n';
import { INDEX_KEY, SETTINGS_KEY } from '@/lib/session-repo';
import { UI_LANGUAGE_KEY } from '@/lib/ui-language';
import {
  COMMAND_IDS,
  clearBadge,
  DEV_BADGE,
  handleMenuOrCommand,
  idleBadge,
  MENU_IDS,
  registerContextMenus,
  showErrorBadge,
  showSavedBadge,
} from '@/service-worker';
import { SESSION_SCHEMA_VERSION, type Session, type SessionIndex } from '@/types';

import { fakeMedia, fetchPackagedFile, getChromeFake, readLocaleFile } from './chrome-fake';

const APP_URL = 'chrome-extension://fakeextid/app.html';

async function seedWindow(urls: string[], focused: boolean): Promise<number> {
  const win = await chrome.windows.create({ url: urls[0] });
  if (win === undefined || win.id === undefined) {
    throw new Error('fake windows.create returned nothing');
  }
  for (const url of urls.slice(1)) {
    await chrome.tabs.create({ windowId: win.id, url, active: false });
  }
  await chrome.windows.update(win.id, { focused });
  return win.id;
}

function sessionKeys(): string[] {
  return [...getChromeFake().state.local.keys()].filter((key) => key.startsWith('session:'));
}

function readIndex(): SessionIndex | undefined {
  const raw = getChromeFake().state.local.get(INDEX_KEY);
  return raw as SessionIndex | undefined;
}

function historySummaries(): SessionIndex['sessions'] {
  return (readIndex()?.sessions ?? []).filter((summary) => summary.kind === 'history');
}

/** The tab strip of `windowId` in index order. */
function stripUrls(windowId: number): string[] {
  return [...getChromeFake().state.tabs.values()]
    .filter((tab) => tab.windowId === windowId)
    .sort((a, b) => a.index - b.index)
    .map((tab) => tab.url);
}

function alarmNames(): string[] {
  return [...getChromeFake().state.alarms.keys()].sort();
}

/** An unprotected alarm snapshot as `takeHistorySnapshot` would have stored it earlier. */
function historySession(id: string, createdAt: number): Session {
  return {
    schemaVersion: SESSION_SCHEMA_VERSION,
    id,
    kind: 'history',
    name: 'Snapshot',
    origin: 'alarm',
    createdAt,
    updatedAt: createdAt,
    windows: [
      {
        state: 'normal',
        focused: false,
        groups: [],
        tabs: [{ url: `https://${id}.example/`, title: id, pinned: false, active: true }],
      },
    ],
  };
}

/** Loads a fresh copy of the worker module against this test's fake (see AGENTS.md "Testing"). */
async function loadWorker(): Promise<typeof import('@/lib/session-repo')> {
  vi.resetModules();
  await import('@/service-worker');
  return await import('@/lib/session-repo');
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('registerContextMenus', () => {
  it('is idempotent: removeAll then exactly the 3 items, no separators', async () => {
    await registerContextMenus();
    await registerContextMenus();

    const menus = getChromeFake().state.menus;
    expect(menus).toHaveLength(3);
    expect(menus.map((m) => m.id)).toEqual([
      MENU_IDS.assembleTabs,
      MENU_IDS.saveAll,
      MENU_IDS.pauseYoutube,
    ]);
    // Opening the app is Chrome's own "Options" item (options_page = app.html#settings) plus the
    // `open-dashboard` command; this menu does not repeat it.
    expect(menus.filter((m) => m.type !== 'separator').map((m) => m.title)).toEqual([
      "Assemble! (move every window's tabs into this one)",
      'Save all windows as session',
      'Pause all YouTube videos',
    ]);
    for (const menu of menus) {
      expect(menu.contexts).toEqual(['action']);
    }
  });
});

describe('badge', () => {
  it('showSavedBadge shows ✓ and clears itself after 2 s', () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const fake = getChromeFake();

    showSavedBadge();
    expect(fake.state.badge.text).toBe('✓');
    expect(fake.state.badge.color).toBe('#16a34a');

    vi.advanceTimersByTime(1999);
    expect(fake.state.badge.text).toBe('✓');
    vi.advanceTimersByTime(1);
    expect(fake.state.badge.text).toBe('');
  });

  it('clearBadge empties the badge text', () => {
    const fake = getChromeFake();
    fake.state.badge.text = '✓';
    clearBadge();
    expect(fake.state.badge.text).toBe('');
  });

  it('showErrorBadge shows ! on a red background and clears itself after 2 s', () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const fake = getChromeFake();

    showErrorBadge();
    expect(fake.state.badge.text).toBe('!');
    expect(fake.state.badge.color).toBe('#d93025');

    vi.advanceTimersByTime(2000);
    expect(fake.state.badge.text).toBe('');
  });

  it('idleBadge is DEV for every copy but the store item, and for the development mode', () => {
    expect(idleBadge('development', STORE_EXTENSION_ID)).toEqual({ text: 'DEV', color: '#d9640a' });
    expect(idleBadge('production', STORE_EXTENSION_ID)).toEqual({ text: '' });
    expect(idleBadge('production', 'abcdefghijklmnopabcdefghijklmnop')).toEqual(DEV_BADGE);
    expect(idleBadge('e2e', 'abcdefghijklmnopabcdefghijklmnop')).toEqual(DEV_BADGE);
    expect(idleBadge('test', 'abcdefghijklmnopabcdefghijklmnop')).toEqual({ text: '' });
  });

  it('in a dev build, clearBadge and the 2 s clear restore DEV instead of emptying the badge', () => {
    vi.stubEnv('MODE', 'development');
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const fake = getChromeFake();

    clearBadge();
    expect(fake.state.badge).toEqual({ text: DEV_BADGE.text, color: DEV_BADGE.color });

    showSavedBadge();
    expect(fake.state.badge).toEqual({ text: '✓', color: '#16a34a' });
    vi.advanceTimersByTime(2000);
    expect(fake.state.badge).toEqual({ text: DEV_BADGE.text, color: DEV_BADGE.color });
  });

  it('a second save 1.5 s later re-arms the clear timer instead of stacking it', () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const fake = getChromeFake();

    showSavedBadge();
    vi.advanceTimersByTime(1500);
    showSavedBadge();

    vi.advanceTimersByTime(500);
    expect(fake.state.badge.text).toBe('✓');
    vi.advanceTimersByTime(1500);
    expect(fake.state.badge.text).toBe('');
  });
});

describe("'assemble-tabs' command", () => {
  async function otherWindow(urls: string[]): Promise<number> {
    const win = await chrome.windows.create({ url: urls, focused: false });
    if (win?.id === undefined) {
      throw new Error('expected a window id');
    }
    return win.id;
  }

  it('gathers the other windows into the focused one and shows ✓', async () => {
    await chrome.tabs.create({ windowId: 1, url: 'https://t.test' });
    await otherWindow(['https://a.test', 'https://b.test']);

    await handleMenuOrCommand(COMMAND_IDS.assembleTabs);

    const fake = getChromeFake();
    expect([...fake.state.windows.keys()]).toEqual([1]);
    expect((await chrome.tabs.query({ windowId: 1 })).map((tab) => tab.url)).toEqual([
      'https://t.test',
      'https://a.test',
      'https://b.test',
    ]);
    expect(fake.state.badge.text).toBe('✓');
  });

  it('shows ! and logs when a window could not be merged', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    await chrome.tabs.create({ windowId: 1, url: 'https://t.test' });
    await otherWindow(['https://a.test']);
    getChromeFake().failNext('tabs.move', 1, 'No tab with id: 42.');

    await handleMenuOrCommand(COMMAND_IDS.assembleTabs);

    expect(getChromeFake().state.badge.text).toBe('!');
    expect(error).toHaveBeenCalled();
  });

  it('leaves the badge empty when there is only one window', async () => {
    await chrome.tabs.create({ windowId: 1, url: 'https://t.test' });

    await handleMenuOrCommand(COMMAND_IDS.assembleTabs);

    expect(getChromeFake().state.badge.text).toBe('');
  });
});

describe('COMMAND_IDS', () => {
  it('matches the ids declared in the manifest', () => {
    // Source of truth: the `commands` block of `defineManifest()` in `vite.config.ts`.
    // Chrome delivers exactly these strings to `commands.onCommand`; keep both sides equal.
    expect(COMMAND_IDS.saveSession).toBe('save-session');
    expect(COMMAND_IDS.openDashboard).toBe('open-dashboard');
    expect(COMMAND_IDS.assembleTabs).toBe('assemble-tabs');
    expect(COMMAND_IDS.assembleTabs).toBe(MENU_IDS.assembleTabs);
    expect(COMMAND_IDS.pauseYoutube).toBe('pause-youtube');
    expect(COMMAND_IDS.pauseYoutube).toBe(MENU_IDS.pauseYoutube);
  });

  it('declares every command id in the manifest', () => {
    const config = readFileSync(
      path.join(import.meta.dirname, '..', '..', 'vite.config.ts'),
      'utf8',
    );
    for (const id of Object.values(COMMAND_IDS)) {
      expect(config).toContain(`'${id}': {`);
    }
  });
});

describe('pausing YouTube', () => {
  const YOUTUBE = 'https://*.youtube.com/*';

  /** A YouTube tab in the focused window with one playing video; returns that video. */
  async function playingYoutubeTab(url = 'https://www.youtube.com/watch?v=a') {
    const fake = getChromeFake();
    await seedWindow(['https://a.example/'], true);
    const tab = await chrome.tabs.create({ url, active: false });
    if (tab.id === undefined) {
      throw new Error('fake tabs.create returned no id');
    }
    const video = fakeMedia('VIDEO', { currentTime: 30 });
    fake.state.pageMedia.set(tab.id, [video]);
    return { tabId: tab.id, video };
  }

  it.each([
    ['the menu item', MENU_IDS.pauseYoutube],
    ['the command', COMMAND_IDS.pauseYoutube],
  ])(
    'without access, %s opens Settings at its YouTube row and runs in no page',
    async (_name, id) => {
      const fake = getChromeFake();
      const { video } = await playingYoutubeTab();

      await handleMenuOrCommand(id);

      expect(fake.state.injectedTabs).toEqual([]);
      expect(video.paused).toBe(false);
      const appTabs = [...fake.state.tabs.values()].filter((tab) => tab.url.startsWith(APP_URL));
      expect(appTabs.map((tab) => tab.url)).toEqual([`${APP_URL}#settings/youtube`]);
      expect(appTabs[0]?.active).toBe(true);
      expect(fake.state.badge.text).toBe('');
    },
  );

  it('without access, points an open app tab at Settings instead of opening a second one', async () => {
    const fake = getChromeFake();
    await playingYoutubeTab();
    await chrome.tabs.create({ url: `${APP_URL}#open`, active: false });

    await handleMenuOrCommand(COMMAND_IDS.pauseYoutube);

    const appTabs = [...fake.state.tabs.values()].filter((tab) => tab.url.startsWith(APP_URL));
    expect(appTabs.map((tab) => tab.url)).toEqual([`${APP_URL}#settings/youtube`]);
  });

  it.each([
    ['the menu item', MENU_IDS.pauseYoutube],
    ['the command', COMMAND_IDS.pauseYoutube],
  ])('with access, %s pauses every YouTube video and shows ✓', async (_name, id) => {
    const fake = getChromeFake();
    fake.state.grantedOrigins.add(YOUTUBE);
    const { video } = await playingYoutubeTab();
    const { video: music } = await playingYoutubeTab('https://music.youtube.com/watch?v=b');

    await handleMenuOrCommand(id);

    expect(video).toMatchObject({ paused: true, currentTime: 30 });
    expect(music.paused).toBe(true);
    expect(fake.state.badge.text).toBe('✓');
    const appTabs = [...fake.state.tabs.values()].filter((tab) => tab.url.startsWith(APP_URL));
    expect(appTabs).toEqual([]);
  });

  it('shows ✓ when nothing was playing, and no badge when no YouTube tab is open', async () => {
    const fake = getChromeFake();
    fake.state.grantedOrigins.add(YOUTUBE);
    await seedWindow(['https://a.example/'], true);

    await handleMenuOrCommand(COMMAND_IDS.pauseYoutube);
    expect(fake.state.badge.text).toBe('');

    const { video } = await playingYoutubeTab();
    video.paused = true;
    await handleMenuOrCommand(COMMAND_IDS.pauseYoutube);
    expect(fake.state.badge.text).toBe('✓');
  });

  it('shows ! and logs when every YouTube tab failed', async () => {
    const fake = getChromeFake();
    fake.state.grantedOrigins.add(YOUTUBE);
    await playingYoutubeTab();
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    fake.failNext('scripting.executeScript', 1, 'Frame with ID 0 is showing error page');

    await handleMenuOrCommand(COMMAND_IDS.pauseYoutube);

    expect(fake.state.badge.text).toBe('!');
    expect(errorSpy).toHaveBeenCalled();
  });

  it('shows ✓ when only some tabs failed', async () => {
    const fake = getChromeFake();
    fake.state.grantedOrigins.add(YOUTUBE);
    await playingYoutubeTab();
    const { video } = await playingYoutubeTab('https://www.youtube.com/watch?v=b');
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    fake.failNext('scripting.executeScript', 1, 'No tab with id: 2.');

    await handleMenuOrCommand(COMMAND_IDS.pauseYoutube);

    expect(video.paused).toBe(true);
    expect(fake.state.badge.text).toBe('✓');
  });

  it('is reached through the real menu and command listeners', async () => {
    await loadWorker();
    const fake = getChromeFake();
    fake.state.grantedOrigins.add(YOUTUBE);
    const { video } = await playingYoutubeTab();

    fake.fire.menuClicked(MENU_IDS.pauseYoutube);
    await vi.waitFor(() => {
      expect(video.paused).toBe(true);
    });

    video.paused = false;
    fake.fire.command(COMMAND_IDS.pauseYoutube);
    await vi.waitFor(() => {
      expect(video.paused).toBe(true);
    });
  });
});

describe('handleMenuOrCommand', () => {
  it("'save-session' writes one session:* key plus the index and sets the badge", async () => {
    await seedWindow(['https://a.example/', 'https://a.example/2'], false);
    await seedWindow(['https://b.example/', 'https://b.example/2', 'https://b.example/3'], true);

    await handleMenuOrCommand('save-session');

    const keys = sessionKeys();
    expect(keys).toHaveLength(1);
    const index = readIndex();
    expect(index?.sessions).toHaveLength(1);
    expect(index?.sessions[0].id).toBe(keys[0].slice('session:'.length));
    expect(index?.sessions[0].windowCount).toBe(1);
    expect(index?.sessions[0].tabCount).toBe(3);
    expect(getChromeFake().state.badge.text).toBe('✓');
  });

  it('gives a second save in the same minute a " (2)" suffix instead of a duplicate name', async () => {
    vi.useFakeTimers({ toFake: ['Date'], now: new Date(2026, 7, 29, 14, 3).getTime() });
    await seedWindow(['https://a.example/'], true);

    await handleMenuOrCommand('save-session');
    await handleMenuOrCommand('save-session');
    await handleMenuOrCommand('save-session');

    const names = readIndex()?.sessions.map((s) => s.name) ?? [];
    expect(names.sort()).toEqual([
      'Session 2026-08-29 14:03 · 1 window · 1 tab',
      'Session 2026-08-29 14:03 · 1 window · 1 tab (2)',
      'Session 2026-08-29 14:03 · 1 window · 1 tab (3)',
    ]);
  });

  it("'save-session' (keyboard command) saves the current window", async () => {
    await seedWindow(['https://a.example/'], true);
    await handleMenuOrCommand('save-session');
    expect(sessionKeys()).toHaveLength(1);
    expect(readIndex()?.sessions[0].windowCount).toBe(1);
  });

  it("'save-all' captures every window", async () => {
    await seedWindow(['https://a.example/', 'https://a.example/2'], false);
    await seedWindow(['https://b.example/'], true);

    await handleMenuOrCommand('save-all');

    expect(sessionKeys()).toHaveLength(1);
    expect(readIndex()?.sessions[0].windowCount).toBe(2);
    expect(readIndex()?.sessions[0].tabCount).toBe(3);
  });

  it("'open-dashboard' focuses an existing dashboard tab instead of creating a second", async () => {
    const fake = getChromeFake();
    const winA = await seedWindow(['https://a.example/', APP_URL], false);
    await seedWindow(['https://b.example/'], true);
    const tabsBefore = fake.state.tabs.size;

    await handleMenuOrCommand('open-dashboard');

    expect(fake.state.tabs.size).toBe(tabsBefore);
    const dashboard = [...fake.state.tabs.values()].find((t) => t.url === APP_URL);
    expect(dashboard?.active).toBe(true);
    expect(fake.state.windows.get(winA)?.focused).toBe(true);
    expect(fake.state.badge.text).toBe('');
  });

  it('ignores unknown ids', async () => {
    await handleMenuOrCommand('nope');
    expect(sessionKeys()).toHaveLength(0);
    expect(getChromeFake().state.tabs.size).toBe(0);
  });

  it('save-session with only an extension page open shows the error badge and writes nothing', async () => {
    await seedWindow([APP_URL], true);

    await handleMenuOrCommand('save-session');

    expect(sessionKeys()).toHaveLength(0);
    expect(getChromeFake().state.badge.text).toBe('!');
  });

  it('a failed sessionRepo.put shows the error badge, reports the error and does not throw', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    await seedWindow(['https://a.example/'], true);
    getChromeFake().failNext('storage.local.set', 1, 'QUOTA_BYTES exceeded');

    await expect(handleMenuOrCommand('save-session')).resolves.toBeUndefined();

    expect(getChromeFake().state.badge.text).toBe('!');
    expect(errorSpy).toHaveBeenCalledWith('[tabinet:sessions]', expect.any(Error));
    expect(sessionKeys()).toHaveLength(0);
  });
});

describe('listener wiring', () => {
  it('a context-menu click on save-all saves a session', async () => {
    vi.resetModules();
    await import('@/service-worker');
    const fake = getChromeFake();
    await seedWindow(['https://a.example/'], true);

    fake.fire.command(COMMAND_IDS.saveSession);

    await vi.waitFor(() => {
      expect(sessionKeys()).toHaveLength(1);
    });
  });

  it('the save-session command saves a session', async () => {
    vi.resetModules();
    await import('@/service-worker');
    const fake = getChromeFake();
    await seedWindow(['https://a.example/'], true);

    fake.fire.command('save-session');

    await vi.waitFor(() => {
      expect(sessionKeys()).toHaveLength(1);
    });
  });

  it('onInstalled registers the menus', async () => {
    vi.resetModules();
    await import('@/service-worker');
    const fake = getChromeFake();

    fake.fire.installed({ reason: 'install' });

    await vi.waitFor(() => {
      expect(fake.state.menus).toHaveLength(3);
    });
  });

  it("onInstalled with reason 'update' registers the menus and runs migrateAll then reconcile", async () => {
    vi.resetModules();
    await import('@/service-worker');
    const { sessionRepo } = await import('@/lib/session-repo');
    const fake = getChromeFake();
    const migrateSpy = vi.spyOn(sessionRepo, 'migrateAll');
    const reconcileSpy = vi.spyOn(sessionRepo, 'reconcile');

    fake.fire.installed({ reason: 'update', previousVersion: '6.0.0' });

    await vi.waitFor(() => {
      expect(fake.state.menus).toHaveLength(3);
      expect(migrateSpy).toHaveBeenCalledTimes(1);
      expect(reconcileSpy).toHaveBeenCalledTimes(1);
    });
  });

  it('onInstalled clears a badge left behind by a previous worker', async () => {
    // The badge is browser state, the 2 s clear timer is worker state. An update starts
    // a new worker, so nothing else would ever clear a ✓ the old one left on the icon.
    vi.resetModules();
    await import('@/service-worker');
    const fake = getChromeFake();
    fake.state.badge.text = '✓';

    fake.fire.installed({ reason: 'update', previousVersion: '6.0.0' });

    await vi.waitFor(() => {
      expect(fake.state.badge.text).toBe('');
    });
  });

  it('an alarm clears a badge left behind by a previous worker', async () => {
    await loadWorker();
    const fake = getChromeFake();
    fake.state.badge.text = '!';

    fake.fire.alarm(HISTORY_ALARM);

    await vi.waitFor(() => {
      expect(fake.state.badge.text).toBe('');
    });
  });

  it('onStartup clears the badge and reconciles', async () => {
    vi.resetModules();
    await import('@/service-worker');
    const { sessionRepo } = await import('@/lib/session-repo');
    const fake = getChromeFake();
    fake.state.badge.text = '✓';
    const reconcileSpy = vi.spyOn(sessionRepo, 'reconcile');

    fake.fire.startup();

    await vi.waitFor(() => {
      expect(fake.state.badge.text).toBe('');
      expect(reconcileSpy).toHaveBeenCalledTimes(1);
    });
  });

  it('onStartup recreates the menus in the current Chrome language', async () => {
    vi.resetModules();
    await import('@/service-worker');
    const fake = getChromeFake();
    // Menus created in English by an earlier install; Chrome has since been switched to Korean.
    fake.state.menus.push({ id: 'assemble-tabs', title: 'Assemble!', contexts: ['action'] });
    fake.setUiLanguage('ko');
    const { t } = await import('@/lib/i18n');

    fake.fire.startup();

    await vi.waitFor(() => {
      expect(fake.state.menus.map((menu) => menu.title)).toEqual([
        t('cmdAssembleTabs'),
        t('workerMenuSaveAll'),
        t('cmdPauseYoutube'),
      ]);
    });
    expect(t('workerMenuSaveAll')).not.toBe('Save all windows as session');
  });

  it('onStartup still arms the alarms when the menus cannot be recreated', async () => {
    await loadWorker();
    const fake = getChromeFake();
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    vi.spyOn(chrome.contextMenus, 'removeAll').mockRejectedValue(new Error('menus unavailable'));

    fake.fire.startup();

    await vi.waitFor(() => {
      expect(fake.state.alarms.size).toBeGreaterThan(0);
    });
    expect(errorSpy).toHaveBeenCalledWith('[tabinet:sessions]', expect.any(Error));
  });

  it('registers no chrome.tabs / windows / tabGroups listeners (AGENTS.md rule)', async () => {
    await loadWorker();

    // The fake does model these events (the dashboard's open-windows pane needs them), so the
    // rule is asserted directly: after importing the worker, not one of them has a listener.
    const tabEvents = [
      chrome.tabs.onCreated,
      chrome.tabs.onRemoved,
      chrome.tabs.onUpdated,
      chrome.tabs.onMoved,
      chrome.tabs.onAttached,
      chrome.tabs.onDetached,
      chrome.tabs.onActivated,
      chrome.tabs.onReplaced,
      chrome.windows.onCreated,
      chrome.windows.onRemoved,
      chrome.windows.onFocusChanged,
      chrome.tabGroups.onCreated,
      chrome.tabGroups.onUpdated,
      chrome.tabGroups.onRemoved,
      chrome.tabGroups.onMoved,
    ];
    expect(tabEvents.map((event) => event.hasListeners())).toEqual(tabEvents.map(() => false));
    expect(chrome.alarms.onAlarm.hasListeners()).toBe(true);
    expect(chrome.action.onClicked.hasListeners()).toBe(true);
    expect(chrome.storage.onChanged.hasListeners()).toBe(true);
  });
});

/**
 * The icon click only sorts: no tab or window is opened by it. Tested against
 * `@/service-worker`, the module Chrome actually loads, with both `action.onClicked` listeners
 * registered (the sorter's and the snapshot one).
 */
describe('the icon click', () => {
  it('sorts the focused window and opens nothing', async () => {
    vi.resetModules();
    await import('@/service-worker');
    const fake = getChromeFake();
    const windowId = await seedWindow(
      ['https://c.example/', 'https://a.example/', 'https://b.example/'],
      true,
    );
    const tabsBefore = fake.state.tabs.size;
    const windowsBefore = fake.state.windows.size;
    // Spied after seeding: these must not be called by the click itself.
    const createTab = vi.spyOn(chrome.tabs, 'create');
    const createWindow = vi.spyOn(chrome.windows, 'create');

    // A `default_popup` in the manifest would swallow this event entirely, so the sort below is
    // also the proof that there is no popup: the click reaches the worker.
    fake.fire.actionClicked();

    await vi.waitFor(() => {
      expect(stripUrls(windowId)).toEqual([
        'https://a.example/',
        'https://b.example/',
        'https://c.example/',
      ]);
    });

    // No dashboard tab, no new window, no tab of any kind: the click sorted and stopped.
    expect(createTab).not.toHaveBeenCalled();
    expect(createWindow).not.toHaveBeenCalled();
    expect(fake.state.tabs.size).toBe(tabsBefore);
    expect(fake.state.windows.size).toBe(windowsBefore);
    expect(
      [...fake.state.tabs.values()].some((tab) => tab.url.startsWith('chrome-extension://')),
    ).toBe(false);
  });
});

describe('history wiring', () => {
  it(`the '${HISTORY_ALARM}' alarm takes an origin 'alarm' history snapshot`, async () => {
    await loadWorker();
    const fake = getChromeFake();
    await seedWindow(['https://a.example/', 'https://a.example/2'], true);

    fake.fire.alarm(HISTORY_ALARM);

    await vi.waitFor(() => {
      expect(historySummaries()).toHaveLength(1);
    });
    expect(historySummaries()[0]).toMatchObject({
      kind: 'history',
      origin: 'alarm',
      windowCount: 1,
      tabCount: 2,
    });
    expect(historySummaries()[0].name).toMatch(/^Snapshot /);
    expect(sessionKeys()).toHaveLength(1);
  });

  it(`the one-shot '${HISTORY_FIRST_ALARM}' alarm takes a snapshot too`, async () => {
    await loadWorker();
    const fake = getChromeFake();
    await seedWindow(['https://a.example/'], true);

    fake.fire.alarm(HISTORY_FIRST_ALARM);

    await vi.waitFor(() => {
      expect(historySummaries()).toHaveLength(1);
    });
    expect(historySummaries()[0].origin).toBe('alarm');
  });

  it('an unrelated alarm is ignored (no capture, no write)', async () => {
    await loadWorker();
    const fake = getChromeFake();
    await seedWindow(['https://a.example/'], true);
    const getAllSpy = vi.spyOn(chrome.windows, 'getAll');

    fake.fire.alarm('someone-elses-alarm');
    // Give a (wrongly) started snapshot every chance to land before asserting nothing did.
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(getAllSpy).not.toHaveBeenCalled();
    expect(sessionKeys()).toHaveLength(0);
  });

  it('an alarm while history is off stores nothing and never queries windows', async () => {
    const { sessionRepo } = await loadWorker();
    const fake = getChromeFake();
    await sessionRepo.setSettings({ historyEnabled: false });
    await seedWindow(['https://a.example/'], true);
    const getAllSpy = vi.spyOn(chrome.windows, 'getAll');

    fake.fire.alarm(HISTORY_ALARM);
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(getAllSpy).not.toHaveBeenCalled();
    expect(sessionKeys()).toHaveLength(0);
  });

  it('a failed alarm snapshot is reported, not thrown, and leaves the badge alone', async () => {
    await loadWorker();
    const fake = getChromeFake();
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    await seedWindow(['https://a.example/'], true);
    fake.failNext('storage.local.set', 1, 'QUOTA_BYTES exceeded');

    expect(() => fake.fire.alarm(HISTORY_ALARM)).not.toThrow();

    await vi.waitFor(() => {
      expect(errorSpy).toHaveBeenCalledWith('[tabinet:sessions]', expect.any(Error));
    });
    expect(sessionKeys()).toHaveLength(0);
    // History is silent: only explicit saves drive the action badge.
    expect(fake.state.badge.text).toBe('');
  });

  it("the icon click takes a concurrent origin 'manual' snapshot while history is on", async () => {
    await loadWorker();
    const fake = getChromeFake();
    await seedWindow(['https://a.example/', 'https://b.example/'], true);

    fake.fire.actionClicked();

    await vi.waitFor(() => {
      expect(historySummaries()).toHaveLength(1);
    });
    expect(historySummaries()[0]).toMatchObject({ origin: 'manual', tabCount: 2 });
  });

  it('the icon click clears a badge left over from an earlier save', async () => {
    await loadWorker();
    const fake = getChromeFake();
    await seedWindow(['https://a.example/'], true);
    // A '!' armed by a failed save whose 2 s clear timer died with the service worker.
    fake.state.badge.text = '!';

    fake.fire.actionClicked();

    expect(fake.state.badge.text).toBe('');
  });

  it('the icon click takes no snapshot while history is off (windows are not queried)', async () => {
    const { sessionRepo } = await loadWorker();
    const fake = getChromeFake();
    await sessionRepo.setSettings({ historyEnabled: false });
    await seedWindow(['https://a.example/'], true);
    const getAllSpy = vi.spyOn(chrome.windows, 'getAll');

    fake.fire.actionClicked();
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(getAllSpy).not.toHaveBeenCalled();
    expect(sessionKeys()).toHaveLength(0);
  });

  it('the icon-click listener returns synchronously and never throws, even when storage fails', async () => {
    await loadWorker();
    const fake = getChromeFake();
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    await seedWindow(['https://a.example/'], true);
    fake.failNext('storage.local.set', 1, 'QUOTA_BYTES exceeded');

    // fire.actionClicked runs every listener synchronously: a throwing snapshot listener would
    // surface here and (in Chrome) break the sort listener registered next to it.
    expect(() => fake.fire.actionClicked()).not.toThrow();

    await vi.waitFor(() => {
      expect(errorSpy).toHaveBeenCalledWith('[tabinet:sessions]', expect.any(Error));
    });
    expect(sessionKeys()).toHaveLength(0);
  });

  it('a second icon click with an unchanged layout is deduplicated by the content hash', async () => {
    await loadWorker();
    const fake = getChromeFake();
    await seedWindow(['https://a.example/'], true);

    fake.fire.actionClicked();
    await vi.waitFor(() => {
      expect(historySummaries()).toHaveLength(1);
    });
    fake.fire.actionClicked();
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(historySummaries()).toHaveLength(1);
  });

  it('turning history off through sessionSettings clears both alarms', async () => {
    const { sessionRepo } = await loadWorker();
    await chrome.alarms.create(HISTORY_ALARM, { periodInMinutes: 5 });
    await chrome.alarms.create(HISTORY_FIRST_ALARM, { delayInMinutes: 1 });
    await chrome.alarms.create('unrelated', { delayInMinutes: 3 });

    await sessionRepo.setSettings({ historyEnabled: false });

    await vi.waitFor(() => {
      expect(alarmNames()).toEqual(['unrelated']);
    });
  });

  it('turning history on / changing the interval re-arms the periodic alarm', async () => {
    const { sessionRepo } = await loadWorker();
    await sessionRepo.setSettings({ historyEnabled: false });
    await vi.waitFor(() => {
      expect(alarmNames()).toEqual([]);
    });

    await sessionRepo.setSettings({ historyEnabled: true, historyIntervalMinutes: 30 });

    await vi.waitFor(() => {
      expect(getChromeFake().state.alarms.get(HISTORY_ALARM)).toEqual({ periodInMinutes: 30 });
    });
    expect(alarmNames()).toEqual([HISTORY_ALARM]);

    await sessionRepo.setSettings({ historyIntervalMinutes: 10 });

    await vi.waitFor(() => {
      expect(getChromeFake().state.alarms.get(HISTORY_ALARM)).toEqual({ periodInMinutes: 10 });
    });
    expect(alarmNames()).toEqual([HISTORY_ALARM]);
  });

  it('storage changes to other keys or the sync area do not touch the alarms', async () => {
    const { sessionRepo } = await loadWorker();
    const createSpy = vi.spyOn(chrome.alarms, 'create');
    const clearSpy = vi.spyOn(chrome.alarms, 'clear');

    await sessionRepo.setHistoryMeta({ lastHash: 'abcd1234', lastSnapshotAt: Date.now() });
    await chrome.storage.local.set({ unrelatedLocalKey: 1 });
    // Same key name in the wrong area (SortSettings live in sync; SessionSettings never do).
    await chrome.storage.sync.set({ [SETTINGS_KEY]: { historyEnabled: false }, sortBy: 'url' });
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(createSpy).not.toHaveBeenCalled();
    expect(clearSpy).not.toHaveBeenCalled();
    expect(alarmNames()).toEqual([]);
  });

  it('removing sessionSettings falls back to the defaults (history on) and arms the alarm', async () => {
    const { sessionRepo } = await loadWorker();
    await sessionRepo.setSettings({ historyEnabled: false });
    await vi.waitFor(() => {
      expect(alarmNames()).toEqual([]);
    });

    // Raw removal on purpose: models a future "Delete all session data" wiping the key.
    await chrome.storage.local.remove(SETTINGS_KEY);

    await vi.waitFor(() => {
      expect(getChromeFake().state.alarms.get(HISTORY_ALARM)).toEqual({ periodInMinutes: 5 });
    });
  });

  it('onInstalled (install) arms the periodic alarm after reconcile, with the default interval', async () => {
    const { sessionRepo } = await loadWorker();
    const fake = getChromeFake();
    const reconcileSpy = vi.spyOn(sessionRepo, 'reconcile');
    const createSpy = vi.spyOn(chrome.alarms, 'create');

    fake.fire.installed({ reason: 'install' });

    await vi.waitFor(() => {
      expect(getChromeFake().state.alarms.get(HISTORY_ALARM)).toEqual({ periodInMinutes: 5 });
    });
    expect(alarmNames()).toEqual([HISTORY_ALARM]);
    expect(fake.state.menus).toHaveLength(3);
    expect(reconcileSpy).toHaveBeenCalledTimes(1);
    expect(reconcileSpy.mock.invocationCallOrder[0]).toBeLessThan(
      createSpy.mock.invocationCallOrder[0],
    );
  });

  it('onInstalled (update) re-asserts the alarm Chrome dropped, replacing without duplicates', async () => {
    const { sessionRepo } = await loadWorker();
    const fake = getChromeFake();
    await sessionRepo.setSettings({ historyIntervalMinutes: 10 });
    await vi.waitFor(() => {
      expect(alarmNames()).toEqual([HISTORY_ALARM]);
    });
    fake.state.alarms.clear();

    fake.fire.installed({ reason: 'update', previousVersion: '6.0.0' });

    await vi.waitFor(() => {
      expect(getChromeFake().state.alarms.get(HISTORY_ALARM)).toEqual({ periodInMinutes: 10 });
    });
    expect(await chrome.alarms.getAll()).toHaveLength(1);
  });

  it('onInstalled leaves the alarms empty while history is off', async () => {
    const { sessionRepo } = await loadWorker();
    const fake = getChromeFake();
    await sessionRepo.setSettings({ historyEnabled: false });
    const reconcileSpy = vi.spyOn(sessionRepo, 'reconcile');

    fake.fire.installed({ reason: 'install' });

    await vi.waitFor(() => {
      expect(reconcileSpy).toHaveBeenCalledTimes(1);
      expect(fake.state.menus).toHaveLength(3);
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(alarmNames()).toEqual([]);
  });

  it('onStartup promotes the last snapshot, arms the periodic alarm and the one-shot first alarm', async () => {
    vi.useFakeTimers({ toFake: ['Date'], now: new Date(2026, 7, 29, 14, 3).getTime() });
    const { sessionRepo } = await loadWorker();
    const fake = getChromeFake();
    const olderAt = new Date(2026, 7, 29, 13, 50).getTime();
    const newestAt = new Date(2026, 7, 29, 13, 58).getTime();
    await sessionRepo.put(historySession('older', olderAt));
    await sessionRepo.put(historySession('newest', newestAt));
    fake.state.badge.text = '✓';

    fake.fire.startup();

    await vi.waitFor(() => {
      expect(alarmNames()).toEqual([HISTORY_FIRST_ALARM, HISTORY_ALARM]);
    });
    expect(fake.state.badge.text).toBe('');
    expect(fake.state.alarms.get(HISTORY_ALARM)).toEqual({ periodInMinutes: 5 });
    expect(fake.state.alarms.get(HISTORY_FIRST_ALARM)).toEqual({ delayInMinutes: 1 });
    const byId = Object.fromEntries(
      (await sessionRepo.listSummaries()).map((s) => [s.id, [s.origin, s.protected]]),
    );
    expect(byId).toEqual({ newest: ['recovered', true], older: ['alarm', undefined] });
    expect(await sessionRepo.get('newest')).toMatchObject({
      origin: 'recovered',
      protected: true,
      name: 'Previous session (recovered) 2026-08-29 13:58',
    });
  });

  it('onStartup runs reconcile → promote → ensureHistoryAlarm → scheduleFirstSnapshot in order', async () => {
    const { sessionRepo } = await loadWorker();
    const fake = getChromeFake();
    await sessionRepo.put(historySession('only', Date.now() - 60_000));
    const reconcileSpy = vi.spyOn(sessionRepo, 'reconcile');
    const promoteSpy = vi.spyOn(sessionRepo, 'markRecovered');
    const createSpy = vi.spyOn(chrome.alarms, 'create');

    fake.fire.startup();

    await vi.waitFor(() => {
      expect(createSpy).toHaveBeenCalledTimes(2);
    });
    expect(createSpy.mock.calls.map((call) => call[0])).toEqual([
      HISTORY_ALARM,
      HISTORY_FIRST_ALARM,
    ]);
    const order = [
      reconcileSpy.mock.invocationCallOrder[0],
      promoteSpy.mock.invocationCallOrder[0],
      createSpy.mock.invocationCallOrder[0],
      createSpy.mock.invocationCallOrder[1],
    ];
    expect([...order].sort((a, b) => a - b)).toEqual(order);
  });

  it('onStartup with history off still promotes the recovered snapshot but arms no alarm', async () => {
    const { sessionRepo } = await loadWorker();
    const fake = getChromeFake();
    await sessionRepo.setSettings({ historyEnabled: false });
    await sessionRepo.put(historySession('last', Date.now() - 60_000));
    await chrome.alarms.create(HISTORY_ALARM, { periodInMinutes: 5 });

    fake.fire.startup();

    await vi.waitFor(() => {
      expect(alarmNames()).toEqual([]);
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(alarmNames()).toEqual([]);
    expect((await sessionRepo.get('last'))?.origin).toBe('recovered');
  });

  it('onStartup still arms the alarms when the promotion fails (error is reported)', async () => {
    const { sessionRepo } = await loadWorker();
    const fake = getChromeFake();
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    await sessionRepo.put(historySession('gone', Date.now() - 60_000));
    // A dashboard delete racing the startup promotion: the summary is listed but the body
    // is gone by the time markRecovered runs.
    vi.spyOn(sessionRepo, 'markRecovered').mockRejectedValue(new Error('Session not found: gone'));

    fake.fire.startup();

    await vi.waitFor(() => {
      expect(alarmNames()).toEqual([HISTORY_FIRST_ALARM, HISTORY_ALARM]);
    });
    expect(errorSpy).toHaveBeenCalledWith('[tabinet:sessions]', expect.any(Error));
  });

  it('onStartup still arms the alarms when reconcile rejects (damaged index)', async () => {
    const { sessionRepo } = await loadWorker();
    const fake = getChromeFake();
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    vi.spyOn(sessionRepo, 'reconcile').mockRejectedValue(new Error('Unknown schema version: 2'));

    fake.fire.startup();

    await vi.waitFor(() => {
      expect(alarmNames()).toEqual([HISTORY_FIRST_ALARM, HISTORY_ALARM]);
    });
    expect(errorSpy).toHaveBeenCalledWith('[tabinet:sessions]', expect.any(Error));
  });

  it('onInstalled still arms the alarm when reconcile rejects (damaged index)', async () => {
    const { sessionRepo } = await loadWorker();
    const fake = getChromeFake();
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    vi.spyOn(sessionRepo, 'reconcile').mockRejectedValue(new Error('Unknown schema version: 2'));

    fake.fire.installed({ reason: 'install' });

    await vi.waitFor(() => {
      expect(alarmNames()).toEqual([HISTORY_ALARM]);
    });
    expect(errorSpy).toHaveBeenCalledWith('[tabinet:sessions]', expect.any(Error));
  });

  it('onInstalled still arms the alarm when the menus cannot be registered', async () => {
    await loadWorker();
    const fake = getChromeFake();
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    vi.spyOn(chrome.contextMenus, 'removeAll').mockRejectedValue(new Error('menus unavailable'));

    fake.fire.installed({ reason: 'install' });

    await vi.waitFor(() => {
      expect(alarmNames()).toEqual([HISTORY_ALARM]);
    });
    expect(errorSpy).toHaveBeenCalledWith('[tabinet:sessions]', expect.any(Error));
  });

  it('a browser start on a damaged index repairs it and still arms the alarms', async () => {
    const { sessionRepo } = await loadWorker();
    const fake = getChromeFake();
    // The real hazard behind the mocks above: an index migrateIndex() refuses to read.
    fake.state.local.set(INDEX_KEY, { schemaVersion: 2, sessions: [] });
    fake.state.local.set('session:orphan', historySession('orphan', Date.now() - 60_000));

    fake.fire.startup();

    await vi.waitFor(() => {
      expect(alarmNames()).toEqual([HISTORY_FIRST_ALARM, HISTORY_ALARM]);
    });
    expect((await sessionRepo.listSummaries()).map((s) => s.id)).toEqual(['orphan']);
  });

  it('the first alarm after startup captures the restored windows as a snapshot', async () => {
    await loadWorker();
    const fake = getChromeFake();

    fake.fire.startup();
    await vi.waitFor(() => {
      expect(alarmNames()).toEqual([HISTORY_FIRST_ALARM, HISTORY_ALARM]);
    });
    // Chrome finished restoring its tabs in the meantime …
    await seedWindow(['https://a.example/', 'https://a.example/2'], true);
    // … and the one-shot alarm fires 1 min later.
    fake.fire.alarm(HISTORY_FIRST_ALARM);

    await vi.waitFor(() => {
      expect(historySummaries()).toHaveLength(1);
    });
    expect(historySummaries()[0]).toMatchObject({ origin: 'alarm', tabCount: 2 });
  });
});

describe('the language chosen in Settings', () => {
  /** The menu titles as a language's own messages.json has them. */
  async function menuTitles(locale: string): Promise<(string | undefined)[]> {
    const catalog = toCatalog(await readLocaleFile(locale));
    return [
      catalog.cmdAssembleTabs?.message,
      catalog.workerMenuSaveAll?.message,
      catalog.cmdPauseYoutube?.message,
    ];
  }

  it('titles the menus in the stored language, whatever Chrome is in', async () => {
    vi.stubGlobal('fetch', fetchPackagedFile);
    const fake = getChromeFake();
    fake.setUiLanguage('en');
    fake.state.sync.set(UI_LANGUAGE_KEY, 'ko');
    vi.resetModules();
    await import('@/service-worker');

    fake.fire.installed({ reason: 'install' });

    const korean = await menuTitles('ko');
    await vi.waitFor(() => {
      expect(fake.state.menus.map((menu) => menu.title)).toEqual(korean);
    });
  });

  it('retitles the menus at once when the language is changed', async () => {
    vi.stubGlobal('fetch', fetchPackagedFile);
    const fake = getChromeFake();
    vi.resetModules();
    await import('@/service-worker');
    fake.fire.installed({ reason: 'install' });
    const english = await menuTitles('en');
    await vi.waitFor(() => {
      expect(fake.state.menus.map((menu) => menu.title)).toEqual(english);
    });

    await chrome.storage.sync.set({ [UI_LANGUAGE_KEY]: 'ja' });

    const japanese = await menuTitles('ja');
    await vi.waitFor(() => {
      expect(fake.state.menus.map((menu) => menu.title)).toEqual(japanese);
    });

    await chrome.storage.sync.set({ [UI_LANGUAGE_KEY]: 'auto' });

    await vi.waitFor(() => {
      expect(fake.state.menus.map((menu) => menu.title)).toEqual(english);
    });
  });

  it('names a saved session in the stored language, waiting for it to load', async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    // The worker was just woken by the command: the language files arrive only after it fires.
    vi.stubGlobal('fetch', async (input: string | URL | Request) => {
      await gate;
      return fetchPackagedFile(input);
    });
    const fake = getChromeFake();
    fake.state.sync.set(UI_LANGUAGE_KEY, 'es');
    await seedWindow(['https://a.example/'], true);
    vi.resetModules();
    await import('@/service-worker');
    const { sessionRepo } = await import('@/lib/session-repo');

    fake.fire.command(COMMAND_IDS.saveSession);
    for (let turn = 0; turn < 50; turn++) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    // Still waiting for the language: saved now, it would be named in Chrome's.
    expect(sessionKeys()).toEqual([]);

    release();
    await vi.waitFor(async () => {
      expect(await sessionRepo.listSummaries()).toHaveLength(1);
    });
    const [summary] = await sessionRepo.listSummaries();
    // Spanish counts the window as "1 ventana"; English would say "1 window".
    fake.setUiLanguage('es');
    expect(summary?.name).toContain(chrome.i18n.getMessage('windowCount_one', ['1']));
  });
});
