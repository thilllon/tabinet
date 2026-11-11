import { t } from '@/lib/i18n';
import {
  matchSessionName,
  SEARCH_SOURCES,
  type SearchEntry,
  type SearchResult,
  type SearchSource,
} from '@/lib/search-engine';
import type { SessionSummary } from '@/types';

/** The tier-1 (session name) block plus the tier-2 sources, in the order they are rendered. */
type SearchGroupSource = 'sessions' | SearchSource;

/** A group's heading in the UI language, read at call time (tests switch the language). */
function searchGroupHeading(source: SearchGroupSource): string {
  switch (source) {
    case 'sessions':
      return t('searchGroupMatchingSessions');
    case 'open':
      return t('searchGroupOpenTabs');
    case 'saved':
      return t('searchGroupSavedSessions');
    case 'notes':
      return t('searchGroupNotes');
    case 'history':
      return t('searchGroupHistory');
  }
}

/**
 * One activatable row: restore a whole session (tier 1), open/focus one tab (tier 2), or show one
 * YouTube note among its video's notes.
 */
export type SearchItem =
  | { kind: 'session'; key: string; summary: SessionSummary }
  | { kind: 'tab'; key: string; entry: SearchEntry }
  | { kind: 'note'; key: string; entry: SearchEntry };

export interface SearchGroup {
  source: SearchGroupSource;
  heading: string;
  /** Every match in this source, including the ones cut off by the per-source limit. */
  count: number;
  hasMore: boolean;
  items: SearchItem[];
  /** Index of this group's first item in the flattened list - the keyboard highlight's index. */
  startIndex: number;
}

/**
 * Tier-1 matches: sessions whose *name* contains every token, answered from the index alone (no
 * body reads). History snapshots only take part once "Also search auto-saved" is chosen, exactly like
 * the tier-2 entries. Order is the index's (newest first).
 *
 * A session this build cannot read is never a result: activating a tier-1 row restores
 * it, and the whole point of the read-only row in the saved list is that this build cannot. Its
 * tier-2 entries do not exist either - nothing could read the body to build them.
 */
export function sessionNameMatches(
  summaries: readonly SessionSummary[],
  tokens: readonly string[],
  options: { includeHistory?: boolean } = {},
): SessionSummary[] {
  if (tokens.length === 0) {
    return [];
  }
  const includeHistory = options.includeHistory ?? false;
  return summaries.filter(
    (summary) =>
      summary.unreadable === undefined &&
      (summary.kind !== 'history' || includeHistory) &&
      matchSessionName(summary.name, [...tokens]),
  );
}

/**
 * A tab row's React key. Saved and history entries are addressed by session + position; an open
 * tab by its runtime id, which survives the tab moving inside its window (its position does not).
 */
function entryKey(entry: SearchEntry): string {
  if (entry.source === 'notes') {
    return `notes:${entry.videoId ?? ''}:${entry.noteId ?? String(entry.tabIndex)}`;
  }
  if (entry.tabId !== undefined) {
    return `open:${String(entry.tabId)}`;
  }
  return `${entry.source}:${entry.sessionId ?? ''}:${String(entry.windowIndex)}:${String(entry.tabIndex)}`;
}

/**
 * The rendered result groups: the tier-1 session matches first, then open tabs, saved sessions,
 * notes and history (`SEARCH_SOURCES` order). Empty groups are dropped, and `startIndex` gives each
 * group's offset into `flattenSearchItems()` so a row can address its own highlight index.
 */
export function buildSearchGroups(
  result: SearchResult,
  sessionMatches: readonly SessionSummary[] = [],
): SearchGroup[] {
  const groups: SearchGroup[] = [];
  let startIndex = 0;

  const push = (
    source: SearchGroupSource,
    items: SearchItem[],
    count: number,
    hasMore: boolean,
  ) => {
    if (items.length === 0) {
      return;
    }
    groups.push({
      source,
      heading: searchGroupHeading(source),
      count,
      hasMore,
      items,
      startIndex,
    });
    startIndex += items.length;
  };

  push(
    'sessions',
    sessionMatches.map((summary) => ({
      kind: 'session' as const,
      key: `session:${summary.id}`,
      summary,
    })),
    sessionMatches.length,
    false,
  );

  for (const source of SEARCH_SOURCES) {
    const bucket = result.bySource[source];
    push(
      source,
      bucket.entries.map((entry) =>
        source === 'notes'
          ? { kind: 'note' as const, key: entryKey(entry), entry }
          : { kind: 'tab' as const, key: entryKey(entry), entry },
      ),
      bucket.count,
      bucket.hasMore,
    );
  }
  return groups;
}

