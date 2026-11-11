import { describe, expect, it } from 'vitest';

import {
  extractGroupingKey,
  findDuplicateTabs,
  isSuspended,
  sortByCustom,
  sortByTitleOrUrl,
  sortedByKey,
  tabToUrl,
  urlSortKey,
} from '@/lib/sort-order';

/** How the url sort orders two urls: their `urlSortKey`s, compared as the sorter does. */
function compareByUrlComponents(a: URL, b: URL): number {
  return urlSortKey(a).localeCompare(urlSortKey(b));
}

describe('url sort order', () => {
  it('sorts URLs alphabetically by hostname', () => {
    const a = new URL('https://apple.com');
    const b = new URL('https://banana.com');
    expect(compareByUrlComponents(a, b)).toBeLessThan(0);
    expect(compareByUrlComponents(b, a)).toBeGreaterThan(0);
  });

  it('returns 0 for identical URLs', () => {
    const a = new URL('https://example.com/path');
    const b = new URL('https://example.com/path');
    expect(compareByUrlComponents(a, b)).toBe(0);
  });

  it('strips www. prefix for comparison', () => {
    const a = new URL('https://www.example.com/page');
    const b = new URL('https://example.com/page');
    expect(compareByUrlComponents(a, b)).toBe(0);
  });

  it('considers pathname in comparison', () => {
    const a = new URL('https://example.com/aaa');
    const b = new URL('https://example.com/zzz');
    expect(compareByUrlComponents(a, b)).toBeLessThan(0);
  });

  it('considers search params in comparison', () => {
    const a = new URL('https://example.com/path?a=1');
    const b = new URL('https://example.com/path?z=1');
    expect(compareByUrlComponents(a, b)).toBeLessThan(0);
  });

  it('considers hash in comparison', () => {
    const a = new URL('https://example.com/path#aaa');
    const b = new URL('https://example.com/path#zzz');
    expect(compareByUrlComponents(a, b)).toBeLessThan(0);
  });

  it('handles chrome:// URLs', () => {
    const a = new URL('chrome://extensions/');
    const b = new URL('chrome://settings/');
    expect(compareByUrlComponents(a, b)).toBeLessThan(0);
    expect(compareByUrlComponents(b, a)).toBeGreaterThan(0);
  });

  it('handles chrome-extension:// URLs', () => {
    const a = new URL('chrome-extension://abcdef/popup.html');
    const b = new URL('chrome-extension://zyxwvu/options.html');
    expect(compareByUrlComponents(a, b)).toBeLessThan(0);
  });

  it('handles file:// URLs', () => {
    const a = new URL('file:///Users/test/doc.html');
    const b = new URL('file:///Users/test/readme.html');
    expect(compareByUrlComponents(a, b)).toBeLessThan(0);
  });

  it('handles chrome:// URLs with subpages', () => {
    const a = new URL('chrome://settings/privacy');
    const b = new URL('chrome://settings/security');
    expect(compareByUrlComponents(a, b)).toBeLessThan(0);
  });
});

describe('extractGroupingKey', () => {
  it('returns full hostname in subdomain mode', () => {
    expect(extractGroupingKey('docs.google.com', 'subdomain')).toBe('docs.google.com');
  });

  it('returns base domain in domain mode', () => {
    expect(extractGroupingKey('docs.google.com', 'domain')).toBe('google.com');
  });

  it('handles two-part TLDs like co.uk', () => {
    expect(extractGroupingKey('www.example.co.uk', 'domain')).toBe('example.co.uk');
  });

  it('handles simple hostname in domain mode', () => {
    expect(extractGroupingKey('example.com', 'domain')).toBe('example.com');
  });

  it('handles known second-level domains', () => {
    expect(extractGroupingKey('app.example.ac.kr', 'domain')).toBe('example.ac.kr');
    expect(extractGroupingKey('shop.example.com.au', 'domain')).toBe('example.com.au');
  });
});

/** The Marvellous Suspender's placeholder page, and another suspender's (any 32-letter a-p id). */
const MARVELLOUS = 'chrome-extension://noogafoofpebimajpfpamcfhoaifemoa/suspended.html#';
const OTHER_SUSPENDER = 'chrome-extension://klbibkeccnjlkjkiokjodocebajanakg/suspended.html#';

