import { describe, expect, it, vi } from 'vitest';

import {
  assembleOutcome,
  assembleTabs,
  pickSourceWindows,
  planWindowMoves,
} from '@/lib/assemble-tabs';

import { getChromeFake } from './chrome-fake';

const DRAGGING = 'Tabs cannot be edited right now (user may be dragging a tab).';

function tab(id: number, index: number, extra: Partial<chrome.tabs.Tab> = {}): chrome.tabs.Tab {
  return {
    id,
    index,
    windowId: 1,
    pinned: false,
    groupId: -1,
    active: false,
    highlighted: false,
    incognito: false,
    discarded: false,
    autoDiscardable: true,
    frozen: false,
    selected: false,
    lastAccessed: 0,
    ...extra,
  };
}

function win(id: number, extra: Partial<chrome.windows.Window> = {}): chrome.windows.Window {
  return {
    id,
    focused: false,
    incognito: false,
    alwaysOnTop: false,
    type: 'normal',
    state: 'normal',
    ...extra,
  };
}

describe('planWindowMoves', () => {
  const look = { title: 'Work', color: 'blue', collapsed: true } as const;

  it('parks the active tab on a pinned tab and moves the pinned block last', () => {
    const tabs = [
      tab(6, 5, { groupId: 20, active: true }),
      tab(1, 0, { pinned: true }),
      tab(2, 1, { pinned: true }),
      tab(3, 2),
      tab(4, 3),
      tab(5, 4, { groupId: 20 }),
      tab(7, 6),
      tab(8, 7, { groupId: 30 }),
    ];
    expect(planWindowMoves(tabs)).toEqual([
      { kind: 'activate', tabId: 1 },
      { kind: 'tabs', tabIds: [3, 4] },
      { kind: 'group', groupId: 20 },
      { kind: 'tabs', tabIds: [7] },
      { kind: 'group', groupId: 30 },
      { kind: 'pinned', tabIds: [1, 2] },
    ]);
  });

  it('keeps an ungrouped active tab as the anchor and moves it last, back into its place', () => {
    expect(
      planWindowMoves([
        tab(1, 0, { pinned: true }),
        tab(2, 1, { active: true }),
        tab(3, 2, { groupId: 20 }),
      ]),
    ).toEqual([
      { kind: 'pinned', tabIds: [1] },
      { kind: 'group', groupId: 20 },
      { kind: 'anchor', tabId: 2, beforeTabId: 3 },
    ]);
    expect(
      planWindowMoves([tab(1, 0), tab(2, 1, { groupId: 20 }), tab(3, 2, { active: true })]),
    ).toEqual([
      { kind: 'tabs', tabIds: [1] },
      { kind: 'group', groupId: 20 },
      { kind: 'anchor', tabId: 3, beforeTabId: undefined },
    ]);
  });

  it('activates the last ungrouped tab when the active tab is inside a group', () => {
    const tabs = [tab(1, 0, { groupId: 20, active: true }), tab(2, 1), tab(3, 2, { groupId: 30 })];
    expect(planWindowMoves(tabs)).toEqual([
      { kind: 'activate', tabId: 2 },
      { kind: 'group', groupId: 20 },
      { kind: 'group', groupId: 30 },
      { kind: 'anchor', tabId: 2, beforeTabId: 3 },
    ]);
  });

  it('takes the active tab out of its group in a window of groups only, and puts it back at its offset', () => {
    const tabs = [
      tab(1, 0, { groupId: 20 }),
      tab(2, 1, { groupId: 20, active: true }),
      tab(3, 2, { groupId: 20 }),
      tab(4, 3, { groupId: 30 }),
    ];
    expect(planWindowMoves(tabs, new Map([[20, look]]))).toEqual([
      { kind: 'detach', tabId: 2, groupId: 20, collapsed: true },
      { kind: 'group', groupId: 20 },
      { kind: 'group', groupId: 30 },
      { kind: 'rejoin', tabId: 2, groupId: 20, offset: 1, collapsed: true },
    ]);
  });

  it('rebuilds a single-tab group that the detach empties, just before what followed it', () => {
    const groups = new Map([[30, look]]);
    expect(
      planWindowMoves(
        [tab(1, 0, { groupId: 30, active: true }), tab(2, 1, { groupId: 20 })],
        groups,
      ),
    ).toEqual([
      { kind: 'detach', tabId: 1, groupId: 30, collapsed: true },
      { kind: 'group', groupId: 20 },
      { kind: 'regroup', tabId: 1, beforeTabId: 2, look },
    ]);
  });

  it('has nothing to do for an empty window and skips tabs without an id', () => {
    expect(planWindowMoves([])).toEqual([]);
    expect(planWindowMoves([tab(1, 0, { active: true }), { ...tab(2, 1), id: undefined }])).toEqual(
      [{ kind: 'anchor', tabId: 1, beforeTabId: undefined }],
    );
  });
});

