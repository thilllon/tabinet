import { formatRoute } from '@/lib/app-route';
import { assembleTabs } from '@/lib/assemble-tabs';
import { ensureSyncAlarm, handleCloudStorageChange, isSyncAlarm, syncNow } from '@/lib/cloud-sync';
import {
  ensureHistoryAlarm,
  HISTORY_ALARM,
  HISTORY_FIRST_ALARM,
  promoteRecoveredSnapshot,
  scheduleFirstSnapshot,
  takeHistorySnapshot,
} from '@/lib/history-snapshots';
import { applyUiLanguage, t, uiLanguageReady } from '@/lib/i18n';
import { openDashboard } from '@/lib/open-app-page';
import { hasYoutubeAccess, pauseYoutubeTabs } from '@/lib/pause-youtube';
import { captureSession } from '@/lib/session-capture';
import { ensureUniqueName } from '@/lib/session-naming';
import { SETTINGS_KEY, sessionRepo } from '@/lib/session-repo';
import { sortTabGroups } from '@/lib/sort-tabs';
import { applyStoredUiLanguage, parseUiLanguage, UI_LANGUAGE_KEY } from '@/lib/ui-language';

/**
 * The service worker: the manifest's `background.service_worker`, and the one file that is only
 * ever loaded there. It wires Chrome events to the functions in `src/lib/` and holds nothing
 * else. Every listener is registered synchronously at module top level (MV3 requirement). No tab/window listeners here -
 * ever (see AGENTS.md). History snapshots are driven by `chrome.alarms` only, which is
 * why `'alarms'` sits in the manifest permissions: `chrome.alarms.onAlarm.addListener` below runs
 * while this module evaluates, and a missing permission would take the whole worker down.
 */

export const MENU_IDS = {
  assembleTabs: 'assemble-tabs',
  saveAll: 'save-all',
  pauseYoutube: 'pause-youtube',
} as const;

/**
 * Keyboard-command ids. These must stay in lockstep with the `commands` block of
 * `defineManifest()` in `vite.config.ts` - Chrome delivers exactly those strings to
 * `commands.onCommand`, and a rename on one side silently stops the shortcut working.
 * `assembleTabs` and `pauseYoutube` deliberately share their ids with the menu items of the same
 * name, so one `case` serves both. `openDashboard` has no
 * menu item: Chrome adds its own "Options" entry (it opens `app.html#settings`), and a second
 * entry onto the same page would only make the menu longer.
 */
export const COMMAND_IDS = {
  saveSession: 'save-session',
  openDashboard: 'open-dashboard',
  assembleTabs: 'assemble-tabs',
  pauseYoutube: 'pause-youtube',
} as const;

const SAVED_BADGE_COLOR = '#16a34a';
const ERROR_BADGE_COLOR = '#d93025';
const BADGE_CLEAR_MS = 2000;

/**
 * A `pnpm dev` build sits in the toolbar next to the store build with the very same icon, so it
 * keeps a permanent DEV badge and the transient ✓ / ! badges return to it instead of to an empty one.
 * Keyed on the same Vite mode as the manifest's " Dev" name suffix (vite.config.ts), so the two
 * can never disagree; `vite build` is 'production' and vitest runs in 'test'.
 */
export const DEV_BADGE = { text: 'DEV', color: '#d9640a' } as const;

export function idleBadge(mode: string): { text: string; color?: string } {
  return mode === 'development' ? DEV_BADGE : { text: '' };
}

// The only timer in this module; re-armed (never stacked) so two saves in quick succession
// don't have the first save's clear cut off the second save's badge early.
let badgeTimer: ReturnType<typeof setTimeout> | undefined;

function armBadge(text: string, color: string): void {
  if (badgeTimer !== undefined) {
    clearTimeout(badgeTimer);
  }
  chrome.action.setBadgeBackgroundColor({ color }).catch(report);
  chrome.action.setBadgeText({ text }).catch(report);
  badgeTimer = setTimeout(clearBadge, BADGE_CLEAR_MS);
}

export function showSavedBadge(): void {
  armBadge('✓', SAVED_BADGE_COLOR);
}

export function showErrorBadge(): void {
  armBadge('!', ERROR_BADGE_COLOR);
}

