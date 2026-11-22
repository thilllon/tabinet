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
  unreadable: 0,
  tooLarge: 0,
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
  | { kind: 'tooLarge'; count: number }
  | { kind: 'unreadable'; count: number }
  | { kind: 'partial'; at: number | null }
  | { kind: 'waiting'; at: number | null }
  | { kind: 'held'; count: number; at: number }
  | { kind: 'upToDate'; at: number }
  | { kind: 'notSynced' };

/** One reading of the facts, and the account (its token) it was read for. */
export interface SyncReading {
  of: string | undefined;
  facts: SyncFacts;
  phase: SyncPhase;
  /** False until the first reading, so no status is claimed before one is known. */
  loaded: boolean;
}

export const UNREAD: SyncReading = {
  of: undefined,
  facts: NO_SYNC_FACTS,
  phase: { kind: 'notSynced' },
  loaded: false,
};

/** `reading` when it is of `account`: never the status or error of the account before. Pure. */
export function readingFor(reading: SyncReading, account: string | undefined): SyncReading {
  return account !== undefined && reading.of === account ? reading : UNREAD;
}

/**
 * `facts` without alarm times that have passed: Chrome can deliver an alarm late, and a time gone
 * by is no promise. The line then says what it says without a time. Pure.
 */
export function withoutPastTimes(facts: SyncFacts, now: number): SyncFacts {
  const ahead = (at: number | null) => (at !== null && at > now ? at : null);
  return { ...facts, soonAt: ahead(facts.soonAt), checkAt: ahead(facts.checkAt) };
}

/** How soon an overdue alarm is looked at again: Chrome may be about to move or drop it. */
const OVERDUE_READ_MS = 30_000;

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

/**
 * The one status that is true now. An item too large or unreadable is never promised a next sync
 * (that would not change it), and never hidden behind "up to date". Pure.
 */
export function syncPhase(facts: SyncFacts, now: number): SyncPhase {
  if (facts.running) {
    return { kind: 'syncing' };
  }
  if (facts.failing) {
    // The retry alone: a periodic check before its time makes no request.
    return { kind: 'failed', at: facts.soonAt ?? facts.checkAt };
  }
  if (timerIsDue(facts, now)) {
    return { kind: 'sendingSoon' };
  }
  if (facts.pending && facts.soonAt !== null) {
    // The soon alarm stands only for work a run can still do.
    return { kind: 'waiting', at: nextRunAt(facts) };
  }
  if (facts.tooLarge > 0) {
    return { kind: 'tooLarge', count: facts.tooLarge };
  }
  if (facts.unreadable > 0) {
    return { kind: 'unreadable', count: facts.unreadable };
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
    case 'tooLarge':
      return tp('settingsAccountStatusTooLarge', phase.count);
    case 'unreadable':
      return tp('settingsAccountStatusUnreadable', phase.count);
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

/**
 * Times as wide as any, at tabular digits: two-digit hours on either side of noon, in the months
 * whose short names are the widest of some language (May, Sept, Nov, December).
 */
function widestTimes(): number[] {
  return [4, 8, 10, 11].flatMap((month) =>
    [10, 22].map((hour) => new Date(2028, month, 28, hour, 58, 58).getTime()),
  );
}

/**
 * Every sentence the line can hold at its widest, for reserving the height of the tallest: not
 * the time it happens to show, as the next one can be wider. Pure but for `t()`.
 */
export function syncPhaseVariants(facts: SyncFacts): string[] {
  const count = (value: number) => [1, Math.max(88, value)];
  const phases: SyncPhase[] = [
    { kind: 'syncing' },
    { kind: 'sendingSoon' },
    { kind: 'notSynced' },
    ...count(facts.tooLarge).map((n) => ({ kind: 'tooLarge', count: n }) as const),
    ...count(facts.unreadable).map((n) => ({ kind: 'unreadable', count: n }) as const),
    ...widestTimes().flatMap((at): SyncPhase[] => [
      { kind: 'failed', at },
      { kind: 'partial', at },
      { kind: 'waiting', at },
      { kind: 'upToDate', at },
      ...count(facts.heldImages).map((n) => ({ kind: 'held', count: n, at }) as const),
    ]),
  ];
  return [...new Set(phases.map(syncPhaseText))];
}

/** The same for the next check's line. */
export function nextCheckVariants(): string[] {
  return [...new Set([null, ...widestTimes()].map(nextCheckText))];
}

/**
 * When other devices' changes are next looked for: the periodic alarm, or the retry while
 * failing, as no check comes before that. Pure.
 */
export function nextCheckAt(facts: SyncFacts): number | null {
  return !facts.running && facts.failing ? (facts.soonAt ?? facts.checkAt) : facts.checkAt;
}

/** The same, as text with the period in it. */
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
    ...[facts.soonAt, facts.checkAt].map((at) => {
      if (at === null) {
        return null;
      }
      return at + 1000 > now ? at + 1000 : now + OVERDUE_READ_MS;
    }),
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
  // A run counts as failing until it ends, so the lock is asked on both sides of that reading:
  // one that just ended, or just began, must not read as a failure.
  const wasRunning = await syncRunning();
  const [status, soon, check] = await Promise.all([
    loadSyncStatus(),
    chrome.alarms.get(CLOUD_SYNC_SOON_ALARM),
    chrome.alarms.get(CLOUD_SYNC_ALARM),
  ]);
  const running = (await syncRunning()) || wasRunning;
  return {
    ...status,
    running,
    soonAt: soon?.scheduledTime ?? null,
    checkAt: check?.scheduledTime ?? null,
  };
}
