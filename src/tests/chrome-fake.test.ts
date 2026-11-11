import { describe, expect, it } from 'vitest';

import { getChromeFake } from './chrome-fake';

describe('chrome fake: tab strip', () => {
  it('keeps pinned tabs first and re-indexes on create', async () => {
    const a = await chrome.tabs.create({ url: 'https://a.test', active: false });
    const b = await chrome.tabs.create({ url: 'https://b.test', active: false });
    const p = await chrome.tabs.create({ url: 'https://p.test', pinned: true, active: false });

    const strip = await chrome.tabs.query({ windowId: a.windowId });
    expect(strip.map((tab) => [tab.url, tab.index, tab.pinned])).toEqual([
      ['https://p.test', 0, true],
      ['https://a.test', 1, false],
      ['https://b.test', 2, false],
    ]);
    expect(p.index).toBe(0);
    expect(b.id).not.toBe(a.id);
  });

  it('activates the new tab by default and deactivates siblings', async () => {
    const first = await chrome.tabs.create({ url: 'https://a.test' });
    const second = await chrome.tabs.create({ url: 'https://b.test' });
    const strip = await chrome.tabs.query({});
    expect(strip.find((tab) => tab.id === first.id)?.active).toBe(false);
    expect(strip.find((tab) => tab.id === second.id)?.active).toBe(true);
  });

  it('rejects tabs.create for an unknown window', async () => {
    await expect(chrome.tabs.create({ windowId: 999, url: 'https://a.test' })).rejects.toThrow(
      'No window with id: 999.',
    );
  });

  it('re-indexes after tabs.remove', async () => {
    const a = await chrome.tabs.create({ url: 'https://a.test' });
    const b = await chrome.tabs.create({ url: 'https://b.test' });
    const c = await chrome.tabs.create({ url: 'https://c.test' });
    if (b.id === undefined) {
      throw new Error('expected id');
    }
    await chrome.tabs.remove(b.id);
    const strip = await chrome.tabs.query({});
    expect(strip.map((tab) => [tab.id, tab.index])).toEqual([
      [a.id, 0],
      [c.id, 1],
    ]);
  });

  it('windows.create makes a window with one about:blank tab', async () => {
    const win = await chrome.windows.create({ focused: false });
    if (!win) {
      throw new Error('expected window');
    }
    expect(win.tabs?.length).toBe(1);
    expect(win.tabs?.[0]?.url).toBe('about:blank');
    expect(win.tabs?.[0]?.active).toBe(true);
    expect(getChromeFake().state.windows.size).toBe(2);
  });

  it('tabs.discard marks the tab and refuses the active tab', async () => {
    const active = await chrome.tabs.create({ url: 'https://a.test' });
    const idle = await chrome.tabs.create({ url: 'https://b.test', active: false });
    if (active.id === undefined || idle.id === undefined) {
      throw new Error('expected ids');
    }
    await expect(chrome.tabs.discard(active.id)).rejects.toThrow('Cannot discard active tab');
    const discarded = await chrome.tabs.discard(idle.id);
    expect(discarded?.discarded).toBe(true);
  });

  it('deferCommit leaves a created tab uncommitted until commitNavigation is called', async () => {
    const fake = getChromeFake();
    fake.state.deferCommit = true;

    const tab = await chrome.tabs.create({ url: 'https://a.test', active: false });
    if (tab.id === undefined) {
      throw new Error('expected id');
    }
    expect(tab.url).toBe('');
    expect(tab.pendingUrl).toBe('https://a.test');
    expect(tab.status).toBe('loading');

    fake.commitNavigation(tab.id);
    const committed = await chrome.tabs.get(tab.id);
    expect(committed.url).toBe('https://a.test');
    expect(committed.pendingUrl).toBeUndefined();
    expect(committed.status).toBe('complete');
  });

  it('tabs.discard on an uncommitted tab mimics Chrome: url stays empty, status becomes unloaded', async () => {
    // A decoy tab occupies "active" so the tab under test (created second, active: false) is not
    // forced active by the fake's "sole tab in the window is always active" rule.
    await chrome.tabs.create({ url: 'https://decoy.test' });
    const fake = getChromeFake();
    fake.state.deferCommit = true;

    const tab = await chrome.tabs.create({ url: 'https://a.test', active: false });
    if (tab.id === undefined) {
      throw new Error('expected id');
    }
    expect(tab.active).toBe(false);
    const discarded = await chrome.tabs.discard(tab.id);
    expect(discarded?.discarded).toBe(true);
    expect(discarded?.url).toBe('');
    expect(discarded?.status).toBe('unloaded');
    // The original url is permanently lost: it never makes it into `url`, and commitNavigation
    // has nothing left to promote once the tab has been discarded uncommitted.
    expect(discarded?.pendingUrl).toBe('https://a.test');
  });
});

