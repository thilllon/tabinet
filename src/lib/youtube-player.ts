import { isRecord } from '@/lib/import-guards';
import { isImageDataUrl } from '@/lib/youtube-video';

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

// ---------------------------------------------------------------------------
// Screenshots
// ---------------------------------------------------------------------------

/** Widest screenshot kept, in pixels; a larger frame is scaled down to it. */
export const FRAME_MAX_WIDTH = 1280;
/** WebP quality of a screenshot, 0 to 1. */
export const FRAME_QUALITY = 0.8;

/** Why a frame could not be taken. */
export type FrameFailure =
  /** The page has no video. */
  | 'noVideo'
  /** The video has no picture yet (not loaded, or no size). */
  | 'notReady'
  /** The browser refused to read the picture (a tainted canvas). */
  | 'blocked'
  /** Anything else: no 2D canvas, or the encoder gave no image. */
  | 'failed';

export type FrameResult =
  | {
      ok: true;
      /** The picture, a `data:image/...;base64,` URL (WebP in Chrome). */
      dataUrl: string;
      width: number;
      height: number;
      /** Seconds into the video when the frame was taken. */
      currentTime: number;
      /** `document.title`, as for `PlayerState.title`. */
      title: string;
    }
  | { ok: false; reason: FrameFailure };

/**
 * Runs inside the YouTube page, like `controlPlayerInPage`, and so is self-contained: it repeats
 * the way that function finds the player. Draws the video's current frame into a canvas, scaled
 * down to at most `maxWidth` pixels wide, and returns it as a WebP data URL at `quality`.
 * YouTube's video comes through Media Source Extensions from its own origin, so the canvas is not
 * tainted; a page where it is anyway makes `toDataURL` throw a `SecurityError`, reported as
 * `blocked`. Nothing is left in the page.
 */
export function captureFrameInPage(maxWidth: number, quality: number): FrameResult {
  const videos = Array.from(document.querySelectorAll<HTMLVideoElement>('video'));
  const video =
    videos.find(
      (element) =>
        typeof element.closest === 'function' && element.closest('#movie_player') !== null,
    ) ?? videos[0];
  if (video === undefined) {
    return { ok: false, reason: 'noVideo' };
  }
  const sourceWidth = video.videoWidth;
  const sourceHeight = video.videoHeight;
  // HAVE_CURRENT_DATA (2): a frame is there to draw.
  if (!(sourceWidth > 0) || !(sourceHeight > 0) || !(video.readyState >= 2)) {
    return { ok: false, reason: 'notReady' };
  }
  const scale = sourceWidth > maxWidth ? maxWidth / sourceWidth : 1;
  const width = Math.max(1, Math.round(sourceWidth * scale));
  const height = Math.max(1, Math.round(sourceHeight * scale));
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext('2d');
  if (context === null) {
    return { ok: false, reason: 'failed' };
  }
  let dataUrl: string;
  try {
    context.drawImage(video, 0, 0, width, height);
    dataUrl = canvas.toDataURL('image/webp', quality);
  } catch (err) {
    const blocked =
      typeof err === 'object' && err !== null && 'name' in err && err.name === 'SecurityError';
    return { ok: false, reason: blocked ? 'blocked' : 'failed' };
  }
  // An encoder that cannot write the type falls back to PNG; an empty canvas gives "data:,".
  if (!dataUrl.startsWith('data:image/')) {
    return { ok: false, reason: 'failed' };
  }
  return {
    ok: true,
    dataUrl,
    width,
    height,
    currentTime: Number.isFinite(video.currentTime) ? video.currentTime : 0,
    title: typeof document.title === 'string' ? document.title : '',
  };
}

const FRAME_FAILURES: readonly FrameFailure[] = ['noVideo', 'notReady', 'blocked', 'failed'];

function isFrameResult(value: unknown): value is FrameResult {
  if (!isRecord(value)) {
    return false;
  }
  if (value.ok === false) {
    return FRAME_FAILURES.some((reason) => reason === value.reason);
  }
  return (
    value.ok === true &&
    typeof value.dataUrl === 'string' &&
    isImageDataUrl(value.dataUrl) &&
    typeof value.width === 'number' &&
    typeof value.height === 'number' &&
    typeof value.currentTime === 'number' &&
    typeof value.title === 'string'
  );
}

/**
 * Takes the current frame of the video in `tabId` (see `captureFrameInPage`). Resolves with the
 * picture or the reason there is none; rejects when Chrome refuses the injection (no access to
 * YouTube, the tab closed or is discarded).
 */
export async function captureFrame(tabId: number): Promise<FrameResult> {
  const results = await chrome.scripting.executeScript({
    target: { tabId },
    func: captureFrameInPage,
    args: [FRAME_MAX_WIDTH, FRAME_QUALITY],
  });
  const result: unknown = results[0]?.result;
  return isFrameResult(result) ? result : { ok: false, reason: 'failed' };
}
