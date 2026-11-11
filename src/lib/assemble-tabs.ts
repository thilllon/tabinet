import { t, tp } from '@/lib/i18n';
import { isTabsCannotBeEditedError, withRetryOnce } from '@/lib/session-restore';

/**
 * "Assemble tabs": pull every tab of the other normal windows into the last-focused one.
 *
 * Tabs are relocated with `chrome.tabs.move` / `chrome.tabGroups.move` only - never reopened by
 * URL and closed - so tab ids, back/forward history and page state survive, and a failed call
 * leaves a tab where it was instead of losing it. Verified in Chrome 152: a cross-window
 * `tabs.move` keeps the id and history but drops `pinned`, and pinning again in the original
 * order appends each tab to the target's pinned area; `tabGroups.move` keeps the group's id,
 * title, colour and collapsed state.
 *
 * The target's active tab must never change, not even for a moment. Verified in Chrome for
 * Testing 151 (and modelled by the test fake): a `tabGroups.move` of a group that holds its
 * source window's active tab makes that tab the target's active tab and expands the group, while
 * `tabs.move` never activates anything. So before any group moves, each source window's active
 * tab is parked on an ungrouped "anchor" tab, and the anchor moves last:
 *  - the active tab itself when it is not in a group;
 *  - otherwise a pinned tab, or the last ungrouped tab, activated first (activating an ungrouped
 *    tab expands nothing - activating a tab inside a collapsed group would expand it);
 *  - in a window of groups only, the active tab is taken out of its group first (re-collapsing the
 *    group when Chrome expands it on the way) and put back into the same group, at the same
 *    offset, once it is in the target. A single-tab group disappears when emptied, so that one
 *    comes back as a new group with the same title, colour and collapsed state.
 */

/** `chrome.tabGroups.TAB_GROUP_ID_NONE`, spelled out so this module stays importable in tests. */
const NO_GROUP = -1;

interface GroupLook {
  title: string;
  color: `${chrome.tabGroups.Color}`;
  collapsed: boolean;
}

type AssembleStep =
  /** In the source window: make this ungrouped tab the active one before any group moves. */
  | { kind: 'activate'; tabId: number }
  /** In the source window: take the active tab out of its group (keeping the group collapsed). */
  | { kind: 'detach'; tabId: number; groupId: number; collapsed: boolean }
  /** Move these pinned tabs together, then pin each again in this order. */
  | { kind: 'pinned'; tabIds: number[] }
  /** A run of consecutive ungrouped tabs, moved as one block. */
  | { kind: 'tabs'; tabIds: number[] }
  /** A whole tab group, moved once. */
  | { kind: 'group'; groupId: number }
  /** The ungrouped anchor, last: just before `beforeTabId` (already in the target) or at the end. */
  | { kind: 'anchor'; tabId: number; beforeTabId?: number }
  /** The detached anchor, last: back into its group, at its old offset. */
  | { kind: 'rejoin'; tabId: number; groupId: number; offset: number; collapsed: boolean }
  /** The anchor whose single-tab group vanished, last: a new group that looks the same. */
  | { kind: 'regroup'; tabId: number; beforeTabId?: number; look: GroupLook };

export type AssembleResult =
  | { status: 'busy' }
  | { status: 'nothing-to-do' }
  | { status: 'done'; mergedWindows: number; failures: AssembleFailure[] };

interface AssembleFailure {
  windowId: number;
  error: unknown;
}

type IdTab = chrome.tabs.Tab & { id: number };

/**
 * The windows whose tabs move: normal windows other than the target that share its incognito
 * mode. Popups, app windows and devtools are never touched, and a private window's tabs never
 * land in a regular one (or the other way round).
 */
export function pickSourceWindows(
  windows: chrome.windows.Window[],
  target: chrome.windows.Window,
): chrome.windows.Window[] {
  return windows.filter(
    (win) =>
      win.id !== undefined &&
      win.id !== target.id &&
      win.type === 'normal' &&
      win.incognito === target.incognito,
  );
}