/** The groups' rows as one ordered list - the order ArrowDown / ArrowUp walk. */
export function flattenSearchItems(groups: readonly SearchGroup[]): SearchItem[] {
  return groups.flatMap((group) => group.items);
}

/** No row highlighted. `nextIndex` starts at the top from here, `prevIndex` at the bottom. */
export const NO_HIGHLIGHT = -1;

/** ArrowDown: the row after `current`, wrapping to the first; `NO_HIGHLIGHT` when there are none. */
export function nextIndex(current: number, length: number): number {
  if (length <= 0) {
    return NO_HIGHLIGHT;
  }
  if (current < 0 || current >= length - 1) {
    return 0;
  }
  return current + 1;
}

/** ArrowUp: the row before `current`, wrapping to the last; `NO_HIGHLIGHT` when there are none. */
export function prevIndex(current: number, length: number): number {
  if (length <= 0) {
    return NO_HIGHLIGHT;
  }
  // `current` can also be past the end (the results shrank under a highlight): wrap to the last.
  if (current <= 0 || current > length - 1) {
    return length - 1;
  }
  return current - 1;
}

/** What Enter should do with the row list on screen. */
type ActivationDecision =
  | { action: 'activate'; index: number }
  /** The list on screen still describes an older query; activate nothing until it catches up. */
  | { action: 'wait' }
  /** Nothing to act on: no results, or a highlight that no longer addresses a row. */
  | { action: 'none' };

/**
 * Resolves an Enter press against the render it is resolved in.
 *
 * Two things make a naive `items[highlight] ?? items[0]` wrong:
 * - the search box commits the typed query and asks for the activation in the same event handler,
 *   and those state updates are batched, so the rows on screen can still be the previous query's.
 *   `typedQuery !== committedQuery` therefore means "wait", never "activate something".
 * - `highlight` is an index into a list that is rebuilt on every tab event. Once it points past
 *   the end, the row the user highlighted is gone - which is *not* the same as having highlighted
 *   nothing, and must not silently activate row 0 (for a tier-1 row: restoring a whole session).
 *
 * Only `NO_HIGHLIGHT` (nothing highlighted at all) falls back to the first row, which is what a
 * search box is expected to do when you type and press Enter.
 */
export function resolveActivation(state: {
  typedQuery: string;
  committedQuery: string;
  highlight: number;
  itemCount: number;
}): ActivationDecision {
  if (state.typedQuery !== state.committedQuery) {
    return { action: 'wait' };
  }
  if (state.itemCount <= 0) {
    return { action: 'none' };
  }
  if (state.highlight === NO_HIGHLIGHT) {
    return { action: 'activate', index: 0 };
  }
  if (state.highlight < 0 || state.highlight >= state.itemCount) {
    return { action: 'none' };
  }
  return { action: 'activate', index: state.highlight };
}

/** The shape of an event target this module needs; `HTMLElement` satisfies it structurally. */
interface EditableTargetLike {
  tagName?: string;
  isContentEditable?: boolean;
}

/**
 * True when a keystroke is already going into a field, so the `/` shortcut must leave it alone:
 * an `<input>`, `<textarea>` or `<select>`, or anything inside a contenteditable region.
 */
export function isEditableTarget(target: EditableTargetLike | null | undefined): boolean {
  if (target === null || target === undefined) {
    return false;
  }
  if (target.isContentEditable === true) {
    return true;
  }
  const tag = typeof target.tagName === 'string' ? target.tagName.toUpperCase() : '';
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT';
}
