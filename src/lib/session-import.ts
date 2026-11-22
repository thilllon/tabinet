import { formatNumber, t } from '@/lib/i18n';
import { isExportBundle, isRecord, isSession } from '@/lib/import-guards';
import { contentHash } from '@/lib/session-hash';
import { migrateSession } from '@/lib/session-migrate';
import type { GroupSnapshot, Session, TabSnapshot, WindowSnapshot } from '@/types';
import { SESSION_SCHEMA_VERSION } from '@/types';

/**
 * Pure parsers for the dashboard's import dialog (file picker or paste). No DOMParser: vitest
 * runs in Node without a DOM, and the tokenizer below is all the Netscape format needs.
 */

export type ImportFormat = 'json' | 'html' | 'markdown' | 'text';

type ImportParser = (text: string, now: number) => Session[] | null;

type ImportResult =
  | { format: ImportFormat; sessions: Session[]; warnings: string[] }
  | { format: null; error: string };

// ---------------------------------------------------------------------------
// Detection
// ---------------------------------------------------------------------------

// Schemes Chrome can open in a tab. `\b` keeps `chrome-extension://` (not restorable) out.
const URL_PATTERN = /\b(?:https?|ftp|file|chrome):\/\/[^\s<>"']+/i;
const URL_PREFIX = /^(?:https?|ftp|file|chrome):\/\//i;

// `[title](url)`: the title may hold backslash escapes; the destination may hold one level of
// balanced parentheses (`…/Foo_(bar)`) and may be wrapped in `<…>`.
const MARKDOWN_LINK = /\[((?:\\.|[^\\\]])*)\]\(\s*<?((?:[^\s()<>]|\([^\s()]*\))+)>?\s*\)/;

const PINNED_MARKER = /^\s*\(pinned\)/;

function globalCopy(pattern: RegExp): RegExp {
  return new RegExp(pattern, `${pattern.flags}g`);
}

/** Sniffs the first non-blank characters; `null` when nothing importable is found. */
export function detectFormat(text: string): ImportFormat | null {
  const trimmed = text.trim();
  if (trimmed === '') {
    return null;
  }
  if (trimmed.startsWith('{')) {
    return 'json';
  }
  if (trimmed.startsWith('[')) {
    // A JSON array also starts with `[`; a Markdown document that starts with a link does not
    // continue with `{`, `"` or a number.
    return new RegExp(`^${MARKDOWN_LINK.source}`).test(trimmed) ? 'markdown' : 'json';
  }
  if (/^<!DOCTYPE\s+NETSCAPE/i.test(trimmed) || /^<DL\b/i.test(trimmed)) {
    return 'html';
  }
  if (trimmed.startsWith('#') || MARKDOWN_LINK.test(trimmed)) {
    return 'markdown';
  }
  return URL_PATTERN.test(trimmed) ? 'text' : null;
}

// ---------------------------------------------------------------------------
// Session construction shared by the HTML and text parsers
// ---------------------------------------------------------------------------

function buildWindow(
  tabs: TabSnapshot[],
  groups: GroupSnapshot[],
  focused: boolean,
): WindowSnapshot {
  // Chrome keeps pinned tabs at the front of the strip; the first tab becomes the active one.
  const ordered = [...tabs.filter((tab) => tab.pinned), ...tabs.filter((tab) => !tab.pinned)];
  return {
    state: 'normal',
    focused,
    groups,
    tabs: ordered.map((tab, index) => ({ ...tab, active: index === 0 })),
  };
}

function focusFirst(windows: WindowSnapshot[]): WindowSnapshot[] {
  return windows.map((window, index) => ({ ...window, focused: index === 0 }));
}

function buildSession(name: string, windows: WindowSnapshot[], now: number): Session {
  return {
    schemaVersion: SESSION_SCHEMA_VERSION,
    id: crypto.randomUUID(),
    kind: 'saved',
    name,
    origin: 'import',
    createdAt: now,
    updatedAt: now,
    contentHash: contentHash(windows),
    windows,
  };
}

// ---------------------------------------------------------------------------
// JSON
// ---------------------------------------------------------------------------

type JsonParse = { value: unknown } | { error: string };