/** Ungrouped runs and whole groups of `tabs` (strip order, no pinned tabs), appended in order. */
function unpinnedSteps(tabs: IdTab[]): AssembleStep[] {
  const steps: AssembleStep[] = [];
  let run: number[] = [];
  const flushRun = (): void => {
    if (run.length > 0) {
      steps.push({ kind: 'tabs', tabIds: run });
      run = [];
    }
  };
  const movedGroups = new Set<number>();
  for (const tab of tabs) {
    if (tab.groupId === NO_GROUP) {
      run.push(tab.id);
      continue;
    }
    flushRun();
    if (!movedGroups.has(tab.groupId)) {
      movedGroups.add(tab.groupId);
      steps.push({ kind: 'group', groupId: tab.groupId });
    }
  }
  flushRun();
  return steps;
}

/**
 * One source window's steps (see the module comment). Replaying them in order rebuilds the
 * window's strip at the end of the target - pinned tabs in the pinned area, everything else in
 * order - while no group that moves ever holds the source window's active tab.
 */
export function planWindowMoves(
  tabs: chrome.tabs.Tab[],
  groups: ReadonlyMap<number, GroupLook> = new Map(),
): AssembleStep[] {
  const ordered = tabs
    .filter((tab): tab is IdTab => tab.id !== undefined)
    .sort((a, b) => a.index - b.index);
  if (ordered.length === 0) {
    return [];
  }
  const pinnedIds = ordered.filter((tab) => tab.pinned).map((tab) => tab.id);
  const unpinned = ordered.filter((tab) => !tab.pinned);
  const active = ordered.find((tab) => tab.active);
  const pinnedStep: AssembleStep[] =
    pinnedIds.length > 0 ? [{ kind: 'pinned', tabIds: pinnedIds }] : [];

  // An ungrouped active tab is already a safe anchor; a pinned anchor simply travels with the
  // pinned block, which then goes last.
  const ungroupedActive = active !== undefined && active.groupId === NO_GROUP ? active : undefined;
  const firstPinned = pinnedIds[0];
  if (ungroupedActive?.pinned || (ungroupedActive === undefined && firstPinned !== undefined)) {
    const activate: AssembleStep[] =
      ungroupedActive === undefined && firstPinned !== undefined
        ? [{ kind: 'activate', tabId: firstPinned }]
        : [];
    return [...activate, ...unpinnedSteps(unpinned), ...pinnedStep];
  }

  const ungrouped = unpinned.filter((tab) => tab.groupId === NO_GROUP);
  const anchor = ungroupedActive ?? ungrouped[ungrouped.length - 1];
  if (anchor !== undefined) {
    const activate: AssembleStep[] =
      anchor === ungroupedActive ? [] : [{ kind: 'activate', tabId: anchor.id }];
    return [
      ...activate,
      ...pinnedStep,
      ...unpinnedSteps(unpinned.filter((tab) => tab !== anchor)),
      { kind: 'anchor', tabId: anchor.id, beforeTabId: unpinned[unpinned.indexOf(anchor) + 1]?.id },
    ];
  }

  // Groups only: the active tab leaves its group for the length of the move.
  if (active === undefined) {
    return unpinnedSteps(unpinned);
  }
  const members = unpinned.filter((tab) => tab.groupId === active.groupId);
  const look = groups.get(active.groupId) ?? { title: '', color: 'grey', collapsed: false };
  const detach: AssembleStep = {
    kind: 'detach',
    tabId: active.id,
    groupId: active.groupId,
    collapsed: look.collapsed,
  };
  const rest = unpinnedSteps(unpinned.filter((tab) => tab !== active));
  if (members.length > 1) {
    return [
      detach,
      ...rest,
      {
        kind: 'rejoin',
        tabId: active.id,
        groupId: active.groupId,
        offset: members.indexOf(active),
        collapsed: look.collapsed,
      },
    ];
  }
  return [
    detach,
    ...rest,
    {
      kind: 'regroup',
      tabId: active.id,
      beforeTabId: unpinned[unpinned.indexOf(active) + 1]?.id,
      look,
    },
  ];
}