describe('chrome fake: windows.create state validation', () => {
  // Verified in Chrome for Testing 151: each of these three combinations rejects with
  // "Invalid value for state"; the accepted ones below resolve.
  it('rejects a minimized window that is also focused', async () => {
    await expect(chrome.windows.create({ state: 'minimized', focused: true })).rejects.toThrow(
      'Invalid value for state',
    );
    expect(getChromeFake().state.windows.size).toBe(1);
  });

  it('rejects a maximized or fullscreen window that is not focused', async () => {
    await expect(chrome.windows.create({ state: 'maximized', focused: false })).rejects.toThrow(
      'Invalid value for state',
    );
    await expect(chrome.windows.create({ state: 'fullscreen', focused: false })).rejects.toThrow(
      'Invalid value for state',
    );
    expect(getChromeFake().state.windows.size).toBe(1);
  });

  it('rejects a non-normal state combined with bounds', async () => {
    await expect(
      chrome.windows.create({ state: 'maximized', left: 10, top: 20, width: 800, height: 600 }),
    ).rejects.toThrow('Invalid value for state');
    await expect(chrome.windows.create({ state: 'minimized', width: 800 })).rejects.toThrow(
      'Invalid value for state',
    );
    expect(getChromeFake().state.windows.size).toBe(1);
  });

  it('accepts the combinations Chrome allows', async () => {
    const normal = await chrome.windows.create({
      state: 'normal',
      focused: false,
      left: 10,
      top: 20,
      width: 800,
      height: 600,
    });
    expect(normal?.state).toBe('normal');
    expect(normal?.left).toBe(10);
    const maximized = await chrome.windows.create({ state: 'maximized', focused: true });
    expect(maximized?.state).toBe('maximized');
    const minimized = await chrome.windows.create({ state: 'minimized', focused: false });
    expect(minimized?.state).toBe('minimized');
    // No state at all: bounds and focus are unconstrained.
    const plain = await chrome.windows.create({ focused: false, width: 640 });
    expect(plain?.state).toBe('normal');
  });
});

describe('chrome fake: groups', () => {
  it('tabs.group assigns a fresh group id and sets groupId on members', async () => {
    const a = await chrome.tabs.create({ url: 'https://a.test' });
    const b = await chrome.tabs.create({ url: 'https://b.test' });
    const c = await chrome.tabs.create({ url: 'https://c.test' });
    if (a.id === undefined || b.id === undefined || c.id === undefined) {
      throw new Error('expected ids');
    }
    const g1 = await chrome.tabs.group({ tabIds: [a.id, b.id], createProperties: { windowId: 1 } });
    const g2 = await chrome.tabs.group({ tabIds: [c.id] });
    expect(g1).not.toBe(g2);

    const grouped = await chrome.tabs.query({ groupId: g1 });
    expect(grouped.map((tab) => tab.id)).toEqual([a.id, b.id]);

    await chrome.tabGroups.update(g1, { title: 'Work', color: 'blue', collapsed: true });
    expect(await chrome.tabGroups.get(g1)).toMatchObject({
      id: g1,
      windowId: 1,
      title: 'Work',
      color: 'blue',
      collapsed: true,
    });
    expect((await chrome.tabGroups.query({})).length).toBe(2);
  });

  it('refuses to group a pinned tab', async () => {
    const p = await chrome.tabs.create({ url: 'https://p.test', pinned: true });
    if (p.id === undefined) {
      throw new Error('expected id');
    }
    await expect(chrome.tabs.group({ tabIds: [p.id] })).rejects.toThrow(
      'Tabs cannot be pinned and grouped.',
    );
  });
});

