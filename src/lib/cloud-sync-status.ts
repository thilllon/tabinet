/**
 * What Settings > Account says about cloud sync (GitHub issue #257): the one status line and the
 * next check for other devices' changes. Nothing is remembered as "syncing": a run holds the sync
 * Web Lock, which the browser releases however the run ends, a stopped worker included, and the
 * times are those of the real alarms.
 */
import {
  CLOUD_SYNC_ALARM,
  CLOUD_SYNC_SOON_ALARM,
  SYNC_LOCK_NAME,
  SYNC_PERIOD_MINUTES,
} from '@/lib/cloud-sync';
import { SYNC_DEBOUNCE_MS } from '@/lib/cloud-sync-scheduler';
import { loadSyncStatus, type SyncStatus } from '@/lib/cloud-sync-state';
import { formatClockTime, formatDateTime } from '@/lib/display-format';
import { t, tp } from '@/lib/i18n';

export interface SyncFacts extends SyncStatus {
  /** A run holds the sync lock, whichever page or worker started it. */
  running: boolean;
  /** When the soon alarm (the fallback or a retry) fires. */
  soonAt: number | null;
  /** When the periodic alarm fires: the next check for other devices' changes. */
  checkAt: number | null;
}

export const NO_SYNC_FACTS: SyncFacts = {
  lastSyncAt: null,
  lastAttemptAt: null,
  changedAt: null,
  pending: false,
  failing: false,
  lastError: undefined,
  heldImages: 0,
  heldImagesNoticed: false,
  running: false,
  soonAt: null,
  checkAt: null,
};

export type SyncPhase =
  | { kind: 'syncing' }
  | { kind: 'failed'; at: number | null }
  | { kind: 'sendingSoon' }
  | { kind: 'partial'; at: number | null }
  | { kind: 'waiting'; at: number | null }
  | { kind: 'held'; count: number; at: number }
  | { kind: 'upToDate'; at: number }
  | { kind: 'notSynced' };

/** After a change the timer has run by now; later, only an alarm can still be trusted to. */
const SOON_WINDOW_MS = SYNC_DEBOUNCE_MS + 1500;

/**
 * Whether "in a few seconds" is still true: a change no run has started for, recent enough for
 * the worker's timer. In a burst each change moves the window; the timer's limit ends it.
 */
function timerIsDue(facts: SyncFacts, now: number): boolean {
  const { changedAt, lastAttemptAt } = facts;
  return (
    facts.pending &&
    changedAt !== null &&
    changedAt >= (lastAttemptAt ?? 0) &&
    Math.abs(now - changedAt) < SOON_WINDOW_MS
  );
}

/** The earliest automatic run that is scheduled. */
function nextRunAt(facts: SyncFacts): number | null {
  const times = [facts.soonAt, facts.checkAt].filter((at) => at !== null);
  return times.length === 0 ? null : Math.min(...times);
}

/** The one status that is true now. Pure. */
export function syncPhase(facts: SyncFacts, now: number): SyncPhase {
  if (facts.running) {
    return { kind: 'syncing' };
  }
  if (facts.failing) {
    return { kind: 'failed', at: nextRunAt(facts) };
  }
  if (timerIsDue(facts, now)) {
    return { kind: 'sendingSoon' };
  }
  if (facts.lastError !== undefined) {
    return { kind: 'partial', at: nextRunAt(facts) };
  }
  if (facts.pending) {
    return { kind: 'waiting', at: nextRunAt(facts) };
  }
  if (facts.lastSyncAt === null) {
    return { kind: 'notSynced' };
  }
  return facts.heldImages > 0
    ? { kind: 'held', count: facts.heldImages, at: facts.lastSyncAt }
    : { kind: 'upToDate', at: facts.lastSyncAt };
}