export function clearBadge(): void {
  if (badgeTimer !== undefined) {
    clearTimeout(badgeTimer);
    badgeTimer = undefined;
  }
  const idle = idleBadge(import.meta.env.MODE);
  if (idle.color !== undefined) {
    chrome.action.setBadgeBackgroundColor({ color: idle.color }).catch(report);
  }
  chrome.action.setBadgeText({ text: idle.text }).catch(report);
}

/**
 * Recreates the icon's right-click menu with its titles in the UI language. Waits for the language
 * chosen in Settings first: the worker starts handling an event before that choice is read.
 */
export async function registerContextMenus(): Promise<void> {
  await uiLanguageReady();
  await chrome.contextMenus.removeAll();
  chrome.contextMenus.create({
    id: MENU_IDS.assembleTabs,
    title: t('cmdAssembleTabs'),
    contexts: ['action'],
  });
  chrome.contextMenus.create({
    id: MENU_IDS.saveAll,
    title: t('workerMenuSaveAll'),
    contexts: ['action'],
  });
  // One message for the menu item and the keyboard command, like Assemble! above.
  chrome.contextMenus.create({
    id: MENU_IDS.pauseYoutube,
    title: t('cmdPauseYoutube'),
    contexts: ['action'],
  });
}

async function saveSession(scope: 'window' | 'all'): Promise<void> {
  try {
    // The session is named in the UI language as it is captured.
    await uiLanguageReady();
    const session = await captureSession(scope);
    if (session.windows.length === 0) {
      // Nothing capturable (e.g. only the dashboard, or an incognito window, is open).
      showErrorBadge();
      return;
    }
    // Two saves in the same minute would otherwise share the default name.
    const names = (await sessionRepo.listSummaries()).map((summary) => summary.name);
    await sessionRepo.put({ ...session, name: ensureUniqueName(session.name, names) });
    showSavedBadge();
  } catch (err) {
    report(err);
    showErrorBadge();
  }
}

/**
 * Gathers every other window's tabs into the current one (src/lib/assemble-tabs.ts). A run that merged
 * everything shows ✓, one where any window failed shows ! and logs why; a single window, or a
 * second trigger while the first is still moving tabs, shows nothing.
 */
async function runAssembleTabs(): Promise<void> {
  try {
    const result = await assembleTabs();
    if (result.status !== 'done') {
      return;
    }
    for (const failure of result.failures) {
      report(failure.error);
    }
    if (result.failures.length > 0) {
      showErrorBadge();
    } else {
      showSavedBadge();
    }
  } catch (err) {
    report(err);
    showErrorBadge();
  }
}

/**
 * Pauses every YouTube video in every window (src/lib/pause-youtube.ts). Without access to
 * YouTube, which Chrome grants only from a click in a page, it opens Settings at its YouTube row
 * (`#settings/youtube`), where the person can allow it, and runs nothing. With it: no badge when no YouTube tab is open (nothing to do,
 * like a single-window Assemble!), ! when every tab failed, and ✓ otherwise, also when nothing
 * was playing - afterwards every YouTube video is paused either way. A failing tab is logged. A
 * tab that did not answer in time (one Chrome froze) is not a failure: its pause stays queued.
 */
async function runPauseYoutube(): Promise<void> {
  try {
    if (!(await hasYoutubeAccess())) {
      // `#settings/youtube`: the dialog brings the YouTube row into view, focuses its switch
      // and says why it opened, so the person is not left wondering what the command did.
      await openDashboard(formatRoute({ view: 'settings', focus: 'youtube' }));
      return;
    }
    const result = await pauseYoutubeTabs();
    for (const failure of result.failures) {
      report(failure.error);
    }
    if (result.tabs === 0) {
      return;
    }
    if (result.failed === result.tabs) {
      showErrorBadge();
    } else {
      showSavedBadge();
    }
  } catch (err) {
    report(err);
    showErrorBadge();
  }
}

