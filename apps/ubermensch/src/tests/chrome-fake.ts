import { readFileSync } from 'node:fs';
import path from 'node:path';

/**
 * In-memory fake of the `chrome.*` subset Übermensch uses (promise forms only): i18n read from
 * public/_locales, `storage.session`, `permissions`, `scripting`, `tabs.query`, `identity` and the
 * events the worker listens to. The single cast to `typeof chrome` is at the end of
 * `createChromeFake()`.
 */

interface FakeEvent<T extends (...args: never[]) => unknown> {
  addListener(callback: T): void;
  removeListener(callback: T): void;
  hasListener(callback: T): boolean;
  emit(...args: Parameters<T>): ReturnType<T>[];
}

function makeEvent<T extends (...args: never[]) => unknown>(): FakeEvent<T> {
  const listeners = new Set<T>();
  return {
    addListener: (callback) => {
      listeners.add(callback);
    },
    removeListener: (callback) => {
      listeners.delete(callback);
    },
    hasListener: (callback) => listeners.has(callback),
    emit: (...args) => Array.from(listeners, (callback) => callback(...args) as ReturnType<T>),
  };
}

const LOCALES_DIR = path.resolve(import.meta.dirname, '../../public/_locales');

interface MessageEntry {
  message: string;
}

/** One language's messages, read from public/_locales. */
export function readLocale(code: string): Record<string, MessageEntry> {
  const parsed: unknown = JSON.parse(
    readFileSync(path.join(LOCALES_DIR, code, 'messages.json'), 'utf8'),
  );
  const out: Record<string, MessageEntry> = {};
  if (typeof parsed === 'object' && parsed !== null) {
    for (const [key, value] of Object.entries(parsed)) {
      const message: unknown =
        typeof value === 'object' && value !== null ? Reflect.get(value, 'message') : undefined;
      if (typeof message === 'string') {
        out[key] = { message };
      }
    }
  }
  return out;
}

/** Chrome's substitution rules for the subset the messages use: `$1`..`$9` and `$$`. */
export function formatChromeMessage(message: string, subs: string[]): string {
  return message.replace(/\$(\$|[1-9])/g, (_match, token: string) =>
    token === '$' ? '$' : (subs[Number(token) - 1] ?? ''),
  );
}

export interface FakeState {
  session: Map<string, unknown>;
  grantedOrigins: Set<string>;
  optionalOrigins: Set<string>;
  permissionAnswer: boolean;
  registered: Map<string, chrome.scripting.RegisteredContentScript>;
  tabs: { id: number; url: string; discarded?: boolean }[];
  injected: { tabId: number; files: string[] }[];
  /** What `launchWebAuthFlow` answers: a redirect URL, an Error, or a function of the request. */
  authAnswer: string | Error | ((url: string) => string | Error);
  authRequests: string[];
  optionsOpened: number;
  language: string;
}

export interface ChromeFake {
  chrome: typeof chrome;
  state: FakeState;
  fire: {
    installed(): void;
    startup(): void;
    actionClicked(): void;
    message(message: unknown, sender: chrome.runtime.MessageSender): Promise<unknown>;
  };
}

export const FAKE_EXTENSION_ID = 'abcdefghijklmnopabcdefghijklmnop';

