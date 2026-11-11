import { describe, expect, it } from 'vitest';

import {
  entriesFromOpenWindows,
  entriesFromSession,
  matchSessionName,
  resultPlace,
  type SearchEntry,
  type SearchSource,
  search,
  splitOnMatches,
  tokenize,
} from '@/lib/search-engine';
import type { Session } from '@/types';

function hostOf(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return '';
  }
}

/** Whether `search()` finds `e` (a saved entry) for these tokens. */
function matchEntry(e: SearchEntry, tokens: string[]): boolean {
  return search([e], tokens.join(' ')).total > 0;
}

/** The order `search()` puts these saved entries in for these tokens. */
function rankEntries(entries: SearchEntry[], tokens: string[]): SearchEntry[] {
  return search(entries, tokens.join(' ')).bySource.saved.entries;
}

function entry(overrides: Partial<SearchEntry> = {}): SearchEntry {
  const url = overrides.url ?? 'https://example.com/';
  return {
    source: 'saved',
    sessionId: 'sess-1',
    sessionName: 'Work',
    sessionUpdatedAt: 1_000,
    windowIndex: 0,
    tabIndex: 0,
    title: 'Example',
    url,
    hostname: hostOf(url),
    ...overrides,
  };
}

function makeSession(overrides: Partial<Session> = {}): Session {
  return {
    schemaVersion: 1,
    id: 'sess-1',
    kind: 'saved',
    name: 'Work',
    origin: 'manual',
    createdAt: 1,
    updatedAt: 2,
    windows: [],
    ...overrides,
  };
}

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
    url: 'https://example.com/',
    title: 'Example',
    ...overrides,
  };
}

function makeWindow(overrides: Partial<chrome.windows.Window> = {}): chrome.windows.Window {
  return {
    id: 1,
    focused: false,
    alwaysOnTop: false,
    incognito: false,
    type: 'normal',
    state: 'normal',
    tabs: [],
    ...overrides,
  };
}

describe('tokenize', () => {
  it('lowercases, splits on any whitespace and de-duplicates in first-seen order', () => {
    expect(tokenize('  GitHub\treact\n React github  ')).toEqual(['github', 'react']);
  });

  it('returns no tokens for an empty or whitespace-only query', () => {
    expect(tokenize('')).toEqual([]);
    expect(tokenize(' \n\t ')).toEqual([]);
  });

  it('folds case of non-ASCII letters', () => {
    expect(tokenize('CAFÉ Über 한국어')).toEqual(['café', 'über', '한국어']);
  });
});

describe('entriesFromSession', () => {
  const session = makeSession({
    id: 'sess-9',
    name: 'Research',
    updatedAt: 42,
    windows: [
      {
        state: 'normal',
        focused: true,
        groups: [{ title: 'Docs', color: 'blue', collapsed: false }],
        tabs: [
          { url: 'https://pinned.example/', title: 'Pinned', pinned: true, active: false },
          { url: 'https://a.example/x', title: 'A', pinned: false, active: true, groupIndex: 0 },
        ],
      },
      {
        state: 'normal',
        focused: false,
        groups: [],
        tabs: [{ url: 'https://b.example/', title: 'B', pinned: false, active: false }],
      },
    ],
  });

  it('flattens windows and tabs with indices, session meta and hostname', () => {
    expect(entriesFromSession(session, 'saved')).toEqual([
      {
        source: 'saved',
        sessionId: 'sess-9',
        sessionName: 'Research',
        sessionUpdatedAt: 42,
        windowIndex: 0,
        tabIndex: 0,
        title: 'Pinned',
        url: 'https://pinned.example/',
        hostname: 'pinned.example',
      },
      {
        source: 'saved',
        sessionId: 'sess-9',
        sessionName: 'Research',
        sessionUpdatedAt: 42,
        windowIndex: 0,
        tabIndex: 1,
        title: 'A',
        url: 'https://a.example/x',
        hostname: 'a.example',
      },
      {
        source: 'saved',
        sessionId: 'sess-9',
        sessionName: 'Research',
        sessionUpdatedAt: 42,
        windowIndex: 1,
        tabIndex: 0,
        title: 'B',
        url: 'https://b.example/',
        hostname: 'b.example',
      },
    ]);
  });

  it('tags entries with the requested source', () => {
    const sources = entriesFromSession(session, 'history').map((e) => e.source);
    expect(sources).toEqual(['history', 'history', 'history']);
  });

  it('precomputes an empty hostname for urls that do not parse or have no host', () => {
    const odd = makeSession({
      windows: [
        {
          state: 'normal',
          focused: false,
          groups: [],
          tabs: [
            { url: 'not a url', title: 'Broken', pinned: false, active: false },
            { url: 'about:blank', title: 'Blank', pinned: false, active: false },
            { url: 'file:///tmp/notes.txt', title: 'Notes', pinned: false, active: false },
            { url: 'chrome://extensions/', title: 'Ext', pinned: false, active: false },
          ],
        },
      ],
    });
    expect(entriesFromSession(odd, 'saved').map((e) => e.hostname)).toEqual([
      '',
      '',
      '',
      'extensions',
    ]);
  });

  it('never copies runtime ids onto saved entries', () => {
    for (const e of entriesFromSession(session, 'saved')) {
      expect(e).not.toHaveProperty('windowId');
      expect(e).not.toHaveProperty('tabId');
    }
  });
});

