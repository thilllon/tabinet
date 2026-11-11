/**
 * The toast queue: the "Setting saved" confirmations and the app's notices ("Exported …",
 * "Saved …"). They float over the page instead of taking a line in it, because a line that
 * appears above the content pushes everything under it down, and back up when it goes. Settings
 * write on every keystroke of a radio or switch, so the queue has to survive a burst: three flicks of the same switch inside a second must read as
 * three confirmations, not one flickering box, and must not grow without end either.
 *
 * Kept pure and separate from the component so the capping and expiry rules can be tested without
 * a DOM - the timers themselves live in `useSavedToasts` (src/hooks/use-toasts.ts).
 */

/** How long a one-word confirmation stays up. */
export const TOAST_MS = 1000;

/** How long a notice stays up: a sentence, sometimes with a name in it, needs reading time. */
export const NOTICE_MS = 4000;

/** How long an error stays up: it has to be read, and nothing else keeps it on screen. */
export const ERROR_MS = 8000;

/** How long a toast with a button stays up: long enough to read it and reach the button. */
export const ACTION_MS = 12000;

/** How many may be stacked at once; a fourth pushes the oldest out. */
export const MAX_TOASTS = 3;

export interface Toast {
  /** Monotonic; also the React key, so a repeated message still animates as a new toast. */
  id: number;
  message: string;
  /** A notice rather than a confirmation: shown without the tick. */
  plain?: boolean;
  /** An error: red-tinted, with a warning sign instead of the tick. */
  tone?: 'error';
  /** A button on the toast; pressing it runs `run` and closes the toast. */
  action?: ToastAction;
}

export interface ToastAction {
  label: string;
  run(): void;
}

/**
 * Appends `toast`, keeping at most `max`. The *oldest* is dropped rather than the newest being
 * refused: the last thing you changed is the thing you want confirmed, so a burst should scroll
 * rather than freeze on the first three.
 */
export function pushToast(list: readonly Toast[], toast: Toast, max: number = MAX_TOASTS): Toast[] {
  if (max <= 0) {
    return [];
  }
  return [...list, toast].slice(-max);
}

/**
 * Rewrites the toast with `toast.id` where it stands, or appends it when it is not (or no longer)
 * on screen. A running count - "Collecting sessions… 30 of 200" - is one toast that changes, not
 * a new one per tick, and keeping the id keeps React from animating it in again each time.
 */
export function upsertToast(
  list: readonly Toast[],
  toast: Toast,
  max: number = MAX_TOASTS,
): Toast[] {
  return list.some((entry) => entry.id === toast.id)
    ? list.map((entry) => (entry.id === toast.id ? toast : entry))
    : pushToast(list, toast, max);
}

/** Removes the toast whose timer fired. A no-op if the cap already pushed it out. */
export function dropToast(list: readonly Toast[], id: number): Toast[] {
  return list.filter((toast) => toast.id !== id);
}