describe('chrome fake: moving tabs between windows (verified in Chrome 152)', () => {
  async function windowWith(urls: string[], focused = false): Promise<number> {
    const win = await chrome.windows.create({ url: urls, focused });
    if (win?.id === undefined) {
      throw new Error('expected a window id');
    }
    return win.id;
  }

  async function strip(windowId: number): Promise<chrome.tabs.Tab[]> {
    return chrome.tabs.query({ windowId });
  }

  it('tabs.move keeps the tab id but drops pinned, and re-pinning appends to the pinned area in order', async () => {
    const target = await windowWith(['https://t-pin.test', 'https://t.test']);
    const [targetPin] = await strip(target);
    await chrome.tabs.update(targetPin?.id ?? -1, { pinned: true });
    const source = await windowWith(['https://p1.test', 'https://p2.test', 'https://s.test']);
    const [p1, p2] = await strip(source);
    const ids = [p1?.id ?? -1, p2?.id ?? -1];
    for (const id of ids) {
      await chrome.tabs.update(id, { pinned: true });
    }

    await chrome.tabs.move(ids, { windowId: target, index: -1 });
    const afterMove = await strip(target);
    expect(afterMove.map((tab) => [tab.url, tab.pinned])).toEqual([
      ['https://t-pin.test', true],
      ['https://t.test', false],
      ['https://p1.test', false],
      ['https://p2.test', false],
    ]);
    expect(afterMove.map((tab) => tab.id).slice(2)).toEqual(ids);

    for (const id of ids) {
      await chrome.tabs.update(id, { pinned: true });
    }
    expect((await strip(target)).map((tab) => [tab.url, tab.pinned])).toEqual([
      ['https://t-pin.test', true],
      ['https://p1.test', true],
      ['https://p2.test', true],
      ['https://t.test', false],
    ]);
  });

  it('a moved tab arrives inactive, the source activates a neighbour, and an emptied source window closes', async () => {
    const target = await windowWith(['https://t.test']);
    const source = await windowWith(['https://a.test', 'https://b.test']);
    const [a, b] = await strip(source);
    await chrome.tabs.update(a?.id ?? -1, { active: true });

    await chrome.tabs.move(a?.id ?? -1, { windowId: target, index: -1 });
    expect((await strip(target)).map((tab) => [tab.url, tab.active])).toEqual([
      ['https://t.test', true],
      ['https://a.test', false],
    ]);
    expect((await strip(source)).map((tab) => [tab.id, tab.active])).toEqual([[b?.id, true]]);

    await chrome.tabs.move(b?.id ?? -1, { windowId: target, index: -1 });
    expect(getChromeFake().state.windows.has(source)).toBe(false);
  });

  it('tabGroups.move carries the whole group: same group id, title, colour, collapsed and tab ids', async () => {
    const target = await windowWith(['https://t.test']);
    const source = await windowWith(['https://g1.test', 'https://g2.test', 'https://loose.test']);
    const [g1, g2, loose] = await strip(source);
    // The source's active tab sits outside the group (see the next test for the other case).
    await chrome.tabs.update(loose?.id ?? -1, { active: true });
    const memberIds: [number, number] = [g1?.id ?? -1, g2?.id ?? -1];
    const groupId = await chrome.tabs.group({
      tabIds: memberIds,
      createProperties: { windowId: source },
    });
    await chrome.tabGroups.update(groupId, { title: 'Work', color: 'blue', collapsed: true });

    await chrome.tabGroups.move(groupId, { windowId: target, index: -1 });

    const [moved] = (await chrome.tabGroups.query({})).filter((group) => group.id === groupId);
    expect([moved?.id, moved?.windowId, moved?.title, moved?.color, moved?.collapsed]).toEqual([
      groupId,
      target,
      'Work',
      'blue',
      true,
    ]);
    expect((await strip(target)).map((tab) => [tab.id, tab.groupId, tab.index])).toEqual([
      [expect.any(Number), -1, 0],
      [memberIds[0], groupId, 1],
      [memberIds[1], groupId, 2],
    ]);
    expect((await strip(source)).map((tab) => tab.url)).toEqual(['https://loose.test']);
  });

  it('tabGroups.move carries the source’s active tab along and expands the group (Chrome for Testing 151)', async () => {
    const target = await windowWith(['https://t1.test', 'https://t2.test']);
    const [, t2] = await strip(target);
    await chrome.tabs.update(t2?.id ?? -1, { active: true });
    const source = await windowWith(['https://g1.test', 'https://g2.test']);
    const [g1, g2] = await strip(source);
    await chrome.tabs.update(g1?.id ?? -1, { active: true });
    const groupId = await chrome.tabs.group({
      tabIds: [g1?.id ?? -1, g2?.id ?? -1],
      createProperties: { windowId: source },
    });
    await chrome.tabGroups.update(groupId, { collapsed: true });

    await chrome.tabGroups.move(groupId, { windowId: target, index: -1 });

    const active = await chrome.tabs.query({ windowId: target, active: true });
    expect(active.map((tab) => tab.id)).toEqual([g1?.id]);
    const [moved] = (await chrome.tabGroups.query({})).filter((group) => group.id === groupId);
    expect(moved?.collapsed).toBe(false);
  });

  it('tabGroups.move without the source’s active tab leaves the target’s active tab and collapse alone', async () => {
    const target = await windowWith(['https://t1.test']);
    const source = await windowWith(['https://s.test', 'https://g.test']);
    const [s1, g] = await strip(source);
    await chrome.tabs.update(s1?.id ?? -1, { active: true });
    const groupId = await chrome.tabs.group({
      tabIds: [g?.id ?? -1],
      createProperties: { windowId: source },
    });
    await chrome.tabGroups.update(groupId, { collapsed: true });

    await chrome.tabGroups.move(groupId, { windowId: target, index: -1 });

    const active = await chrome.tabs.query({ windowId: target, active: true });
    expect(active.map((tab) => tab.url)).toEqual(['https://t1.test']);
    const [moved] = (await chrome.tabGroups.query({})).filter((group) => group.id === groupId);
    expect(moved?.collapsed).toBe(true);
  });

  it('activating a tab inside a collapsed group expands it (Chrome for Testing 151)', async () => {
    const win = await windowWith(['https://a.test', 'https://g.test']);
    const [, g] = await strip(win);
    const groupId = await chrome.tabs.group({
      tabIds: [g?.id ?? -1],
      createProperties: { windowId: win },
    });
    await chrome.tabGroups.update(groupId, { collapsed: true });

    await chrome.tabs.update(g?.id ?? -1, { active: true });

    const [group] = (await chrome.tabGroups.query({})).filter((entry) => entry.id === groupId);
    expect(group?.collapsed).toBe(false);
  });

  it('tabs.ungroup keeps a first or last member in place but moves a middle one after the group, expanding it when active', async () => {
    const win = await windowWith([
      'https://1.test',
      'https://2.test',
      'https://3.test',
      'https://after.test',
    ]);
    const [one, two, three] = await strip(win);
    const groupId = await chrome.tabs.group({
      tabIds: [one?.id ?? -1, two?.id ?? -1, three?.id ?? -1],
      createProperties: { windowId: win },
    });
    await chrome.tabs.update(two?.id ?? -1, { active: true });
    await chrome.tabGroups.update(groupId, { collapsed: true });

    await chrome.tabs.ungroup(two?.id ?? -1);
    expect((await strip(win)).map((tab) => [tab.url, tab.groupId === groupId])).toEqual([
      ['https://1.test', true],
      ['https://3.test', true],
      ['https://2.test', false],
      ['https://after.test', false],
    ]);
    const [group] = (await chrome.tabGroups.query({})).filter((entry) => entry.id === groupId);
    expect(group?.collapsed).toBe(false);

    await chrome.tabs.ungroup(one?.id ?? -1);
    expect((await strip(win)).map((tab) => tab.url)).toEqual([
      'https://1.test',
      'https://3.test',
      'https://2.test',
      'https://after.test',
    ]);
  });

  it('tabGroups.move refuses an index inside the pinned area', async () => {
    const win = await windowWith(['https://p.test', 'https://g.test']);
    const [p, g] = await strip(win);
    await chrome.tabs.update(p?.id ?? -1, { pinned: true });
    const groupId = await chrome.tabs.group({
      tabIds: [g?.id ?? -1],
      createProperties: { windowId: win },
    });
    await expect(chrome.tabGroups.move(groupId, { index: 0 })).rejects.toThrow(/pinned/);
  });

  it('failNext covers tabs.move and tabGroups.move, and nothing moves on a rejected call', async () => {
    const fake = getChromeFake();
    const target = await windowWith(['https://t.test']);
    const source = await windowWith(['https://a.test', 'https://g.test']);
    const [a, g] = await strip(source);
    const groupId = await chrome.tabs.group({
      tabIds: [g?.id ?? -1],
      createProperties: { windowId: source },
    });
    const message = 'Tabs cannot be edited right now (user may be dragging a tab).';
    fake.failNext('tabs.move', 1, message);
    fake.failNext('tabGroups.move', 1, message);

    await expect(chrome.tabs.move(a?.id ?? -1, { windowId: target, index: -1 })).rejects.toThrow(
      message,
    );
    await expect(chrome.tabGroups.move(groupId, { windowId: target, index: -1 })).rejects.toThrow(
      message,
    );
    expect((await strip(source)).map((tab) => tab.url)).toEqual([
      'https://a.test',
      'https://g.test',
    ]);
  });

  it('windows.create honours type and incognito, and incognito windows hold incognito tabs', async () => {
    const popup = await chrome.windows.create({ url: 'https://p.test', type: 'popup' });
    const privateWin = await chrome.windows.create({ url: 'https://i.test', incognito: true });
    expect(popup?.type).toBe('popup');
    expect(privateWin?.incognito).toBe(true);
    expect((await strip(privateWin?.id ?? -1)).map((tab) => tab.incognito)).toEqual([true]);
    const normals = await chrome.windows.getAll({ windowTypes: ['normal'] });
    expect(normals.some((win) => win.id === popup?.id)).toBe(false);
  });
});