describe('entriesFromOpenWindows', () => {
  it('maps live tabs in strip order with runtime ids and pendingUrl', () => {
    const windows = [
      makeWindow({
        id: 7,
        tabs: [
          makeTab({ id: 12, index: 1, url: 'https://b.example/', title: 'B', groupId: 100 }),
          makeTab({
            id: 11,
            index: 0,
            url: 'https://old.example/',
            pendingUrl: 'https://new.example/',
            title: 'A',
          }),
        ],
      }),
      makeWindow({
        id: 8,
        tabs: [makeTab({ id: 21, index: 0, url: 'https://c.example/', title: 'C', pinned: true })],
      }),
    ];
    const entries = entriesFromOpenWindows(windows);

    expect(entries).toHaveLength(3);
    expect(entries.map((e) => [e.windowIndex, e.tabIndex, e.windowId, e.tabId])).toEqual([
      [0, 0, 7, 11],
      [0, 1, 7, 12],
      [1, 0, 8, 21],
    ]);
    expect(entries[0]).toMatchObject({
      source: 'open',
      sessionName: '',
      title: 'A',
      url: 'https://new.example/',
      hostname: 'new.example',
    });
    expect(entries[0]).not.toHaveProperty('sessionId');
  });

  it('stamps every entry with the same build-time recency', () => {
    const before = Date.now();
    const entries = entriesFromOpenWindows([
      makeWindow({ tabs: [makeTab({ id: 1, index: 0 }), makeTab({ id: 2, index: 1 })] }),
    ]);
    const after = Date.now();
    expect(entries[0].sessionUpdatedAt).toBe(entries[1].sessionUpdatedAt);
    expect(entries[0].sessionUpdatedAt).toBeGreaterThanOrEqual(before);
    expect(entries[0].sessionUpdatedAt).toBeLessThanOrEqual(after);
  });

  it('drops tabs without a url', () => {
    const windows = [
      makeWindow({
        tabs: [
          makeTab({ id: 1, index: 0, url: undefined, title: 'No url' }),
          makeTab({ id: 2, index: 1, url: '', title: 'Empty url' }),
          makeTab({ id: 3, index: 2, url: 'https://kept.example/', title: 'Kept' }),
        ],
      }),
    ];
    expect(entriesFromOpenWindows(windows).map((e) => e.title)).toEqual(['Kept']);
  });

  it('drops own extension pages only when excludeUrlPrefix is given', () => {
    const own = 'chrome-extension://fakeextid/';
    const windows = [
      makeWindow({
        tabs: [
          makeTab({ id: 1, index: 0, url: `${own}app.html`, title: 'Dashboard' }),
          makeTab({ id: 2, index: 1, url: 'https://kept.example/', title: 'Kept' }),
        ],
      }),
    ];
    expect(entriesFromOpenWindows(windows).map((e) => e.title)).toEqual(['Dashboard', 'Kept']);
    expect(entriesFromOpenWindows(windows, { excludeUrlPrefix: own }).map((e) => e.title)).toEqual([
      'Kept',
    ]);
    // An empty prefix would match every url; treat it as "not given".
    expect(entriesFromOpenWindows(windows, { excludeUrlPrefix: '' })).toHaveLength(2);
  });

  it('omits windowId/tabId when Chrome reports none', () => {
    const entries = entriesFromOpenWindows([
      makeWindow({ id: undefined, tabs: [makeTab({ id: undefined, index: 0 })] }),
    ]);
    expect(entries[0]).not.toHaveProperty('windowId');
    expect(entries[0]).not.toHaveProperty('tabId');
  });

  // `windowTypes: ['normal']` at the call site filters the window *type*, not incognito-ness.
  it('contributes no entries for an incognito window', () => {
    const windows = [
      makeWindow({
        id: 9,
        incognito: true,
        tabs: [makeTab({ id: 90, index: 0, url: 'https://secret.example/', title: 'Secret' })],
      }),
    ];
    expect(entriesFromOpenWindows(windows)).toEqual([]);
  });

  it('keeps a normal window standing beside an incognito one, and numbers it as window 1', () => {
    const windows = [
      makeWindow({
        id: 9,
        incognito: true,
        tabs: [makeTab({ id: 90, index: 0, url: 'https://secret.example/', title: 'Secret' })],
      }),
      makeWindow({
        id: 7,
        tabs: [makeTab({ id: 70, index: 0, url: 'https://kept.example/', title: 'Kept' })],
      }),
    ];

    const entries = entriesFromOpenWindows(windows);

    expect(entries.map((e) => e.title)).toEqual(['Kept']);
    expect(entries.map((e) => [e.windowIndex, e.windowId, e.tabId])).toEqual([[0, 7, 70]]);
  });
});

