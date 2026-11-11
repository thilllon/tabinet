import { readFileSync } from 'node:fs';

/**
 * In-memory fake of the subset of `chrome.*` used by this extension.
 *
 * Only the promise-returning overloads are implemented. The fake keeps a real
 * tab-strip model (ids, index bookkeeping, pinned-first ordering, groups) so
 * capture/restore code can be tested end to end without a browser.
 *
 * The single cast to `typeof chrome` lives at the end of `createChromeFake()` and is explained there.
 */

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

interface FakeEvent<T extends (...args: never[]) => void> {
  addListener(callback: T): void;
  removeListener(callback: T): void;
  hasListener(callback: T): boolean;
  hasListeners(): boolean;
  emit(...args: Parameters<T>): void;
}

function makeEvent<T extends (...args: never[]) => void>(): FakeEvent<T> {
  const listeners = new Set<T>();
  return {
    addListener(callback) {
      listeners.add(callback);
    },
    removeListener(callback) {
      listeners.delete(callback);
    },
    hasListener(callback) {
      return listeners.has(callback);
    },
    hasListeners() {
      return listeners.size > 0;
    },
    emit(...args) {
      // Copy so a listener that removes itself does not break iteration.
      for (const callback of Array.from(listeners)) {
        callback(...args);
      }
    },
  };
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

type FakeWindowState = `${chrome.windows.WindowState}`;
type FakeGroupColor = `${chrome.tabGroups.Color}`;
type FakeTabStatus = `${chrome.tabs.TabStatus}`;

interface FakeWindow {
  id: number;
  focused: boolean;
  state: FakeWindowState;
  incognito: boolean;
  type: `${chrome.windows.WindowType}`;
  left: number;
  top: number;
  width: number;
  height: number;
}

interface FakeTab {
  id: number;
  windowId: number;
  index: number;
  url: string;
  pendingUrl?: string;
  title: string;
  pinned: boolean;
  active: boolean;
  groupId: number;
  discarded: boolean;
  incognito: boolean;
  /** Chrome froze the page (`Tab.frozen`, Chrome 132+): it runs no task until thawed. */
  frozen?: boolean;
  status: FakeTabStatus;
}

/** A `<video>` or `<audio>` element of a fake page: only what pausing and the notes panel read and call. */
export interface FakeMediaElement {
  tagName: 'VIDEO' | 'AUDIO';
  paused: boolean;
  currentTime: number;
  /** Seconds; `NaN` until the media has loaded its length, as in a real page. */
  duration: number;
  pause(): void;
  /** Starts playing; like the real one it returns a promise. */
  play(): Promise<void>;
}

/** A playing (or paused) media element at `currentTime`, for `state.pageMedia`. */
export function fakeMedia(
  tagName: FakeMediaElement['tagName'],
  {
    paused = false,
    currentTime = 0,
    duration = Number.NaN,
  }: { paused?: boolean; currentTime?: number; duration?: number } = {},
): FakeMediaElement {
  return {
    tagName,
    paused,
    currentTime,
    duration,
    pause() {
      this.paused = true;
    },
    async play() {
      this.paused = false;
    },
  };
}

interface FakeGroup {
  id: number;
  windowId: number;
  title: string;
  color: FakeGroupColor;
  collapsed: boolean;
}

interface FakeState {
  windows: Map<number, FakeWindow>;
  tabs: Map<number, FakeTab>;
  groups: Map<number, FakeGroup>;
  local: Map<string, unknown>;
  sync: Map<string, unknown>;
  badge: { text: string; color?: string };
  menus: chrome.contextMenus.CreateProperties[];
  alarms: Map<string, chrome.alarms.AlarmCreateInfo>;
  createdTabs: chrome.tabs.CreateProperties[];
  nextId: { tab: number; window: number; group: number };
  fileAccessAllowed: boolean;
  /**
   * Host permissions Chrome has granted, as match patterns (`chrome.permissions`). Empty at
   * install, like the real optional `https://*.youtube.com/*`.
   */
  grantedOrigins: Set<string>;
  /** The match patterns the manifest lists under `optional_host_permissions`: all that may be requested. */
  optionalOrigins: string[];
  /** What the person answers to Chrome's permission prompt (`chrome.permissions.request`). */
  permissionAnswer: boolean;
  /**
   * The media elements of each tab's page, by tab id: what a function injected with
   * `chrome.scripting.executeScript` sees as `document.querySelectorAll('video, audio')`.
   */
  pageMedia: Map<number, FakeMediaElement[]>;
  /** Every `chrome.scripting.executeScript` call that reached a page, by tab id. */
  injectedTabs: number[];
  /**
   * Every `chrome.sidePanel.open` call, in order. Chrome requires a user gesture for it, which the
   * fake does not model; a test checks the call was made straight from the menu or command.
   */
  sidePanelOpens: chrome.sidePanel.OpenOptions[];
  /** What `chrome.sidePanel.setPanelBehavior` was last given. */
  sidePanelBehavior: chrome.sidePanel.PanelBehavior;
  /**
   * What Chrome answers to `chrome.identity.getAuthToken`: the Google access token, an error it
   * rejects with (Chrome rejects with "The user did not approve access." when the person closes
   * or turns down the consent window), or a function of the request that returns either. Rejects
   * as a refused consent by default.
   */
  authTokenAnswer: string | Error | ((details: chrome.identity.TokenDetails) => string | Error);
  /** The details of every `getAuthToken` call, in order. */
  authTokenRequests: chrome.identity.TokenDetails[];
  /** Every token passed to `removeCachedAuthToken`, in order. */
  removedAuthTokens: string[];
  /** How many times `clearAllCachedAuthTokens` was called. */
  authTokenCacheClears: number;
  /** Testing-only knob: when true, `tabs.create` leaves the tab
   * uncommitted (`url: ''`, `pendingUrl` set, `status: 'loading'`) until `commitNavigation`
   * is called for it, modelling a real browser navigation that has not finished yet. */
  deferCommit: boolean;
}

type FailableApi =
  | 'tabs.create'
  | 'tabs.group'
  | 'tabs.move'
  | 'tabGroups.move'
  | 'windows.create'
  | 'storage.local.set'
  | 'scripting.executeScript';

interface FakeFire {
  installed(details: chrome.runtime.InstalledDetails): void;
  startup(): void;
  menuClicked(menuItemId: string): void;
  command(name: string): void;
  alarm(name: string): void;
  actionClicked(): void;
  /**
   * `chrome.tabs.onReplaced` (prerender/instant swap). No fake mutation produces it, so it is
   * driven explicitly; the dashboard's open-windows pane listens for it.
   */
  tabReplaced(addedTabId: number, removedTabId: number): void;
}

interface ChromeFake {
  chrome: typeof chrome;
  state: FakeState;
  fire: FakeFire;
  failNext(api: FailableApi, times: number, message: string): void;
  /** What `chrome.i18n.getUILanguage()` reports, and so which `_locales` folder `getMessage` reads. */
  setUiLanguage(language: string): void;
  /** Moves `pendingUrl` -> `url` and sets `status: 'complete'`, as Chrome does on commit. */
  commitNavigation(tabId: number): void;
  /**
   * Freezes a tab's page, as Chrome does to some background tabs: `Tab.frozen` reads true and an
   * injection into it waits, unanswered, until `thawTab` (the page runs no task meanwhile).
   */
  freezeTab(tabId: number): void;
  /** Thaws a frozen tab; the injections waiting on it then run. */
  thawTab(tabId: number): void;
}

const NO_GROUP = -1;
/** `chrome.windows.WINDOW_ID_NONE` - reported by `onFocusChanged` when no window has focus. */
const WINDOW_ID_NONE = -1;

// ---------------------------------------------------------------------------
// Converters (fake state -> @types/chrome shapes)
// ---------------------------------------------------------------------------

function toChromeTab(tab: FakeTab): chrome.tabs.Tab {
  return {
    id: tab.id,
    windowId: tab.windowId,
    index: tab.index,
    url: tab.url,
    pendingUrl: tab.pendingUrl,
    title: tab.title,
    pinned: tab.pinned,
    active: tab.active,
    highlighted: tab.active,
    selected: tab.active,
    groupId: tab.groupId,
    discarded: tab.discarded,
    incognito: tab.incognito,
    frozen: tab.frozen ?? false,
    autoDiscardable: true,
    lastAccessed: 0,
    status: tab.status,
  };
}

function toChromeGroup(group: FakeGroup): chrome.tabGroups.TabGroup {
  return {
    id: group.id,
    windowId: group.windowId,
    title: group.title,
    color: group.color,
    collapsed: group.collapsed,
    shared: false,
  };
}

function globToRegExp(pattern: string): RegExp {
  const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
  return new RegExp(`^${escaped}$`);
}

/**
 * A Chrome match pattern (`<scheme>://<host><path>`) as a RegExp, the way `tabs.query({ url })`
 * and host permissions read it: a `*.` host prefix also matches the bare domain
 * (`https://*.youtube.com/*` matches `https://youtube.com/`). Anything else is read as a glob.
 */
function matchPatternToRegExp(pattern: string): RegExp {
  const parts = /^([a-z*][a-z0-9+.*-]*):\/\/([^/]*)(\/.*)$/.exec(pattern);
  if (parts === null) {
    return globToRegExp(pattern);
  }
  const [, scheme = '', host = '', path = ''] = parts;
  const glob = (text: string) => text.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
  const schemePart = scheme === '*' ? 'https?' : glob(scheme);
  const hostPart =
    host === '*'
      ? '[^/]*'
      : host.startsWith('*.')
        ? `([^/]*\\.)?${glob(host.slice(2))}`
        : glob(host);
  return new RegExp(`^${schemePart}://${hostPart}(:\\d+)?${glob(path)}$`);
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createChromeFake(): ChromeFake {
  const state: FakeState = {
    windows: new Map(),
    tabs: new Map(),
    groups: new Map(),
    local: new Map(),
    sync: new Map(),
    badge: { text: '' },
    menus: [],
    alarms: new Map(),
    createdTabs: [],
    nextId: { tab: 1, window: 1, group: 1 },
    fileAccessAllowed: false,
    grantedOrigins: new Set(),
    optionalOrigins: ['https://*.youtube.com/*'],
    permissionAnswer: true,
    pageMedia: new Map(),
    injectedTabs: [],
    sidePanelOpens: [],
    sidePanelBehavior: { openPanelOnActionClick: false },
    authTokenAnswer: new Error('The user did not approve access.'),
    authTokenRequests: [],
    removedAuthTokens: [],
    authTokenCacheClears: 0,
    deferCommit: false,
  };

  // One focused, empty, normal window so `tabs.create()` without a windowId works.
  state.windows.set(state.nextId.window, {
    id: state.nextId.window,
    focused: true,
    state: 'normal',
    incognito: false,
    type: 'normal',
    left: 0,
    top: 0,
    width: 1280,
    height: 800,
  });
  state.nextId.window += 1;

  // ---- events emitted by tab/window/group mutations ------------------------
  //
  // Registered by the dashboard's live open-windows pane (src/lib/open-windows.ts),
  // never by the service worker (AGENTS.md: no tab listeners there). Every mutating method of the
  // fake emits the matching event *after* the state change, so a listener always observes the new
  // state. Only the events the extension actually listens to are modelled.

  const onTabCreated = makeEvent<(tab: chrome.tabs.Tab) => void>();
  const onTabRemoved = makeEvent<(tabId: number, removeInfo: chrome.tabs.OnRemovedInfo) => void>();
  const onTabUpdated =
    makeEvent<
      (tabId: number, changeInfo: chrome.tabs.OnUpdatedInfo, tab: chrome.tabs.Tab) => void
    >();
  const onTabMoved = makeEvent<(tabId: number, moveInfo: chrome.tabs.OnMovedInfo) => void>();
  const onTabAttached =
    makeEvent<(tabId: number, attachInfo: chrome.tabs.OnAttachedInfo) => void>();
  const onTabDetached =
    makeEvent<(tabId: number, detachInfo: chrome.tabs.OnDetachedInfo) => void>();
  const onTabActivated = makeEvent<(activeInfo: chrome.tabs.OnActivatedInfo) => void>();
  const onTabReplaced = makeEvent<(addedTabId: number, removedTabId: number) => void>();

  const onWindowCreated = makeEvent<(window: chrome.windows.Window) => void>();
  const onWindowRemoved = makeEvent<(windowId: number) => void>();
  const onWindowFocusChanged = makeEvent<(windowId: number) => void>();

  const onGroupCreated = makeEvent<(group: chrome.tabGroups.TabGroup) => void>();
  const onGroupUpdated = makeEvent<(group: chrome.tabGroups.TabGroup) => void>();
  const onGroupRemoved = makeEvent<(group: chrome.tabGroups.TabGroup) => void>();
  const onGroupMoved = makeEvent<(group: chrome.tabGroups.TabGroup) => void>();

  // ---- failure injection -------------------------------------------------

  const failures = new Map<FailableApi, { remaining: number; message: string }>();

  function maybeFail(api: FailableApi): void {
    const entry = failures.get(api);
    if (!entry) {
      return;
    }
    if (entry.remaining <= 0) {
      failures.delete(api);
      return;
    }
    entry.remaining -= 1;
    if (entry.remaining === 0) {
      failures.delete(api);
    }
    throw new Error(entry.message);
  }

  // ---- tab-strip helpers -------------------------------------------------

  function stripOf(windowId: number): FakeTab[] {
    return [...state.tabs.values()]
      .filter((tab) => tab.windowId === windowId)
      .sort((a, b) => a.index - b.index);
  }

  /** Enforces Chrome's invariant: pinned tabs first, indices 0..n-1 contiguous. */
  function reindex(windowId: number): void {
    const strip = stripOf(windowId);
    const pinned = strip.filter((tab) => tab.pinned);
    const unpinned = strip.filter((tab) => !tab.pinned);
    [...pinned, ...unpinned].forEach((tab, index) => {
      tab.index = index;
    });
  }

  function activate(tab: FakeTab): void {
    const changed = !tab.active;
    for (const sibling of stripOf(tab.windowId)) {
      sibling.active = sibling.id === tab.id;
    }
    if (changed) {
      onTabActivated.emit({ tabId: tab.id, windowId: tab.windowId });
    }
  }

  /**
   * Last-focused window, honouring `QueryOptions.windowTypes` like Chrome does, so
   * `getLastFocused({ windowTypes: ['normal'] })` skips a focused popup the way the real call does.
   */
  function focusedWindow(windowTypes?: chrome.windows.QueryOptions['windowTypes']): FakeWindow {
    const candidates = [...state.windows.values()].filter(
      (window) => windowTypes === undefined || windowTypes.includes(window.type),
    );
    const focused = candidates.find((window) => window.focused);
    const fallback = candidates[0];
    const window = focused ?? fallback;
    if (!window) {
      throw new Error('No window.');
    }
    return window;
  }

  function requireWindow(windowId: number): FakeWindow {
    const window = state.windows.get(windowId);
    if (!window) {
      throw new Error(`No window with id: ${windowId}.`);
    }
    return window;
  }

  function requireTab(tabId: number): FakeTab {
    const tab = state.tabs.get(tabId);
    if (!tab) {
      throw new Error(`No tab with id: ${tabId}.`);
    }
    return tab;
  }

  function requireGroup(groupId: number): FakeGroup {
    const group = state.groups.get(groupId);
    if (!group) {
      throw new Error(`No group with id: ${groupId}.`);
    }
    return group;
  }

  function insertTab(
    windowId: number,
    props: { url?: string; pinned?: boolean; active?: boolean; index?: number },
  ): FakeTab {
    requireWindow(windowId);
    const strip = stripOf(windowId);
    const tab: FakeTab = {
      id: state.nextId.tab,
      windowId,
      index: 0,
      url: props.url ?? 'about:blank',
      title: props.url ?? 'about:blank',
      pinned: props.pinned ?? false,
      active: false,
      groupId: NO_GROUP,
      discarded: false,
      incognito: requireWindow(windowId).incognito,
      status: 'complete',
    };
    state.nextId.tab += 1;
    const position = Math.min(props.index ?? strip.length, strip.length);
    strip.splice(position, 0, tab);
    strip.forEach((entry, index) => {
      entry.index = index;
    });
    state.tabs.set(tab.id, tab);
    reindex(windowId);
    onTabCreated.emit(toChromeTab(tab));
    const shouldActivate = (props.active ?? true) || strip.length === 1;
    if (shouldActivate) {
      activate(tab);
    }
    return tab;
  }

  function removeTab(tabId: number): void {
    const tab = requireTab(tabId);
    state.tabs.delete(tabId);
    const strip = stripOf(tab.windowId);
    // Chrome's own rule: the flag is set when this removal is what empties (and closes) the window.
    const windowClosing = strip.length === 0;
    if (strip.length === 0) {
      state.windows.delete(tab.windowId);
    } else {
      reindex(tab.windowId);
    }
    onTabRemoved.emit(tab.id, { isWindowClosing: windowClosing, windowId: tab.windowId });
    if (strip.length === 0) {
      onWindowRemoved.emit(tab.windowId);
    } else if (tab.active) {
      activateNeighbour(tab.windowId, tab.index);
    }
    dropEmptyGroups();
  }

  function expandIfCollapsed(groupId: number): void {
    const group = state.groups.get(groupId);
    if (group?.collapsed) {
      group.collapsed = false;
      onGroupUpdated.emit(toChromeGroup(group));
    }
  }

  /** Chrome's choice after the active tab leaves a window: whatever now sits at its old index. */
  function activateNeighbour(windowId: number, formerIndex: number): void {
    const strip = stripOf(windowId);
    const next = strip[Math.min(formerIndex, strip.length - 1)];
    if (next) {
      activate(next);
    }
  }

  /**
   * Takes `tab` out of its window for a cross-window move, the way Chrome does: the tab arrives
   * inactive, a still-populated source window activates a neighbour, and a window the move
   * empties is closed. Verified in Chrome 152: a cross-window `tabs.move` also drops `pinned`
   * (the caller decides - `tabGroups.move` never carries pinned tabs).
   */
  function detachForMove(tab: FakeTab, targetWindowId: number): () => void {
    const sourceWindowId = tab.windowId;
    const fromIndex = tab.index;
    const wasActive = tab.active;
    tab.active = false;
    tab.windowId = targetWindowId;
    return () => {
      if (stripOf(sourceWindowId).length === 0) {
        if (state.windows.delete(sourceWindowId)) {
          onWindowRemoved.emit(sourceWindowId);
        }
        return;
      }
      reindex(sourceWindowId);
      if (wasActive) {
        activateNeighbour(sourceWindowId, fromIndex);
      }
    };
  }

  function dropEmptyGroups(): void {
    for (const group of state.groups.values()) {
      const members = [...state.tabs.values()].some((tab) => tab.groupId === group.id);
      if (!members) {
        state.groups.delete(group.id);
        onGroupRemoved.emit(toChromeGroup(group));
      }
    }
  }

  function toChromeWindow(window: FakeWindow, populate: boolean): chrome.windows.Window {
    return {
      id: window.id,
      focused: window.focused,
      state: window.state,
      incognito: window.incognito,
      type: window.type,
      left: window.left,
      top: window.top,
      width: window.width,
      height: window.height,
      alwaysOnTop: false,
      tabs: populate ? stripOf(window.id).map(toChromeTab) : undefined,
    };
  }

  // ---- storage -------------------------------------------------------------

  type Changes = { [key: string]: chrome.storage.StorageChange };
  type AreaName = `${chrome.storage.AreaName}`;

  const storageChanged = makeEvent<(changes: Changes, areaName: AreaName) => void>();

  function bytesOf(key: string, value: unknown): number {
    return key.length + JSON.stringify(value).length;
  }

  function makeArea(map: Map<string, unknown>, areaName: AreaName, failKey?: FailableApi) {
    function emit(changes: Changes): void {
      if (Object.keys(changes).length === 0) {
        return;
      }
      storageChanged.emit(changes, areaName);
    }

    function keysOf(
      keys: string | string[] | Record<string, unknown> | null | undefined,
    ): string[] {
      if (keys === null || keys === undefined) {
        return [...map.keys()];
      }
      if (typeof keys === 'string') {
        return [keys];
      }
      if (Array.isArray(keys)) {
        return keys;
      }
      return Object.keys(keys);
    }

    return {
      async get(
        keys?: string | string[] | Record<string, unknown> | null,
      ): Promise<Record<string, unknown>> {
        const result: Record<string, unknown> = {};
        const defaults =
          keys !== null && typeof keys === 'object' && !Array.isArray(keys) ? keys : {};
        for (const key of keysOf(keys)) {
          if (map.has(key)) {
            result[key] = structuredClone(map.get(key));
          } else if (key in defaults) {
            result[key] = defaults[key];
          }
        }
        return result;
      },
      async set(items: Record<string, unknown>): Promise<void> {
        if (failKey) {
          maybeFail(failKey);
        }
        const changes: Changes = {};
        for (const [key, value] of Object.entries(items)) {
          if (value === undefined) {
            continue;
          }
          const oldValue = map.has(key) ? structuredClone(map.get(key)) : undefined;
          const newValue = structuredClone(value);
          map.set(key, newValue);
          changes[key] = { oldValue, newValue: structuredClone(newValue) };
        }
        emit(changes);
      },
      async remove(keys: string | string[]): Promise<void> {
        const changes: Changes = {};
        for (const key of keysOf(keys)) {
          if (map.has(key)) {
            changes[key] = { oldValue: structuredClone(map.get(key)) };
            map.delete(key);
          }
        }
        emit(changes);
      },
      async getKeys(): Promise<string[]> {
        return [...map.keys()];
      },
      async getBytesInUse(keys?: string | string[] | null): Promise<number> {
        let total = 0;
        for (const key of keysOf(keys)) {
          if (map.has(key)) {
            total += bytesOf(key, map.get(key));
          }
        }
        return total;
      },
    };
  }

  const local = makeArea(state.local, 'local', 'storage.local.set');
  const sync = makeArea(state.sync, 'sync');

  // ---- tabs ----------------------------------------------------------------

  const tabs = {
    async query(info: chrome.tabs.QueryInfo): Promise<chrome.tabs.Tab[]> {
      const urlPatterns =
        info.url === undefined
          ? []
          : (Array.isArray(info.url) ? info.url : [info.url]).map(matchPatternToRegExp);
      const focusedId =
        info.currentWindow || info.lastFocusedWindow ? focusedWindow().id : undefined;
      return [...state.tabs.values()]
        .filter((tab) => info.windowId === undefined || tab.windowId === info.windowId)
        .filter((tab) => focusedId === undefined || tab.windowId === focusedId)
        .filter((tab) => info.active === undefined || tab.active === info.active)
        .filter((tab) => info.pinned === undefined || tab.pinned === info.pinned)
        .filter((tab) => info.groupId === undefined || tab.groupId === info.groupId)
        .filter((tab) => urlPatterns.length === 0 || urlPatterns.some((re) => re.test(tab.url)))
        .sort((a, b) => a.windowId - b.windowId || a.index - b.index)
        .map(toChromeTab);
    },
    async create(props: chrome.tabs.CreateProperties): Promise<chrome.tabs.Tab> {
      maybeFail('tabs.create');
      const windowId = props.windowId ?? focusedWindow().id;
      const tab = insertTab(windowId, {
        url: props.url,
        pinned: props.pinned,
        active: props.active,
        index: props.index,
      });
      // Models a real browser: `tabs.create` resolves before navigation commits. The URL
      // moves from `pendingUrl` to `url` only when `commitNavigation` is called for this tab.
      if (state.deferCommit && props.url !== undefined) {
        tab.pendingUrl = tab.url;
        tab.url = '';
        tab.status = 'loading';
      }
      // Recorded only after insertTab succeeds: a rejected create (failNext, or an
      // unknown windowId thrown by requireWindow inside insertTab) must not appear here.
      state.createdTabs.push({ ...props });
      return toChromeTab(tab);
    },
    async update(tabId: number, props: chrome.tabs.UpdateProperties): Promise<chrome.tabs.Tab> {
      const tab = requireTab(tabId);
      const changeInfo: chrome.tabs.OnUpdatedInfo = {};
      if (props.url !== undefined) {
        tab.url = props.url;
        changeInfo.url = props.url;
      }
      if (props.pinned !== undefined) {
        tab.pinned = props.pinned;
        if (props.pinned) {
          tab.groupId = NO_GROUP;
          dropEmptyGroups();
        }
        reindex(tab.windowId);
        changeInfo.pinned = props.pinned;
      }
      if (Object.keys(changeInfo).length > 0) {
        onTabUpdated.emit(tab.id, changeInfo, toChromeTab(tab));
      }
      if (props.active) {
        activate(tab);
        // Verified in Chrome for Testing 151: activating a tab inside a collapsed group expands it.
        expandIfCollapsed(tab.groupId);
      }
      return toChromeTab(tab);
    },
    async remove(tabIds: number | number[]): Promise<void> {
      const ids = Array.isArray(tabIds) ? tabIds : [tabIds];
      for (const id of ids) {
        removeTab(id);
      }
    },
    /**
     * Chrome moves several tabs as a *block*: they land on consecutive indices starting at
     * `index`, in the order given, not all on `index` itself (which would reverse them). The
     * sorter moves a whole group in one call (`src/lib/sort-tabs.ts`), so getting this wrong
     * would make a sorted list come back reversed. `index: -1` appends each in turn, which
     * preserves the order for free.
     */
    async move(
      tabIds: number | number[],
      props: chrome.tabs.MoveProperties,
    ): Promise<chrome.tabs.Tab | chrome.tabs.Tab[]> {
      maybeFail('tabs.move');
      const ids = Array.isArray(tabIds) ? tabIds : [tabIds];
      const moved: FakeTab[] = [];
      // Where the next tab of the block goes, per target window; seeded from `props.index`.
      const nextPosition = new Map<number, number>();
      for (const id of ids) {
        const tab = requireTab(id);
        const targetWindowId = props.windowId ?? tab.windowId;
        requireWindow(targetWindowId);
        const sourceWindowId = tab.windowId;
        const fromIndex = tab.index;
        let settleSource: (() => void) | undefined;
        if (sourceWindowId !== targetWindowId) {
          // Verified in Chrome 152: the tab keeps its id and history but loses `pinned`. A group
          // cannot span windows, so a lone grouped tab leaves its group too.
          tab.pinned = false;
          tab.groupId = NO_GROUP;
          settleSource = detachForMove(tab, targetWindowId);
        }
        tab.windowId = targetWindowId;
        const strip = stripOf(targetWindowId).filter((entry) => entry.id !== tab.id);
        const requested = nextPosition.get(targetWindowId) ?? props.index;
        const position = requested < 0 ? strip.length : Math.min(requested, strip.length);
        nextPosition.set(targetWindowId, requested < 0 ? -1 : position + 1);
        strip.splice(position, 0, tab);
        strip.forEach((entry, index) => {
          entry.index = index;
        });
        reindex(targetWindowId);
        if (sourceWindowId !== targetWindowId) {
          onTabDetached.emit(tab.id, { oldWindowId: sourceWindowId, oldPosition: fromIndex });
          onTabAttached.emit(tab.id, { newWindowId: targetWindowId, newPosition: tab.index });
          settleSource?.();
        } else if (tab.index !== fromIndex) {
          onTabMoved.emit(tab.id, {
            windowId: targetWindowId,
            fromIndex,
            toIndex: tab.index,
          });
        }
        moved.push(tab);
      }
      dropEmptyGroups();
      const converted = moved.map(toChromeTab);
      const single = converted[0];
      return Array.isArray(tabIds) || single === undefined ? converted : single;
    },
    async group(options: chrome.tabs.GroupOptions): Promise<number> {
      maybeFail('tabs.group');
      const ids = Array.isArray(options.tabIds)
        ? options.tabIds
        : options.tabIds === undefined
          ? []
          : [options.tabIds];
      const members = ids.map(requireTab);
      const first = members[0];
      if (!first) {
        throw new Error('No tabs given.');
      }
      if (members.some((tab) => tab.pinned)) {
        throw new Error('Tabs cannot be pinned and grouped.');
      }
      let group: FakeGroup;
      if (options.groupId !== undefined) {
        group = requireGroup(options.groupId);
      } else {
        const windowId = options.createProperties?.windowId ?? first.windowId;
        requireWindow(windowId);
        group = {
          id: state.nextId.group,
          windowId,
          title: '',
          color: 'grey',
          collapsed: false,
        };
        state.nextId.group += 1;
        state.groups.set(group.id, group);
        onGroupCreated.emit(toChromeGroup(group));
      }
      for (const tab of members) {
        tab.groupId = group.id;
        onTabUpdated.emit(tab.id, { groupId: group.id }, toChromeTab(tab));
      }
      dropEmptyGroups();
      return group.id;
    },
    /**
     * Verified in Chrome for Testing 151: a group's first or last tab leaves in place; a tab from
     * the middle is moved to just after the group, and when it is the active tab of a collapsed
     * group that group is expanded.
     */
    async ungroup(tabIds: number | number[]): Promise<void> {
      const ids = Array.isArray(tabIds) ? tabIds : [tabIds];
      for (const id of ids) {
        const tab = requireTab(id);
        const groupId = tab.groupId;
        const members = stripOf(tab.windowId).filter((entry) => entry.groupId === groupId);
        const position = members.indexOf(tab);
        tab.groupId = NO_GROUP;
        if (groupId !== NO_GROUP && position > 0 && position < members.length - 1) {
          const strip = stripOf(tab.windowId).filter((entry) => entry.id !== tab.id);
          const lastMember = members[members.length - 1];
          strip.splice(strip.indexOf(lastMember ?? tab) + 1, 0, tab);
          strip.forEach((entry, index) => {
            entry.index = index;
          });
          if (tab.active) {
            expandIfCollapsed(groupId);
          }
        }
        onTabUpdated.emit(tab.id, { groupId: NO_GROUP }, toChromeTab(tab));
      }
      dropEmptyGroups();
    },
    async discard(tabId?: number): Promise<chrome.tabs.Tab | undefined> {
      if (tabId === undefined) {
        return undefined;
      }
      const tab = requireTab(tabId);
      if (tab.active) {
        throw new Error('Cannot discard active tab');
      }
      tab.discarded = true;
      // Chrome does NOT reject when the tab's navigation has not committed yet: it silently
      // unloads the still-blank tab instead, permanently losing the intended URL.
      if (tab.url === '') {
        tab.status = 'unloaded';
      }
      return toChromeTab(tab);
    },
    async get(tabId: number): Promise<chrome.tabs.Tab> {
      return toChromeTab(requireTab(tabId));
    },
    onCreated: onTabCreated,
    onRemoved: onTabRemoved,
    onUpdated: onTabUpdated,
    onMoved: onTabMoved,
    onAttached: onTabAttached,
    onDetached: onTabDetached,
    onActivated: onTabActivated,
    onReplaced: onTabReplaced,
  };

  // ---- windows -------------------------------------------------------------

  /**
   * Chrome's own `windows.create` validation, verified against Chrome for Testing 151:
   * a minimized window can never be focused, a maximized/fullscreen one can never be created
   * unfocused, and no non-'normal' state may be combined with explicit bounds. All three reject
   * with the same message. Modelled here so `src/lib/session-restore.ts` cannot regress into passing
   * a combination Chrome refuses (see the comment in `openTargetWindow`).
   */
  function rejectInvalidCreateState(data?: chrome.windows.CreateData): void {
    const state = data?.state;
    if (state === undefined) {
      return;
    }
    const invalidState =
      (state === 'minimized' && data?.focused === true) ||
      ((state === 'maximized' || state === 'fullscreen') && data?.focused === false);
    const hasBounds =
      data?.left !== undefined ||
      data?.top !== undefined ||
      data?.width !== undefined ||
      data?.height !== undefined;
    if (invalidState || (state !== 'normal' && hasBounds)) {
      throw new Error('Invalid value for state');
    }
  }

  const windows = {
    async getAll(options?: chrome.windows.QueryOptions): Promise<chrome.windows.Window[]> {
      const populate = options?.populate ?? false;
      const windowTypes = options?.windowTypes;
      return [...state.windows.values()]
        .filter((window) => windowTypes === undefined || windowTypes.includes(window.type))
        .map((window) => toChromeWindow(window, populate));
    },
    async getLastFocused(options?: chrome.windows.QueryOptions): Promise<chrome.windows.Window> {
      return toChromeWindow(focusedWindow(options?.windowTypes), options?.populate ?? false);
    },
    async getCurrent(options?: chrome.windows.QueryOptions): Promise<chrome.windows.Window> {
      return toChromeWindow(focusedWindow(options?.windowTypes), options?.populate ?? false);
    },
    async create(data?: chrome.windows.CreateData): Promise<chrome.windows.Window> {
      maybeFail('windows.create');
      rejectInvalidCreateState(data);
      const window: FakeWindow = {
        id: state.nextId.window,
        focused: data?.focused ?? true,
        state: data?.state ?? 'normal',
        incognito: data?.incognito ?? false,
        type: data?.type ?? 'normal',
        left: data?.left ?? 0,
        top: data?.top ?? 0,
        width: data?.width ?? 1280,
        height: data?.height ?? 800,
      };
      state.nextId.window += 1;
      if (window.focused) {
        for (const other of state.windows.values()) {
          other.focused = false;
        }
      }
      state.windows.set(window.id, window);
      onWindowCreated.emit(toChromeWindow(window, true));
      if (window.focused) {
        onWindowFocusChanged.emit(window.id);
      }
      const urls =
        data?.url === undefined ? ['about:blank'] : Array.isArray(data.url) ? data.url : [data.url];
      urls.forEach((url, index) => {
        insertTab(window.id, { url, active: index === 0 });
      });
      return toChromeWindow(window, true);
    },
    async update(
      windowId: number,
      info: chrome.windows.UpdateInfo,
    ): Promise<chrome.windows.Window> {
      const window = requireWindow(windowId);
      if (info.state !== undefined) {
        window.state = info.state;
      }
      if (info.focused !== undefined) {
        const wasFocused = window.focused;
        if (info.focused) {
          for (const other of state.windows.values()) {
            other.focused = false;
          }
        }
        window.focused = info.focused;
        if (wasFocused !== info.focused) {
          onWindowFocusChanged.emit(info.focused ? window.id : WINDOW_ID_NONE);
        }
      }
      return toChromeWindow(window, false);
    },
    async remove(windowId: number): Promise<void> {
      requireWindow(windowId);
      for (const tab of stripOf(windowId)) {
        state.tabs.delete(tab.id);
        onTabRemoved.emit(tab.id, { isWindowClosing: true, windowId });
      }
      state.windows.delete(windowId);
      onWindowRemoved.emit(windowId);
      dropEmptyGroups();
    },
    onCreated: onWindowCreated,
    onRemoved: onWindowRemoved,
    onFocusChanged: onWindowFocusChanged,
  };

  // ---- tabGroups -----------------------------------------------------------

  const tabGroups = {
    async query(info: chrome.tabGroups.QueryInfo): Promise<chrome.tabGroups.TabGroup[]> {
      return [...state.groups.values()]
        .filter((group) => info.windowId === undefined || group.windowId === info.windowId)
        .map(toChromeGroup);
    },
    async update(
      groupId: number,
      props: chrome.tabGroups.UpdateProperties,
    ): Promise<chrome.tabGroups.TabGroup> {
      const group = requireGroup(groupId);
      if (props.title !== undefined) {
        group.title = props.title;
      }
      if (props.color !== undefined) {
        group.color = props.color;
      }
      if (props.collapsed !== undefined) {
        group.collapsed = props.collapsed;
      }
      onGroupUpdated.emit(toChromeGroup(group));
      return toChromeGroup(group);
    },
    /**
     * Moves the whole group as one block. Verified in Chrome 152: across windows the group keeps
     * its id, title, colour and collapsed state, and its tabs keep their ids. `index` counts
     * positions in the target strip without the group's own tabs; `-1` appends.
     *
     * Verified in Chrome for Testing 151, unlike a cross-window `tabs.move`: when the group holds
     * the source window's active tab, that tab becomes the target window's active tab, and a
     * collapsed group is expanded because it now holds the active tab.
     */
    async move(
      groupId: number,
      props: chrome.tabGroups.MoveProperties,
    ): Promise<chrome.tabGroups.TabGroup> {
      maybeFail('tabGroups.move');
      const group = requireGroup(groupId);
      const sourceWindowId = group.windowId;
      const targetWindowId = props.windowId ?? sourceWindowId;
      requireWindow(targetWindowId);
      const members = stripOf(sourceWindowId).filter((tab) => tab.groupId === group.id);
      const remaining = stripOf(targetWindowId).filter((tab) => tab.groupId !== group.id);
      const pinnedCount = remaining.filter((tab) => tab.pinned).length;
      const position = props.index < 0 ? remaining.length : Math.min(props.index, remaining.length);
      if (position < pinnedCount) {
        throw new Error('Cannot move the group to an index that is in the middle of pinned tabs.');
      }
      const crossWindow = sourceWindowId !== targetWindowId;
      const carriedActive = crossWindow ? members.find((tab) => tab.active) : undefined;
      const fromIndices = new Map(members.map((tab) => [tab.id, tab.index]));
      const settleSource = crossWindow
        ? members.map((tab) => detachForMove(tab, targetWindowId))
        : [];
      remaining.splice(position, 0, ...members);
      remaining.forEach((tab, index) => {
        tab.index = index;
      });
      group.windowId = targetWindowId;
      reindex(targetWindowId);
      for (const tab of members) {
        const fromIndex = fromIndices.get(tab.id) ?? tab.index;
        if (crossWindow) {
          onTabDetached.emit(tab.id, { oldWindowId: sourceWindowId, oldPosition: fromIndex });
          onTabAttached.emit(tab.id, { newWindowId: targetWindowId, newPosition: tab.index });
        } else if (tab.index !== fromIndex) {
          onTabMoved.emit(tab.id, { windowId: targetWindowId, fromIndex, toIndex: tab.index });
        }
      }
      for (const settle of settleSource) {
        settle();
      }
      if (carriedActive !== undefined) {
        activate(carriedActive);
        if (group.collapsed) {
          group.collapsed = false;
          onGroupUpdated.emit(toChromeGroup(group));
        }
      }
      onGroupMoved.emit(toChromeGroup(group));
      return toChromeGroup(group);
    },
    async get(groupId: number): Promise<chrome.tabGroups.TabGroup> {
      return toChromeGroup(requireGroup(groupId));
    },
    onCreated: onGroupCreated,
    onUpdated: onGroupUpdated,
    onRemoved: onGroupRemoved,
    onMoved: onGroupMoved,
  };

  // ---- runtime / contextMenus / commands / action / alarms / extension -----

  const onInstalled = makeEvent<(details: chrome.runtime.InstalledDetails) => void>();
  const onStartup = makeEvent<() => void>();
  const onMenuClicked =
    makeEvent<(info: chrome.contextMenus.OnClickData, tab?: chrome.tabs.Tab) => void>();
  const onCommand = makeEvent<(command: string, tab?: chrome.tabs.Tab) => void>();
  const onActionClicked = makeEvent<(tab: chrome.tabs.Tab) => void>();
  const onAlarm = makeEvent<(alarm: chrome.alarms.Alarm) => void>();

  const runtime = {
    id: 'fakeextid',
    lastError: undefined,
    getURL(path: string): string {
      return `chrome-extension://fakeextid/${path.replace(/^\//, '')}`;
    },
    getManifest(): chrome.runtime.Manifest {
      // Only `version` is read by the app; the rest of ManifestV3 is optional.
      return { manifest_version: 3, name: 'Tabinet', version: '7.0.0' };
    },
    onInstalled,
    onStartup,
  };

  const contextMenus = {
    create(props: chrome.contextMenus.CreateProperties): number | string {
      state.menus.push({ ...props });
      return props.id ?? state.menus.length;
    },
    async removeAll(): Promise<void> {
      state.menus.length = 0;
    },
    onClicked: onMenuClicked,
  };

  const commands = { onCommand };

  const action = {
    async setBadgeText(details: chrome.action.BadgeTextDetails): Promise<void> {
      state.badge.text = details.text ?? '';
    },
    async setBadgeBackgroundColor(details: chrome.action.BadgeColorDetails): Promise<void> {
      state.badge.color =
        typeof details.color === 'string' ? details.color : details.color.join(',');
    },
    onClicked: onActionClicked,
  };

  const toAlarm = (name: string, info: chrome.alarms.AlarmCreateInfo): chrome.alarms.Alarm => ({
    name,
    periodInMinutes: info.periodInMinutes,
    persistAcrossSessions: true,
    scheduledTime: info.when ?? Date.now() + (info.delayInMinutes ?? 0) * 60_000,
  });

  const alarms = {
    async create(
      nameOrInfo: string | chrome.alarms.AlarmCreateInfo | undefined,
      maybeInfo?: chrome.alarms.AlarmCreateInfo,
    ): Promise<void> {
      const name = typeof nameOrInfo === 'string' ? nameOrInfo : '';
      const info =
        typeof nameOrInfo === 'string' || nameOrInfo === undefined ? maybeInfo : nameOrInfo;
      if (!info) {
        throw new Error('alarms.create: alarmInfo is required');
      }
      state.alarms.set(name, { ...info });
    },
    async clear(name?: string): Promise<boolean> {
      return state.alarms.delete(name ?? '');
    },
    async getAll(): Promise<chrome.alarms.Alarm[]> {
      return [...state.alarms.entries()].map(([name, info]) => toAlarm(name, info));
    },
    /** Like Chrome's promise form: resolves `undefined` when there is no alarm by that name. */
    async get(name?: string): Promise<chrome.alarms.Alarm | undefined> {
      const info = state.alarms.get(name ?? '');
      return info === undefined ? undefined : toAlarm(name ?? '', info);
    },
    onAlarm,
  };

  const extension = {
    async isAllowedFileSchemeAccess(): Promise<boolean> {
      return state.fileAccessAllowed;
    },
  };

  // ---- permissions / scripting -----------------------------------------------

  const onPermissionsAdded = makeEvent<(permissions: chrome.permissions.Permissions) => void>();
  const onPermissionsRemoved = makeEvent<(permissions: chrome.permissions.Permissions) => void>();

  /**
   * Host permissions only: the API permissions of the manifest are all required ones here. Like
   * Chrome, `request` refuses an origin the manifest does not list as optional, resolves `true`
   * without asking when everything is granted already, and `onAdded` / `onRemoved` fire only for
   * a real change. The user gesture Chrome requires for `request` is not modelled.
   */
  const permissions = {
    async contains(request: chrome.permissions.Permissions): Promise<boolean> {
      return (request.origins ?? []).every((origin) => state.grantedOrigins.has(origin));
    },
    async getAll(): Promise<chrome.permissions.Permissions> {
      return { origins: [...state.grantedOrigins], permissions: [] };
    },
    async request(request: chrome.permissions.Permissions): Promise<boolean> {
      const origins = request.origins ?? [];
      const unknown = origins.filter((origin) => !state.optionalOrigins.includes(origin));
      if (unknown.length > 0) {
        throw new Error('Only permissions specified in the manifest may be requested.');
      }
      const missing = origins.filter((origin) => !state.grantedOrigins.has(origin));
      if (missing.length === 0) {
        return true;
      }
      if (!state.permissionAnswer) {
        return false;
      }
      for (const origin of missing) {
        state.grantedOrigins.add(origin);
      }
      onPermissionsAdded.emit({ origins: missing, permissions: [] });
      return true;
    },
    async remove(request: chrome.permissions.Permissions): Promise<boolean> {
      const removed = (request.origins ?? []).filter((origin) => state.grantedOrigins.has(origin));
      for (const origin of removed) {
        state.grantedOrigins.delete(origin);
      }
      if (removed.length > 0) {
        onPermissionsRemoved.emit({ origins: removed, permissions: [] });
      }
      return true;
    },
    onAdded: onPermissionsAdded,
    onRemoved: onPermissionsRemoved,
  };

  function hostAllowed(url: string): boolean {
    return [...state.grantedOrigins].some((origin) => matchPatternToRegExp(origin).test(url));
  }

  /**
   * `chrome.scripting.executeScript` with `func`, top frame only. Chrome serializes the function
   * and runs it in the page, so the fake rebuilds it from its source text: a function that leans
   * on anything outside itself (an import, a closure) throws here as it would there. It then runs
   * with `document.querySelectorAll` answering from `state.pageMedia` for that tab. Like Chrome it
   * rejects for a missing tab, a discarded one and a page whose host was not granted. An injection
   * into a frozen tab waits, unanswered, until `thawTab`.
   */
  /** Injections waiting on a frozen tab, by tab id; `thawTab` lets them run. */
  const frozenWaiters = new Map<number, (() => void)[]>();

  const scripting = {
    async executeScript<Args extends unknown[], Result>(
      injection: chrome.scripting.ScriptInjection<Args, Result>,
    ): Promise<chrome.scripting.InjectionResult<Awaited<Result>>[]> {
      maybeFail('scripting.executeScript');
      const tabId = injection.target.tabId;
      const tab = requireTab(tabId);
      if (tab.discarded) {
        throw new Error(`Cannot access contents of the discarded tab ${tabId}.`);
      }
      if (tab.frozen === true) {
        await new Promise<void>((resolve) => {
          frozenWaiters.set(tabId, [...(frozenWaiters.get(tabId) ?? []), resolve]);
        });
      }
      if (!hostAllowed(tab.url)) {
        throw new Error(
          'Cannot access contents of the page. Extension manifest must request permission to access the respective host.',
        );
      }
      if (!('func' in injection) || typeof injection.func !== 'function') {
        throw new Error('The fake only runs `func` injections.');
      }
      const rebuilt: unknown = new Function(`return (${injection.func.toString()});`)();
      if (typeof rebuilt !== 'function') {
        throw new Error('The injected function did not survive serialization.');
      }
      const media = state.pageMedia.get(tabId) ?? [];
      const pageDocument = {
        title: tab.title,
        querySelectorAll(selector: string) {
          const wanted = selector
            .split(',')
            .map((part) => part.trim().toUpperCase())
            .filter((part) => part !== '');
          return media.filter((element) => wanted.includes(element.tagName));
        },
      };
      const previous = Object.getOwnPropertyDescriptor(globalThis, 'document');
      Object.defineProperty(globalThis, 'document', { value: pageDocument, configurable: true });
      let result: unknown;
      try {
        const args: unknown[] =
          'args' in injection && Array.isArray(injection.args) ? injection.args : [];
        result = Reflect.apply(rebuilt, undefined, args);
      } finally {
        if (previous === undefined) {
          Reflect.deleteProperty(globalThis, 'document');
        } else {
          Object.defineProperty(globalThis, 'document', previous);
        }
      }
      state.injectedTabs.push(tabId);
      // CAST: the fake ran the caller's own function, so its result is the caller's `Result`.
      return [
        { documentId: `doc-${tabId}`, frameId: 0, result: (await result) as Awaited<Result> },
      ];
    },
  };

  // ---- sidePanel ---------------------------------------------------------------

  /**
   * `chrome.sidePanel`: `open` needs a window or tab id that exists, like Chrome, and records the
   * call; the user gesture Chrome also requires is not modelled. The panel page itself is not run.
   */
  const sidePanel = {
    async open(options: chrome.sidePanel.OpenOptions): Promise<void> {
      if (options.windowId === undefined && options.tabId === undefined) {
        throw new Error('At least one of tabId and windowId must be provided');
      }
      if (options.windowId !== undefined) {
        requireWindow(options.windowId);
      }
      if (options.tabId !== undefined) {
        requireTab(options.tabId);
      }
      state.sidePanelOpens.push({ ...options });
    },
    async setPanelBehavior(behavior: chrome.sidePanel.PanelBehavior): Promise<void> {
      state.sidePanelBehavior = { ...behavior };
    },
    async getPanelBehavior(): Promise<chrome.sidePanel.PanelBehavior> {
      return { ...state.sidePanelBehavior };
    },
  };

  let uiLanguage = 'en';
  const i18n = {
    getUILanguage(): string {
      return uiLanguage;
    },
    // Real Chrome: the UI language's message, else the default locale's (en), else an empty string;
    // $1..$9 are replaced and $$ becomes $.
    getMessage(name: string, substitutions?: string | string[]): string {
      const entry = localeMessages(uiLanguage)[name] ?? localeMessages('en')[name];
      if (entry === undefined) {
        return '';
      }
      const subs = substitutions === undefined ? [] : [substitutions].flat();
      return expandPlaceholders(entry).replace(/\$(\$|[1-9])/g, (_match, ref: string) =>
        ref === '$' ? '$' : (subs[Number(ref) - 1] ?? ''),
      );
    },
  };

  // ---- identity -------------------------------------------------------------

  /**
   * `chrome.identity`: Chrome's own Google sign-in (`getAuthToken`, promise form, which resolves
   * to `{ token, grantedScopes }` as Chrome 105+ does) and its token cache.
   */
  const identity = {
    async getAuthToken(
      details: chrome.identity.TokenDetails = {},
    ): Promise<chrome.identity.GetAuthTokenResult> {
      state.authTokenRequests.push(details);
      const answer =
        typeof state.authTokenAnswer === 'function'
          ? state.authTokenAnswer(details)
          : state.authTokenAnswer;
      if (answer instanceof Error) {
        throw answer;
      }
      return { token: answer, grantedScopes: details.scopes ?? [] };
    },
    async removeCachedAuthToken(details: chrome.identity.InvalidTokenDetails): Promise<void> {
      state.removedAuthTokens.push(details.token);
    },
    async clearAllCachedAuthTokens(): Promise<void> {
      state.authTokenCacheClears += 1;
    },
  };

  const api = {
    storage: { local, sync, onChanged: storageChanged },
    i18n,
    tabs,
    windows,
    tabGroups,
    runtime,
    contextMenus,
    commands,
    action,
    alarms,
    extension,
    permissions,
    scripting,
    sidePanel,
    identity,
  };

  function gestureTab(): chrome.tabs.Tab | undefined {
    if (state.windows.size === 0) {
      return undefined;
    }
    const windowId = focusedWindow().id;
    const active = [...state.tabs.values()].find(
      (entry) => entry.windowId === windowId && entry.active,
    );
    return active === undefined ? undefined : toChromeTab(active);
  }

  const fire: FakeFire = {
    installed(details) {
      onInstalled.emit(details);
    },
    startup() {
      onStartup.emit();
    },
    // Like Chrome, both hand over the active tab of the window the gesture happened in (the
    // focused one), or no tab when there is no window.
    menuClicked(menuItemId) {
      onMenuClicked.emit({ menuItemId, editable: false }, gestureTab());
    },
    command(name) {
      onCommand.emit(name, gestureTab());
    },
    alarm(name) {
      onAlarm.emit({ name, persistAcrossSessions: true, scheduledTime: Date.now() });
    },
    tabReplaced(addedTabId, removedTabId) {
      onTabReplaced.emit(addedTabId, removedTabId);
    },
    actionClicked() {
      const active = [...state.tabs.values()].find((entry) => entry.active);
      if (active) {
        onActionClicked.emit(toChromeTab(active));
      }
    },
  };

  return {
    // CAST (the only one that touches chrome typings): `api` implements just the
    // promise overloads of a subset of namespaces, while `typeof chrome` declares every
    // namespace plus callback overloads, `events.Event` rule methods, etc. Structural
    // assignability is therefore impossible; tests and app code only ever call the
    // members implemented above. Going through `unknown` keeps the cast honest (no
    // partial overlap check is silently satisfied).
    chrome: api as unknown as typeof chrome,
    state,
    fire,
    failNext(apiName, times, message) {
      failures.set(apiName, { remaining: times, message });
    },
    setUiLanguage(language) {
      uiLanguage = language;
    },
    commitNavigation(tabId) {
      const tab = requireTab(tabId);
      if (tab.pendingUrl !== undefined) {
        tab.url = tab.pendingUrl;
        tab.pendingUrl = undefined;
      }
      tab.status = 'complete';
    },
    freezeTab(tabId) {
      requireTab(tabId).frozen = true;
    },
    thawTab(tabId) {
      requireTab(tabId).frozen = false;
      const waiting = frozenWaiters.get(tabId) ?? [];
      frozenWaiters.delete(tabId);
      for (const resume of waiting) {
        resume();
      }
    },
  };
}

// ---------------------------------------------------------------------------
// Access from tests
// ---------------------------------------------------------------------------

declare global {
  // Installed by src/tests/setup.ts before each test; `var` is required for a globalThis member.
  var __chromeFake: ChromeFake | undefined;
}

/**
 * Returns the fake installed by `src/tests/setup.ts` for the current test.
 *
 * A module imported statically (at the top of a test file) evaluates before any
 * `beforeEach`, so listeners it registers at import time land on setup.ts's
 * throw-away module-level fake, not the one this function returns - load such a
 * module per test instead (`vi.resetModules(); await import(...)`) if its listeners
 * need to be reachable via `fire.*`. See the comment in setup.ts.
 */
export function getChromeFake(): ChromeFake {
  const fake = globalThis.__chromeFake;
  if (!fake) {
    throw new Error('Chrome fake not installed; is src/tests/setup.ts in vitest setupFiles?');
  }
  return fake;
}

interface LocaleMessage {
  message: string;
  description?: string;
  placeholders?: Record<string, { content: string }>;
}

/**
 * Chrome replaces each named placeholder (`$NAME$`, case-insensitive) with its `content` when it
 * loads the file, before `$1`..`$9` are filled in at `getMessage` time; an undefined one makes the
 * whole extension fail to load (src/tests/i18n.test.ts checks that none is).
 */
export function expandPlaceholders(entry: LocaleMessage): string {
  return entry.message.replace(/\$([A-Za-z0-9_@]+)\$/g, (match, name: string) => {
    const placeholder = Object.entries(entry.placeholders ?? {}).find(
      ([key]) => key.toLowerCase() === name.toLowerCase(),
    );
    return placeholder === undefined ? match : placeholder[1].content;
  });
}

const messageCache = new Map<string, Record<string, LocaleMessage>>();

/** `public/_locales/<lang>/messages.json` (region dropped, as Chrome falls back), or nothing. */
function localeMessages(language: string): Record<string, LocaleMessage> {
  const folder = language.replace('-', '_');
  for (const candidate of [folder, folder.split('_')[0]]) {
    const cached = messageCache.get(candidate);
    if (cached !== undefined) {
      return cached;
    }
    try {
      const file = new URL(`../../public/_locales/${candidate}/messages.json`, import.meta.url);
      const parsed = JSON.parse(readFileSync(file, 'utf8')) as Record<string, LocaleMessage>;
      messageCache.set(candidate, parsed);
      return parsed;
    } catch {
      // no such locale: try the language without its region, then give up
    }
  }
  return {};
}

/**
 * A packaged `_locales/<lang>/messages.json`, parsed, the way `readPackagedCatalog()` in
 * src/lib/i18n.ts reads it in the extension: the reader tests pass to `applyUiLanguage()`.
 */
export async function readLocaleFile(locale: string): Promise<unknown> {
  const file = new URL(`../../public/_locales/${locale}/messages.json`, import.meta.url);
  const parsed: unknown = JSON.parse(readFileSync(file, 'utf8'));
  return parsed;
}

/**
 * A `fetch` that serves the extension's own `_locales` files at the fake's
 * `chrome.runtime.getURL()` addresses, and 404 for anything else: install it with
 * `vi.stubGlobal('fetch', fetchPackagedFile)` where code under test (the service worker) uses the
 * default reader. Node's `fetch` cannot read `chrome-extension://` URLs.
 */
export async function fetchPackagedFile(input: string | URL | Request): Promise<Response> {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
  const match = /^chrome-extension:\/\/fakeextid\/_locales\/([A-Za-z_]+)\/messages\.json$/.exec(
    url,
  );
  if (match === null) {
    return new Response('not found', { status: 404 });
  }
  try {
    return new Response(JSON.stringify(await readLocaleFile(match[1])), { status: 200 });
  } catch {
    return new Response('not found', { status: 404 });
  }
}
