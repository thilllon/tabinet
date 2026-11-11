import { useCallback, useEffect, useRef, useState } from 'react';

import { sessionRepo } from '@/lib/session-repo';
import {
  executeRestore,
  loadSanitizeOptions,
  planRestore,
  type RestoreResult,
  type RestoreTarget,
  screenRectOf,
} from '@/lib/session-restore';
import type { Session, SessionSettings } from '@/types';

export interface RestoreProgress {
  done: number;
  total: number;
  /** 0-based index of the window being filled, and how many windows the plan has. */
  windowIndex: number;
  windowCount: number;
  /** True when this restore discards tabs as it goes, so the toast can say what that means. */
  lazy: boolean;
  /** `Date.now()` when the restore started; the toast derives the tabs/s rate from it. */
  startedAt: number;
}

type RestoreOutcome = { ok: true } | { ok: false; reason: 'busy' };

interface UseRestore {
  /**
   * Plans and executes a restore in this page. Resolves `{ ok: false, reason: 'busy' }` -- without
   * touching any state -- when a restore is already running, so the caller reports that from the
   * return value rather than from a `running` flag that can lag a click by a render.
   * `lazyOverride` comes from the confirm dialog's checkbox.
   */
  restore(
    session: Session,
    target: RestoreTarget,
    lazyOverride?: SessionSettings['restoreLazy'],
  ): Promise<RestoreOutcome>;
  progress?: RestoreProgress;
  running: boolean;
  cancel(): void;
  /**
   * True from `cancel()` until the aborted run has wound down: the abort is only noticed between
   * chunks and between commit polls, so the toast acknowledges the click in the meantime.
   */
  cancelling: boolean;
  lastResult?: RestoreResult;
  /** True when `lastResult` ended because `cancel()` aborted it, rather than running to completion. */
  cancelled: boolean;
  dismiss(): void;
}

export function useRestore(): UseRestore {
  const [running, setRunning] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [progress, setProgress] = useState<RestoreProgress | undefined>(undefined);
  const [lastResult, setLastResult] = useState<RestoreResult | undefined>(undefined);
  const [cancelled, setCancelled] = useState(false);
  const controllerRef = useRef<AbortController | null>(null);

  // Warn before leaving the page while a restore is in flight.
  useEffect(() => {
    if (!running) {
      return;
    }
    const warn = (event: BeforeUnloadEvent) => {
      event.preventDefault();
    };
    window.addEventListener('beforeunload', warn);
    return () => {
      window.removeEventListener('beforeunload', warn);
    };
  }, [running]);

  // Abort any in-flight restore if this hook (i.e. the dashboard) unmounts.
  useEffect(() => {
    return () => {
      controllerRef.current?.abort();
    };
  }, []);

  const restore = useCallback<UseRestore['restore']>(async (session, target, lazyOverride) => {
    if (controllerRef.current !== null) {
      return { ok: false, reason: 'busy' };
    }
    const controller = new AbortController();
    controllerRef.current = controller;
    setRunning(true);
    setLastResult(undefined);
    setCancelled(false);
    const startedAt = Date.now();
    setProgress({ done: 0, total: 0, windowIndex: 0, windowCount: 0, lazy: false, startedAt });
    try {
      const [settings, sanitize] = await Promise.all([
        sessionRepo.getSettings(),
        loadSanitizeOptions(),
      ]);
      const plan = planRestore(session, {
        target,
        lazy: lazyOverride ?? settings.restoreLazy,
        sanitize,
      });
      // `planRestore` decides lazily-or-not once for the whole plan, so any window answers for it.
      const lazy = plan.windows.some((planned) => planned.lazy);
      const windowCount = plan.windows.length;
      setProgress({ done: 0, total: plan.totalTabs, windowIndex: 0, windowCount, lazy, startedAt });
      const result = await executeRestore(plan, {
        // Named `restoring` rather than `window`: the global `window` is read right below.
        onProgress: (done, total, restoring) =>
          setProgress({
            done,
            total,
            windowIndex: restoring.index,
            windowCount: restoring.count,
            lazy,
            startedAt,
          }),
        signal: controller.signal,
        screen: screenRectOf(window.screen),
      });
      // Read `aborted` before the finally block below runs (it doesn't touch the signal, but
      // keeping the read right next to where the result lands avoids relying on that detail).
      setCancelled(controller.signal.aborted);
      setLastResult(result);
      // The toast words each failure in the UI language and drops Chrome's English text when it
      // has no translation for it; the original stays here.
      for (const entry of result.errors) {
        console.warn('[tabinet] restore', entry.url, entry.message);
      }
      return { ok: true };
    } finally {
      controllerRef.current = null;
      setProgress(undefined);
      setRunning(false);
      setCancelling(false);
    }
  }, []);

  const cancel = useCallback(() => {
    if (controllerRef.current === null) {
      return;
    }
    controllerRef.current.abort();
    setCancelling(true);
  }, []);

  const dismiss = useCallback(() => {
    setLastResult(undefined);
    setCancelled(false);
  }, []);

  return { restore, progress, running, cancel, cancelling, lastResult, cancelled, dismiss };
}