describe('matching', () => {
  const e = entry({ title: 'React - A JavaScript library', url: 'https://react.dev/learn' });

  it('requires every token to match somewhere (AND)', () => {
    expect(matchEntry(e, tokenize('react learn'))).toBe(true);
    expect(matchEntry(e, tokenize('react vue'))).toBe(false);
  });

  it('matches tokens across title, url and hostname', () => {
    expect(matchEntry(e, ['javascript'])).toBe(true); // title
    expect(matchEntry(e, ['/learn'])).toBe(true); // url only
    expect(matchEntry(e, ['react.dev'])).toBe(true); // hostname
  });

  it('is case-insensitive on the entry side', () => {
    const shouting = entry({ title: 'LOUD TITLE', url: 'https://Example.COM/PATH' });
    expect(matchEntry(shouting, tokenize('loud'))).toBe(true);
    expect(matchEntry(shouting, tokenize('/path'))).toBe(true);
  });

  it('matches unicode titles: Korean and accented letters with case folding', () => {
    const korean = entry({ title: '한국어 문서', url: 'https://ko.example/' });
    expect(matchEntry(korean, tokenize('국어'))).toBe(true);
    expect(matchEntry(korean, tokenize('일본어'))).toBe(false);

    const accented = entry({ title: 'Café Über Straße', url: 'https://cafe.example/' });
    expect(matchEntry(accented, tokenize('CAFÉ über'))).toBe(true);
    expect(matchEntry(accented, tokenize('cafe'))).toBe(true); // via the url
    expect(matchEntry(accented, tokenize('über cafe straße'))).toBe(true);
  });
});

describe('matchSessionName', () => {
  it('ANDs tokens case-insensitively over the name', () => {
    expect(matchSessionName('Work - Sprint 12', tokenize('sprint work'))).toBe(true);
    expect(matchSessionName('Work - Sprint 12', tokenize('sprint 13'))).toBe(false);
    expect(matchSessionName('Проект Альфа', tokenize('альфа'))).toBe(true);
  });

  it('matches every name when there are no tokens', () => {
    expect(matchSessionName('anything', [])).toBe(true);
  });
});

