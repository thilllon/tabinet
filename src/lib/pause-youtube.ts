import { YOUTUBE_ORIGINS } from '@/constants';
import type { MessageKey } from '@/lib/i18n';

/**
 * "Pause all YouTube videos": the right-click menu item and the `pause-youtube` command. Every
 * playing video (and audio) element in every YouTube tab of every window is paused where it is;
 * nothing is muted, unloaded or closed, and running it again never resumes anything.
 *
 * It needs the optional host permission `YOUTUBE_ORIGINS` (src/constants.ts), which Chrome grants
 * only from a click in a page (`requestYoutubeAccess()`, the Settings dialog), never from the
 * service worker. Nothing here touches `chrome.*` while the module evaluates: the worker imports
 * it, and `chrome.scripting` / `chrome.permissions` are used inside the handlers only.
 *
 * There is no content script. `pauseVideosInPage` ships in the package and is handed to
 * `chrome.scripting.executeScript` by value; it presses pause and returns a count, and reads
 * nothing else from the page.
 */

function youtubeOrigins(): string[] {
  return [...YOUTUBE_ORIGINS];
}

/** Whether Chrome currently lets the extension run on YouTube. */
export async function hasYoutubeAccess(): Promise<boolean> {
  return await chrome.permissions.contains({ origins: youtubeOrigins() });
}

/**
 * Asks Chrome for access to YouTube; Chrome shows its own prompt. It must be called straight from
 * a click in an extension page (no `await` before it), because Chrome refuses a request without
 * a user gesture. Resolves `true` when access is granted (or already was), `false` when declined.
 */
export async function requestYoutubeAccess(): Promise<boolean> {
  return await chrome.permissions.request({ origins: youtubeOrigins() });
}

/** Gives the access back. Resolves `true` when Chrome removed it. */
export async function removeYoutubeAccess(): Promise<boolean> {
  return await chrome.permissions.remove({ origins: youtubeOrigins() });
}

/**
 * Whether a `chrome.permissions.onAdded` / `onRemoved` event is about the YouTube access, so the
 * Settings dialog re-reads it only then.
 */
export function touchesYoutubeAccess(permissions: chrome.permissions.Permissions): boolean {
  return (permissions.origins ?? []).some((origin) =>
    (YOUTUBE_ORIGINS as readonly string[]).includes(origin),
  );
}

/**
 * The grey hint under "Access to YouTube" in Settings: loading while Chrome has not answered, the
 * plain explanation while access is off, and, when the menu item or shortcut sent the person here
 * (`#settings/youtube`), why Settings opened and what to do next. Once allowed, it says how to
 * pause, since allowing pauses nothing by itself.
 */
export function youtubeAccessHintKey(granted: boolean | null, sentHere: boolean): MessageKey {
  if (granted === null) {
    return 'commonLoading';
  }
  if (granted) {
    return 'settingsYoutubeAccessOnHint';
  }
  return sentHere ? 'settingsYoutubeAccessAskedHint' : 'settingsYoutubeAccessOffHint';
}

/** youtube.com or any of its subdomains, over https: the same set `YOUTUBE_ORIGINS` names. */
export function isYoutubeUrl(url: string | undefined): boolean {
  if (url === undefined || url === '') {
    return false;
  }
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  const host = parsed.hostname;
  return parsed.protocol === 'https:' && (host === 'youtube.com' || host.endsWith('.youtube.com'));
}

/**
 * The tabs worth pausing, in the order given. Left out: a tab without an id, one that is not on
 * YouTube, and a discarded (unloaded) one, which has no page to run in and plays nothing.
 *
 * A frozen tab (`Tab.frozen`, which Chrome sets on some background tabs) is kept. Its page runs no
 * script until Chrome thaws it, but whether a player Chrome froze starts again on thawing depends
 * on how Chromium froze that page, which has not been checked in a real browser; so it is asked
 * too, and `pauseYoutubeTabs()` stops waiting for its answer after `PAUSE_ANSWER_TIMEOUT_MS`.
 */
