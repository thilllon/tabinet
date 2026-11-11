import { describe, expect, it, vi } from 'vitest';

import {
  hasYoutubeAccess,
  isYoutubeUrl,
  pausableTabIds,
  pauseVideosInPage,
  pauseYoutubeTabs,
  removeYoutubeAccess,
  requestYoutubeAccess,
  touchesYoutubeAccess,
  youtubeAccessHintKey,
} from '@/lib/pause-youtube';

import { fakeMedia, getChromeFake } from './chrome-fake';

const YOUTUBE = 'https://*.youtube.com/*';

async function openTab(url: string): Promise<number> {
  const tab = await chrome.tabs.create({ url, active: false });
  if (tab.id === undefined) {
    throw new Error('fake tabs.create returned no id');
  }
  return tab.id;
}

function tab(overrides: Partial<Omit<chrome.tabs.Tab, 'lastAccessed'>>): chrome.tabs.Tab {
  return {
    id: 1,
    index: 0,
    windowId: 1,
    groupId: -1,
    url: 'https://www.youtube.com/watch?v=a',
    pinned: false,
    active: false,
    highlighted: false,
    selected: false,
    incognito: false,
    discarded: false,
    frozen: false,
    autoDiscardable: true,
    lastAccessed: 0,
    status: 'complete',
    ...overrides,
  };
}

describe('isYoutubeUrl', () => {
  it('takes youtube.com and its subdomains over https', () => {
    expect(isYoutubeUrl('https://www.youtube.com/watch?v=a')).toBe(true);
    expect(isYoutubeUrl('https://m.youtube.com/watch?v=a')).toBe(true);
    expect(isYoutubeUrl('https://music.youtube.com/')).toBe(true);
    expect(isYoutubeUrl('https://youtube.com/')).toBe(true);
  });

  it('refuses look-alikes, other schemes and nothing at all', () => {
    expect(isYoutubeUrl('https://notyoutube.com/')).toBe(false);
    expect(isYoutubeUrl('https://youtube.com.example/')).toBe(false);
    expect(isYoutubeUrl('http://www.youtube.com/')).toBe(false);
    expect(isYoutubeUrl('https://www.youtube-nocookie.com/embed/a')).toBe(false);
    expect(isYoutubeUrl('')).toBe(false);
    expect(isYoutubeUrl(undefined)).toBe(false);
    expect(isYoutubeUrl('not a url')).toBe(false);
  });
});

describe('pausableTabIds', () => {
  it('keeps loaded YouTube tabs in order', () => {
    expect(
      pausableTabIds([
        tab({ id: 3 }),
        tab({ id: 1, url: 'https://music.youtube.com/watch?v=b' }),
        tab({ id: 2, url: 'https://example.com/' }),
      ]),
    ).toEqual([3, 1]);
  });

  it('leaves out discarded and unloaded tabs, and tabs without an id or url', () => {
    expect(
      pausableTabIds([
        tab({ id: 1, discarded: true }),
        tab({ id: 3, status: 'unloaded' }),
        tab({ id: undefined }),
        tab({ id: 5, url: undefined }),
        tab({ id: 6, status: 'loading' }),
      ]),
    ).toEqual([6]);
  });

  it('keeps a frozen tab: its player might start again when Chrome thaws it', () => {
    expect(pausableTabIds([tab({ id: 2, frozen: true })])).toEqual([2]);
  });
});

describe('youtubeAccessHintKey', () => {
  it('waits for Chrome, then explains, and says why Settings opened when the command sent it', () => {
    expect(youtubeAccessHintKey(null, false)).toBe('commonLoading');
    expect(youtubeAccessHintKey(null, true)).toBe('commonLoading');
    expect(youtubeAccessHintKey(false, false)).toBe('settingsYoutubeAccessOffHint');
    expect(youtubeAccessHintKey(false, true)).toBe('settingsYoutubeAccessAskedHint');
    expect(youtubeAccessHintKey(true, false)).toBe('settingsYoutubeAccessOnHint');
    expect(youtubeAccessHintKey(true, true)).toBe('settingsYoutubeAccessOnHint');
  });
});

