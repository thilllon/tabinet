import type { AccountHint, DocRef, PathAnswer } from '@/types';

/**
 * The content script's two requests to the worker (`chrome.runtime.sendMessage`). The worker
 * checks every message with `isPathRequest` and the sender with `isOwnContentScript`.
 */
export type PathRequest =
  | { type: 'ubermensch:get-path'; doc: DocRef; account: AccountHint }
  | { type: 'ubermensch:sign-in'; doc: DocRef; account: AccountHint };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isIndex(value: unknown): boolean {
  return (
    value === undefined ||
    (typeof value === 'number' && Number.isInteger(value) && value >= 0 && value < 1000)
  );
}

function isDocRef(value: unknown): value is DocRef {
  return (
    isRecord(value) &&
    (value.kind === 'document' || value.kind === 'spreadsheets' || value.kind === 'presentation') &&
    typeof value.fileId === 'string' &&
    /^[\w-]{10,200}$/.test(value.fileId) &&
    isIndex(value.accountIndex)
  );
}

function isAccountHint(value: unknown): value is AccountHint {
  return (
    isRecord(value) &&
    isIndex(value.index) &&
    (value.email === undefined || (typeof value.email === 'string' && value.email.length <= 320))
  );
}

export function isPathRequest(value: unknown): value is PathRequest {
  return (
    isRecord(value) &&
    (value.type === 'ubermensch:get-path' || value.type === 'ubermensch:sign-in') &&
    isDocRef(value.doc) &&
    isAccountHint(value.account)
  );
}

/** Only this extension's own script on a docs.google.com page may ask. */
export function isOwnContentScript(sender: chrome.runtime.MessageSender, ownId: string): boolean {
  if (sender.id !== ownId || sender.url === undefined) {
    return false;
  }
  try {
    const url = new URL(sender.url);
    return url.protocol === 'https:' && url.hostname === 'docs.google.com';
  } catch {
    return false;
  }
}

export function isPathAnswer(value: unknown): value is PathAnswer {
  if (!isRecord(value)) {
    return false;
  }
  switch (value.state) {
    case 'not-configured':
    case 'needs-sign-in':
      return true;
    case 'ready':
      return isRecord(value.path);
    case 'error':
      return typeof value.reason === 'string';
    default:
      return false;
  }
}