/** The status sentence. */
export function syncPhaseText(phase: SyncPhase): string {
  switch (phase.kind) {
    case 'syncing':
      return t('settingsAccountStatusSyncing');
    case 'failed':
      return phase.at === null
        ? t('settingsAccountStatusFailedPlain')
        : t('settingsAccountStatusFailed', formatClockTime(phase.at, 'seconds'));
    case 'sendingSoon':
      return t('settingsAccountStatusSoon');
    case 'partial':
      return phase.at === null
        ? t('settingsAccountStatusPartialPlain')
        : t('settingsAccountStatusPartial', formatClockTime(phase.at, 'seconds'));
    case 'waiting':
      return phase.at === null
        ? t('settingsAccountStatusWaitingPlain')
        : t('settingsAccountStatusWaiting', formatClockTime(phase.at, 'seconds'));
    case 'held':
      return tp('settingsAccountStatusHeld', phase.count, formatDateTime(phase.at));
    case 'upToDate':
      return t('settingsAccountStatusUpToDate', formatDateTime(phase.at));
    case 'notSynced':
      return t('settingsAccountNotSyncedYet');
  }
}

/** Every sentence the line can hold, for reserving the height of the tallest. Pure but for `t()`. */
export function syncPhaseVariants(at: number, heldImages: number): string[] {
  const phases: SyncPhase[] = [
    { kind: 'syncing' },
    { kind: 'failed', at },
    { kind: 'sendingSoon' },
    { kind: 'partial', at },
    { kind: 'waiting', at },
    { kind: 'held', count: Math.max(1, heldImages), at },
    { kind: 'upToDate', at },
    { kind: 'notSynced' },
  ];
  return phases.map(syncPhaseText);
}

/** When other devices' changes are next looked for, with the period in it. */
export function nextCheckText(checkAt: number | null): string {
  return checkAt === null
    ? tp('settingsAccountCheckEvery', SYNC_PERIOD_MINUTES)
    : tp('settingsAccountNextCheck', SYNC_PERIOD_MINUTES, formatClockTime(checkAt));
}

/**
 * When the line could next be wrong with no storage event to say so (a timer window closing, an
 * alarm time passing), or `null`. Always ahead of `now`, so reading again cannot spin. Pure.
 */
export function nextReadAt(facts: SyncFacts, now: number): number | null {
  const times = [
    timerIsDue(facts, now) && facts.changedAt !== null ? facts.changedAt + SOON_WINDOW_MS : null,
    facts.soonAt === null ? null : facts.soonAt + 1000,
    facts.checkAt === null ? null : facts.checkAt + 1000,
  ].filter((at): at is number => at !== null && at > now);
  return times.length === 0 ? null : Math.min(...times);
}

/** Whether two readings would show the same, so an unchanged one renders nothing. Pure. */
export function sameFacts(a: SyncFacts, b: SyncFacts): boolean {
  return (Object.keys(a) as (keyof SyncFacts)[]).every((key) => a[key] === b[key]);
}

/** Whether a sync holds the lock. A page waiting in `whenSyncEnds()` holds it shared, and is not one. */
async function syncRunning(): Promise<boolean> {
  const locks = typeof navigator === 'undefined' ? undefined : navigator.locks;
  const held = (await locks?.query())?.held;
  return held?.some((lock) => lock.name === SYNC_LOCK_NAME && lock.mode === 'exclusive') === true;
}

/** Resolves once the running sync lets go of the lock, also when its worker died; or on abort. */
export async function whenSyncEnds(signal: AbortSignal): Promise<void> {
  try {
    await navigator.locks.request(SYNC_LOCK_NAME, { mode: 'shared', signal }, () => undefined);
  } catch (err: unknown) {
    if (!signal.aborted) {
      throw err;
    }
  }
}

export async function loadSyncFacts(): Promise<SyncFacts> {
  const [status, running, soon, check] = await Promise.all([
    loadSyncStatus(),
    syncRunning(),
    chrome.alarms.get(CLOUD_SYNC_SOON_ALARM),
    chrome.alarms.get(CLOUD_SYNC_ALARM),
  ]);
  return {
    ...status,
    running,
    soonAt: soon?.scheduledTime ?? null,
    checkAt: check?.scheduledTime ?? null,
  };
}
