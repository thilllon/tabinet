import { POLICY } from '@/constants';
import { t, tp, uiLanguageReady } from '@/lib/i18n';
import { captureSession } from '@/lib/session-capture';
import { contentHash } from '@/lib/session-hash';
import { formatNameStamp } from '@/lib/session-naming';
import { sessionRepo } from '@/lib/session-repo';
import type { Session, SessionId, SessionOrigin, SessionSettings, SessionSummary } from '@/types';

/**
 * Automatic history snapshots & crash recovery. Pure orchestration over
 * `captureSession()` and `sessionRepo`, plus thin `chrome.alarms` wrappers. Nothing here registers
 * a listener: the service worker (`src/service-worker.ts`) wires `alarms.onAlarm`,
 * `runtime.onStartup` and `storage.onChanged` to these functions.
 */

/** Periodic alarm; `periodInMinutes` = `SessionSettings.historyIntervalMinutes`. */
export const HISTORY_ALARM = 'history-snapshot';
/** One-shot alarm armed at startup so the first snapshot runs after Chrome restored its tabs. */
export const HISTORY_FIRST_ALARM = 'history-first';
const FIRST_SNAPSHOT_DELAY_MINUTES = 1;

/** Which event produced the snapshot; `'recovered'` and `'import'` are never captured directly. */
type HistorySnapshotOrigin = Extract<SessionOrigin, 'alarm' | 'manual' | 'startup'>;

interface HistorySnapshotOptions {
  origin: HistorySnapshotOrigin;
}

type HistorySnapshotOutcome = 'saved' | 'skipped-empty' | 'skipped-unchanged' | 'disabled';

export interface HistorySnapshotResult {
  outcome: HistorySnapshotOutcome;
  /** Set only when `outcome === 'saved'`. */
  sessionId?: SessionId;
  /** Ids removed by the ring-buffer prune that followed a save (oldest first). */
  pruned: SessionId[];
}

const PROMOTABLE_ORIGINS: ReadonlySet<SessionOrigin> = new Set<SessionOrigin>([
  'alarm',
  'manual',
  'startup',
]);

/**
 * "Snapshot 2026-08-29 14:03 · 3 windows · 87 tabs" (history counterpart of `defaultSessionName`),
 * in the UI language at capture time.
 */
export function defaultHistoryName(date: Date, windowCount: number, tabCount: number): string {
  return t(
    'sessionSnapshotDefaultName',
    formatNameStamp(date),
    tp('windowCount', windowCount),
    tp('tabCount', tabCount),
  );
}

/** "Previous session (recovered) 2026-08-29 14:03" - `date` is the snapshot's capture time. */
export function recoveredSnapshotName(date: Date): string {
  return t('sessionRecoveredName', formatNameStamp(date));
}

function tabCountOf(session: Session): number {
  return session.windows.reduce((count, win) => count + win.tabs.length, 0);
}

/**
 * Capture every normal window and store it as a `kind: 'history'` session, unless history is
 * off, nothing is capturable, or the layout is identical to the last snapshot (`contentHash`
 * vs `historyMeta.lastHash` - titles are excluded from the hash, see session-hash.ts). After a save the
 * ring buffer is trimmed to `historyMaxSnapshots` unprotected snapshots (saved sessions and
 * protected snapshots are never touched) and `historyMeta` is advanced.
 *
 * The steps run as separate repo calls (each under the Web Lock), not one transaction: two
 * overlapping invocations in the same worker instance could store the same layout twice, which
 * the next prune absorbs. Errors (quota, capture) propagate to the caller.
 */
export async function takeHistorySnapshot(
  opts: HistorySnapshotOptions,
): Promise<HistorySnapshotResult> {
  const settings = await sessionRepo.getSettings();
  if (!settings.historyEnabled) {
    return { outcome: 'disabled', pruned: [] };
  }

  const captured = await captureSession('all');
  if (captured.windows.length === 0) {
    return { outcome: 'skipped-empty', pruned: [] };
  }

  const hash = captured.contentHash ?? contentHash(captured.windows);
  const meta = await sessionRepo.getHistoryMeta();
  if (meta !== undefined && meta.lastHash === hash) {
    return { outcome: 'skipped-unchanged', pruned: [] };
  }

  // Named in the language chosen in Settings, which a just-woken worker may still be reading. Only
  // here, after the capture: an icon click's snapshot must see the tabs before the sort runs.
  await uiLanguageReady();
  const session: Session = {
    ...captured,
    kind: 'history',
    origin: opts.origin,
    name: defaultHistoryName(
      new Date(captured.createdAt),
      captured.windows.length,
      tabCountOf(captured),
    ),
    contentHash: hash,
  };
  await sessionRepo.put(session);
  const pruned = await sessionRepo.pruneHistory(settings.historyMaxSnapshots);
  await sessionRepo.setHistoryMeta({ lastHash: hash, lastSnapshotAt: Date.now() });
  return { outcome: 'saved', sessionId: session.id, pruned };
}