describe('isSuspended', () => {
  it('returns false for normal tab', () => {
    const tab = makeTab({ url: 'https://example.com' });
    expect(isSuspended(tab)).toBe(false);
  });

  it('returns false for tab without URL', () => {
    const tab = makeTab({ url: undefined });
    expect(isSuspended(tab)).toBe(false);
  });

  it('returns false for chrome:// URL', () => {
    const tab = makeTab({ url: 'chrome://settings/' });
    expect(isSuspended(tab)).toBe(false);
  });
});

describe('tabToUrl', () => {
  it('returns tab URL directly when groupSuspendedTabs is true', () => {
    const tab = makeTab({ url: 'https://example.com/page' });
    const result = tabToUrl(tab, true);
    expect(result.href).toBe('https://example.com/page');
  });

  it('returns pendingUrl when url is not available', () => {
    const tab = makeTab({ url: undefined, pendingUrl: 'https://pending.com' });
    const result = tabToUrl(tab, false);
    expect(result.href).toBe('https://pending.com/');
  });

  it('returns tab url for normal tabs', () => {
    const tab = makeTab({ url: 'https://example.com' });
    const result = tabToUrl(tab, false);
    expect(result.href).toBe('https://example.com/');
  });

  // Chrome reports a still-loading tab as `url: ''` with the destination in `pendingUrl`.
  it('prefers pendingUrl over an empty url with groupSuspendedTabs off', () => {
    const tab = makeTab({ url: '', pendingUrl: 'https://loading.example/page' });
    expect(tabToUrl(tab, false).href).toBe('https://loading.example/page');
  });

  it('prefers pendingUrl over an empty url with groupSuspendedTabs on', () => {
    const tab = makeTab({ url: '', pendingUrl: 'https://loading.example/page' });
    expect(tabToUrl(tab, true).href).toBe('https://loading.example/page');
  });

  it('both exits agree on a navigating tab that still has its old url', () => {
    const tab = makeTab({ url: 'https://old.example/', pendingUrl: 'https://new.example/' });
    expect(tabToUrl(tab, true).href).toBe(tabToUrl(tab, false).href);
  });

  it('returns the sentinel instead of throwing when a tab has no url at all', () => {
    const tab = makeTab({ url: '', pendingUrl: undefined });
    expect(() => tabToUrl(tab, false)).not.toThrow();
    expect(() => tabToUrl(tab, true)).not.toThrow();
    expect(tabToUrl(tab, false).href).toBe(tabToUrl(tab, true).href);
    // The sentinel sorts after every real url rather than aborting the whole sort.
    expect(
      compareByUrlComponents(tabToUrl(tab, false), new URL('https://zoo.com/')),
    ).toBeGreaterThan(0);
  });

  it('returns the sentinel for an unparseable suspended uri parameter', () => {
    const tab = makeTab({ url: `${MARVELLOUS}uri=not a url` });
    expect(() => tabToUrl(tab, false)).not.toThrow();
  });

  it('reads a suspended tab as the page it stands for, whichever suspender made it', () => {
    const real = 'https://www.youtube.com/watch?v=abc&list=PL1#t=42';
    for (const prefix of [MARVELLOUS, OTHER_SUSPENDER]) {
      const tab = makeTab({ url: `${prefix}ttl=Video&pos=3&uri=${real}` });
      // Verbatim: the `&list=` and the fragment of the real url survive.
      expect(tabToUrl(tab, false).href).toBe(real);
      // While suspended tabs are kept together they sort by the placeholder itself.
      expect(tabToUrl(tab, true).href).toBe(`${prefix}ttl=Video&pos=3&uri=${real}`);
    }
  });

  it('never reads a uri= parameter out of a page that is not suspended', () => {
    const tab = makeTab({ url: 'https://search.example/?uri=https://elsewhere.example/' });
    expect(tabToUrl(tab, false).href).toBe(
      'https://search.example/?uri=https://elsewhere.example/',
    );
  });
});

