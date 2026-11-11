import { describe, expect, it, vi } from 'vitest';

import {
  notesToLoad,
  changedSessionIds,
  PREWARM_BYTE_BUDGET,
  SearchCorpusCache,
  scheduleIdle,
  selectPrewarmIds,
} from '@/lib/search-corpus';
import { sessionKey, sessionRepo } from '@/lib/session-repo';
import type { Session, SessionSummary } from '@/types';

function makeSession(id: string, urls: string[], overrides: Partial<Session> = {}): Session {
  return {
    schemaVersion: 1,
    id,
    kind: 'saved',
    name: `Session ${id}`,
    origin: 'manual',
    createdAt: 1,
    updatedAt: 2,
    windows: [
      {
        state: 'normal',
        focused: true,
        groups: [],
        tabs: urls.map((url, index) => ({
          url,
          title: `Tab ${index}`,
          pinned: false,
          active: index === 0,
        })),
      },
    ],
    ...overrides,
  };
}

function summary(overrides: Partial<SessionSummary> = {}): SessionSummary {
  return {
    id: 'a',
    kind: 'saved',
    name: 'Session a',
    origin: 'manual',
    createdAt: 1,
    updatedAt: 2,
    windowCount: 1,
    tabCount: 1,
    bytes: 1_000,
    ...overrides,
  };
}

describe('selectPrewarmIds', () => {
  it('takes sessions newest first until the byte budget is spent', () => {
    const summaries = [
      summary({ id: 'a', bytes: 400 }),
      summary({ id: 'b', bytes: 400 }),
      summary({ id: 'c', bytes: 400 }),
      summary({ id: 'd', bytes: 400 }),
    ];

    // 400 + 400 + 400 reaches the 1000-byte budget on the third; the fourth is left to lazy load.
    expect(selectPrewarmIds(summaries, 1_000)).toEqual(['a', 'b', 'c']);
  });

  it('never pre-warms a body this build cannot read', () => {
    const summaries = [
      summary({ id: 'a' }),
      summary({ id: 'future', unreadable: { reason: 'unknown-schema', version: 2 } }),
      summary({ id: 'b' }),
    ];

    expect(selectPrewarmIds(summaries)).toEqual(['a', 'b']);
  });

  it('never pre-warms history snapshots, whatever the budget', () => {
    const summaries = [
      summary({ id: 'h1', kind: 'history', bytes: 10 }),
      summary({ id: 's1', bytes: 10 }),
      summary({ id: 'h2', kind: 'history', bytes: 10 }),
    ];

    expect(selectPrewarmIds(summaries)).toEqual(['s1']);
  });

  it('always takes at least the newest session, even when it alone exceeds the budget', () => {
    const summaries = [
      summary({ id: 'big', bytes: PREWARM_BYTE_BUDGET * 4 }),
      summary({ id: 'b' }),
    ];

    expect(selectPrewarmIds(summaries)).toEqual(['big']);
  });

  it('returns nothing for an empty index', () => {
    expect(selectPrewarmIds([])).toEqual([]);
  });
});

describe('changedSessionIds', () => {
  it('picks the session body keys out of a local storage change batch', () => {
    const changes = {
      [sessionKey('a')]: { newValue: {} },
      sessionIndex: { newValue: {} },
      [sessionKey('b')]: { oldValue: {} },
    };

    expect(changedSessionIds(changes, 'local')).toEqual(['a', 'b']);
  });

  it('ignores other areas and non-session keys', () => {
    expect(changedSessionIds({ [sessionKey('a')]: { newValue: {} } }, 'sync')).toEqual([]);
    expect(changedSessionIds({ sessionSettings: { newValue: {} } }, 'local')).toEqual([]);
  });
});

describe('scheduleIdle', () => {
  it('falls back to a timer when requestIdleCallback is unavailable (Node)', async () => {
    const ran = vi.fn();

    scheduleIdle(ran);
    expect(ran).not.toHaveBeenCalled();
    await new Promise((resolve) => setTimeout(resolve, 5));

    expect(ran).toHaveBeenCalledTimes(1);
  });

  it('cancels a callback that has not run yet', async () => {
    const ran = vi.fn();

    scheduleIdle(ran)();
    await new Promise((resolve) => setTimeout(resolve, 5));

    expect(ran).not.toHaveBeenCalled();
  });
});