describe('chrome fake: storage', () => {
  it('storage.onChanged fires with old and new values for the local area', async () => {
    const seen: Array<[Record<string, chrome.storage.StorageChange>, string]> = [];
    chrome.storage.onChanged.addListener((changes, area) => {
      seen.push([changes, area]);
    });
    await chrome.storage.local.set({ k: 1 });
    await chrome.storage.local.set({ k: 2 });
    await chrome.storage.local.remove('k');
    expect(seen).toEqual([
      [{ k: { oldValue: undefined, newValue: 1 } }, 'local'],
      [{ k: { oldValue: 1, newValue: 2 } }, 'local'],
      [{ k: { oldValue: 2 } }, 'local'],
    ]);
  });

  it('get returns copies, honours defaults objects and null (everything)', async () => {
    await chrome.storage.local.set({ a: { n: 1 }, b: 'x' });
    const all = await chrome.storage.local.get(null);
    expect(all).toEqual({ a: { n: 1 }, b: 'x' });
    const withDefault = await chrome.storage.local.get({ a: 0, missing: 'dflt' });
    expect(withDefault).toEqual({ a: { n: 1 }, missing: 'dflt' });
    const stored = getChromeFake().state.local.get('a');
    expect(stored).toEqual({ n: 1 });
    expect(stored).not.toBe(all.a);
  });

  it('getKeys lists keys and getBytesInUse counts JSON bytes', async () => {
    await chrome.storage.local.set({ 'session:1': { x: 1 }, sessionIndex: [] });
    expect((await chrome.storage.local.getKeys()).sort()).toEqual(['session:1', 'sessionIndex']);
    expect(await chrome.storage.local.getBytesInUse('sessionIndex')).toBe(
      'sessionIndex'.length + '[]'.length,
    );
    expect(await chrome.storage.local.getBytesInUse(null)).toBe(
      'sessionIndex'.length + 2 + 'session:1'.length + JSON.stringify({ x: 1 }).length,
    );
  });
});