function tryParseJson(text: string): JsonParse {
  try {
    return { value: JSON.parse(text) };
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
}

/** An export bundle, a bare session, or an array of sessions; anything else is `null`. */
function sessionRecords(value: unknown): unknown[] | null {
  if (isExportBundle(value)) {
    return value.sessions;
  }
  if (Array.isArray(value)) {
    return value;
  }
  return isRecord(value) ? [value] : null;
}

/** Fresh id, saved/import, the "(imported)" suffix (in the UI language), timestamps = now; unknown fields are dropped. */
function asImported(session: Session, now: number): Session {
  // `protected` is a history-only flag and an imported session is always a saved one.
  const imported: Session = {
    schemaVersion: session.schemaVersion,
    id: crypto.randomUUID(),
    kind: 'saved',
    name: t('expImportedName', session.name),
    origin: 'import',
    createdAt: now,
    updatedAt: now,
    windows: session.windows,
  };
  if (session.contentHash !== undefined) {
    imported.contentHash = session.contentHash;
  }
  return imported;
}

export function parseJson(text: string, now: number): Session[] | null {
  if (detectFormat(text) !== 'json') {
    return null;
  }
  const parsed = tryParseJson(text);
  if ('error' in parsed) {
    return null;
  }
  const records = sessionRecords(parsed.value);
  if (records === null || records.length === 0) {
    return null;
  }
  const sessions: Session[] = [];
  for (const record of records) {
    if (!isSession(record)) {
      return null;
    }
    try {
      sessions.push(asImported(migrateSession(record), now));
    } catch {
      return null;
    }
  }
  return sessions;
}

// ---------------------------------------------------------------------------
// Netscape bookmark HTML
// ---------------------------------------------------------------------------

interface BookmarkFolder {
  title: string;
  links: TabSnapshot[];
  folders: BookmarkFolder[];
}

// Tokens: `<DL>`, `</DL>`, `<H3 …>title</H3>`, `<A …>title</A>`. Tags are case-insensitive and
// `\b` keeps `<ABBR>` / `<DLX>` from matching. Group 1/2: H3 attrs/text; group 3/4: A attrs/text.
const BOOKMARK_TOKEN =
  /<DL\b[^>]*>|<\/DL\s*>|<H3\b([^>]*)>([\s\S]*?)<\/H3\s*>|<A\b([^>]*)>([\s\S]*?)<\/A\s*>/gi;

const HREF_ATTRIBUTE = /\bHREF\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i;

const NAMED_ENTITIES = new Map<string, string>([
  ['amp', '&'],
  ['lt', '<'],
  ['gt', '>'],
  ['quot', '"'],
  ['apos', "'"],
  ['nbsp', ' '],
]);

export function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (entity: string, body: string) => {
    if (body.startsWith('#')) {
      const isHex = body[1] === 'x' || body[1] === 'X';
      const code = Number.parseInt(body.slice(isHex ? 2 : 1), isHex ? 16 : 10);
      return code <= 0x10ffff ? String.fromCodePoint(code) : entity;
    }
    return NAMED_ENTITIES.get(body.toLowerCase()) ?? entity;
  });
}

function innerText(html: string): string {
  return decodeEntities(html.replace(/<[^>]*>/g, '')).trim();
}

function hrefOf(attributes: string): string | undefined {
  const match = HREF_ATTRIBUTE.exec(attributes);
  if (match === null) {
    return undefined;
  }
  const href = decodeEntities(match[1] ?? match[2] ?? match[3] ?? '');
  return href === '' ? undefined : href;
}

/**
 * Folder tree from the Netscape layout, where `<DT><H3>title</H3>` names the folder whose
 * children are in the `<DL>` that follows it. A `<DL>` with no preceding `<H3>` (the document
 * root, or a stray one) is transparent: its links land in the enclosing folder.
 */
function parseBookmarkTree(text: string): BookmarkFolder {
  const root: BookmarkFolder = { title: '', links: [], folders: [] };
  const stack: BookmarkFolder[] = [root];
  let pending: BookmarkFolder | undefined;

  for (const match of text.matchAll(BOOKMARK_TOKEN)) {
    const token = match[0];
    const current = stack[stack.length - 1] ?? root;
    if (token.startsWith('</')) {
      if (stack.length > 1) {
        stack.pop();
      }
      pending = undefined;
    } else if (/^<DL/i.test(token)) {
      stack.push(pending ?? current);
      pending = undefined;
    } else if (/^<H3/i.test(token)) {
      const folder: BookmarkFolder = { title: innerText(match[2] ?? ''), links: [], folders: [] };
      current.folders.push(folder);
      pending = folder;
    } else {
      pending = undefined;
      const url = hrefOf(match[3] ?? '');
      if (url !== undefined) {
        current.links.push({ url, title: innerText(match[4] ?? ''), pinned: false, active: false });
      }
    }
  }
  return root;
}

/** Every link in the subtree: the folder's own first, then its sub-folders' in order. */
function flattenLinks(folder: BookmarkFolder): TabSnapshot[] {
  return [...folder.links, ...folder.folders.flatMap(flattenLinks)];
}

