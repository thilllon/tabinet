import { contentHash } from '@/lib/session-hash';
import type { Session, TabSnapshot, WindowSnapshot } from '@/types';

/**
 * Rebuilds a window after tabs were removed: groups no tab references any more are dropped and the
 * remaining `groupIndex` values are remapped. Filtering alone cannot do it - `groupIndex` is a
 * position in `groups`, so removing the last tab of group 0 would leave every other tab pointing at
 * the wrong group. Relative order is preserved, so the surviving groups stay in first-appearance
 * order.
 */
function compactGroups(
  groups: WindowSnapshot['groups'],
  tabs: TabSnapshot[],
): Pick<WindowSnapshot, 'groups' | 'tabs'> {
  const used = new Set<number>();
  for (const tab of tabs) {
    if (tab.groupIndex !== undefined) {
      used.add(tab.groupIndex);
    }
  }
  const kept = [...used].sort((a, b) => a - b);
  const remap = new Map(kept.map((oldIndex, newIndex) => [oldIndex, newIndex]));

  return {
    groups: kept.map((index) => groups[index]),
    tabs: tabs.map((tab) => {
      if (tab.groupIndex === undefined) {
        return tab;
      }
      const groupIndex = remap.get(tab.groupIndex);
      return groupIndex === undefined ? tab : { ...tab, groupIndex };
    }),
  };
}

/** `window` with `tabs`, its groups compacted, and every other field kept as it was. */
function withTabs(window: WindowSnapshot, tabs: TabSnapshot[]): WindowSnapshot {
  const compacted = compactGroups(window.groups, tabs);
  const next: WindowSnapshot = {
    state: window.state,
    focused: window.focused,
    groups: compacted.groups,
    tabs: compacted.tabs,
  };
  if (window.bounds !== undefined) {
    next.bounds = window.bounds;
  }
  return next;
}

/** `session` with `windows`, or `null` when nothing is left - the caller then deletes it. */
function withWindows(session: Session, windows: WindowSnapshot[]): Session | null {
  if (windows.length === 0) {
    return null;
  }
  // The hash fingerprints urls/pinned/group index/title, so an edit invalidates it; recomputing
  // here keeps history dedupe (`historyMeta.lastHash`) honest about what is actually stored.
  return { ...session, windows, contentHash: contentHash(windows) };
}

function requireWindow(session: Session, windowIndex: number): WindowSnapshot {
  const window = session.windows[windowIndex];
  if (windowIndex < 0 || window === undefined) {
    throw new RangeError(`Session ${session.id} has no window at index ${windowIndex}`);
  }
  return window;
}

/**
 * Removes one tab from a saved session ("Remove from session").
 *
 * Removing the last tab of a window removes the window; removing the last window returns `null`,
 * which `sessionRepo.update` turns into a delete - the dashboard asks first.
 */
export function removeTabFromSession(
  session: Session,
  windowIndex: number,
  tabIndex: number,
): Session | null {
  const window = requireWindow(session, windowIndex);
  if (tabIndex < 0 || window.tabs[tabIndex] === undefined) {
    throw new RangeError(`Window ${windowIndex} has no tab at index ${tabIndex}`);
  }
  const tabs = window.tabs.filter((_tab, index) => index !== tabIndex);
  const windows =
    tabs.length === 0
      ? session.windows.filter((_window, index) => index !== windowIndex)
      : session.windows.map((entry, index) =>
          index === windowIndex ? withTabs(window, tabs) : entry,
        );
  return withWindows(session, windows);
}

/** Removes one whole window from a saved session; `null` when it was the last one. */
export function removeWindowFromSession(session: Session, windowIndex: number): Session | null {
  requireWindow(session, windowIndex);
  return withWindows(
    session,
    session.windows.filter((_window, index) => index !== windowIndex),
  );
}

/** Returns a copy of `session` that contains only `windows[windowIndex]`. */
export function pickWindow(session: Session, windowIndex: number): Session {
  const window = session.windows[windowIndex];
  if (windowIndex < 0 || window === undefined) {
    throw new RangeError(`Session ${session.id} has no window at index ${windowIndex}`);
  }
  return { ...session, windows: [window] };
}
