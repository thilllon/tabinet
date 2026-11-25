import { POLICY } from '@/constants';
import { formatBytes } from '@/lib/display-format';
import { errorDetail, knownErrorText } from '@/lib/error-message';
import { joinFacts, type MessageKey, t, tp } from '@/lib/i18n';
import type { ImportFormat } from '@/lib/session-import';
import type { Session } from '@/types';

/**
 * The import dialog's decisions, kept out of the component: the size guard, how a detected format
 * is named, and the preview tree shown before anything is written. Parsing itself lives in
 * `src/lib/session-import.ts`; nothing here touches storage or the DOM.
 */

/** How much of the tree the preview draws before it starts counting instead. */
export const PREVIEW_SESSION_LIMIT = 10;
export const PREVIEW_WINDOW_LIMIT = 5;
export const PREVIEW_TITLE_LIMIT = 3;

type SizeCheck = { ok: true } | { ok: false; error: string };

/** UTF-8 bytes, matching `File.size` - a pasted emoji is not one byte. */
export function utf8ByteLength(text: string): number {
  return new TextEncoder().encode(text).length;
}

/**
 * Whether the dialog accepts input this large. The parsers are regex passes over the whole string,
 * so a hundred-megabyte paste would freeze the page instead of failing politely.
 */
export function checkImportSize(
  bytes: number,
  max: number = POLICY.import.maxFileBytes,
): SizeCheck {
  if (bytes <= max) {
    return { ok: true };
  }
  return {
    ok: false,
    error: t('expErrorTooLarge', formatBytes(bytes), formatBytes(max)),
  };
}

/** Every failure that stops the dialog before parsing reads the same way. */
export function fileReadError(err: unknown): string {
  console.warn('[tabinet] import file read failed', errorDetail(err));
  const reason = knownErrorText(err);
  return reason === undefined ? t('expErrorFileReadPlain') : t('expErrorFileRead', reason);
}

const FORMAT_LABEL_KEYS: Record<ImportFormat, MessageKey> = {
  json: 'expDetectedJson',
  html: 'expDetectedHtml',
  markdown: 'expDetectedMarkdown',
  text: 'expDetectedLinks',
};

export function importFormatLabel(format: ImportFormat): string {
  return t(FORMAT_LABEL_KEYS[format]);
}

/** The commit button: "Import 1 session" / "Import 3 sessions". */
export function importButtonLabel(count: number): string {
  return tp('expImportButton', count);
}

export function importedNotice(count: number): string {
  return tp('expImportedNotice', count);
}

interface ImportPreviewWindow {
  /** 1-based, as in "Window 2" everywhere else in the dashboard. */
  number: number;
  tabCount: number;
  /** The first few tab titles, falling back to the url for a title-less tab. */
  titles: string[];
  /** Tabs of this window the titles leave out. */
  moreTabs: number;
}

interface ImportPreviewSession {
  name: string;
  windowCount: number;
  tabCount: number;
  windows: ImportPreviewWindow[];
  /** Windows of this session the tree leaves out. */
  moreWindows: number;
}

export interface ImportPreview {
  sessions: ImportPreviewSession[];
  /** Sessions the tree leaves out; the totals below still count them. */
  moreSessions: number;
  sessionCount: number;
  windowCount: number;
  tabCount: number;
}

function previewWindow(session: Session, windowIndex: number): ImportPreviewWindow {
  const window = session.windows[windowIndex];
  const tabs = window?.tabs ?? [];
  const titles = tabs
    .slice(0, PREVIEW_TITLE_LIMIT)
    .map((tab) => (tab.title.trim() === '' ? tab.url : tab.title));
  return {
    number: windowIndex + 1,
    tabCount: tabs.length,
    titles,
    moreTabs: Math.max(0, tabs.length - titles.length),
  };
}

function previewSession(session: Session): ImportPreviewSession {
  const tabCount = session.windows.reduce((total, window) => total + window.tabs.length, 0);
  const shown = Math.min(session.windows.length, PREVIEW_WINDOW_LIMIT);
  return {
    name: session.name,
    windowCount: session.windows.length,
    tabCount,
    windows: Array.from({ length: shown }, (_, index) => previewWindow(session, index)),
    moreWindows: session.windows.length - shown,
  };
}

/**
 * Session → windows → tab counts and the first few titles, with per-level "+N more" counts so a
 * large import renders in constant size. The totals always describe the whole parse, not the
 * part that is drawn.
 */
export function buildImportPreview(sessions: readonly Session[]): ImportPreview {
  const shown = Math.min(sessions.length, PREVIEW_SESSION_LIMIT);
  const preview: ImportPreview = {
    sessions: sessions.slice(0, shown).map(previewSession),
    moreSessions: sessions.length - shown,
    sessionCount: sessions.length,
    windowCount: 0,
    tabCount: 0,
  };
  for (const session of sessions) {
    preview.windowCount += session.windows.length;
    for (const window of session.windows) {
      preview.tabCount += window.tabs.length;
    }
  }
  return preview;
}

/** "3 sessions · 5 windows · 87 tabs" - the same shape as a session's meta line. */
export function formatImportTotals(preview: ImportPreview): string {
  return joinFacts([
    tp('expSessionCount', preview.sessionCount),
    tp('windowCount', preview.windowCount),
    tp('tabCount', preview.tabCount),
  ]);
}
