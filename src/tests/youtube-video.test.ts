import { describe, expect, it } from 'vitest';

import {
  activeVideoOf,
  canonicalVideoUrl,
  isImageDataUrl,
  cleanVideoTitle,
  entriesByTime,
  formatTimestamp,
  parseVideoId,
  pickVideoTab,
  sameActiveVideo,
  videoUrlAt,
} from '@/lib/youtube-video';
import type { NoteEntry } from '@/types';

const ID = 'dQw4w9WgXcQ';

describe('parseVideoId', () => {
  it.each([
    `https://www.youtube.com/watch?v=${ID}`,
    `https://youtube.com/watch?v=${ID}`,
    `https://m.youtube.com/watch?v=${ID}`,
    `https://music.youtube.com/watch?v=${ID}&list=RDAMVM`,
    `https://www.youtube.com/watch?app=desktop&v=${ID}&t=42s`,
    `http://www.youtube.com/watch?v=${ID}`,
    `https://youtu.be/${ID}`,
    `https://youtu.be/${ID}?t=10`,
    `https://www.youtube.com/shorts/${ID}`,
    `https://www.youtube.com/live/${ID}?feature=share`,
    `https://WWW.YOUTUBE.COM/watch?v=${ID}`,
  ])('reads the id from %s', (url) => {
    expect(parseVideoId(url)).toBe(ID);
  });

  it.each([
    undefined,
    '',
    'not a url',
    'https://www.youtube.com/',
    'https://www.youtube.com/@channel',
    'https://www.youtube.com/playlist?list=PL123',
    'https://www.youtube.com/watch',
    'https://www.youtube.com/watch?v=short',
    `https://www.youtube.com/watch?v=${ID}x`,
    `https://www.youtube.com/watch/extra?v=${ID}`,
    `https://www.youtube.com/shorts/`,
    `https://notyoutube.com/watch?v=${ID}`,
    `https://youtube.com.evil.example/watch?v=${ID}`,
    `https://gaming.youtube.com/watch?v=${ID}`,
    `ftp://www.youtube.com/watch?v=${ID}`,
    `https://youtu.be/`,
  ])('finds no video in %s', (url) => {
    expect(parseVideoId(url)).toBeUndefined();
  });
});

describe('canonicalVideoUrl', () => {
  it('is the www watch url', () => {
    expect(canonicalVideoUrl(ID)).toBe(`https://www.youtube.com/watch?v=${ID}`);
    expect(parseVideoId(canonicalVideoUrl(ID))).toBe(ID);
  });
});

describe('cleanVideoTitle', () => {
  it.each([
    ['Never Gonna Give You Up - YouTube', 'Never Gonna Give You Up'],
    ['(3) Never Gonna Give You Up - YouTube', 'Never Gonna Give You Up'],
    ['(99+) Talk - YouTube', 'Talk'],
    ['Song - YouTube Music', 'Song'],
    ['A - B - YouTube', 'A - B'],
    ['YouTube', 'YouTube'],
    ['', ''],
    [undefined, ''],
  ])('%s reads %s', (title, expected) => {
    expect(cleanVideoTitle(title)).toBe(expected);
  });
});

describe('formatTimestamp', () => {
  it.each([
    [0, '0:00'],
    [5, '0:05'],
    [59.9, '0:59'],
    [60, '1:00'],
    [83, '1:23'],
    [3599, '59:59'],
    [3600, '1:00:00'],
    [3723, '1:02:03'],
    [36_000, '10:00:00'],
    [-4, '0:00'],
    [Number.NaN, '0:00'],
    [Number.POSITIVE_INFINITY, '0:00'],
  ])('%s seconds read %s', (seconds, expected) => {
    expect(formatTimestamp(seconds)).toBe(expected);
  });
});

describe('entriesByTime', () => {
  const entry = (id: string, at: number, createdAt: number): NoteEntry => ({
    id,
    at,
    text: id,
    createdAt,
    updatedAt: createdAt,
  });

  it('orders by time, then by when each was written, without touching the input', () => {
    const entries = [entry('c', 30, 1), entry('a', 10, 5), entry('b2', 20, 9), entry('b1', 20, 2)];
    expect(entriesByTime(entries).map((e) => e.id)).toEqual(['a', 'b1', 'b2', 'c']);
    expect(entries.map((e) => e.id)).toEqual(['c', 'a', 'b2', 'b1']);
  });
});