function isPromotable(summary: SessionSummary): boolean {
  return (
    summary.kind === 'history' &&
    summary.protected !== true &&
    PROMOTABLE_ORIGINS.has(summary.origin)
  );
}

/**
 * Crash recovery, run from `runtime.onStartup`: the newest unprotected alarm/manual/startup
 * snapshot is the last known layout of the previous browser session, so it becomes
 * `origin: 'recovered'`, `protected: true` (exempt from pruning) and is renamed
 * "Previous session (recovered) <capture time>". Returns its id, or `null` when nothing qualifies.
 *
 * Idempotent: a recovered snapshot is never re-promoted, and only snapshots captured *after* the
 * newest existing recovered one are candidates - otherwise every restart with no new snapshots
 * in between (history off, or an unchanged layout) would promote one more stale snapshot and
 * slowly turn the whole ring into protected entries.
 *
 * That guard bounds one startup, not the sequence of them: with new snapshots arriving between
 * restarts, each start still pins one more, and the ring buffer skips every one of them. So the
 * pins are capped here too - the newest `POLICY.snapshots.keepRecovered` stay protected (so whoever
 * notices the loss only a launch later still has it) and the rest are demoted (never deleted) back
 * into the ring. A snapshot protected some other way is never demoted: only pins this function
 * made carry the `autoProtected` marker.
 */
export async function promoteRecoveredSnapshot(): Promise<SessionId | null> {
  const summaries = await sessionRepo.listSummaries();
  const newestRecoveredAt = summaries
    .filter((summary) => summary.kind === 'history' && summary.origin === 'recovered')
    .reduce((latest, summary) => Math.max(latest, summary.createdAt), Number.NEGATIVE_INFINITY);

  const candidate = summaries
    .filter((summary) => isPromotable(summary) && summary.createdAt > newestRecoveredAt)
    .sort((a, b) => b.createdAt - a.createdAt || b.updatedAt - a.updatedAt)[0];

  if (candidate !== undefined) {
    await uiLanguageReady();
    await sessionRepo.markRecovered(
      candidate.id,
      recoveredSnapshotName(new Date(candidate.createdAt)),
    );
  }
  // Runs even when nothing was promoted: a start that finds no candidate can still find more
  // pins than the cap (a lowered cap, or an interrupted trim on the previous start).
  await sessionRepo.demoteAutoProtected(POLICY.snapshots.keepRecovered);
  return candidate?.id ?? null;
}

/**
 * Re-asserts the periodic alarm from the settings (reads them when not given). Chrome drops all
 * alarms on extension update/reload, so this runs from `onInstalled`/`onStartup` and whenever
 * `sessionSettings` changes. With history off both alarms are cleared so the worker goes back to
 * waking on user actions only.
 *
 * An alarm already running at the right interval is left alone: `alarms.create` restarts the
 * countdown, and this runs on every settings write and every browser start, so with a long
 * interval (up to a day) re-creating it each time could keep pushing the next snapshot away for
 * good. A new alarm is timed from the last snapshot, not from now, for the same reason.
 */
export async function ensureHistoryAlarm(settings?: SessionSettings): Promise<void> {
  const resolved = settings ?? (await sessionRepo.getSettings());
  if (resolved.historyEnabled) {
    const period = resolved.historyIntervalMinutes;
    const existing = await chrome.alarms.get(HISTORY_ALARM);
    if (existing?.periodInMinutes === period) {
      return;
    }
    const meta = await sessionRepo.getHistoryMeta();
    const due = meta === undefined ? undefined : meta.lastSnapshotAt + period * 60_000;
    await chrome.alarms.create(
      HISTORY_ALARM,
      due === undefined
        ? { periodInMinutes: period }
        : { periodInMinutes: period, when: Math.max(Date.now(), due) },
    );
    return;
  }
  await chrome.alarms.clear(HISTORY_ALARM);
  await chrome.alarms.clear(HISTORY_FIRST_ALARM);
}

/**
 * One-shot `history-first` alarm, 1 minute after startup, so the first post-launch snapshot
 * happens once Chrome has finished restoring its tabs (a capture during restore would record
 * half-loaded windows). No-op while history is off.
 */
export async function scheduleFirstSnapshot(settings?: SessionSettings): Promise<void> {
  const resolved = settings ?? (await sessionRepo.getSettings());
  if (!resolved.historyEnabled) {
    return;
  }
  await chrome.alarms.create(HISTORY_FIRST_ALARM, {
    delayInMinutes: FIRST_SNAPSHOT_DELAY_MINUTES,
  });
}
