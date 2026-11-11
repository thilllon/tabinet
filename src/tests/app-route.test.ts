import { describe, expect, it } from 'vitest';

import {
  formatRoute,
  HOME,
  parseRoute,
  routeOfEntryBelow,
  routeSessionId,
  viewBehind,
} from '@/lib/app-route';

describe('parseRoute', () => {
  it('reads every view from its hash, with or without the leading #', () => {
    expect(parseRoute('')).toEqual(HOME);
    expect(parseRoute('#')).toEqual(HOME);
    expect(parseRoute('#open')).toEqual(HOME);
    expect(parseRoute('#settings')).toEqual({ view: 'settings' });
    expect(parseRoute('#saved/abc-123')).toEqual({ view: 'saved', id: 'abc-123' });
    expect(parseRoute('auto/abc-123')).toEqual({ view: 'auto', id: 'abc-123' });
    expect(parseRoute('#search/tab%20organizer')).toEqual({
      view: 'search',
      query: 'tab organizer',
    });
  });

  it('falls back to the open tabs view for anything it does not recognise', () => {
    expect(parseRoute('#nope')).toEqual(HOME);
    expect(parseRoute('#saved/')).toEqual(HOME);
    expect(parseRoute('#saved')).toEqual(HOME);
    expect(parseRoute('#search/')).toEqual(HOME);
  });

  it('reads the part of Settings to bring into view, and ignores one it does not know', () => {
    expect(parseRoute('#settings/youtube')).toEqual({ view: 'settings', focus: 'youtube' });
    expect(parseRoute('#settings/nope')).toEqual({ view: 'settings' });
    expect(parseRoute('#settings/')).toEqual({ view: 'settings' });
    expect(formatRoute({ view: 'settings', focus: 'youtube' })).toBe('#settings/youtube');
    expect(formatRoute({ view: 'settings' })).toBe('#settings');
  });

  it('keeps a malformed escape as typed instead of throwing', () => {
    expect(parseRoute('#search/%E0%A4%A')).toEqual({ view: 'search', query: '%E0%A4%A' });
  });

  it('round-trips ids and queries that need escaping', () => {
    for (const route of [
      HOME,
      { view: 'settings' },
      { view: 'settings', focus: 'youtube' },
      { view: 'saved', id: 'a/b #c' },
      { view: 'auto', id: '0914-0912' },
      { view: 'search', query: '모두의 창업 #1' },
    ] as const) {
      expect(parseRoute(formatRoute(route))).toEqual(route);
    }
  });
});

describe('routeSessionId', () => {
  it('names the record a route points at', () => {
    expect(routeSessionId({ view: 'saved', id: 'x' })).toBe('x');
    expect(routeSessionId({ view: 'auto', id: 'y' })).toBe('y');
    expect(routeSessionId(HOME)).toBeUndefined();
    expect(routeSessionId({ view: 'search', query: 'x' })).toBeUndefined();
  });
});

describe('viewBehind', () => {
  it('keeps the previous view on screen while Settings is open over it', () => {
    const saved = { view: 'saved', id: 'abc' } as const;
    expect(viewBehind({ view: 'settings' }, saved)).toEqual(saved);
    expect(viewBehind({ view: 'settings' }, HOME)).toEqual(HOME);
    expect(viewBehind({ view: 'settings', focus: 'youtube' }, saved)).toEqual(saved);
  });

  it('shows every other route as itself, whatever came before', () => {
    const search = { view: 'search', query: 'github' } as const;
    expect(viewBehind(search, HOME)).toEqual(search);
    expect(viewBehind(HOME, search)).toEqual(HOME);
  });
});

describe('routeOfEntryBelow', () => {
  const page = '/app.html';
  const base = 'chrome-extension://abc/app.html';

  it('is undefined when there is no entry below', () => {
    expect(routeOfEntryBelow(undefined, page)).toBeUndefined();
    expect(routeOfEntryBelow(null, page)).toBeUndefined();
  });

  it('is undefined when the entry below is another page', () => {
    expect(routeOfEntryBelow('chrome-extension://abc/other.html#saved/x', page)).toBeUndefined();
  });

  it('is undefined when the entry below is Settings itself', () => {
    expect(routeOfEntryBelow(`${base}#settings`, page)).toBeUndefined();
    expect(routeOfEntryBelow(`${base}#settings/youtube`, page)).toBeUndefined();
  });

  it('reads the view the entry below shows', () => {
    expect(routeOfEntryBelow(`${base}#saved/x`, page)).toEqual({ view: 'saved', id: 'x' });
  });

  it('reads an entry without a hash as the open tabs view', () => {
    expect(routeOfEntryBelow(base, page)).toEqual(HOME);
  });
});
