import { DOCS_CONTENT_MATCHES, DOCS_ORIGINS } from '@/constants';

/**
 * Access to docs.google.com is an optional host permission: nothing runs on Google Docs until the
 * person turns it on in the options page (a click, as `chrome.permissions.request` requires). The
 * content script is then registered with `chrome.scripting.registerContentScripts`, so the
 * manifest declares none and asks for no host at install.
 */

export const CONTENT_SCRIPT_ID = 'drive-path';

export async function hasDocsAccess(): Promise<boolean> {
  return chrome.permissions.contains({ origins: [...DOCS_ORIGINS] });
}

/** Page only, straight from a click. */
export async function requestDocsAccess(): Promise<boolean> {
  return chrome.permissions.request({ origins: [...DOCS_ORIGINS] });
}

export async function removeDocsAccess(): Promise<boolean> {
  return chrome.permissions.remove({ origins: [...DOCS_ORIGINS] });
}

/** Whether a `permissions.onAdded/onRemoved` event concerns docs.google.com. */
export function touchesDocsAccess(permissions: chrome.permissions.Permissions): boolean {
  return (permissions.origins ?? []).some((origin) =>
    (DOCS_ORIGINS as readonly string[]).includes(origin),
  );
}

/**
 * Registers the content script while access is granted and unregisters it otherwise; safe to run
 * again at any time (install, startup, a permission change).
 */
export async function syncContentScript(file: string): Promise<'registered' | 'unregistered'> {
  const granted = await hasDocsAccess();
  const existing = await chrome.scripting.getRegisteredContentScripts({ ids: [CONTENT_SCRIPT_ID] });
  if (!granted) {
    if (existing.length > 0) {
      await chrome.scripting.unregisterContentScripts({ ids: [CONTENT_SCRIPT_ID] });
    }
    return 'unregistered';
  }
  const script: chrome.scripting.RegisteredContentScript = {
    id: CONTENT_SCRIPT_ID,
    js: [file],
    matches: [...DOCS_CONTENT_MATCHES],
    runAt: 'document_idle',
    persistAcrossSessions: true,
  };
  if (existing.length > 0) {
    await chrome.scripting.updateContentScripts([script]);
  } else {
    await chrome.scripting.registerContentScripts([script]);
  }
  return 'registered';
}

/**
 * Right after access is granted, the Docs tabs already open get the script too, so the person does
 * not have to reload them. A tab that refuses (still loading, an error page) is skipped.
 */
export async function injectIntoOpenDocs(file: string): Promise<number> {
  const tabs = await chrome.tabs.query({ url: [...DOCS_CONTENT_MATCHES] });
  let injected = 0;
  for (const tab of tabs) {
    if (tab.id === undefined || tab.discarded === true) {
      continue;
    }
    try {
      await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: [file] });
      injected += 1;
    } catch {
      // Not injectable right now; the registered script runs on its next load.
    }
  }
  return injected;
}