export function pausableTabIds(tabs: readonly chrome.tabs.Tab[]): number[] {
  const ids: number[] = [];
  for (const tab of tabs) {
    if (tab.id === undefined || !isYoutubeUrl(tab.url)) {
      continue;
    }
    if (tab.discarded || tab.status === 'unloaded') {
      continue;
    }
    ids.push(tab.id);
  }
  return ids;
}

/**
 * Runs inside a YouTube page, not in the extension: Chrome serializes it, so it must stay
 * self-contained (no imports, no closure over anything in this module). Pauses every `<video>` and
 * `<audio>` that is playing and returns how many it paused. A paused element keeps its position.
 */
export function pauseVideosInPage(): number {
  let paused = 0;
  for (const media of document.querySelectorAll<HTMLMediaElement>('video, audio')) {
    if (!media.paused) {
      media.pause();
      paused += 1;
    }
  }
  return paused;
}

export interface PauseFailure {
  tabId: number;
  error: unknown;
}

export interface PauseResult {
  /** YouTube tabs the pause was sent to. */
  tabs: number;
  /** Videos (and audio elements) that were playing and are now paused. */
  paused: number;
  /** Tabs it could not run in (closed meanwhile, an error page, incognito not allowed, ...). */
  failed: number;
  /**
   * Tabs that had not answered after `PAUSE_ANSWER_TIMEOUT_MS`, such as a tab Chrome froze in the
   * background. Not a failure: the pause stays queued for that page and runs if Chrome wakes it.
   */
  unanswered: number;
  failures: PauseFailure[];
}

/**
 * How long `pauseYoutubeTabs()` waits for each tab's answer, so a page that runs nothing (a tab
 * Chrome froze) cannot hold up the result and the badge. A loaded page answers in milliseconds.
 */
const PAUSE_ANSWER_TIMEOUT_MS = 3000;

const NO_ANSWER = Symbol('no answer');

/** `promise`, or `NO_ANSWER` when it has not settled within `ms`. */
async function withinTime<T>(promise: Promise<T>, ms: number): Promise<T | typeof NO_ANSWER> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<typeof NO_ANSWER>((resolve) => {
    timer = setTimeout(() => resolve(NO_ANSWER), ms);
  });
  try {
    return await Promise.race([promise, late]);
  } finally {
    clearTimeout(timer);
  }
}

/** The number one injection reported, or 0 when the page sent nothing back. */
function pausedIn(results: readonly chrome.scripting.InjectionResult<number>[]): number {
  let total = 0;
  for (const entry of results) {
    if (typeof entry.result === 'number' && Number.isFinite(entry.result)) {
      total += entry.result;
    }
  }
  return total;
}

/**
 * Pauses every YouTube tab of every window. The caller checks `hasYoutubeAccess()` first: without
 * it Chrome lists the tabs without their urls and refuses every injection. One tab failing never
 * stops the others; each failure is returned for the caller to log. A tab that has not answered
 * within `timeoutMs` is counted as `unanswered`, not waited for.
 */
export async function pauseYoutubeTabs({
  timeoutMs = PAUSE_ANSWER_TIMEOUT_MS,
}: { timeoutMs?: number } = {}): Promise<PauseResult> {
  const tabs = await chrome.tabs.query({ url: youtubeOrigins() });
  const ids = pausableTabIds(tabs);
  const outcomes = await Promise.allSettled(
    ids.map((tabId) =>
      withinTime(
        chrome.scripting.executeScript({ target: { tabId }, func: pauseVideosInPage }),
        timeoutMs,
      ),
    ),
  );
  let paused = 0;
  let unanswered = 0;
  const failures: PauseFailure[] = [];
  outcomes.forEach((outcome, index) => {
    if (outcome.status === 'rejected') {
      failures.push({ tabId: ids[index] ?? -1, error: outcome.reason });
    } else if (outcome.value === NO_ANSWER) {
      unanswered += 1;
    } else {
      paused += pausedIn(outcome.value);
    }
  });
  return { tabs: ids.length, paused, failed: failures.length, unanswered, failures };
}