describe('ranking within a source', () => {
  it('orders hostname prefix > title match > url-only match', () => {
    const urlOnly = entry({ title: 'Issues', url: 'https://example.com/github/issues' });
    const titleHit = entry({ title: 'GitHub issues', url: 'https://example.com/issues' });
    const hostHit = entry({ title: 'Issues', url: 'https://github.com/issues' });

    expect(rankEntries([urlOnly, titleHit, hostHit], tokenize('github'))).toEqual([
      hostHit,
      titleHit,
      urlOnly,
    ]);
  });

  it('treats a www. host as a hostname prefix hit', () => {
    const www = entry({ title: 'Home', url: 'https://www.github.com/' });
    const titleHit = entry({ title: 'GitHub', url: 'https://example.com/' });
    const inner = entry({ title: 'Home', url: 'https://mygithub.com/' });
    expect(rankEntries([inner, titleHit, www], ['github'])).toEqual([www, titleHit, inner]);
  });

  it('a hostname substring that is not a prefix does not reach the top tier', () => {
    const substring = entry({ title: 'Home', url: 'https://api.github.com/' });
    const titleHit = entry({ title: 'GitHub', url: 'https://example.com/' });
    expect(rankEntries([substring, titleHit], ['github'])).toEqual([titleHit, substring]);
  });

  it('orders newest session first within a tier and source', () => {
    const old = entry({ sessionId: 'old', title: 'Doc', sessionUpdatedAt: 10 });
    const newer = entry({ sessionId: 'new', title: 'Doc', sessionUpdatedAt: 20 });
    expect(rankEntries([old, newer], ['doc'])).toEqual([newer, old]);
  });

  it('is stable for full ties', () => {
    const first = entry({ title: 'Doc', tabIndex: 0 });
    const second = entry({ title: 'Doc', tabIndex: 1 });
    const third = entry({ title: 'Doc', tabIndex: 2 });
    expect(rankEntries([first, second, third], ['doc'])).toEqual([first, second, third]);
  });

  it('does not mutate its input', () => {
    const a = entry({ title: 'Doc', sessionUpdatedAt: 1 });
    const b = entry({ title: 'Doc', sessionUpdatedAt: 2 });
    const input = [a, b];
    rankEntries(input, ['doc']);
    expect(input).toEqual([a, b]);
  });
});

describe('search', () => {
  const corpus: SearchEntry[] = [
    entry({ source: 'open', title: 'GitHub', url: 'https://github.com/' }),
    entry({ source: 'open', title: 'Mail', url: 'https://mail.example/' }),
    entry({ source: 'saved', title: 'Issue tracker', url: 'https://github.com/org/repo/issues' }),
    entry({ source: 'saved', title: 'Unrelated', url: 'https://other.example/' }),
    entry({ source: 'history', title: 'GitHub Actions', url: 'https://github.com/actions' }),
  ];

  it('returns an empty result with zero counts for an empty or whitespace query', () => {
    for (const query of ['', '   ']) {
      const result = search(corpus, query, { includeHistory: true });
      expect(result).toEqual({
        query,
        tokens: [],
        total: 0,
        bySource: {
          open: { entries: [], count: 0, hasMore: false },
          saved: { entries: [], count: 0, hasMore: false },
          history: { entries: [], count: 0, hasMore: false },
        },
      });
    }
  });

  it('groups matches by source with counts and a total, excluding history by default', () => {
    const result = search(corpus, 'GitHub');
    expect(result.query).toBe('GitHub');
    expect(result.tokens).toEqual(['github']);
    expect(result.bySource.open.entries.map((e) => e.title)).toEqual(['GitHub']);
    expect(result.bySource.saved.entries.map((e) => e.title)).toEqual(['Issue tracker']);
    expect(result.bySource.history).toEqual({ entries: [], count: 0, hasMore: false });
    expect(result.total).toBe(2);
  });

  it('includes history when asked', () => {
    const result = search(corpus, 'github', { includeHistory: true });
    expect(result.bySource.history.entries.map((e) => e.title)).toEqual(['GitHub Actions']);
    expect(result.bySource.history.count).toBe(1);
    expect(result.total).toBe(3);
  });

  it('applies AND semantics across tokens', () => {
    const result = search(corpus, 'github issues');
    expect(result.total).toBe(1);
    expect(result.bySource.saved.entries[0].title).toBe('Issue tracker');
  });

  it('ranks within each source', () => {
    const saved: SearchEntry[] = [
      entry({ source: 'saved', title: 'Old', url: 'https://x.example/docs', sessionUpdatedAt: 1 }),
      entry({ source: 'saved', title: 'Docs', url: 'https://x.example/', sessionUpdatedAt: 1 }),
      entry({ source: 'saved', title: 'Home', url: 'https://docs.example/', sessionUpdatedAt: 1 }),
      entry({ source: 'saved', title: 'Docs', url: 'https://x.example/', sessionUpdatedAt: 2 }),
    ];
    const titles = search(saved, 'docs').bySource.saved.entries.map((e) => [e.title, e.url]);
    expect(titles).toEqual([
      ['Home', 'https://docs.example/'],
      ['Docs', 'https://x.example/'],
      ['Docs', 'https://x.example/'],
      ['Old', 'https://x.example/docs'],
    ]);
    // The two title hits are ordered by recency.
    const docs = search(saved, 'docs').bySource.saved.entries.filter((e) => e.title === 'Docs');
    expect(docs.map((e) => e.sessionUpdatedAt)).toEqual([2, 1]);
  });

  it('cuts each source to limitPerSource, reporting the full count and hasMore', () => {
    const many: SearchEntry[] = [];
    for (let i = 0; i < 5; i += 1) {
      many.push(entry({ source: 'open', title: `Tab ${i}`, sessionUpdatedAt: i }));
      many.push(entry({ source: 'saved', title: `Tab ${i}`, sessionUpdatedAt: i }));
    }
    many.push(entry({ source: 'history', title: 'Tab h', sessionUpdatedAt: 0 }));

    const result = search(many, 'tab', { limitPerSource: 2, includeHistory: true });

    expect(result.bySource.open).toMatchObject({ count: 5, hasMore: true });
    expect(result.bySource.open.entries.map((e) => e.title)).toEqual(['Tab 4', 'Tab 3']);
    expect(result.bySource.saved).toMatchObject({ count: 5, hasMore: true });
    expect(result.bySource.history).toMatchObject({ count: 1, hasMore: false });
    expect(result.bySource.history.entries).toHaveLength(1);
    expect(result.total).toBe(11);
  });

  it('reports hasMore false when the count equals the limit', () => {
    const three = [0, 1, 2].map((i) => entry({ source: 'saved', title: `Tab ${i}` }));
    expect(search(three, 'tab', { limitPerSource: 3 }).bySource.saved).toMatchObject({
      count: 3,
      hasMore: false,
    });
  });

  it('searches 10,000 entries in under 40 ms', () => {
    /*
     * The target is 10,000 entries in under 20 ms. Measured on this machine with
     * `search(big, 'git issue', { includeHistory: true })` repeated 12x per process, over four
     * fresh vitest processes (ms):
     *
     *   cold (first call, JIT still warming): 5.2  6.1  7.6  8.7
     *   warm (calls 2-12):                    1.0 - 3.5, median ~1.8
     *
     * So the 20 ms target is met roughly 2x over even cold. The bound here is 40 ms - ~4.6x the
     * worst cold run - because this is the only figure CI has to hit on a shared runner that can
     * be several times slower than a dev machine, and a flaky perf test gets deleted rather than
     * investigated. It is still tight enough to catch what it is for: an accidental O(n²) or a
     * per-entry `new URL()` creeping back in would cost hundreds of ms, not tens.
     */

    // 5 hosts × 6 words (coprime) so every host/title combination occurs in the corpus.
    const hosts = ['github.com', 'www.google.com', 'docs.example.org', 'mail.example.net', 'x.io'];
    const words = ['GitHub', 'Issue', 'Pull request', 'Dashboard', 'Notes', '한국어 문서'];
    const sources: SearchSource[] = ['open', 'saved', 'history'];
    const big: SearchEntry[] = [];
    for (let i = 0; i < 10_000; i += 1) {
      const hostname = hosts[i % hosts.length];
      big.push(
        entry({
          source: sources[i % sources.length],
          sessionId: `sess-${i % 40}`,
          sessionUpdatedAt: i % 40,
          title: `${words[i % words.length]} page ${i}`,
          url: `https://${hostname}/path/${i}?q=${i}`,
          hostname,
        }),
      );
    }

    const started = performance.now();
    const result = search(big, 'git issue', { includeHistory: true });
    const elapsed = performance.now() - started;

    expect(result.total).toBeGreaterThan(0);
    expect(elapsed).toBeLessThan(40);
  });
});