describe('findDuplicateTabs', () => {
  it('returns empty map when no duplicates', () => {
    const tabs = [
      makeTab({ id: 1, url: 'https://a.com' }),
      makeTab({ id: 2, url: 'https://b.com' }),
    ];
    const result = findDuplicateTabs(tabs);
    expect(result.size).toBe(0);
  });

  it('detects duplicate tabs by URL', () => {
    const tabs = [
      makeTab({ id: 1, url: 'https://a.com' }),
      makeTab({ id: 2, url: 'https://a.com' }),
      makeTab({ id: 3, url: 'https://b.com' }),
    ];
    const result = findDuplicateTabs(tabs);
    expect(result.size).toBe(1);
    expect(result.get('https://a.com')?.length).toBe(2);
  });

  it('skips tabs without URL', () => {
    const tabs = [
      makeTab({ id: 1, url: undefined, pendingUrl: undefined }),
      makeTab({ id: 2, url: undefined, pendingUrl: undefined }),
    ];
    const result = findDuplicateTabs(tabs);
    expect(result.size).toBe(0);
  });

  it('uses pendingUrl as fallback', () => {
    const tabs = [
      makeTab({ id: 1, url: undefined, pendingUrl: 'https://a.com' }),
      makeTab({ id: 2, url: undefined, pendingUrl: 'https://a.com' }),
    ];
    const result = findDuplicateTabs(tabs);
    expect(result.size).toBe(1);
  });

  it('detects duplicate chrome:// tabs', () => {
    const tabs = [
      makeTab({ id: 1, url: 'chrome://settings/' }),
      makeTab({ id: 2, url: 'chrome://settings/' }),
      makeTab({ id: 3, url: 'chrome://extensions/' }),
    ];
    const result = findDuplicateTabs(tabs);
    expect(result.size).toBe(1);
    expect(result.get('chrome://settings/')?.length).toBe(2);
  });

  it('treats chrome:// and https:// as different URLs', () => {
    const tabs = [
      makeTab({ id: 1, url: 'chrome://settings/' }),
      makeTab({ id: 2, url: 'https://settings/' }),
    ];
    const result = findDuplicateTabs(tabs);
    expect(result.size).toBe(0);
  });
});

