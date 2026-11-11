import { useEffect, useState } from 'react';

import { type ActiveVideo, activeVideoOf, sameActiveVideo } from '@/lib/youtube-video';

export interface ActiveVideoState {
  /** `undefined` until Chrome has answered, `null` when the active tab shows no video. */
  video: ActiveVideo | null | undefined;
}

/**
 * The YouTube video in the active tab of the window the notes panel is in, kept current as the
 * person switches tabs or YouTube moves to another video (it changes the url without loading a new
 * page). The tab listeners live in the panel and die with it, never in the service worker.
 */
export function useActiveVideo(): ActiveVideoState {
  const [video, setVideo] = useState<ActiveVideo | null | undefined>(undefined);

  useEffect(() => {
    let live = true;
    let windowId: number | undefined;

    const refresh = () => {
      if (windowId === undefined) {
        return;
      }
      chrome.tabs.query({ active: true, windowId }).then(
        ([tab]) => {
          if (!live) {
            return;
          }
          const next = activeVideoOf(tab);
          setVideo((current) =>
            current !== undefined && sameActiveVideo(current, next) ? current : next,
          );
        },
        (err: unknown) => {
          console.error('[tabinet:notes] active tab unknown', err);
          if (live) {
            setVideo(null);
          }
        },
      );
    };

    const onActivated = (info: chrome.tabs.OnActivatedInfo) => {
      if (info.windowId === windowId) {
        refresh();
      }
    };
    const onUpdated = (_tabId: number, change: chrome.tabs.OnUpdatedInfo, tab: chrome.tabs.Tab) => {
      if (
        tab.active &&
        tab.windowId === windowId &&
        (change.url !== undefined || change.title !== undefined)
      ) {
        refresh();
      }
    };
    // A tab dragged in or out of this window changes which tab is active here.
    const onMovedBetweenWindows = () => refresh();

    chrome.tabs.onActivated.addListener(onActivated);
    chrome.tabs.onUpdated.addListener(onUpdated);
    chrome.tabs.onAttached.addListener(onMovedBetweenWindows);
    chrome.tabs.onDetached.addListener(onMovedBetweenWindows);

    // The side panel belongs to one window; `getCurrent` answers with it.
    chrome.windows.getCurrent().then(
      (window) => {
        windowId = window.id;
        refresh();
      },
      (err: unknown) => {
        console.error('[tabinet:notes] window unknown', err);
        if (live) {
          setVideo(null);
        }
      },
    );

    return () => {
      live = false;
      chrome.tabs.onActivated.removeListener(onActivated);
      chrome.tabs.onUpdated.removeListener(onUpdated);
      chrome.tabs.onAttached.removeListener(onMovedBetweenWindows);
      chrome.tabs.onDetached.removeListener(onMovedBetweenWindows);
    };
  }, []);

  return { video };
}