/** A window folder: direct links are ungrouped tabs, each sub-folder is a grey group. */
function folderToWindow(folder: BookmarkFolder): WindowSnapshot | null {
  const groups: GroupSnapshot[] = [];
  const tabs: TabSnapshot[] = [...folder.links];
  for (const sub of folder.folders) {
    const grouped = flattenLinks(sub);
    if (grouped.length === 0) {
      continue;
    }
    const groupIndex = groups.length;
    groups.push({ title: sub.title, color: 'grey', collapsed: false });
    tabs.push(...grouped.map((tab) => ({ ...tab, groupIndex })));
  }
  return tabs.length === 0 ? null : buildWindow(tabs, groups, false);
}

/** A session folder: direct links form a window of their own, ahead of the sub-folder windows. */
function folderToSession(folder: BookmarkFolder, now: number): Session | null {
  const windows: WindowSnapshot[] = [];
  if (folder.links.length > 0) {
    windows.push(buildWindow(folder.links, [], false));
  }
  for (const sub of folder.folders) {
    const window = folderToWindow(sub);
    if (window !== null) {
      windows.push(window);
    }
  }
  if (windows.length === 0) {
    return null;
  }
  return buildSession(
    folder.title === '' ? t('expImportedBookmarks') : folder.title,
    focusFirst(windows),
    now,
  );
}

/**
 * Top-level folders become sessions (links at the top level become one "Imported bookmarks"
 * session), second-level folders windows, third-level folders groups; deeper folders are
 * flattened into their group.
 */
export function parseNetscapeHtml(text: string, now: number): Session[] | null {
  if (detectFormat(text) !== 'html') {
    return null;
  }
  const root = parseBookmarkTree(text);
  const sessions: Session[] = [];
  if (root.links.length > 0) {
    sessions.push(
      buildSession(t('expImportedBookmarks'), [buildWindow(root.links, [], true)], now),
    );
  }
  for (const folder of root.folders) {
    const session = folderToSession(folder, now);
    if (session !== null) {
      sessions.push(session);
    }
  }
  return sessions.length === 0 ? null : sessions;
}

// ---------------------------------------------------------------------------
// Plain text / Markdown
// ---------------------------------------------------------------------------

const TRAILING_PUNCTUATION = '.,;:!?\'"]}';

/**
 * Sentence punctuation after a bare URL is not part of it; `…/Foo_(bar)` keeps its paren.
 *
 * Linear, and it touches the string once at the end. `URL_PATTERN`'s `[^\s<>"']+` is unbounded,
 * so this runs on whatever a pasted file happens to contain -- and it runs synchronously in the
 * dashboard's render path (ImportDialog's useMemo), where a slow parse freezes the tab before the
 * user can even confirm the import. Trimming by repeated `slice`/anchored-regex instead is
 * quadratic: each pass re-scans (and re-flattens) the whole string, so a run of trailing `)`
 * costs O(n^2) -- measured at ~12 s for 40k characters, i.e. hours for a 1 MB paste, three orders
 * of magnitude under `POLICY.import.maxFileBytes`.
 */
function trimTrailingPunctuation(url: string): string {
  let opens = 0;
  let closes = 0;
  for (let i = 0; i < url.length; i += 1) {
    const char = url.charAt(i);
    if (char === '(') {
      opens += 1;
    } else if (char === ')') {
      closes += 1;
    }
  }
  // Walk back over trailing punctuation runs and unbalanced `)` by index. Only `)` is ever a
  // paren, so `opens` stays exact and `closes` only needs the one decrement below.
  let end = url.length;
  for (;;) {
    while (end > 0 && TRAILING_PUNCTUATION.includes(url.charAt(end - 1))) {
      end -= 1;
    }
    if (end === 0 || url.charAt(end - 1) !== ')' || opens >= closes) {
      break;
    }
    end -= 1;
    closes -= 1;
  }
  return end === url.length ? url : url.slice(0, end);
}

