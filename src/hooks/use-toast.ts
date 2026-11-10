import { createContext, useContext, useEffect } from 'react';

import type { ToastOptions } from '@/hooks/use-saved-toasts';
import { ERROR_MS } from '@/lib/toast-queue';

type ShowToast = (message: string, options?: ToastOptions) => void;

/**
 * The app page's one toast stack (`useSavedToasts` in `app.tsx`), handed down so any component can
 * show an alert there instead of drawing a line of its own. Outside the provider it does nothing.
 */
export const ToastContext = createContext<ShowToast>(() => {});

/**
 * Shows `message` as an error toast whenever it changes to a new text. Components keep their error
 * state as before (cleared when the next attempt starts) and call this instead of rendering it, so
 * every alert in the app reads the same way: a toast, red-tinted, up for `ERROR_MS`.
 */
export function useErrorToast(message: string | undefined, show?: ShowToast): void {
  const fromContext = useContext(ToastContext);
  const target = show ?? fromContext;
  useEffect(() => {
    if (message !== undefined) {
      target(message, { ms: ERROR_MS, tone: 'error' });
    }
  }, [message, target]);
}