describe('chrome fake: failNext and events', () => {
  it('failNext rejects exactly N calls, then succeeds', async () => {
    getChromeFake().failNext('tabs.create', 2, 'Tabs cannot be edited right now');
    await expect(chrome.tabs.create({ url: 'https://a.test' })).rejects.toThrow(
      'Tabs cannot be edited right now',
    );
    await expect(chrome.tabs.create({ url: 'https://a.test' })).rejects.toThrow(
      'Tabs cannot be edited right now',
    );
    const ok = await chrome.tabs.create({ url: 'https://a.test' });
    expect(ok.url).toBe('https://a.test');
    expect(getChromeFake().state.createdTabs.length).toBe(1);
  });

  it('fire.actionClicked reaches every action.onClicked listener with the active tab', async () => {
    const fake = getChromeFake();
    const seen: string[] = [];
    // Two listeners, as in the real worker (sort + snapshot, both in service-worker.ts).
    chrome.action.onClicked.addListener((tab) => {
      seen.push(`first:${tab.url}`);
    });
    chrome.action.onClicked.addListener((tab) => {
      seen.push(`second:${tab.url}`);
    });

    // No tab at all: Chrome never fires the event without a tab, and neither does the fake.
    fake.fire.actionClicked();
    expect(seen).toEqual([]);

    await chrome.windows.create({ url: 'https://a.test/' });
    fake.fire.actionClicked();
    expect(seen).toEqual(['first:https://a.test/', 'second:https://a.test/']);
  });
});

