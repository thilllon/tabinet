import { errorDetail } from '@/lib/error-message';
import { formatNumber, joinSentences, type MessageKey, t, tp } from '@/lib/i18n';
import type { ExportScope } from '@/lib/session-export';
import { sessionRepo } from '@/lib/session-repo';
import type { ExportFormat, Session, SessionId, SessionSummary } from '@/types';

/**
 * Everything the export menu and Settings' "Export everything" decide, kept out of the components:
 * which items the menu shows, what a scope is called, what the confirmation says, and how the
 * bodies of a whole backup are collected. Serialization itself lives in `src/lib/session-export.ts`.
 */

interface ExportFormatItem {
  format: ExportFormat;
  /** Menu item text; also what the QA script looks for. */
  label: string;
}

const EXPORT_FORMATS: readonly ExportFormat[] = ['json', 'markdown', 'text', 'html', 'csv'];

const FORMAT_ITEM_KEYS: Record<ExportFormat, MessageKey> = {
  json: 'expMenuJson',
  markdown: 'expMenuMarkdown',
  text: 'expMenuText',
  html: 'expMenuHtml',
  csv: 'expMenuCsv',
};

/** The export menu's items in menu order, labelled in the UI language at call time. */
export function exportFormatItems(): ExportFormatItem[] {
  return EXPORT_FORMATS.map((format) => ({ format, label: t(FORMAT_ITEM_KEYS[format]) }));
}

/** One whole sentence per format, so a translation can put the name where its grammar wants. */
const EXPORTED_NOTICE_KEYS: Record<ExportFormat, MessageKey> = {
  json: 'expExportedJson',
  markdown: 'expExportedMarkdown',
  text: 'expExportedText',
  html: 'expExportedHtml',
  csv: 'expExportedCsv',
};

/**
 * The optional indices the menu carries as props, as the discriminated `ExportScope` union
 * `scopeToSession()` expects. A `groupIndex` without a `windowIndex` is meaningless and is
 * treated as the whole session.
 */
export function buildExportScope(
  session: Session,
  windowIndex?: number,
  groupIndex?: number,
): ExportScope {
  if (windowIndex === undefined) {
    return { session };
  }
  if (groupIndex === undefined) {
    return { session, windowIndex };
  }
  return { session, windowIndex, groupIndex };
}

/**
 * What the export is called in the filename and in the confirmation: the session name, narrowed
 * by "Window N" or by the group's title. An out-of-range index falls back to the session name -
 * a stale click must not throw on the way to a notice.
 */
export function exportScopeName(
  session: Session,
  windowIndex?: number,
  groupIndex?: number,
): string {
  if (windowIndex === undefined || session.windows[windowIndex] === undefined) {
    return session.name;
  }
  if (groupIndex === undefined) {
    return t('expScopeWindow', session.name, formatNumber(windowIndex + 1));
  }
  const group = session.windows[windowIndex].groups[groupIndex];
  if (group === undefined) {
    return t('expScopeWindow', session.name, formatNumber(windowIndex + 1));
  }
  return t('expScopeGroup', session.name, group.title === '' ? t('expUntitledGroup') : group.title);
}

export function exportedNotice(name: string, format: ExportFormat): string {
  return t(EXPORTED_NOTICE_KEYS[format], name);
}

export function copiedLinksNotice(count: number): string {
  return tp('commonCopiedLinks', count);
}

export function copiedMarkdownNotice(count: number): string {
  return tp('expCopiedMarkdown', count);
}

/**
 * The tab row's own "Copy link": one url, so it is a sentence rather than a count -
 * "Copied 1 link." would be counting to one. The multi-link notices above stay as they are.
 */
export function copiedLinkNotice(): string {
  return t('expCopiedLink');
}

/** Nothing was in scope - an empty group, or a window whose tabs were all removed. */
export function nothingToExportNotice(): string {
  return t('expNothingToExport');
}

// ---------------------------------------------------------------------------
// Export all (JSON backup)
// ---------------------------------------------------------------------------

export interface CollectProgress {
  loaded: number;
  total: number;
}

interface CollectedBodies {
  /** The bodies that could be read, in the order their summaries were given. */
  sessions: Session[];
  /** Ids whose body is gone or unreadable (deleted mid-pass, or a newer schema version). */
  skipped: SessionId[];
}

/** Above this many sessions the collection is slow enough to be worth announcing. */
export const PROGRESS_NOTICE_THRESHOLD = 20;

export function shouldReportProgress(total: number): boolean {
  return total > PROGRESS_NOTICE_THRESHOLD;
}

export function collectProgressNotice(progress: CollectProgress): string {
  return t('expCollecting', formatNumber(progress.loaded), formatNumber(progress.total));
}

/** A notice per body would re-render the whole dashboard for every read; tick in batches. */
export const PROGRESS_TICK_SIZE = 10;

export function shouldTickProgress(progress: CollectProgress): boolean {
  return progress.loaded % PROGRESS_TICK_SIZE === 0 || progress.loaded === progress.total;
}

export function exportAllNotice(exported: number, skipped: number): string {
  const sentence = tp('expExportedAll', exported);
  return skipped === 0 ? sentence : joinSentences(sentence, tp('expUnreadable', skipped));
}

/**
 * Whether "Export everything" has anything to put in a backup: at least one session or snapshot
 * this version can read. Settings disables the button otherwise, so an empty store never answers
 * a click with a "nothing to export" notice (and repeated clicks never stack them).
 */
export function canExportAll(summaries: readonly SessionSummary[]): boolean {
  return summaries.some((summary) => summary.unreadable === undefined);
}

/** Every body vanished between the click and the read (deleted in another window meanwhile). */
export function nothingToExportAllNotice(): string {
  return t('expNothingToExportAll');
}

/**
 * Reads every body in `summaries` through `sessionRepo.get()` - saved sessions and history
 * snapshots alike - so Settings' "Export everything" can put them in one `ExportBundle`.
 *
 * Sequential on purpose: a backup of hundreds of sessions is read one body at a time so the page
 * never holds a burst of parallel reads, and `onProgress` can drive an honest counter. A body
 * that has vanished or cannot be migrated costs itself only: it is listed in `skipped` and the
 * backup still contains everything else.
 */
export async function collectSessionBodies(
  summaries: readonly SessionSummary[],
  onProgress?: (progress: CollectProgress) => void,
): Promise<CollectedBodies> {
  const sessions: Session[] = [];
  const skipped: SessionId[] = [];
  const total = summaries.length;
  let loaded = 0;
  for (const summary of summaries) {
    try {
      const session = await sessionRepo.get(summary.id);
      if (session === undefined) {
        skipped.push(summary.id);
      } else {
        sessions.push(session);
      }
    } catch (err) {
      console.warn('[tabinet:sessions] export skipped', summary.id, errorDetail(err));
      skipped.push(summary.id);
    }
    loaded += 1;
    onProgress?.({ loaded, total });
  }
  return { sessions, skipped };
}
