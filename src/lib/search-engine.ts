import { formatNumber, t } from '@/lib/i18n';
import { videoUrlAt } from '@/lib/youtube-video';
import type { Session, VideoNotes } from '@/types';

export type SearchSource = 'open' | 'saved' | 'notes' | 'history';

/**
 * Result and ranking order of the sources: live tabs, then saved sessions, then YouTube notes,
 * then history.
 */
export const SEARCH_SOURCES: readonly SearchSource[] = ['open', 'saved', 'notes', 'history'];

/**
 * Where a matching tab is, shown beside it in the results. A saved or snapshot tab names its
 * session and window ("Work · Window 2"); an open tab is already in the one place everyone means
 * by "open", so it names just its window ("Window 2"), numbered like the Open tabs list.
 */
export function resultPlace(
  entry: Pick<SearchEntry, 'source' | 'sessionName' | 'windowIndex'>,
): string {
  const windowNumber = formatNumber(entry.windowIndex + 1);
  return entry.source === 'open'
    ? t('treeWindowLabel', windowNumber)
    : t('searchResultPlace', entry.sessionName, windowNumber);
}

/**
 * One searchable tab, or one YouTube note (`source: 'notes'`). Built once per session body / open-windows snapshot by the
 * `entriesFrom*` helpers so that the per-keystroke work is only tokenising and matching.
 */
export interface SearchEntry {
  source: SearchSource;
  /** Owning session; absent for open tabs. */
  sessionId?: string;
  /** The owning session's name; '' for open tabs, which belong to no session. */
  sessionName: string;
  /** Last ranking key (newest first). `Date.now()` at build time for open tabs. */
  sessionUpdatedAt: number;
  /** Index into `Session.windows`, or into the `windows` argument for open tabs. */
  windowIndex: number;
  /** Index into `WindowSnapshot.tabs`, or the live strip index (`Tab.index`) for open tabs. */
  tabIndex: number;
  title: string;
  url: string;
  /** `new URL(url).hostname`, precomputed once; '' when the url does not parse. */
  hostname: string;
  /** Chrome runtime ids, open tabs only: in-memory so a result can focus the tab, never persisted. */
  windowId?: number;
  tabId?: number;
  /**
   * Notes only: more text matched like the title (the video's title, while `title` is the note's
   * text), and where the note is.
   */
  context?: string;
  videoId?: string;
  noteId?: string;
  /** Seconds into the video. */
  at?: number;
}

interface OpenEntriesOptions {
  /** `chrome.runtime.getURL('')` - tabs whose url starts with this (our own pages) are dropped. */
  excludeUrlPrefix?: string;
}

interface SearchOptions {
  /** Entries returned per source (default 200); `count` still reports every match. */
  limitPerSource?: number;
  /** History bodies are opt-in (the "Also search auto-saved" button); default false. */
  includeHistory?: boolean;
}

interface SearchSourceResult {
  entries: SearchEntry[];
  /** Matches in this source, including those cut off by `limitPerSource`. */
  count: number;
  hasMore: boolean;
}

export interface SearchResult {
  query: string;
  tokens: string[];
  /** Sum of `count` over the sources. */
  total: number;
  bySource: Record<SearchSource, SearchSourceResult>;
}

interface TextSegment {
  text: string;
  match: boolean;
}

export const DEFAULT_LIMIT_PER_SOURCE = 200;

function hostnameOf(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return '';
  }
}

export function entriesFromSession(session: Session, source: 'saved' | 'history'): SearchEntry[] {
  const entries: SearchEntry[] = [];
  for (const [windowIndex, win] of session.windows.entries()) {
    for (const [tabIndex, tab] of win.tabs.entries()) {
      entries.push({
        source,
        sessionId: session.id,
        sessionName: session.name,
        sessionUpdatedAt: session.updatedAt,
        windowIndex,
        tabIndex,
        title: tab.title,
        url: tab.url,
        hostname: hostnameOf(tab.url),
      });
    }
  }
  return entries;
}

/**
 * Entries for the live tabs of populated windows (`windows.getAll({ populate: true })`).
 * Incognito windows are skipped, then tabs without a url are dropped, as are our own extension
 * pages when `excludeUrlPrefix` is given. Runtime ids are kept on the entries (in memory only)
 * so results can focus tabs.
 */