describe('sortByTitleOrUrl', () => {
  it('sorts tabs alphabetically by title (A→Z)', () => {
    const tabs = [
      makeTab({ title: 'Zebra', url: 'https://z.com' }),
      makeTab({ title: 'Apple', url: 'https://a.com' }),
      makeTab({ title: 'Mango', url: 'https://m.com' }),
    ];

    sortByTitleOrUrl(tabs, 'title', false, false);

    expect(tabs.map((t) => t.title)).toEqual(['Apple', 'Mango', 'Zebra']);
  });

  it('sorts tabs alphabetically by URL', () => {
    const tabs = [
      makeTab({ url: 'https://zoo.com' }),
      makeTab({ url: 'https://apple.com' }),
      makeTab({ url: 'https://banana.com' }),
    ];

    sortByTitleOrUrl(tabs, 'url', false, false);

    expect(tabs.map((t) => t.url)).toEqual([
      'https://apple.com',
      'https://banana.com',
      'https://zoo.com',
    ]);
  });

  it('does not reorder pinned tabs when sortPinnedTabs is false', () => {
    const tabs = [
      makeTab({ title: 'Zebra', pinned: true }),
      makeTab({ title: 'Apple', pinned: false }),
      makeTab({ title: 'Mango', pinned: false }),
    ];

    sortByTitleOrUrl(tabs, 'title', false, false);

    // Pinned tab should stay in place relative to others
    expect(tabs[0].pinned).toBe(true);
  });

  it('sorts pinned tabs when sortPinnedTabs is true', () => {
    const tabs = [
      makeTab({ title: 'Zebra', pinned: true }),
      makeTab({ title: 'Apple', pinned: true }),
    ];

    sortByTitleOrUrl(tabs, 'title', false, true);

    expect(tabs.map((t) => t.title)).toEqual(['Apple', 'Zebra']);
  });

  it('handles empty title gracefully', () => {
    const tabs = [
      makeTab({ title: 'Beta' }),
      makeTab({ title: undefined }),
      makeTab({ title: 'Alpha' }),
    ];

    sortByTitleOrUrl(tabs, 'title', false, false);

    expect(tabs.map((t) => t.title ?? '')).toEqual(['', 'Alpha', 'Beta']);
  });

  it('handles empty array', () => {
    const tabs: chrome.tabs.Tab[] = [];
    sortByTitleOrUrl(tabs, 'title', false, false);
    expect(tabs).toEqual([]);
  });

  it('sorts mixed chrome:// and https:// tabs by URL', () => {
    const tabs = [
      makeTab({ url: 'https://zoo.com' }),
      makeTab({ url: 'chrome://settings/' }),
      makeTab({ url: 'chrome://extensions/' }),
      makeTab({ url: 'https://apple.com' }),
    ];

    sortByTitleOrUrl(tabs, 'url', false, false);

    expect(tabs.map((t) => t.url)).toEqual([
      'https://apple.com',
      'chrome://extensions/',
      'chrome://settings/',
      'https://zoo.com',
    ]);
  });

  it('sorts tabs with about:blank by URL', () => {
    const tabs = [makeTab({ url: 'https://example.com' }), makeTab({ url: 'about:blank' })];

    sortByTitleOrUrl(tabs, 'url', false, false);

    // about:blank has empty hostname, so it sorts before any domain
    expect(tabs[0].url).toBe('about:blank');
  });

  it('sorts chrome-extension:// tabs by URL', () => {
    const tabs = [
      makeTab({ url: 'chrome-extension://zzz/popup.html' }),
      makeTab({ url: 'chrome-extension://aaa/options.html' }),
    ];

    sortByTitleOrUrl(tabs, 'url', false, false);

    expect(tabs.map((t) => t.url)).toEqual([
      'chrome-extension://aaa/options.html',
      'chrome-extension://zzz/popup.html',
    ]);
  });

  it('sorts file:// tabs by title', () => {
    const tabs = [
      makeTab({ title: 'Readme', url: 'file:///readme.html' }),
      makeTab({ title: 'About', url: 'file:///about.html' }),
    ];

    sortByTitleOrUrl(tabs, 'title', false, false);

    expect(tabs.map((t) => t.title)).toEqual(['About', 'Readme']);
  });

  it('sorts many tabs with diverse URLs including subdomains and special schemes', () => {
    const tabs = [
      makeTab({ url: 'https://www.youtube.com/watch?v=abc123' }),
      makeTab({ url: 'chrome://settings/privacy' }),
      makeTab({ url: 'https://docs.google.com/document/d/1' }),
      makeTab({ url: 'https://mail.google.com/mail/u/0/#inbox' }),
      makeTab({ url: 'about:blank' }),
      makeTab({ url: 'https://github.com/anthropics/claude-code' }),
      makeTab({ url: 'chrome-extension://abcdef/options.html' }),
      makeTab({ url: 'https://ko.wikipedia.org/wiki/JavaScript' }),
      makeTab({ url: 'https://stackoverflow.com/questions/12345' }),
      makeTab({ url: 'https://developer.mozilla.org/en-US/docs/Web/API' }),
      makeTab({ url: 'chrome://extensions/' }),
      makeTab({ url: 'https://www.amazon.com/dp/B09V3KXJPB' }),
      makeTab({ url: 'https://drive.google.com/drive/my-drive' }),
      makeTab({ url: 'https://news.ycombinator.com/' }),
      makeTab({ url: 'file:///Users/test/index.html' }),
      makeTab({ url: 'https://calendar.google.com/calendar/u/0' }),
      makeTab({ url: 'https://app.slack.com/client/T1234/C5678' }),
      makeTab({ url: 'https://www.reddit.com/r/programming/' }),
      makeTab({ url: 'https://translate.google.com/?sl=en&tl=ko' }),
      makeTab({ url: 'chrome://flags/' }),
      makeTab({ url: 'https://console.cloud.google.com/home/dashboard' }),
      makeTab({ url: 'https://www.notion.so/workspace/page-id' }),
      makeTab({ url: 'https://en.wikipedia.org/wiki/TypeScript' }),
      makeTab({ url: 'https://github.com/vercel/next.js/issues' }),
      makeTab({ url: 'https://maps.google.com/maps?q=seoul' }),
    ];

    sortByTitleOrUrl(tabs, 'url', false, false);

    const urls = tabs.map((t) => {
      const u = new URL(t.url ?? '');
      return u.hostname.replace(/^www\./, '') + u.pathname + u.search + u.hash;
    });

    // Verify sorted in ascending order
    for (let i = 1; i < urls.length; i++) {
      expect(urls[i - 1].localeCompare(urls[i])).toBeLessThanOrEqual(0);
    }

    // Verify specific ordering expectations
    const hostnames = tabs.map((t) => new URL(t.url ?? '').hostname.replace(/^www\./, ''));

    // about:blank (empty hostname) should be first
    expect(hostnames[0]).toBe('');

    // chrome-extension:// comes early (hostname is extension ID)
    // amazon.com before github.com
    const amazonIdx = hostnames.indexOf('amazon.com');
    const githubIdx = hostnames.indexOf('github.com');
    expect(amazonIdx).toBeLessThan(githubIdx);

    // Multiple google subdomains should appear (URL sort is by full key, not just domain)
    const googleHostnames = hostnames.filter((h) => h.endsWith('google.com'));
    expect(googleHostnames.length).toBe(7);
    // They should be in alphabetical order among themselves
    const sortedGoogle = [...googleHostnames].sort((a, b) => a.localeCompare(b));
    expect(googleHostnames).toEqual(sortedGoogle);

    // Same domain, different paths: github.com entries should be adjacent
    const githubIndices = hostnames
      .map((h, i) => (h === 'github.com' ? i : -1))
      .filter((i) => i !== -1);
    expect(githubIndices.length).toBe(2);
    expect(githubIndices[1] - githubIndices[0]).toBe(1);

    // Two wikipedia subdomains should both be present and in alphabetical order
    const wikiHostnames = hostnames.filter((h) => h.endsWith('wikipedia.org'));
    expect(wikiHostnames.length).toBe(2);
    expect(wikiHostnames).toEqual([...wikiHostnames].sort((a, b) => a.localeCompare(b)));
  });
});

