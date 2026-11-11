import { describe, expect, it } from 'vitest';

import { type SearchEntry, search } from '@/lib/search-engine';
import {
  buildSearchGroups,
  flattenSearchItems,
  isEditableTarget,
  NO_HIGHLIGHT,
  nextIndex,
  prevIndex,
  resolveActivation,
  sessionNameMatches,
} from '@/lib/search-nav';
import type { SessionSummary } from '@/types';

function entry(overrides: Partial<SearchEntry> = {}): SearchEntry {
  return {
    source: 'saved',
    sessionId: 'sess-1',
    sessionName: 'Work',
    sessionUpdatedAt: 1_000,
    windowIndex: 0,
    tabIndex: 0,
    title: 'Docs',
    url: 'https://docs.example/',
    hostname: 'docs.example',
    ...overrides,
  };
}

function summary(overrides: Partial<SessionSummary> = {}): SessionSummary {
  return {
    id: 'sess-1',
    kind: 'saved',
    name: 'Work',
    origin: 'manual',
    createdAt: 1,
    updatedAt: 2,
    windowCount: 1,
    tabCount: 1,
    bytes: 10,
    ...overrides,
  };
}

describe('sessionNameMatches', () => {
  const summaries = [
    summary({ id: 'a', name: 'Work reading' }),
    summary({ id: 'b', name: 'Holiday' }),
    summary({ id: 'h', kind: 'history', name: 'Snapshot work' }),
  ];

  it('matches every token against the session name, index order', () => {
    expect(sessionNameMatches(summaries, ['work']).map((item) => item.id)).toEqual(['a']);
  });

  it('includes history snapshots only when asked', () => {
    expect(
      sessionNameMatches(summaries, ['work'], { includeHistory: true }).map((item) => item.id),
    ).toEqual(['a', 'h']);
  });

  it('matches nothing without tokens', () => {
    expect(sessionNameMatches(summaries, [])).toEqual([]);
  });

  it('never offers a session this build cannot read', () => {
    // Activating a tier-1 row restores the session; a body from a newer schema cannot be
    // restored, so it must not be offered here either.
    const withFuture = [
      ...summaries,
      summary({
        id: 'f',
        name: 'Work from the future',
        unreadable: { reason: 'unknown-schema', version: 2 },
      }),
    ];

    expect(sessionNameMatches(withFuture, ['work']).map((item) => item.id)).toEqual(['a']);
  });
});

describe('buildSearchGroups', () => {
  const corpus = [
    entry({ source: 'open', sessionName: 'Open windows', tabId: 7, windowId: 3, title: 'Docs' }),
    entry({ source: 'saved', title: 'Docs saved', tabIndex: 1 }),
    entry({ source: 'history', sessionId: 'hist-1', title: 'Docs snapshot', tabIndex: 2 }),
    entry({
      source: 'notes',
      sessionId: undefined,
      sessionName: 'A video',
      title: 'Docs note',
      videoId: 'abcdefghijk',
      noteId: 'n1',
      at: 12,
    }),
  ];

  it('orders session matches first, then open, saved, notes and history', () => {
    const result = search(corpus, 'docs', { includeHistory: true });

    const groups = buildSearchGroups(result, [summary({ name: 'Docs project' })]);

    expect(groups.map((group) => group.heading)).toEqual([
      'Matching sessions',
      'Open tabs',
      'Saved sessions',
      'Notes',
      'Snapshots',
    ]);
    expect(groups.map((group) => group.startIndex)).toEqual([0, 1, 2, 3, 4]);
    expect(groups.map((group) => group.count)).toEqual([1, 1, 1, 1, 1]);
  });

  it('makes a note a note row, keyed by its video and note', () => {
    const notes = buildSearchGroups(search(corpus, 'docs')).find(
      (group) => group.source === 'notes',
    );
    expect(notes?.items).toEqual([{ kind: 'note', key: 'notes:abcdefghijk:n1', entry: corpus[3] }]);
  });

  it('drops empty groups, so history disappears while it is opted out', () => {
    const groups = buildSearchGroups(search(corpus, 'docs'));

    expect(groups.map((group) => group.source)).toEqual(['open', 'saved', 'notes']);
  });

  it('keeps the per-source count and hasMore of a truncated source', () => {
    const many = Array.from({ length: 5 }, (_, index) =>
      entry({ source: 'open', tabId: index, tabIndex: index }),
    );

    const groups = buildSearchGroups(search(many, 'docs', { limitPerSource: 2 }));

    expect(groups[0].items).toHaveLength(2);
    expect(groups[0].count).toBe(5);
    expect(groups[0].hasMore).toBe(true);
  });

  it('gives every row a distinct key', () => {
    const groups = buildSearchGroups(search(corpus, 'docs', { includeHistory: true }), [summary()]);
    const items = flattenSearchItems(groups);

    expect(new Set(items.map((item) => item.key)).size).toBe(items.length);
    expect(items.map((item) => item.kind)).toEqual(['session', 'tab', 'tab', 'note', 'tab']);
  });

  it('flattens to nothing when nothing matched', () => {
    expect(flattenSearchItems(buildSearchGroups(search(corpus, 'nothing-here')))).toEqual([]);
  });
});

