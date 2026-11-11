/**
 * The app page is one page with hash routes, so every view has an address: Settings (a dialog over
 * the view behind it, see `viewBehind`) can be opened from Chrome's own "Options" item, a session can be bookmarked, and the browser's Back
 * button walks the views. Hash routing (not the History API) because `hashchange` is the only
 * navigation signal an extension page gets for free, and `chrome-extension://` has no server to
 * resolve a path against.
 */

/**
 * A part of Settings the dialog brings into view and focuses on arrival: `youtube` is where
 * "Pause all YouTube videos" sends a person who has not allowed access to YouTube yet.
 */
export type SettingsFocus = 'youtube';

export type Route =
  | { view: 'open' }
  | { view: 'settings'; focus?: SettingsFocus }
  | { view: 'saved'; id: string }
  | { view: 'auto'; id: string }
  | { view: 'notes'; videoId: string }
  | { view: 'search'; query: string };

/** What an unknown, empty or malformed hash resolves to. */
export const HOME: Route = { view: 'open' };

function decode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    // A half-typed or hand-edited escape ("%E0") is a value, not a crash.
    return value;
  }
}

export function parseRoute(hash: string): Route {
  const raw = hash.startsWith('#') ? hash.slice(1) : hash;
  if (raw === '' || raw === 'open') {
    return HOME;
  }
  if (raw === 'settings') {
    return { view: 'settings' };
  }
  const slash = raw.indexOf('/');
  if (slash === -1) {
    return HOME;
  }
  const head = raw.slice(0, slash);
  const tail = decode(raw.slice(slash + 1));
  if (head === 'settings') {
    // An unknown part is still Settings, just without anything to bring into view.
    return tail === 'youtube' ? { view: 'settings', focus: 'youtube' } : { view: 'settings' };
  }
  if (tail === '') {
    return HOME;
  }
  if (head === 'saved') {
    return { view: 'saved', id: tail };
  }
  if (head === 'auto') {
    return { view: 'auto', id: tail };
  }
  if (head === 'search') {
    return { view: 'search', query: tail };
  }
  if (head === 'notes') {
    return { view: 'notes', videoId: tail };
  }
  return HOME;
}

export function formatRoute(route: Route): string {
  switch (route.view) {
    case 'open':
      return '#open';
    case 'settings':
      return route.focus === undefined ? '#settings' : `#settings/${route.focus}`;
    case 'saved':
      return `#saved/${encodeURIComponent(route.id)}`;
    case 'auto':
      return `#auto/${encodeURIComponent(route.id)}`;
    case 'search':
      return `#search/${encodeURIComponent(route.query)}`;
    case 'notes':
      return `#notes/${encodeURIComponent(route.videoId)}`;
  }
}

/** The id a session/snapshot route points at, or `undefined` for the other views. */
export function routeSessionId(route: Route): string | undefined {
  return route.view === 'saved' || route.view === 'auto' ? route.id : undefined;
}

/**
 * What the page shows underneath: Settings is a dialog over the view you were in, so its route
 * keeps the previous view on screen, and every other route simply is the view.
 */
export function viewBehind(route: Route, previous: Route): Route {
  return route.view === 'settings' ? previous : route;
}

/** The address and the view under it, as the page keeps them. */
export interface RouteState {
  route: Route;
  /** The view the page itself shows - `route`, or what was showing before Settings opened. */
  page: Route;
}

/** The state after navigating to `route`: Settings keeps the page that was showing behind it. */
export function advanceRoute(previous: RouteState, route: Route): RouteState {
  return { route, page: viewBehind(route, previous.page) };
}

/**
 * The view a history entry's url shows, when that entry is this page (`pathname`) showing
 * something other than Settings; `undefined` otherwise. The pure half of `viewBelow`.
 */
export function routeOfEntryBelow(
  belowUrl: string | null | undefined,
  pathname: string,
): Route | undefined {
  if (belowUrl === undefined || belowUrl === null) {
    return undefined;
  }
  const url = new URL(belowUrl);
  if (url.pathname !== pathname) {
    return undefined;
  }
  const route = parseRoute(url.hash);
  return route.view === 'settings' ? undefined : route;
}

/**
 * The view on the history entry right below this one, when that entry is this page showing
 * something other than Settings - which is the view the dialog was opened over, whether the click
 * came from inside the page or `#settings` was typed into the address bar. Read from the
 * Navigation API (Chrome 102+) rather than remembered, so it is still right after a reload, a
 * duplicated tab or a restored browser session. `undefined` when Settings is the first thing this
 * tab showed (Chrome's "Options", a bookmark).
 */
export function viewBelow(): Route | undefined {
  const index = window.navigation.currentEntry?.index;
  const below = index === undefined ? undefined : window.navigation.entries()[index - 1];
  return routeOfEntryBelow(below?.url, window.location.pathname);
}