describe('splitOnMatches', () => {
  it('marks a case-insensitive hit and keeps the original casing', () => {
    expect(splitOnMatches('Hello GitHub World', tokenize('github'))).toEqual([
      { text: 'Hello ', match: false },
      { text: 'GitHub', match: true },
      { text: ' World', match: false },
    ]);
  });

  it('never produces empty segments at the edges', () => {
    expect(splitOnMatches('github', ['github'])).toEqual([{ text: 'github', match: true }]);
    expect(splitOnMatches('github rocks', ['github'])).toEqual([
      { text: 'github', match: true },
      { text: ' rocks', match: false },
    ]);
    expect(splitOnMatches('on github', ['github'])).toEqual([
      { text: 'on ', match: false },
      { text: 'github', match: true },
    ]);
  });

  it('returns one plain segment without tokens and nothing for empty text', () => {
    expect(splitOnMatches('plain', [])).toEqual([{ text: 'plain', match: false }]);
    expect(splitOnMatches('plain', ['zzz', ''])).toEqual([{ text: 'plain', match: false }]);
    expect(splitOnMatches('', ['a'])).toEqual([]);
  });

  it('merges overlapping tokens into one segment', () => {
    expect(splitOnMatches('javascript', ['java', 'script', 'ascr'])).toEqual([
      { text: 'javascript', match: true },
    ]);
    expect(splitOnMatches('xx react-dom yy', ['react', 'ct-do'])).toEqual([
      { text: 'xx ', match: false },
      { text: 'react-do', match: true },
      { text: 'm yy', match: false },
    ]);
  });

  it('merges adjacent hits and self-overlapping repeats', () => {
    expect(splitOnMatches('abcd', ['ab', 'cd'])).toEqual([{ text: 'abcd', match: true }]);
    expect(splitOnMatches('baaab', ['aa'])).toEqual([
      { text: 'b', match: false },
      { text: 'aaa', match: true },
      { text: 'b', match: false },
    ]);
  });

  it('marks every occurrence and tolerates repeated tokens', () => {
    expect(splitOnMatches('foo bar foo', ['foo', 'foo'])).toEqual([
      { text: 'foo', match: true },
      { text: ' bar ', match: false },
      { text: 'foo', match: true },
    ]);
  });

  it('highlights unicode text', () => {
    expect(splitOnMatches('한국어 문서 목록', tokenize('문서'))).toEqual([
      { text: '한국어 ', match: false },
      { text: '문서', match: true },
      { text: ' 목록', match: false },
    ]);
    expect(splitOnMatches('Café Über', tokenize('CAFÉ'))).toEqual([
      { text: 'Café', match: true },
      { text: ' Über', match: false },
    ]);
  });

  it('keeps offsets aligned when lowercasing would change the string length', () => {
    // 'İ'.toLowerCase() is two code units; a naive lowercase would shift every later offset.
    expect(splitOnMatches('İstanbul trip', ['stanbul'])).toEqual([
      { text: 'İ', match: false },
      { text: 'stanbul', match: true },
      { text: ' trip', match: false },
    ]);
  });

  it('round-trips: concatenated segments equal the input', () => {
    const text = 'The quick brown fox jumps over the lazy dog';
    const segments = splitOnMatches(text, tokenize('the o quick'));
    expect(segments.map((s) => s.text).join('')).toBe(text);
    expect(segments.some((s) => s.text === '')).toBe(false);
  });
});