describe('nextIndex / prevIndex', () => {
  it('starts at the top and at the bottom from no highlight', () => {
    expect(nextIndex(NO_HIGHLIGHT, 3)).toBe(0);
    expect(prevIndex(NO_HIGHLIGHT, 3)).toBe(2);
  });

  it('steps and wraps around', () => {
    expect(nextIndex(0, 3)).toBe(1);
    expect(nextIndex(2, 3)).toBe(0);
    expect(prevIndex(2, 3)).toBe(1);
    expect(prevIndex(0, 3)).toBe(2);
  });

  it('stays on the only row of a one-row list', () => {
    expect(nextIndex(0, 1)).toBe(0);
    expect(prevIndex(0, 1)).toBe(0);
  });

  it('reports no highlight for an empty list', () => {
    expect(nextIndex(NO_HIGHLIGHT, 0)).toBe(NO_HIGHLIGHT);
    expect(prevIndex(2, 0)).toBe(NO_HIGHLIGHT);
  });

  it('recovers from a highlight left past the end of a shorter list', () => {
    expect(nextIndex(9, 3)).toBe(0);
    expect(prevIndex(9, 3)).toBe(2);
  });
});

describe('resolveActivation', () => {
  const state = {
    typedQuery: 'docs',
    committedQuery: 'docs',
    highlight: NO_HIGHLIGHT,
    itemCount: 3,
  };

  it('activates the first row when nothing is highlighted', () => {
    expect(resolveActivation(state)).toEqual({ action: 'activate', index: 0 });
  });

  it('activates the highlighted row', () => {
    expect(resolveActivation({ ...state, highlight: 2 })).toEqual({ action: 'activate', index: 2 });
  });

  // "The row I highlighted is gone" is not "I highlighted nothing": it must not fall back to
  // row 0, which for a tier-1 row would restore a session the user never chose.
  it('activates nothing when the highlight is past the end of a shrunken list', () => {
    expect(resolveActivation({ ...state, highlight: 3 })).toEqual({ action: 'none' });
    expect(resolveActivation({ ...state, highlight: 99 })).toEqual({ action: 'none' });
    expect(resolveActivation({ ...state, highlight: -2 })).toEqual({ action: 'none' });
  });

  it('activates nothing when there are no rows', () => {
    expect(resolveActivation({ ...state, itemCount: 0 })).toEqual({ action: 'none' });
    expect(resolveActivation({ ...state, highlight: 0, itemCount: 0 })).toEqual({ action: 'none' });
  });

  // The rows on screen still belong to the previous query: wait for the commit to land rather
  // than activate a row the user never saw.
  it('waits while the committed query lags the typed text, whatever is highlighted', () => {
    expect(resolveActivation({ ...state, committedQuery: 'do' })).toEqual({ action: 'wait' });
    expect(resolveActivation({ ...state, committedQuery: '', highlight: 1 })).toEqual({
      action: 'wait',
    });
    // Including the very first Enter, where nothing is committed and no row could exist yet.
    expect(
      resolveActivation({
        typedQuery: 'docs',
        committedQuery: '',
        highlight: NO_HIGHLIGHT,
        itemCount: 0,
      }),
    ).toEqual({ action: 'wait' });
  });
});

describe('isEditableTarget', () => {
  it('is true for form fields and contenteditable regions', () => {
    expect(isEditableTarget({ tagName: 'INPUT' })).toBe(true);
    expect(isEditableTarget({ tagName: 'textarea' })).toBe(true);
    expect(isEditableTarget({ tagName: 'SELECT' })).toBe(true);
    expect(isEditableTarget({ tagName: 'DIV', isContentEditable: true })).toBe(true);
  });

  it('is false for anything else, and for no target at all', () => {
    expect(isEditableTarget({ tagName: 'BUTTON' })).toBe(false);
    expect(isEditableTarget({ tagName: 'DIV', isContentEditable: false })).toBe(false);
    expect(isEditableTarget(null)).toBe(false);
    expect(isEditableTarget(undefined)).toBe(false);
  });
});