export function entriesFromOpenWindows(
  windows: chrome.windows.Window[],
  opts: OpenEntriesOptions = {},
): SearchEntry[] {
  const excludePrefix = opts.excludeUrlPrefix ?? '';
  const now = Date.now();

  const entries: SearchEntry[] = [];
  // Counts only the windows that are kept, so "Window N" numbers them exactly like the
  // open-windows pane (which reads the same windows through `captureWindowsWithIds`).
  let windowIndex = 0;
  for (const win of windows) {
    // Same rule as `captureWindow` (src/lib/session-capture.ts): an incognito window is never read.
    // `windows.getAll({ windowTypes: ['normal'] })` filters the window *type*, not incognito-ness,
    // so without this an incognito title or url would surface in search once the user allows the
    // extension in incognito - which PRIVACY_POLICY.md rules out without qualification.
    if (win.incognito) {
      continue;
    }
    const tabs = [...(win.tabs ?? [])].sort((a, b) => a.index - b.index);
    for (const tab of tabs) {
      // Same resolution as capture: a navigating tab reports its destination as `pendingUrl`.
      const url = tab.pendingUrl ?? tab.url;
      if (url === undefined || url === '') {
        continue;
      }
      if (excludePrefix !== '' && url.startsWith(excludePrefix)) {
        continue;
      }
      const entry: SearchEntry = {
        source: 'open',
        sessionName: '',
        sessionUpdatedAt: now,
        windowIndex,
        tabIndex: tab.index,
        title: tab.title ?? '',
        url,
        hostname: hostnameOf(url),
      };
      if (win.id !== undefined) {
        entry.windowId = win.id;
      }
      if (tab.id !== undefined) {
        entry.tabId = tab.id;
      }
      entries.push(entry);
    }
    windowIndex += 1;
  }
  return entries;
}

/**
 * One entry per note on a video: the note's text is the title, the video's title the context
 * (and the place shown beside it), the url the video at the note's second. A note holding only a
 * screenshot is found by the video's title.
 */
export function entriesFromNotes(notes: VideoNotes): SearchEntry[] {
  return notes.entries.map((entry, index) => {
    const url = videoUrlAt(notes.videoId, entry.at);
    return {
      source: 'notes',
      sessionName: notes.title,
      sessionUpdatedAt: notes.updatedAt,
      windowIndex: 0,
      tabIndex: index,
      title: entry.text,
      url,
      hostname: hostnameOf(url),
      context: notes.title,
      videoId: notes.videoId,
      noteId: entry.id,
      at: entry.at,
    };
  });
}

/** Lowercase whitespace-separated tokens, de-duplicated in first-seen order; '' → []. */
export function tokenize(query: string): string[] {
  return [...new Set(query.toLowerCase().split(/\s+/))].filter((token) => token !== '');
}

/** 0 = a token is a prefix of the hostname, 1 = a token is in the title, 2 = url-only. */
type MatchTier = 0 | 1 | 2;
const NO_MATCH = -1;

function isHostnamePrefix(hostname: string, token: string): boolean {
  if (hostname.startsWith(token)) {
    return true;
  }
  // "github" should rank www.github.com as a host hit too (sort-order.ts strips `www.` the same way).
  return hostname.startsWith('www.') && hostname.startsWith(token, 4);
}

/**
 * AND over the tokens against title | url | hostname, returning the best tier seen or
 * NO_MATCH. Title and hostname are lowercased once per entry; the (long) url only when a
 * token is found in neither. `tokens` are expected to come from `tokenize()` (lowercase).
 */
function classify(entry: SearchEntry, tokens: string[]): MatchTier | typeof NO_MATCH {
  const title =
    entry.context === undefined
      ? entry.title.toLowerCase()
      : `${entry.title}\n${entry.context}`.toLowerCase();
  const hostname = entry.hostname.toLowerCase();
  let url: string | undefined;
  let tier: MatchTier = 2;
  for (const token of tokens) {
    const inTitle = title.includes(token);
    const inHostname = hostname.includes(token);
    if (!inTitle && !inHostname) {
      url ??= entry.url.toLowerCase();
      if (!url.includes(token)) {
        return NO_MATCH;
      }
    }
    if (inHostname && isHostnamePrefix(hostname, token)) {
      tier = 0;
    } else if (inTitle && tier === 2) {
      tier = 1;
    }
  }
  return tier;
}

/** Tier-1 (index only) match: every token is a substring of the session name. */
export function matchSessionName(name: string, tokens: string[]): boolean {
  const lower = name.toLowerCase();
  return tokens.every((token) => lower.includes(token));
}

const SOURCE_RANK: Record<SearchSource, number> = { open: 0, saved: 1, notes: 2, history: 3 };

