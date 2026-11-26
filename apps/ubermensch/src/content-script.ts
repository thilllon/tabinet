/**
 * The content script on Docs, Sheets and Slides (registered only once docs.google.com access is
 * granted, see src/lib/docs-access.ts). It adds one element after the title and asks the worker
 * where the file lives; it never signs in by itself, only from a click on its own button. Built
 * as a self-contained IIFE (`?iife` import in the worker), so it imports nothing at run time.
 */
import { findAccountEmail, findMountAnchor } from '@/lib/docs-dom';
import { parseDocUrl } from '@/lib/docs-url';
import { isPathAnswer, type PathRequest } from '@/lib/messages';
import { loadingView, pathView, type PathView } from '@/lib/path-format';
import { createHost, renderView } from '@/lib/path-mount';
import type { DocRef, PathAnswer } from '@/types';

const RUNNING_FLAG = '__ubermenschDrivePath';
/** How long DOM changes are let settle before the mount is checked again. */
const SETTLE_MS = 250;

function start(): void {
  const { host, root } = createHost(document);
  let current: DocRef | undefined;
  let request = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let stopped = false;
  let view: PathView = loadingView();

  const draw = (next: PathView): void => {
    view = next;
    renderView(root, view, (action) => {
      void load(action === 'sign-in');
    });
  };

  const ask = async (doc: DocRef, interactive: boolean): Promise<PathAnswer | undefined> => {
    const message: PathRequest = {
      type: interactive ? 'ubermensch:sign-in' : 'ubermensch:get-path',
      doc,
      account: { index: doc.accountIndex, email: findAccountEmail(document) },
    };
    try {
      const answer: unknown = await chrome.runtime.sendMessage(message);
      return isPathAnswer(answer) ? answer : { state: 'error', reason: 'unknown' };
    } catch {
      // The extension was reloaded or removed under this page: take our element away and stop.
      stop();
      return undefined;
    }
  };

  const load = async (interactive: boolean): Promise<void> => {
    const doc = current;
    if (doc === undefined) {
      return;
    }
    request += 1;
    const mine = request;
    draw(loadingView());
    const answer = await ask(doc, interactive);
    if (answer !== undefined && mine === request && !stopped) {
      draw(pathView(answer, doc));
    }
  };

  const check = (): void => {
    timer = undefined;
    if (stopped) {
      return;
    }
    const doc = parseDocUrl(location.href);
    if (doc === undefined) {
      host.remove();
      return;
    }
    if (
      current === undefined ||
      doc.fileId !== current.fileId ||
      doc.accountIndex !== current.accountIndex
    ) {
      current = doc;
      void load(false);
    }
    const anchor = findMountAnchor(document);
    if (anchor === undefined) {
      return; // Google changed its title bar: show nothing rather than guess.
    }
    if (host.parentElement !== anchor) {
      anchor.append(host);
    }
  };

  const schedule = (): void => {
    if (timer === undefined && !stopped) {
      timer = setTimeout(check, SETTLE_MS);
    }
  };

  const observer = new MutationObserver(schedule);

  function stop(): void {
    stopped = true;
    observer.disconnect();
    if (timer !== undefined) {
      clearTimeout(timer);
    }
    host.remove();
  }

  draw(view);
  observer.observe(document.documentElement, { childList: true, subtree: true });
  window.addEventListener('popstate', schedule);
  check();
}

// Injected again into a tab that already runs it (access granted while the tab was open, then
// the page's own registration): one copy is enough.
if (Reflect.get(window, RUNNING_FLAG) !== true) {
  Reflect.set(window, RUNNING_FLAG, true);
  try {
    start();
  } catch (err) {
    // Never break the page: a failure here only means no path is shown.
    console.warn('Übermensch: the folder path could not start', err);
  }
}