describe('chrome fake: tab / window / group events', () => {
  /** Every event the dashboard's open-windows pane subscribes to, as `name -> emitted args`. */
  function recordAll(): string[] {
    const log: string[] = [];
    chrome.tabs.onCreated.addListener((tab) => log.push(`tabs.onCreated:${String(tab.id)}`));
    chrome.tabs.onRemoved.addListener((tabId, info) =>
      log.push(`tabs.onRemoved:${tabId}:${String(info.isWindowClosing)}:${info.windowId}`),
    );
    chrome.tabs.onUpdated.addListener((tabId, changeInfo) =>
      log.push(`tabs.onUpdated:${tabId}:${Object.keys(changeInfo).join(',')}`),
    );
    chrome.tabs.onMoved.addListener((tabId, info) =>
      log.push(`tabs.onMoved:${tabId}:${info.fromIndex}->${info.toIndex}`),
    );
    chrome.tabs.onAttached.addListener((tabId, info) =>
      log.push(`tabs.onAttached:${tabId}:${info.newWindowId}`),
    );
    chrome.tabs.onDetached.addListener((tabId, info) =>
      log.push(`tabs.onDetached:${tabId}:${info.oldWindowId}`),
    );
    chrome.tabs.onActivated.addListener((info) =>
      log.push(`tabs.onActivated:${info.tabId}:${info.windowId}`),
    );
    chrome.tabs.onReplaced.addListener((added, removed) =>
      log.push(`tabs.onReplaced:${added}:${removed}`),
    );
    chrome.windows.onCreated.addListener((win) => log.push(`windows.onCreated:${String(win.id)}`));
    chrome.windows.onRemoved.addListener((id) => log.push(`windows.onRemoved:${id}`));
    chrome.windows.onFocusChanged.addListener((id) => log.push(`windows.onFocusChanged:${id}`));
    chrome.tabGroups.onCreated.addListener((g) => log.push(`tabGroups.onCreated:${g.id}`));
    chrome.tabGroups.onUpdated.addListener((g) =>
      log.push(`tabGroups.onUpdated:${g.id}:${g.title}`),
    );
    chrome.tabGroups.onRemoved.addListener((g) => log.push(`tabGroups.onRemoved:${g.id}`));
    chrome.tabGroups.onMoved.addListener((g) => log.push(`tabGroups.onMoved:${g.id}`));
    return log;
  }

  it('tabs.create fires onCreated, then onActivated when the new tab takes focus', async () => {
    const log = recordAll();
    const tab = await chrome.tabs.create({ url: 'https://a.test' });
    expect(log).toEqual([
      `tabs.onCreated:${String(tab.id)}`,
      `tabs.onActivated:${String(tab.id)}:1`,
    ]);
  });

  it('a background tabs.create fires onCreated only', async () => {
    await chrome.tabs.create({ url: 'https://first.test' });
    const log = recordAll();
    const tab = await chrome.tabs.create({ url: 'https://a.test', active: false });
    expect(log).toEqual([`tabs.onCreated:${String(tab.id)}`]);
  });

  it('tabs.remove fires onRemoved and activates the neighbour', async () => {
    const a = await chrome.tabs.create({ url: 'https://a.test', active: false });
    const b = await chrome.tabs.create({ url: 'https://b.test' });
    if (a.id === undefined || b.id === undefined) {
      throw new Error('expected ids');
    }
    const log = recordAll();
    await chrome.tabs.remove(b.id);
    expect(log).toEqual([`tabs.onRemoved:${b.id}:false:1`, `tabs.onActivated:${a.id}:1`]);
  });

  it('closing the last tab of a window fires onRemoved with isWindowClosing and windows.onRemoved', async () => {
    const win = await chrome.windows.create({ url: 'https://only.test', focused: false });
    const tabId = win?.tabs?.[0]?.id;
    if (win?.id === undefined || tabId === undefined) {
      throw new Error('expected window and tab');
    }
    const log = recordAll();
    await chrome.tabs.remove(tabId);
    expect(log).toEqual([`tabs.onRemoved:${tabId}:true:${win.id}`, `windows.onRemoved:${win.id}`]);
  });

  it('windows.create fires windows.onCreated, onFocusChanged and the tab events', async () => {
    const log = recordAll();
    const win = await chrome.windows.create({ url: 'https://w.test' });
    const tabId = win?.tabs?.[0]?.id;
    expect(log).toEqual([
      `windows.onCreated:${String(win?.id)}`,
      `windows.onFocusChanged:${String(win?.id)}`,
      `tabs.onCreated:${String(tabId)}`,
      `tabs.onActivated:${String(tabId)}:${String(win?.id)}`,
    ]);
  });

  it('windows.remove fires onRemoved for every tab, then windows.onRemoved', async () => {
    const win = await chrome.windows.create({ url: 'https://a.test', focused: false });
    if (win?.id === undefined) {
      throw new Error('expected window');
    }
    await chrome.tabs.create({ windowId: win.id, url: 'https://b.test', active: false });
    const log = recordAll();
    await chrome.windows.remove(win.id);
    const removals = log.filter((entry) => entry.startsWith('tabs.onRemoved:'));
    expect(removals).toHaveLength(2);
    expect(removals.every((entry) => entry.includes(':true:'))).toBe(true);
    expect(log.at(-1)).toBe(`windows.onRemoved:${win.id}`);
  });

  it('windows.update fires onFocusChanged, with WINDOW_ID_NONE when focus is dropped', async () => {
    const log = recordAll();
    await chrome.windows.update(1, { focused: false });
    await chrome.windows.update(1, { focused: true });
    await chrome.windows.update(1, { focused: true });
    expect(log).toEqual(['windows.onFocusChanged:-1', 'windows.onFocusChanged:1']);
  });

  it('tabs.move places several tabs as a block, in the order given', async () => {
    // What the sorter relies on: one `tabs.move([...ids], { index })` per group, whose whole
    // point is that the ids arrive in sorted order. Chrome puts them on consecutive indices;
    // dropping each on `index` instead would silently reverse every sort.
    const win = await chrome.windows.create({ url: 'https://c.example/' });
    const windowId = win?.id ?? -1;
    const a = await chrome.tabs.create({ windowId, url: 'https://a.example/', active: false });
    const b = await chrome.tabs.create({ windowId, url: 'https://b.example/', active: false });
    const c = (await chrome.tabs.query({ windowId, url: 'https://c.example/' }))[0];

    await chrome.tabs.move([a.id ?? -1, b.id ?? -1, c.id ?? -1], { index: 0 });

    const strip = (await chrome.tabs.query({ windowId })).map((tab) => tab.url);
    expect(strip).toEqual(['https://a.example/', 'https://b.example/', 'https://c.example/']);

    // index -1 appends each in turn, which preserves the order too.
    await chrome.tabs.move([a.id ?? -1, b.id ?? -1], { index: -1 });
    expect((await chrome.tabs.query({ windowId })).map((tab) => tab.url)).toEqual([
      'https://c.example/',
      'https://a.example/',
      'https://b.example/',
    ]);
  });

  it('tabs.move fires onMoved inside a window and onDetached/onAttached across windows', async () => {
    const a = await chrome.tabs.create({ url: 'https://a.test', active: false });
    const b = await chrome.tabs.create({ url: 'https://b.test', active: false });
    const other = await chrome.windows.create({ url: 'https://o.test', focused: false });
    if (a.id === undefined || b.id === undefined || other?.id === undefined) {
      throw new Error('expected ids');
    }
    const log = recordAll();
    await chrome.tabs.move(b.id, { index: 0 });
    await chrome.tabs.move(a.id, { windowId: other.id, index: -1 });
    expect(log).toEqual([
      `tabs.onMoved:${b.id}:1->0`,
      `tabs.onDetached:${a.id}:1`,
      `tabs.onAttached:${a.id}:${other.id}`,
      // `a` was window 1's active tab, so the window it left activates what took its place.
      `tabs.onActivated:${b.id}:1`,
    ]);
  });

  it('tabs.update fires onUpdated for url and pinned changes only', async () => {
    const tab = await chrome.tabs.create({ url: 'https://a.test' });
    if (tab.id === undefined) {
      throw new Error('expected id');
    }
    const log = recordAll();
    await chrome.tabs.update(tab.id, { url: 'https://b.test' });
    await chrome.tabs.update(tab.id, { pinned: true });
    await chrome.tabs.update(tab.id, { active: true });
    expect(log).toEqual([`tabs.onUpdated:${tab.id}:url`, `tabs.onUpdated:${tab.id}:pinned`]);
  });

  it('grouping fires tabGroups.onCreated plus a tabs.onUpdated per member, ungrouping onRemoved', async () => {
    const a = await chrome.tabs.create({ url: 'https://a.test', active: false });
    const b = await chrome.tabs.create({ url: 'https://b.test', active: false });
    if (a.id === undefined || b.id === undefined) {
      throw new Error('expected ids');
    }
    const log = recordAll();
    const groupId = await chrome.tabs.group({ tabIds: [a.id, b.id] });
    await chrome.tabGroups.update(groupId, { title: 'Work' });
    await chrome.tabGroups.move(groupId, { index: -1 });
    await chrome.tabs.ungroup([a.id, b.id]);
    expect(log).toEqual([
      `tabGroups.onCreated:${groupId}`,
      `tabs.onUpdated:${a.id}:groupId`,
      `tabs.onUpdated:${b.id}:groupId`,
      `tabGroups.onUpdated:${groupId}:Work`,
      `tabGroups.onMoved:${groupId}`,
      `tabs.onUpdated:${a.id}:groupId`,
      `tabs.onUpdated:${b.id}:groupId`,
      `tabGroups.onRemoved:${groupId}`,
    ]);
  });
});

