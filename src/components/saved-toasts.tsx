import { Check, TriangleAlert } from 'lucide-react';

import type { Toast } from '@/lib/toast-queue';
import { cn } from '@/lib/utils';

interface SavedToastsProps {
  toasts: readonly Toast[];
  /** Takes a toast down; called after its button ran. */
  onDismiss(id: number): void;
}

/**
 * The stack of toasts - "Setting saved" confirmations and the app's notices - pinned to the bottom
 * centre of the viewport, or of the Settings dialog when `app.tsx` renders it in there (the dialog
 * is translated into place, which makes it the containing block for `fixed` children).
 *
 * `fixed` rather than placed in the flow: a line in the flow pushes everything under it down when
 * it appears and back up when it goes, and in a long scrolling column a confirmation next to the
 * control you just touched is off-screen as soon as you scroll. Newest
 * sits at the bottom, nearest the eye.
 *
 * `pointer-events-none` on the stack - it floats over the page and must never swallow a click
 * meant for the control underneath, which matters precisely because it appears while you are still
 * clicking things.
 *
 * One `role="status"` wrapper, not one per toast: a live region announces its *changes*, so
 * re-using the same region reads each new line once instead of registering three regions that
 * re-announce the whole stack.
 */
export function SavedToasts({ toasts, onDismiss }: SavedToastsProps) {
  return (
    <div
      // oxlint-disable-next-line jsx-a11y/prefer-tag-over-role -- a live region for a stack of toasts, not a form's <output>.
      role="status"
      aria-live="polite"
      className="pointer-events-none fixed inset-x-0 bottom-6 z-50 flex flex-col items-center gap-2"
    >
      {toasts.map((toast) => (
        <div
          key={toast.id}
          className={cn(
            'mx-4 flex items-center gap-2 rounded-full border px-3 py-1.5 text-sm shadow-lg motion-safe:animate-in motion-safe:fade-in motion-safe:slide-in-from-bottom-2',
            toast.tone === 'error'
              ? 'border-toast-error-border bg-toast-error text-toast-error-foreground'
              : 'border-toast-border bg-toast text-toast-foreground',
          )}
        >
          {toast.tone === 'error' ? (
            <TriangleAlert aria-hidden="true" className="size-3.5 shrink-0" />
          ) : (
            toast.plain !== true && (
              <Check aria-hidden="true" className="size-3.5 shrink-0 text-primary" />
            )
          )}
          {toast.message}
          {toast.action !== undefined && (
            // The stack ignores the pointer; only the button takes clicks back.
            <button
              type="button"
              title={toast.action.title}
              className="pointer-events-auto shrink-0 rounded-full px-2 py-0.5 font-medium text-primary underline-offset-2 hover:underline focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none"
              onClick={() => {
                toast.action?.run();
                onDismiss(toast.id);
              }}
            >
              {toast.action.label}
            </button>
          )}
        </div>
      ))}
    </div>
  );
}