describe('sorting tabs that have no committed url', () => {
  // Reproduces the icon-click crash: with `groupSuspendedTabs` on, a loading tab (url '') used to
  // reach `new URL('')` and throw, aborting the sort half-way through the window.
  for (const groupSuspendedTabs of [false, true]) {
    it(`sorts a loading tab by its pendingUrl (groupSuspendedTabs: ${String(groupSuspendedTabs)})`, () => {
      const tabs = [
        makeTab({ id: 1, url: 'https://zoo.com/' }),
        makeTab({ id: 2, url: '', pendingUrl: 'https://apple.com/' }),
        makeTab({ id: 3, url: 'https://mango.com/' }),
      ];

      expect(() => sortByTitleOrUrl(tabs, 'url', groupSuspendedTabs, false)).not.toThrow();

      expect(tabs.map((t) => t.id)).toEqual([2, 3, 1]);
    });

    it(`puts a tab with no url at all last (groupSuspendedTabs: ${String(groupSuspendedTabs)})`, () => {
      const tabs = [
        makeTab({ id: 1, url: '', pendingUrl: undefined }),
        makeTab({ id: 2, url: 'https://zoo.com/' }),
        makeTab({ id: 3, url: '', pendingUrl: undefined }),
        makeTab({ id: 4, url: 'https://apple.com/' }),
      ];

      expect(() => sortByTitleOrUrl(tabs, 'url', groupSuspendedTabs, false)).not.toThrow();

      // Real urls first, then the unknown tabs - in their original relative order (stable sort).
      expect(tabs.map((t) => t.id)).toEqual([4, 2, 1, 3]);
    });
  }

  it('sortByCustom groups url-less tabs together instead of throwing', () => {
    const tabs = [
      makeTab({ id: 1, url: 'https://zoo.com/a' }),
      makeTab({ id: 2, url: '', pendingUrl: undefined }),
      makeTab({ id: 3, url: '', pendingUrl: 'https://apple.com/b' }),
      makeTab({ id: 4, url: '', pendingUrl: undefined }),
    ];

    expect(() => sortByCustom(tabs, 'leftToRight', true, false, false, 'subdomain')).not.toThrow();

    // Custom sort keeps groups in first-appearance order: zoo.com, then the two tabs with no url
    // (one group, since they share the sentinel host), then the loading tab's apple.com.
    expect(tabs.map((t) => t.id)).toEqual([1, 2, 4, 3]);
  });
});

