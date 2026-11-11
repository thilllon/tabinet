import { LocalizedError, reportError } from '@/lib/error-message';
import { t } from '@/lib/i18n';
import { hasYoutubeAccess } from '@/lib/pause-youtube';
import { loadSanitizeOptions, type RestoreTarget, sanitizeRestoreUrl } from '@/lib/session-restore';
import { seekPlayer } from '@/lib/youtube-player';
import { canonicalVideoUrl, pickVideoTab, videoUrlAt } from '@/lib/youtube-video';

type ActionResult = { ok: true } | { ok: false; reason: string };

async function run(action: () => Promise<unknown>): Promise<ActionResult> {
  try {
    await action();
    return { ok: true };
  } catch (err) {
    return { ok: false, reason: reportError('tab action', err) };
  }
}

/**
 * "Go to tab": activates a live tab and brings its window forward. Two calls, in that order - a
 * `windows.update({ focused: true })` on a window whose active tab has not changed yet would show
 * the wrong tab for a frame. Never throws; a tab closed between render and click comes back as
 * `{ ok: false }` for the row to show inline.
 */
export function goToTab(tabId: number, windowId: number): Promise<ActionResult> {
  return run(async () => {
    await chrome.tabs.update(tabId, { active: true });
    await chrome.windows.update(windowId, { focused: true });
  });
}

/** "Close tab". The pane refreshes from `tabs.onRemoved`, not from this result. */
export function closeTab(tabId: number): Promise<ActionResult> {
  return run(() => chrome.tabs.remove(tabId));
}

/**
 * Closes several tabs in one call. Chrome rejects the whole call when any id is unknown, and a
 * selection can outlive one of its tabs by a moment, so on a failure the ids are retried one by
 * one and only the tabs that are really still open and would not close are reported.
 */
export async function closeTabs(tabIds: readonly number[]): Promise<ActionResult> {
  if (tabIds.length === 0) {
    return { ok: true };
  }
  const all = await run(() => chrome.tabs.remove([...tabIds]));
  if (all.ok) {
    return all;
  }
  let failure: ActionResult = { ok: true };
  for (const tabId of tabIds) {
    const open = await chrome.tabs.get(tabId).then(
      () => true,
      () => false,
    );
    if (!open) {
      continue;
    }
    const one = await closeTab(tabId);
    if (!one.ok) {
      failure = one;
    }
  }
  return failure;
}

/** "Close window" - every tab in it goes with it, which is why the UI confirms first. */
export function closeWindow(windowId: number): Promise<ActionResult> {
  return run(() => chrome.windows.remove(windowId));
}

/**
 * The restore target for "Restore into this window": the window the dashboard itself is in, read
 * fresh at click time rather than from the pane's snapshot (the dashboard tab can be dragged into
 * another window while the page stays mounted).
 */
export async function currentWindowTarget(): Promise<RestoreTarget> {
  const current = await chrome.windows.getCurrent();
  if (current.id === undefined) {
    throw new LocalizedError(t('openNoCurrentWindow'));
  }
  return { kind: 'window', windowId: current.id };
}

type OpenTabResult = { ok: true } | { ok: false; reason: string };

/**
 * Opens one saved tab in a background tab, through the same sanitiser a restore uses:
 * a snapshot url is whatever the page had at capture time (`data:`, `javascript:`, `blob:`, a
 * foreign extension page), so it must never reach `chrome.tabs.create` unchecked. Never throws -
 * a refused url and a rejected `tabs.create` both come back as `{ ok: false, reason }` for the
 * caller to show inline.
 */
export async function openTabInBackground(url: string): Promise<OpenTabResult> {
  try {
    const options = await loadSanitizeOptions();
    const safe = sanitizeRestoreUrl(url, options);
    if (safe === null) {
      return { ok: false, reason: t('openUnsupportedUrl') };
    }
    await chrome.tabs.create({ url: safe, active: false });
    return { ok: true };
  } catch (err) {
    return { ok: false, reason: reportError('open tab', err) };
  }
}

/**
 * Clicking a tab in a saved session or a snapshot: a tab manager must not make tabs multiply, so
 * a page that is already open is brought forward instead of opened a second time. Matching is on
 * the exact stored URL - a saved `…/issues?page=2` is a different page from `…/issues`, and
 * guessing which query strings are "the same page" would surprise more often than it would help.
 */

/** The open tab to jump to, or `undefined` when this URL is not open anywhere. */
function pickOpenTab(
  tabs: readonly chrome.tabs.Tab[],
  url: string,
): { tabId: number; windowId: number } | undefined {
  for (const tab of tabs) {
    if (tab.id === undefined || tab.windowId === undefined) {
      continue;
    }
    // A tab still loading reports its destination in `pendingUrl` and an empty `url`.
    const current = tab.url !== undefined && tab.url !== '' ? tab.url : tab.pendingUrl;
    if (current === url) {
      return { tabId: tab.id, windowId: tab.windowId };
    }
  }
  return undefined;
}

type OpenSavedTabResult = { ok: true; switched: boolean } | { ok: false; reason: string };

export async function openSavedTab(url: string): Promise<OpenSavedTabResult> {
  let open: { tabId: number; windowId: number } | undefined;
  try {
    // No url filter: a match pattern cannot express "this exact URL, query string and all".
    open = pickOpenTab(await chrome.tabs.query({}), url);
  } catch {
    // Reading the tab list is a convenience here; failing it just means opening a new tab.
    open = undefined;
  }
  if (open === undefined) {
    const opened = await openTabInBackground(url);
    return opened.ok ? { ok: true, switched: false } : opened;
  }
  const jumped = await goToTab(open.tabId, open.windowId);
  return jumped.ok ? { ok: true, switched: true } : jumped;
}

type OpenVideoAtResult = { ok: true; switched: boolean } | { ok: false; reason: string };

/**
 * A note's time on the app page: the video at that second. A tab already showing the video is
 * brought forward and moved there (through the player when Tabinet may reach YouTube, else by
 * loading its `&t=` address), so the video does not open twice; otherwise the `&t=` address opens
 * in a background tab, like a saved tab does. Without `seconds` (the video itself) an open tab is
 * only brought forward, where it is. Never throws.
 */
export async function openVideoAt(videoId: string, seconds?: number): Promise<OpenVideoAtResult> {
  const url = seconds === undefined ? canonicalVideoUrl(videoId) : videoUrlAt(videoId, seconds);
  let open: { tabId: number; windowId: number } | undefined;
  try {
    open = pickVideoTab(await chrome.tabs.query({}), videoId);
  } catch {
    // As in openSavedTab: the tab list is a convenience, a new tab is still right.
    open = undefined;
  }
  if (open === undefined) {
    const opened = await openTabInBackground(url);
    return opened.ok ? { ok: true, switched: false } : opened;
  }
  const { tabId, windowId } = open;
  if (seconds === undefined) {
    const jumped = await goToTab(tabId, windowId);
    return jumped.ok ? { ok: true, switched: true } : jumped;
  }
  const seeked = await hasYoutubeAccess()
    .then((granted) => (granted ? seekPlayer(tabId, seconds) : null))
    // A discarded or still loading tab cannot be reached; loading the address works there too.
    .catch(() => null);
  if (seeked === null) {
    const moved = await run(() => chrome.tabs.update(tabId, { url }));
    if (!moved.ok) {
      return moved;
    }
  }
  const jumped = await goToTab(tabId, windowId);
  return jumped.ok ? { ok: true, switched: true } : jumped;
}
