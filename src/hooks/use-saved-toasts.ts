import { useCallback, useEffect, useRef, useState } from 'react';

import { dropToast, TOAST_MS, type Toast, upsertToast } from '@/lib/toast-queue';

export interface ToastOptions {
  /** How long it stays up. Default `TOAST_MS`. */
  ms?: number;
  /** A notice rather than a confirmation: shown without the tick. */
  plain?: boolean;
  /**
   * Toasts sharing a key are one toast: showing another while the first is still up rewrites it
   * (and restarts its clock) instead of stacking a second.
   */
  key?: string;
  /** An error rather than a notice. */
  tone?: 'error';
}

interface SavedToasts {
  toasts: Toast[];
  /** Shows one toast; it removes itself after `options.ms`. */
  show(message: string, options?: ToastOptions): void;
}

/**
 * Timer half of the toasts - the queue rules themselves are pure, in ./toast-queue.ts.
 *
 * Every toast owns its own timeout rather than the stack sharing one: with a shared timer a second
 * change would either cut the first toast short or hold all three up for a full second past the
 * last one. Each is tracked so unmounting the owner cannot leave a `setState` pointing at a gone
 * component.
 */
export function useSavedToasts(): SavedToasts {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const nextId = useRef(0);
  const timers = useRef(new Map<number, ReturnType<typeof setTimeout>>());
  // The id currently standing in for each key, while its timer is still running.
  const keyed = useRef(new Map<string, number>());

  useEffect(() => {
    const pending = timers.current;
    return () => {
      for (const timer of pending.values()) {
        clearTimeout(timer);
      }
      pending.clear();
    };
  }, []);

  const show = useCallback((message: string, options: ToastOptions = {}) => {
    const { ms = TOAST_MS, plain, key, tone } = options;
    const standing = key === undefined ? undefined : keyed.current.get(key);
    const id = standing !== undefined && timers.current.has(standing) ? standing : nextId.current++;
    if (key !== undefined) {
      keyed.current.set(key, id);
    }
    clearTimeout(timers.current.get(id));
    setToasts((list) => upsertToast(list, { id, message, plain, tone }));
    timers.current.set(
      id,
      setTimeout(() => {
        timers.current.delete(id);
        // Harmless if the cap already evicted this one - dropToast is a no-op then.
        setToasts((list) => dropToast(list, id));
      }, ms),
    );
  }, []);

  return { toasts, show };
}
