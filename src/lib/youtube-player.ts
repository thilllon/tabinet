import { isRecord } from '@/lib/import-guards';

/**
 * The YouTube notes panel's view of the player in a tab: read its time, title, length and whether
 * it plays; seek; pause and play. Each is one `chrome.scripting.executeScript` of
 * `controlPlayerInPage`, which needs the optional YouTube host permission (src/lib/pause-youtube.ts
 * asks for it); without it Chrome refuses the injection and the call rejects. There is no content
 * script and nothing stays in the page. No `chrome.*` while the module evaluates.
 */

export type PlayerCommand = 'read' | 'seek' | 'pause' | 'play';

/** What the panel knows about the player, read in the page. */
export interface PlayerState {
  /** Seconds from the start. */
  currentTime: number;
  /** Seconds; 0 while the video has not loaded its length (or is a live stream without one). */
  duration: number;
  paused: boolean;
  /** `document.title`, e.g. `(3) Title - YouTube`; `cleanVideoTitle()` makes it the title. */
  title: string;
  /** For `pause`: the video was playing and this call paused it. Otherwise false. */
  changed: boolean;
}

/**
 * Runs inside the YouTube page, not in the extension: Chrome serializes it, so it must stay
 * self-contained (no imports, no closure over anything in this module). Finds the watch page's
 * player (the video inside `#movie_player`; the first video when there is no such element),
 * carries out `command` and returns the state after it, or `null` when the page has no video.
 * `play()` returns a promise that rejects when the browser refuses autoplay; that is ignored, the
 * video then simply stays paused.
 */
export function controlPlayerInPage(command: PlayerCommand, seconds: number): PlayerState | null {
  const videos = Array.from(document.querySelectorAll<HTMLVideoElement>('video'));
  const video =
    videos.find(
      (element) =>
        typeof element.closest === 'function' && element.closest('#movie_player') !== null,
    ) ?? videos[0];
  if (video === undefined) {
    return null;
  }
  let changed = false;
  if (command === 'seek' && Number.isFinite(seconds) && seconds >= 0) {
    video.currentTime = seconds;
  } else if (command === 'pause' && !video.paused) {
    video.pause();
    changed = true;
  } else if (command === 'play' && video.paused) {
    const started: unknown = video.play();
    if (started instanceof Promise) {
      started.catch(() => undefined);
    }
  }
  const duration = Number.isFinite(video.duration) ? video.duration : 0;
  return {
    currentTime: Number.isFinite(video.currentTime) ? video.currentTime : 0,
    duration,
    paused: video.paused,
    title: typeof document.title === 'string' ? document.title : '',
    changed,
  };
}

function isPlayerState(value: unknown): value is PlayerState {
  if (!isRecord(value)) {
    return false;
  }
  const record = value;
  return (
    typeof record.currentTime === 'number' &&
    typeof record.duration === 'number' &&
    typeof record.paused === 'boolean' &&
    typeof record.title === 'string' &&
    typeof record.changed === 'boolean'
  );
}

/**
 * Sends `command` to the top frame of `tabId` and returns the player's state after it, or `null`
 * when the page shows no video. Rejects when Chrome refuses (no access to YouTube, the tab closed
 * or is discarded, an error page).
 */
export async function controlPlayer(
  tabId: number,
  command: PlayerCommand,
  seconds = 0,
): Promise<PlayerState | null> {
  const results = await chrome.scripting.executeScript({
    target: { tabId },
    func: controlPlayerInPage,
    args: [command, seconds],
  });
  const result: unknown = results[0]?.result;
  return isPlayerState(result) ? result : null;
}

export function readPlayer(tabId: number): Promise<PlayerState | null> {
  return controlPlayer(tabId, 'read');
}

export function seekPlayer(tabId: number, seconds: number): Promise<PlayerState | null> {
  return controlPlayer(tabId, 'seek', seconds);
}

export function pausePlayer(tabId: number): Promise<PlayerState | null> {
  return controlPlayer(tabId, 'pause');
}

export function playPlayer(tabId: number): Promise<PlayerState | null> {
  return controlPlayer(tabId, 'play');
}