/** CommonMark: a backslash escapes any ASCII punctuation character. */
function unescapeMarkdown(text: string): string {
  return text.replace(/\\([!-/:-@[-`{-~])/g, '$1');
}

function lineTabs(line: string): TabSnapshot[] {
  const tabs: TabSnapshot[] = [];
  let rest = line;
  for (const match of line.matchAll(globalCopy(MARKDOWN_LINK))) {
    const [whole, rawTitle = '', rawUrl = ''] = match;
    // Blank out the link so the bare-URL pass below does not pick up its destination again.
    rest = rest.replace(whole, ' ');
    if (!URL_PREFIX.test(rawUrl)) {
      continue;
    }
    const pinned = PINNED_MARKER.test(line.slice(match.index + whole.length));
    tabs.push({ url: rawUrl, title: unescapeMarkdown(rawTitle).trim(), pinned, active: false });
  }
  for (const match of rest.matchAll(globalCopy(URL_PATTERN))) {
    const url = trimTrailingPunctuation(match[0]);
    const pinned = PINNED_MARKER.test(rest.slice(match.index + match[0].length));
    tabs.push({ url, title: '', pinned, active: false });
  }
  return tabs;
}

/**
 * `[title](url)` links and bare URLs, one window per blank-line-separated block, in a single
 * session named "Imported links". Lines without a URL (headings, prose) are ignored.
 */
export function parseTextOrMarkdown(text: string, now: number): Session[] | null {
  const format = detectFormat(text);
  if (format !== 'markdown' && format !== 'text') {
    return null;
  }
  const windows: WindowSnapshot[] = [];
  for (const block of text.replace(/\r\n?/g, '\n').split(/\n\s*\n/)) {
    const tabs = block.split('\n').flatMap(lineTabs);
    if (tabs.length > 0) {
      windows.push(buildWindow(tabs, [], false));
    }
  }
  if (windows.length === 0) {
    return null;
  }
  return [buildSession(t('expImportedLinks'), focusFirst(windows), now)];
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

/**
 * Tried in order; the first parser that returns sessions wins. Each parser sniffs the input
 * itself, so a parser for another tool's format (e.g. a Session Buddy JSON adapter) can be
 * inserted here.
 */
export const parsers: ImportParser[] = [parseJson, parseNetscapeHtml, parseTextOrMarkdown];

/**
 * Where in `text` the JSON parser stopped, read out of its (English) message: V8 says
 * "... at position 52" and newer builds add "(line 1 column 53)". `undefined` when it says
 * neither, e.g. "Unexpected end of JSON input".
 */
export function jsonErrorLocation(
  message: string,
  text: string,
): { line: number; column: number } | undefined {
  const lineColumn = /line (\d+) column (\d+)/.exec(message);
  if (lineColumn !== null) {
    return { line: Number(lineColumn[1]), column: Number(lineColumn[2]) };
  }
  const position = /position (\d+)/.exec(message);
  if (position === null) {
    return undefined;
  }
  const before = text.slice(0, Number(position[1]));
  const lines = before.split('\n');
  return { line: lines.length, column: (lines.at(-1)?.length ?? 0) + 1 };
}

function describeJsonFailure(text: string): string {
  const parsed = tryParseJson(text);
  if ('error' in parsed) {
    // The parser's own words are English whatever the UI language; only where it stopped is kept.
    const location = jsonErrorLocation(parsed.error, text);
    return location === undefined
      ? t('expErrorMalformedJson')
      : t('expErrorMalformedJsonAt', formatNumber(location.line), formatNumber(location.column));
  }
  const { value } = parsed;
  let records: unknown[];
  if (isRecord(value) && value.app === 'tab-organizer') {
    if (typeof value.schemaVersion === 'number' && value.schemaVersion !== SESSION_SCHEMA_VERSION) {
      return unsupportedVersion(value.schemaVersion);
    }
    const { sessions } = value;
    if (!Array.isArray(sessions)) {
      return t('expErrorNoSessionsList');
    }
    records = sessions;
  } else {
    records = Array.isArray(value) ? value : [value];
  }
  if (records.length === 0) {
    return t('expErrorNoSessions');
  }
  for (const [index, record] of records.entries()) {
    if (
      isRecord(record) &&
      typeof record.schemaVersion === 'number' &&
      record.schemaVersion !== SESSION_SCHEMA_VERSION
    ) {
      return unsupportedVersion(record.schemaVersion);
    }
    if (!isSession(record)) {
      return t('expErrorInvalidSession', formatNumber(index + 1));
    }
  }
  return t('expErrorNotExport');
}

function unsupportedVersion(version: number): string {
  return t('expErrorSchemaVersion', String(version), String(SESSION_SCHEMA_VERSION));
}

function describeFailure(format: ImportFormat, text: string): string {
  switch (format) {
    case 'json': {
      return describeJsonFailure(text);
    }
    case 'html': {
      return t('expErrorNoBookmarks');
    }
    case 'markdown':
    case 'text': {
      return t('expErrorNoUrls');
    }
  }
}

function collectWarnings(sessions: Session[]): string[] {
  const warnings: string[] = [];
  for (const session of sessions) {
    if (session.windows.length === 0) {
      warnings.push(t('expWarnNoWindows', session.name));
    }
    for (const [index, window] of session.windows.entries()) {
      if (window.tabs.length === 0) {
        warnings.push(t('expWarnEmptyWindow', session.name, formatNumber(index + 1)));
      }
    }
  }
  return warnings;
}

/** Detects the format, runs the parser chain, and explains failures in user-facing terms. */
export function importSessions(text: string, now: number): ImportResult {
  const format = detectFormat(text);
  if (format === null) {
    return {
      format: null,
      error: t('expErrorNothingToImport'),
    };
  }
  for (const parse of parsers) {
    const sessions = parse(text, now);
    if (sessions !== null) {
      return { format, sessions, warnings: collectWarnings(sessions) };
    }
  }
  return { format: null, error: describeFailure(format, text) };
}