/** "Tabs cannot be edited right now (user may be dragging a tab)" clears up after a moment. */
function retrying<T>(fn: () => Promise<T>): Promise<T> {
  return withRetryOnce(fn, isTabsCannotBeEditedError);
}

/** Target index for a move that lands just before `tabId`; `-1` (the end) when there is none. */
async function indexBefore(tabId: number | undefined): Promise<number> {
  return tabId === undefined ? -1 : (await chrome.tabs.get(tabId)).index;
}

/** Collapses the group again when Chrome expanded it (it must not hold the active tab). */
async function keepCollapsed(groupId: number, collapsed: boolean): Promise<void> {
  if (!collapsed) {
    return;
  }
  const [group] = (await chrome.tabGroups.query({})).filter((entry) => entry.id === groupId);
  if (group !== undefined && !group.collapsed) {
    await retrying(() => chrome.tabGroups.update(groupId, { collapsed: true }));
  }
}

async function runStep(step: AssembleStep, targetWindowId: number): Promise<void> {
  switch (step.kind) {
    case 'activate':
      await retrying(() => chrome.tabs.update(step.tabId, { active: true }));
      return;
    case 'detach':
      await retrying(() => chrome.tabs.ungroup(step.tabId));
      // Ungrouping a tab from the middle of a collapsed group expands it; it no longer holds the
      // active tab, so it can be collapsed again before it moves.
      await keepCollapsed(step.groupId, step.collapsed);
      return;
    case 'pinned':
      await retrying(() => chrome.tabs.move(step.tabIds, { windowId: targetWindowId, index: -1 }));
      for (const tabId of step.tabIds) {
        await retrying(() => chrome.tabs.update(tabId, { pinned: true }));
      }
      return;
    case 'tabs':
      await retrying(() => chrome.tabs.move(step.tabIds, { windowId: targetWindowId, index: -1 }));
      return;
    case 'group':
      await retrying(() =>
        chrome.tabGroups.move(step.groupId, { windowId: targetWindowId, index: -1 }),
      );
      return;
    case 'anchor': {
      const index = await indexBefore(step.beforeTabId);
      await retrying(() => chrome.tabs.move(step.tabId, { windowId: targetWindowId, index }));
      return;
    }
    case 'rejoin': {
      const members = (): Promise<chrome.tabs.Tab[]> =>
        chrome.tabs.query({ windowId: targetWindowId, groupId: step.groupId });
      const before = await members();
      const lastIndex = before[before.length - 1]?.index;
      // Right after the group's last tab, then into the group, then back to its old offset.
      await retrying(() =>
        chrome.tabs.move(step.tabId, {
          windowId: targetWindowId,
          index: lastIndex === undefined ? -1 : lastIndex + 1,
        }),
      );
      await retrying(() => chrome.tabs.group({ tabIds: step.tabId, groupId: step.groupId }));
      const firstIndex = (await members())[0]?.index;
      if (firstIndex !== undefined && step.offset < before.length) {
        await retrying(() => chrome.tabs.move(step.tabId, { index: firstIndex + step.offset }));
      }
      await keepCollapsed(step.groupId, step.collapsed);
      return;
    }
    case 'regroup': {
      const index = await indexBefore(step.beforeTabId);
      await retrying(() => chrome.tabs.move(step.tabId, { windowId: targetWindowId, index }));
      const groupId = await retrying(() =>
        chrome.tabs.group({ tabIds: step.tabId, createProperties: { windowId: targetWindowId } }),
      );
      await retrying(() => chrome.tabGroups.update(groupId, step.look));
      return;
    }
  }
}

/**
 * Safety net for a race the plan cannot see (the user activating a tab inside a group of a
 * window that is still being emptied): puts the target's recorded active tab back and
 * re-collapses groups that arrived collapsed. With the anchors in place it has nothing to do.
 */
