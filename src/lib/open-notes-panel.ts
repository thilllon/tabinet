/**
 * Opens the YouTube notes side panel (src/pages/notes-panel.tsx, the manifest's
 * `side_panel.default_path`) in a window. Chrome opens a side panel only in answer to a user
 * gesture, so this must be called straight from the click, menu item or command, before anything
 * is awaited: the gesture does not survive an `await` in the service worker.
 *
 * `windowId` is the window the gesture happened in (the menu's or command's tab, or the app
 * page's own window). Without one, the last-focused window is looked up first; Chrome may then
 * refuse for want of a gesture, and the promise rejects.
 */
export async function openNotesPanel(windowId: number | undefined): Promise<void> {
  if (windowId !== undefined) {
    return chrome.sidePanel.open({ windowId });
  }
  const window = await chrome.windows.getLastFocused({ windowTypes: ['normal'] });
  if (window.id === undefined) {
    throw new Error('No window to open the notes panel in.');
  }
  return chrome.sidePanel.open({ windowId: window.id });
}
