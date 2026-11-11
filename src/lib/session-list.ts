import { type MessageKey, t } from '@/lib/i18n';
import type { SessionOrigin, SessionSummary, UnreadableSession } from '@/types';

/**
 * Splits the index into the two lists the sidebar shows separately: `kind: 'saved'` in the
 * saved sessions list, `kind: 'history'` in the folded snapshots list. History snapshots share the
 * index with saved sessions, so the saved list must filter rather than render everything.
 *
 * Order is preserved from the input - `sessionRepo.listSummaries()` returns newest first, and a
 * snapshot's `updatedAt` is not moved by protect/rename, so the snapshots list gets newest-first
 * capture order for free.
 */
export function splitByKind(summaries: readonly SessionSummary[]): {
  saved: SessionSummary[];
  history: SessionSummary[];
} {
  const saved: SessionSummary[] = [];
  const history: SessionSummary[] = [];
  for (const summary of summaries) {
    (summary.kind === 'history' ? history : saved).push(summary);
  }
  return { saved, history };
}

/** The version that wrote it, for the row's second line: "schema v2". */
export function unreadableSchemaLabel(unreadable: UnreadableSession): string {
  return t('sessionUnreadableSchema', unreadable.version);
}

const ORIGIN_LABEL_KEYS: Record<SessionOrigin, MessageKey> = {
  alarm: 'sessionOriginAlarm',
  manual: 'sessionOriginManual',
  startup: 'sessionOriginStartup',
  recovered: 'sessionOriginRecovered',
  import: 'sessionOriginImport',
};

/** Badge text for a snapshot row: the alarm is the "automatic" one users recognise. */
export function historyOriginLabel(origin: SessionOrigin): string {
  return t(ORIGIN_LABEL_KEYS[origin]);
}

/** Capture time decides which snapshot is newest (protect/rename never move `createdAt`). */
function newestFirst(a: SessionSummary, b: SessionSummary): number {
  return b.createdAt - a.createdAt || b.updatedAt - a.updatedAt || a.id.localeCompare(b.id);
}

/**
 * The snapshot the worker promoted after a restart, while it is still the newest one - the app's
 * sidebar marks it "recovered" instead of putting a banner over the page. An ordinary snapshot
 * taken after it means the user has been browsing since the restart, so the marker goes away on
 * its own.
 */
export function recoveredSnapshot(
  historySummaries: readonly SessionSummary[],
): SessionSummary | undefined {
  const newest = [...historySummaries].sort(newestFirst)[0];
  return newest !== undefined && newest.origin === 'recovered' ? newest : undefined;
}
