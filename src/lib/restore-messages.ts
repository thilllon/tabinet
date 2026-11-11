/**
 * What a restore says: the confirmation threshold, the summary line after a restore, and the
 * extra lines the progress toast shows while it runs.
 */

import { knownErrorText } from '@/lib/error-message';
import { formatNumber, joinFacts, t, tp } from '@/lib/i18n';
import type { RestoreResult, RestoreTarget } from '@/lib/session-restore';
import type { Session } from '@/types';

/** Confirm (with the lazy checkbox) when a restore would open more than 100 tabs. */
export const RESTORE_CONFIRM_THRESHOLD = 100;

export function countTabs(session: Session): number {
  return session.windows.reduce((sum, window) => sum + window.tabs.length, 0);
}

export function needsRestoreConfirm(session: Session): boolean {
  return countTabs(session) > RESTORE_CONFIRM_THRESHOLD;
}

/**
 * One sentence for the confirm dialog: a `newWindows` restore opens windows, a `window` restore
 * appends to the one the dashboard is in and opens none.
 */
export function formatRestoreDestination(session: Session, target: RestoreTarget): string {
  if (target.kind === 'window') {
    return t('restoreDestinationHere', session.name);
  }
  return tp('restoreDestinationNewWindows', session.windows.length, session.name);
}

// executeRestore records group/activation/window-state failures as `errors` entries whose `url`
// is a synthetic `group:<title>` / `activate:<url>` / `window-state:<state>` marker rather than a
// real tab url - these are structural restore problems, not tabs that failed to open.
const STRUCTURAL_ERROR_PREFIXES = ['group:', 'activate:', 'window-state:'];

function isStructuralRestoreError(entry: RestoreResult['errors'][number]): boolean {
  return STRUCTURAL_ERROR_PREFIXES.some((prefix) => entry.url.startsWith(prefix));
}

/**
 * One line of the restore result's error list, in the UI language. `entry.message` is Chrome's
 * (English) text; it is shown only when `knownErrorText()` can say it in the UI language, and the
 * line is worded without a reason otherwise. The synthetic markers become words too: a group by
 * its title, an activation by the tab's address, a window state without the internal state name.
 */
export function restoreErrorLine(entry: RestoreResult['errors'][number]): string {
  const reason = knownErrorText(entry.message);
  const { url } = entry;
  if (url.startsWith('group:')) {
    const title = url.slice('group:'.length);
    const name = title === '' ? t('treeUntitledGroup') : title;
    return reason === undefined
      ? t('restoreProblemGroupPlain', name)
      : t('restoreProblemGroup', name, reason);
  }
  if (url.startsWith('activate:')) {
    const address = url.slice('activate:'.length);
    return reason === undefined
      ? t('restoreProblemActivatePlain', address)
      : t('restoreProblemActivate', address, reason);
  }
  if (url.startsWith('window-state:')) {
    return reason === undefined
      ? t('restoreProblemWindowStatePlain')
      : t('restoreProblemWindowState', reason);
  }
  return reason === undefined
    ? t('restoreFailedItemPlain', url)
    : t('restoreFailedItem', url, reason);
}

interface SplitRestoreErrors {
  /** Real tabs that failed to open. */
  tabErrors: RestoreResult['errors'];
  /** Synthetic group/activation/window-state failures - see `isStructuralRestoreError`. */
  structuralProblems: RestoreResult['errors'];
}

/** Separates executeRestore's tab-level failures from its group/window "structural" ones. */
export function splitRestoreErrors(result: RestoreResult): SplitRestoreErrors {
  const tabErrors: RestoreResult['errors'] = [];
  const structuralProblems: RestoreResult['errors'] = [];
  for (const entry of result.errors) {
    (isStructuralRestoreError(entry) ? structuralProblems : tabErrors).push(entry);
  }
  return { tabErrors, structuralProblems };
}