describe('touchesYoutubeAccess', () => {
  it('is true only for a change that includes the YouTube origin', () => {
    expect(touchesYoutubeAccess({ origins: [YOUTUBE] })).toBe(true);
    expect(touchesYoutubeAccess({ origins: ['https://example.com/*'] })).toBe(false);
    expect(touchesYoutubeAccess({ permissions: ['tabs'] })).toBe(false);
    expect(touchesYoutubeAccess({})).toBe(false);
  });
});

describe('the YouTube access', () => {
  it('is not granted at install, and follows request and remove', async () => {
    const fake = getChromeFake();
    const added = vi.fn();
    const removed = vi.fn();
    chrome.permissions.onAdded.addListener(added);
    chrome.permissions.onRemoved.addListener(removed);

    expect(await hasYoutubeAccess()).toBe(false);
    expect(await requestYoutubeAccess()).toBe(true);
    expect(await hasYoutubeAccess()).toBe(true);
    expect(fake.state.grantedOrigins.has(YOUTUBE)).toBe(true);
    expect(added).toHaveBeenCalledWith({ origins: [YOUTUBE], permissions: [] });

    expect(await removeYoutubeAccess()).toBe(true);
    expect(await hasYoutubeAccess()).toBe(false);
    expect(removed).toHaveBeenCalledWith({ origins: [YOUTUBE], permissions: [] });
  });

  it('stays off when the person declines Chrome’s prompt', async () => {
    getChromeFake().state.permissionAnswer = false;

    expect(await requestYoutubeAccess()).toBe(false);
    expect(await hasYoutubeAccess()).toBe(false);
  });
});

describe('pauseVideosInPage', () => {
  it('pauses every playing video and audio element, keeps their place, and counts them', () => {
    const playing = fakeMedia('VIDEO', { currentTime: 93 });
    const music = fakeMedia('AUDIO', { currentTime: 4 });
    const alreadyPaused = fakeMedia('VIDEO', { paused: true, currentTime: 10 });
    const pause = vi.spyOn(alreadyPaused, 'pause');
    vi.stubGlobal('document', {
      querySelectorAll: (selector: string) => {
        expect(selector).toBe('video, audio');
        return [playing, music, alreadyPaused];
      },
    });
    try {
      expect(pauseVideosInPage()).toBe(2);
    } finally {
      vi.unstubAllGlobals();
    }
    expect(playing).toMatchObject({ paused: true, currentTime: 93 });
    expect(music).toMatchObject({ paused: true, currentTime: 4 });
    expect(pause).not.toHaveBeenCalled();
  });

  it('survives serialization: rebuilt from its source text alone, it still runs', () => {
    // A reference to an import or a closure would only fail when called, so call it.
    const rebuilt: unknown = new Function(`return (${pauseVideosInPage.toString()});`)();
    if (typeof rebuilt !== 'function') {
      throw new Error('pauseVideosInPage did not rebuild into a function');
    }
    const video = fakeMedia('VIDEO');
    vi.stubGlobal('document', { querySelectorAll: () => [video] });
    try {
      expect(Reflect.apply(rebuilt, undefined, [])).toBe(1);
    } finally {
      vi.unstubAllGlobals();
    }
    expect(video.paused).toBe(true);
  });
});