describe('SearchCorpusCache', () => {
  it('loads bodies lazily and reuses the cached entries', async () => {
    await sessionRepo.put(makeSession('a', ['https://a.example/one', 'https://a.example/two']));
    const cache = new SearchCorpusCache();

    expect(cache.entriesFor(['a'])).toEqual([]);
    expect(cache.isLoaded('a')).toBe(false);

    await cache.ensureLoaded(['a']);

    expect(cache.isLoaded('a')).toBe(true);
    expect(cache.entriesFor(['a']).map((entry) => entry.url)).toEqual([
      'https://a.example/one',
      'https://a.example/two',
    ]);

    // A second pass must not re-read storage: the entries are the expensive part.
    const get = vi.spyOn(chrome.storage.local, 'get');
    await cache.ensureLoaded(['a']);
    expect(get).not.toHaveBeenCalled();
    get.mockRestore();
  });

  it('reads a whole pre-warm batch in one storage request', async () => {
    await sessionRepo.put(makeSession('a', ['https://a.example/']));
    await sessionRepo.put(makeSession('b', ['https://b.example/']));
    await sessionRepo.put(makeSession('c', ['https://c.example/']));
    const cache = new SearchCorpusCache();
    const get = vi.spyOn(chrome.storage.local, 'get');

    await cache.ensureLoaded(['a', 'b', 'c']);

    expect(get).toHaveBeenCalledTimes(1);
    expect(cache.entriesFor(['a', 'b', 'c']).map((entry) => entry.url)).toEqual([
      'https://a.example/',
      'https://b.example/',
      'https://c.example/',
    ]);
    get.mockRestore();
  });

  it('keeps the rest of a batch when one body cannot be read', async () => {
    await sessionRepo.put(makeSession('a', ['https://a.example/']));
    await chrome.storage.local.set({ [sessionKey('future')]: { schemaVersion: 99, id: 'future' } });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const cache = new SearchCorpusCache();

    await cache.ensureLoaded(['future', 'a', 'gone']);

    expect(cache.entriesFor(['a']).map((entry) => entry.url)).toEqual(['https://a.example/']);
    // Both the unreadable and the deleted body are cached as empty, so no query retries them.
    expect(cache.isLoaded('future')).toBe(true);
    expect(cache.isLoaded('gone')).toBe(true);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it('coalesces concurrent loads of the same session into one read', async () => {
    await sessionRepo.put(makeSession('a', ['https://a.example/one']));
    const cache = new SearchCorpusCache();
    const get = vi.spyOn(chrome.storage.local, 'get');

    await Promise.all([cache.ensureLoaded(['a']), cache.ensureLoaded(['a'])]);

    expect(get).toHaveBeenCalledTimes(1);
    get.mockRestore();
  });

  it('tags entries with the session kind so history stays opt-in', async () => {
    await sessionRepo.put(makeSession('h', ['https://h.example/'], { kind: 'history' }));
    const cache = new SearchCorpusCache();

    await cache.ensureLoaded(['h']);

    expect(cache.entriesFor(['h']).map((entry) => entry.source)).toEqual(['history']);
  });

  it('returns entries for several sessions in the order the ids are given', async () => {
    await sessionRepo.put(makeSession('a', ['https://a.example/']));
    await sessionRepo.put(makeSession('b', ['https://b.example/']));
    const cache = new SearchCorpusCache();

    await cache.ensureLoaded(['a', 'b']);

    expect(cache.entriesFor(['b', 'a']).map((entry) => entry.url)).toEqual([
      'https://b.example/',
      'https://a.example/',
    ]);
  });

  it('reloads a session after invalidate(), and only then sees the new body', async () => {
    await sessionRepo.put(makeSession('a', ['https://old.example/']));
    const cache = new SearchCorpusCache();
    await cache.ensureLoaded(['a']);

    await sessionRepo.put(makeSession('a', ['https://new.example/']));
    await cache.ensureLoaded(['a']);
    expect(cache.entriesFor(['a']).map((entry) => entry.url)).toEqual(['https://old.example/']);

    expect(cache.invalidate('a')).toBe(true);
    expect(cache.isLoaded('a')).toBe(false);
    await cache.ensureLoaded(['a']);

    expect(cache.entriesFor(['a']).map((entry) => entry.url)).toEqual(['https://new.example/']);
  });

  it('reports nothing to drop when invalidating a session it never loaded', () => {
    expect(new SearchCorpusCache().invalidate('nope')).toBe(false);
  });

  it('invalidates through chrome.storage.onChanged while subscribed, and stops after unsubscribe', async () => {
    await sessionRepo.put(makeSession('a', ['https://old.example/']));
    const cache = new SearchCorpusCache();
    await cache.ensureLoaded(['a']);
    const invalidated: string[][] = [];
    const unsubscribe = cache.subscribe((ids) => invalidated.push(ids));

    await sessionRepo.put(makeSession('a', ['https://new.example/']));

    expect(invalidated).toEqual([['a']]);
    expect(cache.isLoaded('a')).toBe(false);

    await cache.ensureLoaded(['a']);
    unsubscribe();
    await sessionRepo.put(makeSession('a', ['https://newer.example/']));

    expect(invalidated).toEqual([['a']]);
    expect(cache.isLoaded('a')).toBe(true);
  });

  it('drops ids that vanished from the index', async () => {
    await sessionRepo.put(makeSession('a', ['https://a.example/']));
    await sessionRepo.put(makeSession('b', ['https://b.example/']));
    const cache = new SearchCorpusCache();
    await cache.ensureLoaded(['a', 'b']);

    expect(cache.retain(['a'])).toEqual(['b']);

    expect(cache.loadedCount).toBe(1);
    expect(cache.isLoaded('b')).toBe(false);
    expect(cache.entriesFor(['a', 'b']).map((entry) => entry.url)).toEqual(['https://a.example/']);
  });

  it('drops a load still in flight for an id that left the index', async () => {
    await sessionRepo.put(makeSession('a', ['https://a.example/']));
    const cache = new SearchCorpusCache();

    const loading = cache.ensureLoaded(['a']);
    expect(cache.retain([])).toEqual(['a']);
    await loading;

    expect(cache.isLoaded('a')).toBe(false);
    expect(cache.entriesFor(['a'])).toEqual([]);
  });

  it('caches an empty list for a session that no longer has a body', async () => {
    const cache = new SearchCorpusCache();

    await cache.ensureLoaded(['gone']);

    expect(cache.isLoaded('gone')).toBe(true);
    expect(cache.entriesFor(['gone'])).toEqual([]);
  });

  it('caches an empty list for a body it cannot read, instead of retrying every query', async () => {
    await chrome.storage.local.set({ [sessionKey('future')]: { schemaVersion: 99, id: 'future' } });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const cache = new SearchCorpusCache();

    await cache.ensureLoaded(['future']);
    const get = vi.spyOn(chrome.storage.local, 'get');
    await cache.ensureLoaded(['future']);

    expect(cache.entriesFor(['future'])).toEqual([]);
    expect(get).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalled();
    get.mockRestore();
    warn.mockRestore();
  });

  it('counts only the changes that move entries in or out of the cache', async () => {
    await sessionRepo.put(makeSession('a', ['https://a.example/']));
    const cache = new SearchCorpusCache();
    expect(cache.mutations).toBe(0);

    await cache.ensureLoaded(['a']);
    const afterLoad = cache.mutations;
    expect(afterLoad).toBeGreaterThan(0);

    // Nothing to load and nothing to drop: the corpus is unchanged, and callers can tell.
    await cache.ensureLoaded(['a']);
    cache.invalidate('never-cached');
    cache.retain(['a']);
    expect(cache.mutations).toBe(afterLoad);

    cache.invalidate('a');
    expect(cache.mutations).toBe(afterLoad + 1);
  });

  it('forgets everything on clear()', async () => {
    await sessionRepo.put(makeSession('a', ['https://a.example/']));
    const cache = new SearchCorpusCache();
    await cache.ensureLoaded(['a']);

    cache.clear();

    expect(cache.loadedCount).toBe(0);
    expect(cache.entriesFor(['a'])).toEqual([]);
  });
});

describe('notesToLoad', () => {
  const summary = (videoId: string, updatedAt: number) => ({
    videoId,
    url: `https://www.youtube.com/watch?v=${videoId}`,
    title: videoId,
    entryCount: 1,
    createdAt: 1,
    updatedAt,
  });

  it('reads the videos not read yet and those changed since', () => {
    const loaded = new Map([
      ['same', 10],
      ['changed', 10],
    ]);
    expect(
      notesToLoad([summary('new', 5), summary('same', 10), summary('changed', 11)], loaded),
    ).toEqual(['new', 'changed']);
    expect(notesToLoad([], loaded)).toEqual([]);
  });
});