/**
 * `total` (aka M) must count attempted tabs only - restored + skipped + tab errors - never
 * structural (group/window) problems; the caller computes it that way (see ProgressToast, which
 * uses `splitRestoreErrors`). That keeps "of total" meaningful whether the run finished in full or
 * broke off early (e.g. a window failed to open partway through): both read as a fraction of tabs
 * the restore actually attempted. When `options.cancelled` is set, the fraction is dropped
 * entirely in favour of a plain count of tabs opened before Cancel was pressed. Lazily restored
 * tabs (`result.discarded`) are always called out: between 51 and 100 tabs the 'auto' setting
 * discards without ever having shown the confirm dialog, so this is the only place it is visible.
 */
export function formatRestoreSummary(
  result: RestoreResult,
  total: number,
  options: { cancelled?: boolean } = {},
): string {
  const parts =
    options.cancelled === true
      ? [tp('restoreSummaryCancelled', result.restored)]
      : [tp('restoreSummaryRestored', total, formatNumber(result.restored))];
  if (result.discarded > 0) {
    parts.push(tp('restoreSummaryDiscarded', result.discarded));
  }
  if (options.cancelled === true) {
    // Cancel stops the restore; it never undoes it: already-created tabs are kept.
    // Say so, or the windows left behind look like a half-failed restore to clean up by hand.
    if (result.restored > 0) {
      parts.push(t('restoreSummaryKept'));
    }
    return joinFacts(parts);
  }
  const { tabErrors, structuralProblems } = splitRestoreErrors(result);
  if (result.skipped.length > 0) {
    parts.push(tp('restoreSummarySkipped', result.skipped.length));
  }
  if (tabErrors.length > 0) {
    parts.push(tp('restoreSummaryFailed', tabErrors.length));
  }
  if (structuralProblems.length > 0) {
    parts.push(tp('restoreSummaryProblems', structuralProblems.length));
  }
  return joinFacts(parts);
}

/**
 * The extra lines the restore toast shows while `executeRestore` runs. The tab counter itself stays where it was
 * - this is the per-window line, the throughput and the lazy-restore explanation, all pure so
 * they can be tested without a DOM.
 */

/**
 * "Window 2 of 3" - which window of the plan is being filled. `index` is 0-based, as
 * `executeRestore` reports it. A single-window restore returns undefined: "Window 1 of 1" tells
 * the user nothing the tab counter has not already said.
 */
export function formatWindowLine(index: number, count: number): string | undefined {
  if (!Number.isFinite(index) || !Number.isFinite(count) || count <= 1) {
    return undefined;
  }
  const shown = Math.min(Math.max(1, Math.floor(index) + 1), Math.floor(count));
  return t('restoreWindowLine', formatNumber(shown), formatNumber(Math.floor(count)));
}

/** Below this the sample is too short for a rate that does not jump around. */
const MIN_SAMPLE_MS = 750;

/**
 * "~45 tabs/s" - measured over the whole run so far, not the last chunk, so the number settles
 * instead of flickering. Undefined until there is enough of a sample to be honest about.
 */
export function formatRate(done: number, elapsedMs: number): string | undefined {
  if (!Number.isFinite(done) || !Number.isFinite(elapsedMs)) {
    return undefined;
  }
  if (done <= 0 || elapsedMs < MIN_SAMPLE_MS) {
    return undefined;
  }
  const perSecond = done / (elapsedMs / 1000);
  // Under 10/s the integer would round away most of the signal (0.4 -> "0 tabs/s").
  const rounded = perSecond >= 10 ? Math.round(perSecond) : Math.round(perSecond * 10) / 10;
  return tp('restoreRate', rounded);
}

/** Shown on the result of a restore that discarded tabs. */
export function lazyRestoreSummaryHint(discarded: number): string | undefined {
  if (discarded <= 0) {
    return undefined;
  }
  return tp('restoreLazyDone', discarded);
}