describe('sortByCustom preserveOrderWithinGroups with groupSuspendedTabs on', () => {
  /**
   * Two normal tabs of one host in reverse url order, plus two suspended tabs of the same, each
   * suspended by a different suspender: both are recognised without any configured id.
   */
  function fixture(): chrome.tabs.Tab[] {
    return [
      makeTab({ id: 1, url: 'https://example.com/zebra' }),
      makeTab({ id: 2, url: 'https://example.com/apple' }),
      makeTab({ id: 3, url: `${MARVELLOUS}ttl=S&pos=0&uri=https://example.com/mango` }),
      makeTab({ id: 4, url: `${OTHER_SUSPENDER}ttl=S&pos=1&uri=https://example.com/banana` }),
    ];
  }

  function sort(tabs: chrome.tabs.Tab[], preserveOrderWithinGroups: boolean): void {
    sortByCustom(tabs, 'leftToRight', true, preserveOrderWithinGroups, false, 'subdomain');
  }

  it('url-sorts within a group when preserveOrderWithinGroups is off', () => {
    const tabs = fixture();

    sort(tabs, false);

    // Suspended block first (banana < mango by the decoded target url), then the normal group
    // sorted by url: /apple before /zebra. Before the fix the normal group came back as 1, 2 --
    // `groupSuspendedTabs` made the comparator behave as if 'preserve order' were always on.
    expect(tabs.map((t) => t.id)).toEqual([4, 3, 2, 1]);
  });

  it('keeps the original order within a group when preserveOrderWithinGroups is on', () => {
    const tabs = fixture();

    sort(tabs, true);

    expect(tabs.map((t) => t.id)).toEqual([3, 4, 1, 2]);
  });

  it('leaves the suspended block ordered exactly as it was before the fix', () => {
    const off = fixture();
    const on = fixture();

    sort(off, false);
    sort(on, true);

    // The suspended sub-sort has always passed `gsSuspended: false`, so it honoured the switch
    // then and honours it now: url order with it off, capture order with it on.
    expect(off.slice(0, 2).map((t) => t.id)).toEqual([4, 3]);
    expect(on.slice(0, 2).map((t) => t.id)).toEqual([3, 4]);
  });

  it('sorts normal tabs the same whether groupSuspendedTabs is on or off', () => {
    const withGrouping = [
      makeTab({ id: 1, url: 'https://example.com/zebra' }),
      makeTab({ id: 2, url: 'https://example.com/apple' }),
    ];
    const withoutGrouping = withGrouping.map((tab) => ({ ...tab }));

    sortByCustom(withGrouping, 'leftToRight', true, false, false, 'subdomain');
    sortByCustom(withoutGrouping, 'leftToRight', false, false, false, 'subdomain');

    expect(withGrouping.map((t) => t.id)).toEqual([2, 1]);
    expect(withoutGrouping.map((t) => t.id)).toEqual([2, 1]);
  });
});

function makeTab(overrides: Partial<chrome.tabs.Tab> = {}): chrome.tabs.Tab {
  return {
    id: 1,
    index: 0,
    pinned: false,
    highlighted: false,
    windowId: 1,
    active: false,
    incognito: false,
    selected: false,
    discarded: false,
    autoDiscardable: true,
    frozen: false,
    groupId: -1,
    lastAccessed: 0,
    url: 'https://example.com',
    title: 'Example',
    ...overrides,
  };
}

describe('urlSortKey', () => {
  it('drops a leading www. and keeps path, query and fragment', () => {
    expect(urlSortKey(new URL('https://www.example.com/a?b=1#c'))).toBe('example.com/a?b=1#c');
    expect(urlSortKey(new URL('https://WWW.Example.com/'))).toBe('example.com/');
  });
});

describe('sortedByKey', () => {
  it('derives each key once, however many comparisons the sort makes', () => {
    const items = Array.from({ length: 200 }, (_, i) => (i * 7919) % 200);
    let derived = 0;
    const sorted = sortedByKey(
      items,
      (item) => {
        derived += 1;
        return item;
      },
      (a, b) => a - b,
    );
    expect(derived).toBe(items.length);
    expect(sorted).toEqual([...items].sort((a, b) => a - b));
  });

  it('is stable and leaves its input alone', () => {
    const items = [
      { id: 1, rank: 1 },
      { id: 2, rank: 0 },
      { id: 3, rank: 1 },
      { id: 4, rank: 0 },
    ];
    const copy = [...items];
    const sorted = sortedByKey(
      items,
      (item) => item.rank,
      (a, b) => a - b,
    );
    expect(sorted.map((item) => item.id)).toEqual([2, 4, 1, 3]);
    expect(items).toEqual(copy);
  });
});
