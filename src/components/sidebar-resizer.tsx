import { type KeyboardEvent, type PointerEvent, useRef } from 'react';

import { t } from '@/lib/i18n';
import {
  clampSidebarWidth,
  MAX_SIDEBAR_WIDTH,
  MIN_SIDEBAR_WIDTH,
  SIDEBAR_WIDTH_STEP,
} from '@/lib/ui-state';

interface SidebarResizerProps {
  width: number;
  /** Called on every drag frame and on every arrow key - already clamped. */
  onResize(width: number): void;
  /** Called when the drag or key press ends, so the width can be stored once. */
  onCommit(width: number): void;
}

/**
 * The grab bar between the sidebar and the main pane. Pointer capture rather than window-level
 * listeners: the pointer keeps reporting to this element even when the drag runs past the window,
 * and the browser cleans up if the button is released somewhere we never see. Arrow keys move it
 * too - a drag handle nobody can reach from the keyboard is a control only some people have.
 */
export function SidebarResizer({ width, onResize, onCommit }: SidebarResizerProps) {
  const dragRef = useRef<{ startX: number; startWidth: number } | undefined>(undefined);

  const handlePointerDown = (event: PointerEvent<HTMLDivElement>) => {
    dragRef.current = { startX: event.clientX, startWidth: width };
    event.currentTarget.setPointerCapture(event.pointerId);
    event.preventDefault();
  };

  const handlePointerMove = (event: PointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (drag === undefined) {
      return;
    }
    onResize(clampSidebarWidth(drag.startWidth + (event.clientX - drag.startX)));
  };

  const endDrag = (event: PointerEvent<HTMLDivElement>) => {
    if (dragRef.current === undefined) {
      return;
    }
    dragRef.current = undefined;
    event.currentTarget.releasePointerCapture(event.pointerId);
    onCommit(width);
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const step =
      event.key === 'ArrowLeft'
        ? -SIDEBAR_WIDTH_STEP
        : event.key === 'ArrowRight'
          ? SIDEBAR_WIDTH_STEP
          : 0;
    if (step === 0) {
      return;
    }
    event.preventDefault();
    const next = clampSidebarWidth(width + step);
    onResize(next);
    onCommit(next);
  };

  return (
    <div
      // oxlint-disable-next-line jsx-a11y/prefer-tag-over-role -- a draggable resize handle is ARIA's focusable `separator`; an <hr> cannot be one.
      role="separator"
      aria-orientation="vertical"
      aria-label={t('appResizeSidebarLabel')}
      title={t('appResizeSidebarTitle')}
      aria-valuenow={width}
      aria-valuemin={MIN_SIDEBAR_WIDTH}
      aria-valuemax={MAX_SIDEBAR_WIDTH}
      tabIndex={0}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={endDrag}
      onPointerCancel={endDrag}
      onKeyDown={handleKeyDown}
      onDoubleClick={() => {
        // A double-click is the usual "put it back" on a split view.
        onResize(clampSidebarWidth(Number.NaN));
        onCommit(clampSidebarWidth(Number.NaN));
      }}
      className="group hidden cursor-col-resize touch-none items-stretch justify-center outline-none lg:flex"
    >
      <span className="h-full w-px bg-border transition-colors group-hover:bg-primary/50 group-focus-visible:bg-primary" />
    </div>
  );
}