describe('chrome fake: match patterns, permissions and scripting', () => {
  const YOUTUBE = 'https://*.youtube.com/*';

  it('reads a `*.` host in tabs.query as the domain and every subdomain', async () => {
    await chrome.tabs.create({ url: 'https://youtube.com/', active: false });
    await chrome.tabs.create({ url: 'https://www.youtube.com/watch?v=a', active: false });
    await chrome.tabs.create({ url: 'https://notyoutube.com/', active: false });
    await chrome.tabs.create({ url: 'http://www.youtube.com/', active: false });

    const found = await chrome.tabs.query({ url: [YOUTUBE] });

    expect(found.map((tab) => tab.url)).toEqual([
      'https://youtube.com/',
      'https://www.youtube.com/watch?v=a',
    ]);
  });

  it('refuses to request an origin the manifest does not list as optional', async () => {
    await expect(
      chrome.permissions.request({ origins: ['https://example.com/*'] }),
    ).rejects.toThrow(/specified in the manifest/);
  });

  it('fires onAdded only for a real change', async () => {
    const calls: chrome.permissions.Permissions[] = [];
    chrome.permissions.onAdded.addListener((permissions) => calls.push(permissions));

    await chrome.permissions.request({ origins: [YOUTUBE] });
    await chrome.permissions.request({ origins: [YOUTUBE] });

    expect(calls).toEqual([{ origins: [YOUTUBE], permissions: [] }]);
  });

  it('refuses to inject into a page whose host was not granted', async () => {
    const tab = await chrome.tabs.create({ url: 'https://www.youtube.com/', active: false });
    if (tab.id === undefined) {
      throw new Error('no id');
    }
    await expect(
      chrome.scripting.executeScript({ target: { tabId: tab.id }, func: () => 1 }),
    ).rejects.toThrow(/Cannot access contents of the page/);
    expect(getChromeFake().state.injectedTabs).toEqual([]);
  });

  it('runs the injected function from its source text, as Chrome serializes it', async () => {
    getChromeFake().state.grantedOrigins.add(YOUTUBE);
    const tab = await chrome.tabs.create({ url: 'https://www.youtube.com/', active: false });
    if (tab.id === undefined) {
      throw new Error('no id');
    }
    const outside = 41;

    await expect(
      chrome.scripting.executeScript({ target: { tabId: tab.id }, func: () => outside + 1 }),
    ).rejects.toThrow(/outside/);
    const [result] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: (a: number, b: number) => a + b,
      args: [40, 2],
    });
    expect(result?.result).toBe(42);
  });
});