interface Ranked {
  entry: SearchEntry;
  tier: number;
  /** Position in the input, the final tie-break, so equal entries keep their order. */
  index: number;
}

function compareRanked(a: Ranked, b: Ranked): number {
  if (a.tier !== b.tier) {
    return a.tier - b.tier;
  }
  const bySource = SOURCE_RANK[a.entry.source] - SOURCE_RANK[b.entry.source];
  if (bySource !== 0) {
    return bySource;
  }
  if (a.entry.sessionUpdatedAt !== b.entry.sessionUpdatedAt) {
    return b.entry.sessionUpdatedAt - a.entry.sessionUpdatedAt;
  }
  return a.index - b.index;
}

function emptySourceResult(): SearchSourceResult {
  return { entries: [], count: 0, hasMore: false };
}

/**
 * Tier-2 (bodies) search over a prebuilt corpus: matched entries per source, ranked, cut to
 * `limitPerSource` with `hasMore`/`count` for a "show more" control. History entries are
 * skipped unless `includeHistory`. An empty query yields an empty result with zero counts.
 */
export function search(
  corpus: SearchEntry[],
  query: string,
  opts: SearchOptions = {},
): SearchResult {
  const tokens = tokenize(query);
  const limit = opts.limitPerSource ?? DEFAULT_LIMIT_PER_SOURCE;
  const includeHistory = opts.includeHistory ?? false;

  const buckets: Record<SearchSource, Ranked[]> = { open: [], saved: [], notes: [], history: [] };
  if (tokens.length > 0) {
    for (let index = 0; index < corpus.length; index += 1) {
      const entry = corpus[index];
      if (entry.source === 'history' && !includeHistory) {
        continue;
      }
      const tier = classify(entry, tokens);
      if (tier !== NO_MATCH) {
        buckets[entry.source].push({ entry, tier, index });
      }
    }
  }

  const bySource: Record<SearchSource, SearchSourceResult> = {
    open: emptySourceResult(),
    saved: emptySourceResult(),
    notes: emptySourceResult(),
    history: emptySourceResult(),
  };
  let total = 0;
  for (const source of SEARCH_SOURCES) {
    const bucket = buckets[source];
    bucket.sort(compareRanked);
    const count = bucket.length;
    bySource[source] = {
      entries: bucket.slice(0, limit).map((item) => item.entry),
      count,
      hasMore: count > limit,
    };
    total += count;
  }
  return { query, tokens, total, bySource };
}

/**
 * Lowercases `text` without changing its length, so offsets found in the folded string map
 * back to the original. A few characters expand under `toLowerCase()` (e.g. 'İ' → 'i̇');
 * those are left as-is rather than desynchronising the highlight.
 */
function foldCase(text: string): string {
  const lower = text.toLowerCase();
  if (lower.length === text.length) {
    return lower;
  }
  let folded = '';
  for (const char of text) {
    const lowerChar = char.toLowerCase();
    folded += lowerChar.length === char.length ? lowerChar : char;
  }
  return folded;
}

/**
 * Splits `text` into alternating plain / matching segments for highlighting without
 * `dangerouslySetInnerHTML`. Case-insensitive on `tokenize()` tokens; every occurrence of every
 * token is marked, overlapping and adjacent hits merge into one segment, no segment is empty.
 */
export function splitOnMatches(text: string, tokens: string[]): TextSegment[] {
  if (text === '') {
    return [];
  }
  const folded = foldCase(text);

  const ranges: Array<[number, number]> = [];
  for (const token of tokens) {
    if (token === '') {
      continue;
    }
    let start = folded.indexOf(token);
    while (start !== -1) {
      ranges.push([start, start + token.length]);
      // Advance by one, not by the token length, so self-overlapping hits ("aa" in "aaa") are
      // all found and merged below instead of leaving a gap.
      start = folded.indexOf(token, start + 1);
    }
  }
  ranges.sort((a, b) => a[0] - b[0]);

  const segments: TextSegment[] = [];
  let cursor = 0;
  let i = 0;
  while (i < ranges.length) {
    const start = ranges[i][0];
    let end = ranges[i][1];
    i += 1;
    while (i < ranges.length && ranges[i][0] <= end) {
      end = Math.max(end, ranges[i][1]);
      i += 1;
    }
    if (start > cursor) {
      segments.push({ text: text.slice(cursor, start), match: false });
    }
    segments.push({ text: text.slice(start, end), match: true });
    cursor = end;
  }
  if (cursor < text.length) {
    segments.push({ text: text.slice(cursor), match: false });
  }
  return segments;
}
