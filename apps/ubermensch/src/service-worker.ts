import { injectIntoOpenDocs, syncContentScript, touchesDocsAccess } from '@/lib/docs-access';
import { isOwnContentScript, isPathRequest, type PathRequest } from '@/lib/messages';
import { answerPath, type ServiceDeps, signInAndAnswer } from '@/lib/path-service';
import type { PathAnswer } from '@/types';

import contentScriptFile from './content-script.ts?iife';

/*
 * The service worker: event wiring only, every listener registered synchronously at module top
 * level. The work is in src/lib/. It answers the content script's questions (Drive is called from
 * here, never from the page), keeps the content script registered exactly while docs.google.com
 * access is granted, and opens the options page on an icon click.
 */

const deps: ServiceDeps = {
  fetch: (input, init) => fetch(input, init),
  now: () => Date.now(),
};

/** Answers one request from the content script. Never throws: a failure is an `error` answer. */
export async function handleRequest(request: PathRequest): Promise<PathAnswer> {
  try {
    return request.type === 'ubermensch:sign-in'
      ? await signInAndAnswer(request.doc, request.account, deps)
      : await answerPath(request.doc, request.account, deps);
  } catch (err) {
    console.error('Übermensch: path request failed', err instanceof Error ? err.name : err);
    return { state: 'error', reason: 'unknown' };
  }
}

async function resync(inject: boolean): Promise<void> {
  try {
    const state = await syncContentScript(contentScriptFile);
    if (inject && state === 'registered') {
      await injectIntoOpenDocs(contentScriptFile);
    }
  } catch (err) {
    console.error('Übermensch: content script registration failed', err);
  }
}

chrome.runtime.onInstalled.addListener(() => {
  void resync(false);
});

chrome.runtime.onStartup.addListener(() => {
  void resync(false);
});

chrome.permissions.onAdded.addListener((permissions) => {
  if (touchesDocsAccess(permissions)) {
    void resync(true);
  }
});

chrome.permissions.onRemoved.addListener((permissions) => {
  if (touchesDocsAccess(permissions)) {
    void resync(false);
  }
});

chrome.action.onClicked.addListener(() => {
  void chrome.runtime.openOptionsPage();
});

chrome.runtime.onMessage.addListener((message: unknown, sender, sendResponse) => {
  if (!isPathRequest(message) || !isOwnContentScript(sender, chrome.runtime.id)) {
    return false;
  }
  void handleRequest(message).then(sendResponse);
  return true; // the answer comes asynchronously
});