describe('chrome.sidePanel', () => {
  it('records an open in a window that exists, and refuses one without a target', async () => {
    const fake = getChromeFake();
    const win = await chrome.windows.create({ url: 'https://a.example/' });
    if (win?.id === undefined) {
      throw new Error('fake windows.create returned nothing');
    }

    await chrome.sidePanel.open({ windowId: win.id });

    expect(fake.state.sidePanelOpens).toEqual([{ windowId: win.id }]);
    // @ts-expect-error -- the type already demands a target; Chrome checks it at run time too.
    await expect(chrome.sidePanel.open({})).rejects.toThrow(/tabId and windowId/);
    await expect(chrome.sidePanel.open({ windowId: 999 })).rejects.toThrow();
  });

  it('does not open on a click on the icon unless told to', async () => {
    expect(await chrome.sidePanel.getPanelBehavior()).toEqual({ openPanelOnActionClick: false });
  });
});

describe('menu clicks and commands', () => {
  it('hand over the active tab of the focused window, as Chrome does', async () => {
    const fake = getChromeFake();
    const win = await chrome.windows.create({ url: 'https://a.example/' });
    const seen: (chrome.tabs.Tab | undefined)[] = [];
    chrome.contextMenus.onClicked.addListener((_info, tab) => seen.push(tab));
    chrome.commands.onCommand.addListener((_command, tab) => seen.push(tab));

    fake.fire.menuClicked('x');
    fake.fire.command('y');

    expect(seen.map((tab) => tab?.windowId)).toEqual([win?.id, win?.id]);
    expect(seen.every((tab) => tab?.active === true)).toBe(true);
  });
});