export async function handleMenuOrCommand(id: string): Promise<void> {
  clearBadge();
  switch (id) {
    case COMMAND_IDS.saveSession:
      await saveSession('window');
      return;
    case MENU_IDS.saveAll:
      await saveSession('all');
      return;
    case COMMAND_IDS.openDashboard:
      await openDashboard();
      return;
    // Also `COMMAND_IDS.assembleTabs`, the same id.
    case MENU_IDS.assembleTabs:
      await runAssembleTabs();
      return;
    // Also `COMMAND_IDS.pauseYoutube`, the same id.
    case MENU_IDS.pauseYoutube:
      await runPauseYoutube();
      return;
    default:
      return;
  }
}

/**
 * Every step that runs before the alarms are armed is caught locally (not left to the listener's
 * outer .catch): the alarms are what keeps history running, so nothing upstream of them may
 * abort the handler. `registerContextMenus` touches the menus API, and `migrateAll`/`reconcile`
 * read the stored index - a `sessionIndex` from a future schema (or plain garbage) makes
 * `migrateIndex` throw, and without this the alarms would never be armed again. `reconcile()`
 * itself tolerates such an index and rebuilds it from the bodies (see session-repo.ts), so the two
 * halves together mean a damaged index is both survivable and repaired.
 */
async function onInstalled(details: chrome.runtime.InstalledDetails): Promise<void> {
  // Every handler clears the badge first. An install/update starts a brand-new worker,
  // so the 2 s `setTimeout` that would have cleared a ✓ or ! from the previous one is gone while
  // the badge text - browser state - survives on the icon.
  clearBadge();
  await registerContextMenus().catch(report);
  if (details.reason === 'update') {
    await sessionRepo.migrateAll().catch(report);
  }
  await sessionRepo.reconcile().catch(report);
  // Chrome drops every alarm on extension update/reload, so the periodic history alarm is
  // re-asserted for all reasons (a no-op replace when it already exists).
  await ensureHistoryAlarm();
  // The cloud sync alarm, for the same reason (nothing at all while sync is unconfigured).
  await ensureSyncAlarm().catch(report);
}

async function onStartup(): Promise<void> {
  clearBadge();
  // Chrome keeps the context menu items across restarts with the titles they were created with,
  // in the language of that moment; recreating them here makes them follow a Chrome language the
  // person changed since the last install or update. Caught locally like the repair steps below.
  await registerContextMenus().catch(report);
  await sessionRepo.reconcile().catch(report);
  // Crash recovery first, so the last snapshot of the previous browser session is protected
  // before any new snapshot can push it out of the ring. Caught locally (like reconcile above)
  // so a failed promotion still lets the alarms below be armed.
  await promoteRecoveredSnapshot().catch(report);
  // Not caught: unlike the steps above this one is not a repair pass but the alarm arming's own
  // input, and a rejection here means the storage read itself failed - `ensureHistoryAlarm()`
  // would fail on its internal read too, so there is nothing to salvage and the listener's outer
  // .catch reports it.
  const settings = await sessionRepo.getSettings();
  await ensureHistoryAlarm(settings);
  // One-shot 'history-first' 1 min out: Chrome is still restoring tabs while onStartup runs,
  // and a capture now would record half-loaded windows.
  await scheduleFirstSnapshot(settings);
  await ensureSyncAlarm().catch(report);
}

/**
 * `alarms.onAlarm` handler. The cloud sync alarms (`cloud-sync`, `cloud-sync-soon`) run a sync,
 * which returns `'notReady'` by itself when this device is not ready. Both history alarms take an `origin: 'alarm'` snapshot;
 * `takeHistorySnapshot` itself returns `'disabled'` (without querying windows) when the user
 * turned history off after the alarm was scheduled, so no settings read is needed here.
 */
function onAlarm(alarm: chrome.alarms.Alarm): void {
  // Before the name check, like every other handler: an alarm is often the *only* thing
  // that wakes the worker for minutes at a time, so it is the one chance to clear a badge whose
  // clear timer died with a previous worker. It can cut a fresh badge a fraction short when an
  // alarm lands inside those 2 s; a stale ✓ that never goes away is the worse failure.
  clearBadge();
  if (isSyncAlarm(alarm.name)) {
    syncNow().catch(report);
    return;
  }
  if (alarm.name !== HISTORY_ALARM && alarm.name !== HISTORY_FIRST_ALARM) {
    return;
  }
  takeHistorySnapshot({ origin: 'alarm' }).catch(report);
}