/**
 * Result highlighting goes through `splitOnMatches()` and there is no
 * `dangerouslySetInnerHTML` anywhere - true by construction today, and this is what keeps it true.
 *
 * oxlint's `react/no-danger` (an error in `pnpm lint`) covers the JSX-attribute form; this catches
 * the two ways round it that a lint rule cannot, an `oxlint-disable` comment and the prop passed
 * through `createElement`/a spread object, for the price of one glob.
 */
describe('the source tree', () => {
  // Every module under src/ (these tests left out), as text, through Vite's own glob so the list is exactly what the build
  // sees.
  const SOURCES = import.meta.glob<string>(['../**/*.{ts,tsx}', '!./**'], {
    query: '?raw',
    import: 'default',
    eager: true,
  });

  // Assembled at runtime so this file is not its own violation.
  const FORBIDDEN = ['dangerously', 'SetInnerHTML'].join('');

  /**
   * Comments are stripped first: modules explain *why* they avoid the prop (see `splitOnMatches`
   * above), and a doc comment saying so must not read as a violation. The `(?<!:)` keeps
   * `https://` out of the line-comment rule.
   */
  function code(source: string): string {
    return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(?<!:)\/\/.*$/gm, '');
  }

  it(`never uses ${['dangerously', 'SetInnerHTML'].join('')}`, () => {
    const files = Object.entries(SOURCES);
    // Guard against the glob silently matching nothing (a moved directory would pass vacuously).
    expect(files.length).toBeGreaterThan(50);

    const offenders = files
      .filter(([, source]) => code(source).includes(FORBIDDEN))
      .map(([file]) => file);

    expect(offenders).toEqual([]);
  });
});

describe('resultPlace', () => {
  it('names just the window for an open tab', () => {
    expect(resultPlace({ source: 'open', sessionName: '', windowIndex: 0 })).toBe('Window 1');
  });

  it('names the session and the window for a saved or snapshot tab', () => {
    expect(resultPlace({ source: 'saved', sessionName: 'Work', windowIndex: 1 })).toBe(
      'Work · Window 2',
    );
    expect(resultPlace({ source: 'history', sessionName: 'Snap', windowIndex: 0 })).toBe(
      'Snap · Window 1',
    );
  });
});