describe('activeVideoOf', () => {
  function tab(overrides: Partial<Omit<chrome.tabs.Tab, 'lastAccessed'>>): chrome.tabs.Tab {
    return {
      id: 7,
      index: 0,
      windowId: 1,
      groupId: -1,
      pinned: false,
      active: true,
      highlighted: true,
      selected: true,
      incognito: false,
      discarded: false,
      frozen: false,
      autoDiscardable: true,
      lastAccessed: 0,
      status: 'complete',
      ...overrides,
    };
  }

  it('is the tab, its video and its cleaned title', () => {
    expect(
      activeVideoOf(
        tab({ url: `https://www.youtube.com/watch?v=${ID}`, title: '(2) Song - YouTube' }),
      ),
    ).toEqual({ tabId: 7, videoId: ID, title: 'Song' });
  });

  it('reads the address a tab is still navigating to', () => {
    expect(activeVideoOf(tab({ url: '', pendingUrl: `https://youtu.be/${ID}` }))?.videoId).toBe(ID);
  });

  it('is null for no tab, a tab without an id and a page that is not a video', () => {
    expect(activeVideoOf(undefined)).toBeNull();
    expect(activeVideoOf(tab({ id: undefined, url: `https://youtu.be/${ID}` }))).toBeNull();
    expect(activeVideoOf(tab({ url: 'https://www.youtube.com/' }))).toBeNull();
  });
});

describe('sameActiveVideo', () => {
  const video = { tabId: 1, videoId: ID, title: 'Song' };

  it('compares every field, and null with null', () => {
    expect(sameActiveVideo(video, { ...video })).toBe(true);
    expect(sameActiveVideo(video, { ...video, title: 'Other' })).toBe(false);
    expect(sameActiveVideo(video, { ...video, tabId: 2 })).toBe(false);
    expect(sameActiveVideo(null, null)).toBe(true);
    expect(sameActiveVideo(video, null)).toBe(false);
  });
});

describe('isImageDataUrl', () => {
  it('accepts base64 WebP, PNG and JPEG data URLs only', () => {
    expect(isImageDataUrl('data:image/webp;base64,UklGRg==')).toBe(true);
    expect(isImageDataUrl('data:image/png;base64,iVBORw0K')).toBe(true);
    expect(isImageDataUrl('data:image/jpeg;base64,/9j/')).toBe(true);
    expect(isImageDataUrl('data:,')).toBe(false);
    expect(isImageDataUrl('data:image/svg+xml;base64,PHN2Zz4=')).toBe(false);
    expect(isImageDataUrl('data:text/html;base64,PGI+')).toBe(false);
    expect(isImageDataUrl('javascript:alert(1)')).toBe(false);
    expect(isImageDataUrl('data:image/webp;base64,AA"onerror=x')).toBe(false);
  });
});

describe('videoUrlAt', () => {
  it('links the video at whole seconds, cut like the time written beside it', () => {
    expect(videoUrlAt(ID, 83.9)).toBe(`https://www.youtube.com/watch?v=${ID}&t=83s`);
    expect(videoUrlAt(ID, 3725)).toBe(`https://www.youtube.com/watch?v=${ID}&t=3725s`);
    expect(videoUrlAt(ID, -4)).toBe(`https://www.youtube.com/watch?v=${ID}&t=0s`);
    expect(videoUrlAt(ID, Number.NaN)).toBe(`https://www.youtube.com/watch?v=${ID}&t=0s`);
  });
});

describe('pickVideoTab', () => {
  const tab = (overrides: Partial<chrome.tabs.Tab>): chrome.tabs.Tab =>
    ({ id: 1, windowId: 1, index: 0, incognito: false, url: '', ...overrides }) as chrome.tabs.Tab;

  it('finds the tab showing the video in any form of its url', () => {
    const tabs = [
      tab({ id: 1, url: 'https://www.youtube.com/watch?v=otherVideo1' }),
      tab({ id: 2, windowId: 5, url: `https://youtu.be/${ID}?t=10` }),
    ];
    expect(pickVideoTab(tabs, ID)).toEqual({ tabId: 2, windowId: 5 });
  });

  it('reads a navigating tab by its pending url, and never an incognito tab', () => {
    expect(
      pickVideoTab([tab({ id: 3, pendingUrl: `https://m.youtube.com/watch?v=${ID}` })], ID),
    ).toEqual({ tabId: 3, windowId: 1 });
    expect(
      pickVideoTab([tab({ id: 4, incognito: true, url: canonicalVideoUrl(ID) })], ID),
    ).toBeUndefined();
    expect(pickVideoTab([], ID)).toBeUndefined();
  });
});