describe('pauseYoutubeTabs', () => {
  it('pauses the videos of every YouTube tab of every window and nothing else', async () => {
    const fake = getChromeFake();
    fake.state.grantedOrigins.add(YOUTUBE);
    const other = await chrome.windows.create({ url: 'https://example.com/' });
    if (other?.id === undefined) {
      throw new Error('fake windows.create returned nothing');
    }
    const first = await openTab('https://www.youtube.com/watch?v=a');
    const music = await openTab('https://music.youtube.com/watch?v=b');
    const second = (
      await chrome.tabs.create({
        windowId: other.id,
        url: 'https://m.youtube.com/watch?v=c',
        active: false,
      })
    ).id;
    const elsewhere = await openTab('https://example.com/video');
    if (second === undefined) {
      throw new Error('fake tabs.create returned no id');
    }
    const media = {
      first: fakeMedia('VIDEO', { currentTime: 12 }),
      music: fakeMedia('AUDIO'),
      second: fakeMedia('VIDEO', { paused: true }),
      elsewhere: fakeMedia('VIDEO'),
    };
    fake.state.pageMedia.set(first, [media.first]);
    fake.state.pageMedia.set(music, [media.music]);
    fake.state.pageMedia.set(second, [media.second]);
    fake.state.pageMedia.set(elsewhere, [media.elsewhere]);

    const result = await pauseYoutubeTabs();

    expect(result).toEqual({ tabs: 3, paused: 2, failed: 0, unanswered: 0, failures: [] });
    expect(fake.state.injectedTabs.toSorted()).toEqual([first, music, second].toSorted());
    expect(media.first).toMatchObject({ paused: true, currentTime: 12 });
    expect(media.music.paused).toBe(true);
    expect(media.elsewhere.paused).toBe(false);
  });

  it('never resumes anything when run again', async () => {
    const fake = getChromeFake();
    fake.state.grantedOrigins.add(YOUTUBE);
    const id = await openTab('https://www.youtube.com/watch?v=a');
    const video = fakeMedia('VIDEO');
    fake.state.pageMedia.set(id, [video]);

    expect((await pauseYoutubeTabs()).paused).toBe(1);
    expect((await pauseYoutubeTabs()).paused).toBe(0);
    expect(video.paused).toBe(true);
  });

  it('skips a discarded tab instead of trying to run in it', async () => {
    const fake = getChromeFake();
    fake.state.grantedOrigins.add(YOUTUBE);
    await openTab('https://example.com/');
    const id = await openTab('https://www.youtube.com/watch?v=a');
    await chrome.tabs.discard(id);

    expect(await pauseYoutubeTabs()).toEqual({
      tabs: 0,
      paused: 0,
      failed: 0,
      unanswered: 0,
      failures: [],
    });
    expect(fake.state.injectedTabs).toEqual([]);
  });

  it('does not wait on a frozen tab, and its pause still lands when Chrome thaws it', async () => {
    const fake = getChromeFake();
    fake.state.grantedOrigins.add(YOUTUBE);
    const frozen = await openTab('https://www.youtube.com/watch?v=a');
    const awake = await openTab('https://www.youtube.com/watch?v=b');
    const sleeping = fakeMedia('VIDEO', { currentTime: 40 });
    const playing = fakeMedia('VIDEO');
    fake.state.pageMedia.set(frozen, [sleeping]);
    fake.state.pageMedia.set(awake, [playing]);
    fake.freezeTab(frozen);

    const result = await pauseYoutubeTabs({ timeoutMs: 20 });

    expect(result).toEqual({ tabs: 2, paused: 1, failed: 0, unanswered: 1, failures: [] });
    expect(playing.paused).toBe(true);
    expect(sleeping.paused).toBe(false);

    fake.thawTab(frozen);
    await vi.waitFor(() => expect(sleeping).toMatchObject({ paused: true, currentTime: 40 }));
  });

  it('keeps going when one tab fails, and reports that tab', async () => {
    const fake = getChromeFake();
    fake.state.grantedOrigins.add(YOUTUBE);
    const first = await openTab('https://www.youtube.com/watch?v=a');
    const second = await openTab('https://www.youtube.com/watch?v=b');
    const video = fakeMedia('VIDEO');
    fake.state.pageMedia.set(second, [video]);
    fake.failNext('scripting.executeScript', 1, 'Frame with ID 0 is showing error page');

    const result = await pauseYoutubeTabs();

    expect(result).toMatchObject({ tabs: 2, paused: 1, failed: 1 });
    expect(result.failures.map((failure) => failure.tabId)).toEqual([first]);
    expect(video.paused).toBe(true);
  });

  it('runs in no page at all without the access', async () => {
    const fake = getChromeFake();
    const id = await openTab('https://www.youtube.com/watch?v=a');
    const video = fakeMedia('VIDEO');
    fake.state.pageMedia.set(id, [video]);

    const result = await pauseYoutubeTabs();

    expect(result).toMatchObject({ tabs: 1, paused: 0, failed: 1 });
    expect(fake.state.injectedTabs).toEqual([]);
    expect(video.paused).toBe(false);
  });
});
