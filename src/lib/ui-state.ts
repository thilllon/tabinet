/**
 * Per-tab UI state (`sessionStorage`): which disclosure is open.
 * Deliberately not `chrome.storage` - none of this is user data, it must not travel between
 * devices or outlive the dashboard tab, and it must never go through `sessionRepo` (AGENTS.md:
 * every session-key write goes through the repo under the Web Lock; these keys are not session
 * keys at all).
 */

// Prefixed with the extension's name before Tabinet; kept so a remembered state survives the rename.
/** Open/closed state of the sidebar's snapshots fold. */
export const HISTORY_OPEN_KEY = 'tab-organizer:history-open';
/** Width of the app's sidebar, in pixels - a preference, so it outlives the tab. */
export const SIDEBAR_WIDTH_KEY = 'tab-organizer:sidebar-width';

/**
 * `sessionStorage` is absent under vitest (Node, no DOM) and its accessors throw outright when
 * the browser blocks site data, so every read/write is guarded and failures are ignored: losing a
 * disclosure's open state is not worth an error banner.
 */
export function readUiState(key: string): string | undefined {
  if (typeof sessionStorage === 'undefined') {
    return undefined;
  }
  try {
    return sessionStorage.getItem(key) ?? undefined;
  } catch {
    return undefined;
  }
}

export function writeUiState(key: string, value: string): void {
  if (typeof sessionStorage === 'undefined') {
    return;
  }
  try {
    sessionStorage.setItem(key, value);
  } catch {
    // ignored - see readUiState
  }
}

/**
 * The same guarded pair against `localStorage`, for the handful of preferences that should
 * outlive the tab (the sidebar width). Still not user data, still never `chrome.storage`.
 */
export function readLocalUiState(key: string): string | undefined {
  if (typeof localStorage === 'undefined') {
    return undefined;
  }
  try {
    return localStorage.getItem(key) ?? undefined;
  } catch {
    return undefined;
  }
}

export function writeLocalUiState(key: string, value: string): void {
  if (typeof localStorage === 'undefined') {
    return;
  }
  try {
    localStorage.setItem(key, value);
  } catch {
    // ignored - see readLocalUiState
  }
}

/**
 * The sidebar can be dragged wider: session names are long ("Session 2026-09-22 14:13 · …") and a
 * fixed column cut them off. Bounds rather than a free-for-all - narrower than `MIN` hides the
 * names it exists to show, wider than `MAX` starves the pane the sidebar is there to drive.
 */
export const MIN_SIDEBAR_WIDTH = 180;
export const MAX_SIDEBAR_WIDTH = 520;
export const DEFAULT_SIDEBAR_WIDTH = 260;
/** Arrow keys on the drag handle move it in steps this size. */
export const SIDEBAR_WIDTH_STEP = 16;

export function clampSidebarWidth(width: number): number {
  if (!Number.isFinite(width)) {
    return DEFAULT_SIDEBAR_WIDTH;
  }
  return Math.min(MAX_SIDEBAR_WIDTH, Math.max(MIN_SIDEBAR_WIDTH, Math.round(width)));
}

export function readSidebarWidth(): number {
  const stored = readLocalUiState(SIDEBAR_WIDTH_KEY);
  return stored === undefined ? DEFAULT_SIDEBAR_WIDTH : clampSidebarWidth(Number(stored));
}

export function writeSidebarWidth(width: number): void {
  writeLocalUiState(SIDEBAR_WIDTH_KEY, String(clampSidebarWidth(width)));
}

/** The notes panel's "Pause while I write" box, remembered on this device. */
export const NOTES_PAUSE_KEY = 'tabinet:notes-pause-while-writing';

/** On unless it was turned off: a note is easier to write while the video waits. */
export function readNotesPause(): boolean {
  return readLocalUiState(NOTES_PAUSE_KEY) !== 'false';
}

export function writeNotesPause(on: boolean): void {
  writeLocalUiState(NOTES_PAUSE_KEY, String(on));
}