/**
 * Second `action.onClicked` listener (the other, further down this file, is the sort - untouched). Runs
 * concurrently with the sort and is never awaited by it: the snapshot only needs the URLs, which
 * it captures before a `closeAllButOne` duplicate pass closes any (tab order may reflect an
 * in-progress sort - acceptable, recovery is about URLs). `takeHistorySnapshot` gates on
 * `historyEnabled` before touching any window, so a click costs one storage read while history is
 * off. Errors are reported, never thrown: the click must keep sorting no matter what.
 */
function onActionClicked(): void {
  // The badge is browser state, but the timer that clears it is worker state: a worker torn down
  // during those 2 s leaves a stale save/error badge on the icon indefinitely. Every other entry
  // point clears it first (`handleMenuOrCommand`, `onStartup`), so the icon click does too --
  // synchronously and without awaiting anything, leaving the sort listener untouched.
  clearBadge();
  takeHistorySnapshot({ origin: 'manual' }).catch(report);
}

/**
 * `storage.onChanged` handler, for two settings the app page writes:
 *
 * - `sessionSettings` (local; history toggled, interval changed) re-arms or clears the alarms. The
 *   stored value is re-read through `sessionRepo.getSettings()` rather than taken from
 *   `changes[...].newValue` so it goes through the same normalisation (and default fallback when
 *   the key was removed) as every other settings read.
 * - `uiLanguage` (sync; the language chosen in Settings, or on another device) is put in use and
 *   the right-click menu is recreated, so its titles follow at once.
 *
 * Every change is also handed to cloud sync first (`handleCloudStorageChange()`): the account or
 * key arms or clears its alarms, a setting marks the settings dirty, and new work in
 * `cloudSyncMeta` asks for a sync a minute later. It returns at once while sync is unconfigured.
 */
function onStorageChanged(
  changes: { [key: string]: chrome.storage.StorageChange },
  areaName: chrome.storage.AreaName,
): void {
  handleCloudStorageChange(changes, areaName).catch(report);
  if (areaName === 'sync' && UI_LANGUAGE_KEY in changes) {
    void applyUiLanguage(parseUiLanguage(changes[UI_LANGUAGE_KEY]?.newValue));
    registerContextMenus().catch(report);
    return;
  }
  if (areaName !== 'local' || !(SETTINGS_KEY in changes)) {
    return;
  }
  ensureHistoryAlarm().catch(report);
}

function report(err: unknown): void {
  console.error('[tabinet:sessions]', err);
}

// The language chosen in Settings, read once per worker start. Started here, before any listener
// can run, and never rejecting; everything that makes text waits on `uiLanguageReady()`. Listeners
// are still registered synchronously below - this only starts a read.
void applyStoredUiLanguage();

chrome.runtime.onInstalled.addListener((details) => {
  onInstalled(details).catch(report);
});

chrome.runtime.onStartup.addListener(() => {
  onStartup().catch(report);
});

chrome.contextMenus.onClicked.addListener((info) => {
  handleMenuOrCommand(String(info.menuItemId)).catch(report);
});

chrome.commands.onCommand.addListener((command) => {
  handleMenuOrCommand(command).catch(report);
});

// `vite build --mode e2e` only: scripts/e2e/assemble.ts drives commands from the real-Chrome QA run
// without a keyboard. Vite inlines `MODE`, so every other build drops this branch entirely.
if (import.meta.env.MODE === 'e2e') {
  Object.assign(globalThis, { __tabOrganizerE2e: { handleMenuOrCommand } });
}

chrome.alarms.onAlarm.addListener(onAlarm);

chrome.action.onClicked.addListener(onActionClicked);

chrome.storage.onChanged.addListener(onStorageChanged);

/*
 * Sorting: the toolbar icon and its keyboard shortcut (`_execute_action`)
 */

// One sort at a time. A move plan (move-plan.ts) is only right for the order it was made from, so
// a second click waits for the first and then sorts whatever the strip looks like by then - which
// is usually nothing left to do.
let sortQueue: Promise<void> = Promise.resolve();

chrome.action.onClicked.addListener(() => {
  sortQueue = sortQueue.then(sortTabGroups).catch((err: unknown) => {
    console.error('[tabinet] sort failed', err);
  });
});