describe('pickSourceWindows', () => {
  it('keeps only other normal windows with the same incognito mode as the target', () => {
    const target = win(1);
    const windows = [
      target,
      win(2),
      win(3, { incognito: true }),
      win(4, { type: 'popup' }),
      win(5, { type: 'app' }),
      win(6, { type: 'devtools' }),
      win(7),
    ];
    expect(pickSourceWindows(windows, target).map((w) => w.id)).toEqual([2, 7]);
    expect(pickSourceWindows(windows, win(3, { incognito: true })).map((w) => w.id)).toEqual([]);
  });
});

describe('assembleTabs against the chrome fake', () => {
  /** Window 1 (the fake's initial, focused window) is the target; sources are opened unfocused. */
  async function targetWith(urls: string[]): Promise<number> {
    for (const [index, url] of urls.entries()) {
      await chrome.tabs.create({ windowId: 1, url, active: index === 0 });
    }
    return 1;
  }

  async function sourceWith(urls: string[], data: chrome.windows.CreateData = {}): Promise<number> {
    const created = await chrome.windows.create({ url: urls, focused: false, ...data });
    if (created?.id === undefined) {
      throw new Error('expected a window id');
    }
    return created.id;
  }

  async function idsOf(windowId: number): Promise<number[]> {
    return (await chrome.tabs.query({ windowId })).map((t) => t.id ?? -1);
  }

  async function pin(windowId: number, count: number): Promise<number[]> {
    const ids = (await idsOf(windowId)).slice(0, count);
    for (const id of ids) {
      await chrome.tabs.update(id, { pinned: true });
    }
    return ids;
  }

  async function group(
    windowId: number,
    tabIds: [number, ...number[]],
    props: chrome.tabGroups.UpdateProperties,
  ): Promise<number> {
    const groupId = await chrome.tabs.group({ tabIds, createProperties: { windowId } });
    await chrome.tabGroups.update(groupId, props);
    return groupId;
  }

  function allTabIds(): number[] {
    return [...getChromeFake().state.tabs.keys()].sort((a, b) => a - b);
  }

  async function strip(windowId: number): Promise<[string, boolean, number][]> {
    return (await chrome.tabs.query({ windowId })).map((t) => [t.url ?? '', t.pinned, t.groupId]);
  }

  it('re-pins moved pinned tabs in order after the target’s own pinned tabs, keeping tab ids', async () => {
    const target = await targetWith(['https://t-pin.test', 'https://t.test']);
    await pin(target, 1);
    const source = await sourceWith(['https://p1.test', 'https://p2.test', 'https://s.test']);
    const pinnedIds = await pin(source, 2);
    const before = allTabIds();

    const result = await assembleTabs();

    expect(result).toEqual({ status: 'done', mergedWindows: 1, failures: [] });
    expect((await strip(target)).map(([url, pinned]) => [url, pinned])).toEqual([
      ['https://t-pin.test', true],
      ['https://p1.test', true],
      ['https://p2.test', true],
      ['https://t.test', false],
      ['https://s.test', false],
    ]);
    expect((await idsOf(target)).slice(1, 3)).toEqual(pinnedIds);
    expect(allTabIds()).toEqual(before);
    expect(getChromeFake().state.windows.has(source)).toBe(false);
  });

  it('moves a group whole: same group id, title, colour and collapsed state', async () => {
    const target = await targetWith(['https://t.test']);
    const source = await sourceWith(['https://g1.test', 'https://g2.test', 'https://after.test']);
    // g1 is the source window's active tab: moving the group as it is would make g1 the target's
    // active tab and expand the group (Chrome for Testing 151), so `after` is activated first.
    const [g1 = -1, g2 = -1] = await idsOf(source);
    const groupId = await group(source, [g1, g2], {
      title: 'Work',
      color: 'blue',
      collapsed: true,
    });

    await assembleTabs();

    const [moved] = (await chrome.tabGroups.query({})).filter((g) => g.id === groupId);
    expect(moved).toMatchObject({
      windowId: target,
      title: 'Work',
      color: 'blue',
      collapsed: true,
    });
    expect(await strip(target)).toEqual([
      ['https://t.test', false, -1],
      ['https://g1.test', false, groupId],
      ['https://g2.test', false, groupId],
      ['https://after.test', false, -1],
    ]);
    expect((await idsOf(target)).slice(1, 3)).toEqual([g1, g2]);
    const active = await chrome.tabs.query({ windowId: target, active: true });
    expect(active.map((t) => t.url)).toEqual(['https://t.test']);
  });

  it('keeps the order of ungrouped tabs around a group, window after window', async () => {
    const target = await targetWith(['https://t.test']);
    const first = await sourceWith([
      'https://a.test',
      'https://b.test',
      'https://g.test',
      'https://c.test',
    ]);
    const [, , g = -1] = await idsOf(first);
    await group(first, [g], { title: 'G' });
    await sourceWith(['https://d.test', 'https://e.test']);

    await assembleTabs();

    expect((await strip(target)).map(([url]) => url)).toEqual([
      'https://t.test',
      'https://a.test',
      'https://b.test',
      'https://g.test',
      'https://c.test',
      'https://d.test',
      'https://e.test',
    ]);
    expect([...getChromeFake().state.windows.keys()]).toEqual([target]);
  });

  it('leaves incognito and popup windows alone', async () => {
    const target = await targetWith(['https://t.test']);
    const privateWin = await sourceWith(['https://private.test'], { incognito: true });
    const popup = await sourceWith(['https://popup.test'], { type: 'popup' });
    const normal = await sourceWith(['https://n.test']);

    const result = await assembleTabs();

    expect(result).toEqual({ status: 'done', mergedWindows: 1, failures: [] });
    expect((await strip(target)).map(([url]) => url)).toEqual(['https://t.test', 'https://n.test']);
    expect((await strip(privateWin)).map(([url]) => url)).toEqual(['https://private.test']);
    expect((await strip(popup)).map(([url]) => url)).toEqual(['https://popup.test']);
    expect(getChromeFake().state.windows.has(normal)).toBe(false);
  });

  /** Every tab activation Chrome reports for `windowId` from now on. */
  function activationsIn(windowId: number): number[] {
    const seen: number[] = [];
    chrome.tabs.onActivated.addListener((info) => {
      if (info.windowId === windowId) {
        seen.push(info.tabId);
      }
    });
    return seen;
  }

  it('never activates a tab in the target, even for a group that holds its window’s active tab', async () => {
    const target = await targetWith(['https://t1.test', 'https://t2.test']);
    const [, t2 = -1] = await idsOf(target);
    await chrome.tabs.update(t2, { active: true });
    const source = await sourceWith(['https://g1.test', 'https://g2.test', 'https://loose.test']);
    const [g1 = -1, g2 = -1] = await idsOf(source);
    const groupId = await group(source, [g1, g2], { title: 'G', collapsed: true });
    const seen = activationsIn(target);

    await assembleTabs();

    expect(seen).toEqual([]);
    expect((await chrome.tabs.query({ windowId: target, active: true })).map((t) => t.id)).toEqual([
      t2,
    ]);
    const [moved] = (await chrome.tabGroups.query({})).filter((g) => g.id === groupId);
    expect(moved?.collapsed).toBe(true);
    expect((await strip(target)).map(([url]) => url)).toEqual([
      'https://t1.test',
      'https://t2.test',
      'https://g1.test',
      'https://g2.test',
      'https://loose.test',
    ]);
  });

  it('moves a window of groups only without touching the target’s active tab or the groups', async () => {
    const target = await targetWith(['https://t.test']);
    const source = await sourceWith([
      'https://a.test',
      'https://b.test',
      'https://c.test',
      'https://d.test',
    ]);
    const [a = -1, b = -1, c = -1, d = -1] = await idsOf(source);
    const first = await group(source, [a, b, c], {
      title: 'Three',
      color: 'green',
      collapsed: true,
    });
    const second = await group(source, [d], { title: 'One', color: 'red' });
    await chrome.tabs.update(b, { active: true });
    await chrome.tabGroups.update(first, { collapsed: true });
    const seen = activationsIn(target);
    const before = allTabIds();

    const result = await assembleTabs();

    expect(result).toEqual({ status: 'done', mergedWindows: 1, failures: [] });
    expect(seen).toEqual([]);
    expect(allTabIds()).toEqual(before);
    expect(await strip(target)).toEqual([
      ['https://t.test', false, -1],
      ['https://a.test', false, first],
      ['https://b.test', false, first],
      ['https://c.test', false, first],
      ['https://d.test', false, second],
    ]);
    const [moved] = (await chrome.tabGroups.query({})).filter((g) => g.id === first);
    expect(moved).toMatchObject({ title: 'Three', color: 'green', collapsed: true });
  });

  it('rebuilds a single-tab group that held its window’s active tab, with the same look', async () => {
    const target = await targetWith(['https://t.test']);
    const source = await sourceWith(['https://only.test']);
    const [only = -1] = await idsOf(source);
    await group(source, [only], { title: 'Solo', color: 'purple', collapsed: true });
    const seen = activationsIn(target);

    await assembleTabs();

    expect(seen).toEqual([]);
    const moved = await chrome.tabs.get(only);
    expect(moved.windowId).toBe(target);
    const [rebuilt] = (await chrome.tabGroups.query({})).filter((g) => g.id === moved.groupId);
    expect(rebuilt).toMatchObject({
      title: 'Solo',
      color: 'purple',
      collapsed: true,
      windowId: target,
    });
  });

  it('keeps going when one window fails, and loses no tab', async () => {
    const target = await targetWith(['https://t.test']);
    const failing = await sourceWith(['https://g.test', 'https://stays.test']);
    const [g = -1] = await idsOf(failing);
    await group(failing, [g], { title: 'G' });
    await sourceWith(['https://ok.test']);
    const before = allTabIds();
    getChromeFake().failNext('tabGroups.move', 1, 'No group with id: 99.');

    const result = await assembleTabs();

    if (result.status !== 'done') {
      throw new Error(`expected a finished run, got ${result.status}`);
    }
    expect(result.mergedWindows).toBe(1);
    expect(result.failures.map((f) => f.windowId)).toEqual([failing]);
    expect((await strip(target)).map(([url]) => url)).toEqual([
      'https://t.test',
      'https://ok.test',
    ]);
    expect((await strip(failing)).map(([url]) => url)).toEqual([
      'https://g.test',
      'https://stays.test',
    ]);
    expect(allTabIds()).toEqual(before);
  });

  it('retries once when Chrome says the tab strip cannot be edited right now', async () => {
    const target = await targetWith(['https://t.test']);
    await sourceWith(['https://a.test']);
    getChromeFake().failNext('tabs.move', 1, DRAGGING);

    const result = await assembleTabs();

    expect(result).toEqual({ status: 'done', mergedWindows: 1, failures: [] });
    expect((await strip(target)).map(([url]) => url)).toEqual(['https://t.test', 'https://a.test']);
  });

  it('does nothing when there is only one window', async () => {
    const target = await targetWith(['https://t.test', 'https://u.test']);
    const before = await strip(target);

    expect(await assembleTabs()).toEqual({ status: 'nothing-to-do' });
    expect(await strip(target)).toEqual(before);
  });

  it('ignores a second trigger while the first run is still moving tabs', async () => {
    await targetWith(['https://t.test']);
    await sourceWith(['https://a.test']);

    const [first, second] = await Promise.all([assembleTabs(), assembleTabs()]);

    expect(first.status).toBe('done');
    expect(second).toEqual({ status: 'busy' });
    // The flag is released once the run ends.
    expect(await assembleTabs()).toEqual({ status: 'nothing-to-do' });
  });

  it('keeps the target’s active tab and focuses the target at the end', async () => {
    const target = await targetWith(['https://t1.test', 'https://t2.test']);
    const [, t2 = -1] = await idsOf(target);
    await chrome.tabs.update(t2, { active: true });
    const source = await sourceWith(['https://a.test', 'https://b.test']);
    const [a = -1] = await idsOf(source);
    await chrome.tabs.update(a, { active: true });
    const focus = vi.spyOn(chrome.windows, 'update');

    await assembleTabs();

    const active = await chrome.tabs.query({ windowId: target, active: true });
    expect(active.map((t) => t.id)).toEqual([t2]);
    expect(focus).toHaveBeenCalledWith(target, { focused: true });
  });
});

describe('assembleOutcome', () => {
  it('confirms how many windows were gathered', () => {
    expect(assembleOutcome({ status: 'done', mergedWindows: 1, failures: [] })).toEqual({
      kind: 'notice',
      message: 'Gathered 1 window into this one.',
    });
    expect(assembleOutcome({ status: 'done', mergedWindows: 3, failures: [] }).message).toBe(
      'Gathered 3 windows into this one.',
    );
  });

  it('reports a window that could not be moved as an error that stays up', () => {
    const outcome = assembleOutcome({
      status: 'done',
      mergedWindows: 2,
      failures: [{ windowId: 7, error: new Error('Tabs cannot be edited right now') }],
    });
    expect(outcome.kind).toBe('error');
    expect(outcome.message).toBe(
      'Gathered 2 windows; 1 window could not be moved and was left as it was.',
    );
  });

  it('says so when there was nothing to gather or a run is already under way', () => {
    expect(assembleOutcome({ status: 'nothing-to-do' }).kind).toBe('notice');
    expect(assembleOutcome({ status: 'busy' }).kind).toBe('notice');
  });
});