export function createChromeFake(): ChromeFake {
  const state: FakeState = {
    session: new Map(),
    grantedOrigins: new Set(),
    optionalOrigins: new Set(['https://docs.google.com/*']),
    permissionAnswer: true,
    registered: new Map(),
    tabs: [],
    injected: [],
    authAnswer: new Error('The user did not approve access.'),
    authRequests: [],
    optionsOpened: 0,
    language: 'en',
  };

  const storageChanged =
    makeEvent<(changes: Record<string, chrome.storage.StorageChange>, area: string) => void>();
  const permissionsAdded = makeEvent<(permissions: chrome.permissions.Permissions) => void>();
  const permissionsRemoved = makeEvent<(permissions: chrome.permissions.Permissions) => void>();
  const installed = makeEvent<(details: { reason: string }) => void>();
  const startup = makeEvent<() => void>();
  const actionClicked = makeEvent<(tab: unknown) => void>();
  const messageEvent =
    makeEvent<
      (
        message: unknown,
        sender: chrome.runtime.MessageSender,
        sendResponse: (response: unknown) => void,
      ) => boolean | undefined
    >();

  const clone = <T>(value: T): T => structuredClone(value);

  const session = {
    get: async (keys: string | string[] | null): Promise<Record<string, unknown>> => {
      const out: Record<string, unknown> = {};
      const wanted =
        keys === null ? [...state.session.keys()] : typeof keys === 'string' ? [keys] : keys;
      for (const key of wanted) {
        if (state.session.has(key)) {
          out[key] = clone(state.session.get(key));
        }
      }
      return out;
    },
    set: async (items: Record<string, unknown>): Promise<void> => {
      const changes: Record<string, chrome.storage.StorageChange> = {};
      for (const [key, value] of Object.entries(items)) {
        changes[key] = { oldValue: state.session.get(key), newValue: clone(value) };
        state.session.set(key, clone(value));
      }
      storageChanged.emit(changes, 'session');
    },
    remove: async (keys: string | string[]): Promise<void> => {
      const changes: Record<string, chrome.storage.StorageChange> = {};
      for (const key of typeof keys === 'string' ? [keys] : keys) {
        if (state.session.has(key)) {
          changes[key] = { oldValue: state.session.get(key) };
          state.session.delete(key);
        }
      }
      storageChanged.emit(changes, 'session');
    },
  };

  const originsOf = (permissions: chrome.permissions.Permissions): string[] =>
    permissions.origins ?? [];

  const fake = {
    i18n: {
      getMessage: (key: string, subs?: string | string[]): string => {
        const entry = readLocale(state.language)[key] ?? readLocale('en')[key];
        if (entry === undefined) {
          return '';
        }
        return formatChromeMessage(
          entry.message,
          subs === undefined ? [] : typeof subs === 'string' ? [subs] : subs,
        );
      },
      getUILanguage: () => state.language,
    },
    storage: { session, onChanged: storageChanged },
    permissions: {
      contains: async (permissions: chrome.permissions.Permissions) =>
        originsOf(permissions).every((origin) => state.grantedOrigins.has(origin)),
      request: async (permissions: chrome.permissions.Permissions) => {
        const origins = originsOf(permissions);
        if (!origins.every((origin) => state.optionalOrigins.has(origin))) {
          throw new Error('Only permissions specified in the manifest may be requested.');
        }
        if (!state.permissionAnswer) {
          return false;
        }
        const added = origins.filter((origin) => !state.grantedOrigins.has(origin));
        added.forEach((origin) => state.grantedOrigins.add(origin));
        if (added.length > 0) {
          permissionsAdded.emit({ origins: added });
        }
        return true;
      },
      remove: async (permissions: chrome.permissions.Permissions) => {
        const removed = originsOf(permissions).filter((origin) =>
          state.grantedOrigins.delete(origin),
        );
        if (removed.length > 0) {
          permissionsRemoved.emit({ origins: removed });
        }
        return true;
      },
      onAdded: permissionsAdded,
      onRemoved: permissionsRemoved,
    },
    scripting: {
      getRegisteredContentScripts: async (filter?: { ids?: string[] }) =>
        [...state.registered.values()].filter(
          (script) => filter?.ids === undefined || filter.ids.includes(script.id),
        ),
      registerContentScripts: async (scripts: chrome.scripting.RegisteredContentScript[]) => {
        for (const script of scripts) {
          if (state.registered.has(script.id)) {
            throw new Error(`Duplicate script ID '${script.id}'`);
          }
          state.registered.set(script.id, clone(script));
        }
      },
      updateContentScripts: async (scripts: chrome.scripting.RegisteredContentScript[]) => {
        for (const script of scripts) {
          if (!state.registered.has(script.id)) {
            throw new Error(`Nonexistent script ID '${script.id}'`);
          }
          state.registered.set(script.id, clone(script));
        }
      },
      unregisterContentScripts: async (filter?: { ids?: string[] }) => {
        for (const id of filter?.ids ?? [...state.registered.keys()]) {
          state.registered.delete(id);
        }
      },
      executeScript: async (injection: { target: { tabId: number }; files?: string[] }) => {
        const tab = state.tabs.find((candidate) => candidate.id === injection.target.tabId);
        if (tab === undefined || tab.discarded === true) {
          throw new Error(`No tab with id: ${injection.target.tabId}`);
        }
        if (!state.grantedOrigins.has('https://docs.google.com/*')) {
          throw new Error('Cannot access contents of the page.');
        }
        state.injected.push({ tabId: tab.id, files: injection.files ?? [] });
        return [{ frameId: 0, result: undefined }];
      },
    },
    tabs: {
      // Match patterns as the code uses them: a scheme, a host and a path ending in `*`.
      query: async (query: { url?: string | string[] }) => {
        const patterns =
          query.url === undefined
            ? undefined
            : typeof query.url === 'string'
              ? [query.url]
              : query.url;
        return state.tabs
          .filter(
            (tab) =>
              patterns === undefined ||
              patterns.some((pattern) => tab.url.startsWith(pattern.replace(/\*$/, ''))),
          )
          .map((tab) => clone(tab));
      },
    },
    identity: {
      getRedirectURL: (pathPart?: string) =>
        `https://${FAKE_EXTENSION_ID}.chromiumapp.org/${pathPart ?? ''}`,
      launchWebAuthFlow: async (details: { url: string; interactive?: boolean }) => {
        state.authRequests.push(details.url);
        const answer =
          typeof state.authAnswer === 'function' ? state.authAnswer(details.url) : state.authAnswer;
        if (answer instanceof Error) {
          throw answer;
        }
        return answer;
      },
    },
    runtime: {
      id: FAKE_EXTENSION_ID,
      onInstalled: installed,
      onStartup: startup,
      onMessage: messageEvent,
      openOptionsPage: async () => {
        state.optionsOpened += 1;
      },
    },
    action: { onClicked: actionClicked },
  };

  return {
    // The fake covers only what the extension calls; this is the one place it stands in for the
    // whole `chrome` namespace.
    chrome: fake as unknown as typeof chrome,
    state,
    fire: {
      installed: () => {
        installed.emit({ reason: 'install' });
      },
      startup: () => {
        startup.emit();
      },
      actionClicked: () => {
        actionClicked.emit({});
      },
      message: (message, sender) =>
        new Promise((resolve) => {
          const results = messageEvent.emit(message, sender, resolve);
          if (!results.includes(true)) {
            resolve(undefined);
          }
        }),
    },
  };
}