async function restoreTargetView(
  targetWindowId: number,
  activeTabId: number | undefined,
  collapsedGroupIds: Set<number>,
): Promise<void> {
  const strip = await chrome.tabs.query({ windowId: targetWindowId });
  const stillHere = strip.some((tab) => tab.id === activeTabId);
  const nowActive = strip.find((tab) => tab.active)?.id;
  if (activeTabId !== undefined && stillHere && nowActive !== activeTabId) {
    await retrying(() => chrome.tabs.update(activeTabId, { active: true }));
  }
  for (const groupId of collapsedGroupIds) {
    await keepCollapsed(groupId, true);
  }
}

// Worker state for the length of one run only: a second trigger while tabs are still moving is
// ignored rather than interleaved with the first.
let running = false;

/**
 * Moves every tab of the other normal windows into the last-focused normal window, then focuses
 * it. Each source window is handled on its own: when one fails, whatever of it had not moved yet
 * stays in its window, and the remaining windows still merge. A window emptied by the moves is
 * closed by Chrome itself.
 */
export async function assembleTabs(): Promise<AssembleResult> {
  if (running) {
    return { status: 'busy' };
  }
  running = true;
  try {
    let target: chrome.windows.Window;
    try {
      target = await chrome.windows.getLastFocused({ populate: true, windowTypes: ['normal'] });
    } catch {
      // No normal window exists at all, so there is nothing to gather into.
      return { status: 'nothing-to-do' };
    }
    const targetWindowId = target.id;
    if (targetWindowId === undefined) {
      return { status: 'nothing-to-do' };
    }

    const windows = await chrome.windows.getAll({ populate: true, windowTypes: ['normal'] });
    const sources = pickSourceWindows(windows, target);
    if (sources.length === 0) {
      return { status: 'nothing-to-do' };
    }
    const activeTabId = target.tabs?.find((tab) => tab.active)?.id;
    const sourceIds = new Set(sources.map((source) => source.id));
    const groups = new Map<number, GroupLook>();
    const collapsedGroupIds = new Set<number>();
    for (const group of await chrome.tabGroups.query({})) {
      groups.set(group.id, {
        title: group.title ?? '',
        color: group.color,
        collapsed: group.collapsed,
      });
      if (group.collapsed && sourceIds.has(group.windowId)) {
        collapsedGroupIds.add(group.id);
      }
    }

    const failures: AssembleFailure[] = [];
    let mergedWindows = 0;
    for (const source of sources) {
      try {
        for (const step of planWindowMoves(source.tabs ?? [], groups)) {
          await runStep(step, targetWindowId);
        }
        mergedWindows += 1;
      } catch (error) {
        failures.push({ windowId: source.id ?? -1, error });
      }
    }

    try {
      await restoreTargetView(targetWindowId, activeTabId, collapsedGroupIds);
      await chrome.windows.update(targetWindowId, { focused: true });
    } catch (error) {
      failures.push({ windowId: targetWindowId, error });
    }
    return { status: 'done', mergedWindows, failures };
  } finally {
    running = false;
  }
}

/** What the Open tabs view says after its Assemble button ran: a passing toast, or an error line. */
type AssembleOutcome = { kind: 'notice'; message: string } | { kind: 'error'; message: string };

export function assembleOutcome(result: AssembleResult): AssembleOutcome {
  if (result.status === 'busy') {
    return { kind: 'notice', message: t('openAssembleBusy') };
  }
  if (result.status === 'nothing-to-do') {
    return { kind: 'notice', message: t('openAssembleNothing') };
  }
  const failed = result.failures.length;
  if (failed > 0) {
    // Tabs that did not move are still in their own window, which is the thing worth saying.
    return {
      kind: 'error',
      message: tp('openAssemblePartial', failed, tp('windowCount', result.mergedWindows)),
    };
  }
  return {
    kind: 'notice',
    message: tp('openAssembleDone', result.mergedWindows),
  };
}
