import { useEffect, useState } from 'react';

import { type PlayerState, readPlayer } from '@/lib/youtube-player';

/** How often the panel asks the page where the video is. */
const POLL_MS = 1000;

/**
 * The player's state in `tabId`, asked again every second while the panel is visible, so the
 * "Add note at" button shows the time it would take. `null` until the page answers, or while it
 * cannot (no access, no video yet). Only the component that shows the time uses this, so the
 * second-by-second update redraws that button and nothing else.
 */
export function usePlayerTime(tabId: number | undefined, enabled: boolean): PlayerState | null {
  const [state, setState] = useState<PlayerState | null>(null);

  useEffect(() => {
    setState(null);
    if (tabId === undefined || !enabled) {
      return;
    }
    let live = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const poll = () => {
      if (document.visibilityState !== 'visible') {
        timer = setTimeout(poll, POLL_MS);
        return;
      }
      readPlayer(tabId)
        .catch(() => null)
        .then((next) => {
          if (!live) {
            return;
          }
          setState((current) =>
            current !== null &&
            next !== null &&
            Math.floor(current.currentTime) === Math.floor(next.currentTime) &&
            current.paused === next.paused &&
            current.title === next.title
              ? current
              : next,
          );
          timer = setTimeout(poll, POLL_MS);
        });
    };
    poll();
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [tabId, enabled]);

  return state;
}
