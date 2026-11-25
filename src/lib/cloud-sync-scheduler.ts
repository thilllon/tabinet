import { POLICY } from '@/constants';
/**
 * The cloud sync timers of one service worker's life (GitHub issue #257): a short debounce after a
 * change, with a limit so edits that keep coming still go out, and one run at a time plus at most
 * one waiting behind it. All of it is lost when Chrome stops the worker, so everything that must
 * not be lost also has the `cloud-sync-soon` alarm (`src/lib/cloud-sync.ts`).
 */
import type { SyncOptions, SyncResult, SyncTrigger } from '@/lib/cloud-sync';

/** Quiet time after the last change before it is sent. */
export const SYNC_DEBOUNCE_MS = POLICY.sync.debounceMs;
/** The longest a change waits while more keep coming. */
export const SYNC_MAX_WAIT_MS = POLICY.sync.maxWaitMs;

/**
 * `'changed'`: the debounce timer. `'due'`: the soon alarm. `'periodic'`: the periodic alarm.
 * `'always'`: an account or key that just became ready.
 */
export type SyncRunMode = 'changed' | 'due' | 'periodic' | 'always';

const STRENGTH: Record<SyncRunMode, number> = { changed: 0, due: 1, periodic: 2, always: 3 };

/** The wait for the timer when a change lands `now`, in a burst that began at `burstStart`. Pure. */
export function debounceDelay(burstStart: number, now: number): number {
  return Math.max(0, Math.min(SYNC_DEBOUNCE_MS, burstStart + SYNC_MAX_WAIT_MS - now));
}

export interface SyncScheduler {
  /** What a storage change asked for (`handleCloudStorageChange()`). */
  trigger(trigger: SyncTrigger): void;
  /** A run now, or straight after the running one. */
  run(mode: SyncRunMode): void;
}

export function createSyncScheduler(deps: {
  sync(options?: SyncOptions): Promise<SyncResult>;
  report(err: unknown): void;
}): SyncScheduler {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let burstStart: number | undefined;
  let running: AbortController | undefined;
  let waiting: SyncRunMode | undefined;

  const cancelTimer = () => {
    clearTimeout(timer);
    timer = undefined;
    burstStart = undefined;
  };

  const run = (mode: SyncRunMode) => {
    if (mode === 'periodic' || mode === 'always') {
      // This run reads what is dirty when it starts, so it sends what the timer was waiting to.
      cancelTimer();
    }
    if (running !== undefined) {
      if (waiting === undefined || STRENGTH[mode] > STRENGTH[waiting]) {
        waiting = mode;
      }
      return;
    }
    running = new AbortController();
    const { signal } = running;
    deps
      .sync(mode === 'always' ? { signal } : { signal, onlyIf: mode })
      .catch(deps.report)
      .finally(() => {
        running = undefined;
        const next = waiting;
        waiting = undefined;
        if (next !== undefined) {
          run(next);
        }
      });
  };

  const trigger = (what: SyncTrigger) => {
    if (what === 'now') {
      run('always');
    } else if (what === 'stop') {
      cancelTimer();
      waiting = undefined;
      // Signed out: what is on the way belongs to nobody here any more.
      running?.abort();
    } else if (what === 'soon') {
      const now = Date.now();
      burstStart ??= now;
      clearTimeout(timer);
      timer = setTimeout(
        () => {
          cancelTimer();
          run('changed');
        },
        debounceDelay(burstStart, now),
      );
    }
  };

  return { trigger, run };
}
