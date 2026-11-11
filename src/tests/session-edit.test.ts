import { describe, expect, it } from 'vitest';

import { pickWindow, removeTabFromSession, removeWindowFromSession } from '@/lib/session-edit';
import { contentHash } from '@/lib/session-hash';
import type { Session, TabSnapshot, WindowSnapshot } from '@/types';

function tab(url: string, groupIndex?: number, pinned = false): TabSnapshot {
  return groupIndex === undefined
    ? { url, title: url, pinned, active: false }
    : { url, title: url, pinned, active: false, groupIndex };
}

function makeWindow(overrides: Partial<WindowSnapshot> = {}): WindowSnapshot {
  return {
    state: 'normal',
    focused: false,
    groups: [],
    tabs: [tab('https://a/'), tab('https://b/')],
    ...overrides,
  };
}

function makeSession(windows: WindowSnapshot[]): Session {
  return {
    schemaVersion: 1,
    id: 'id-a',
    kind: 'saved',
    name: 'Fixture',
    origin: 'manual',
    createdAt: 1_000,
    updatedAt: 2_000,
    contentHash: 'stale123',
    windows,
  };
}

describe('removeTabFromSession', () => {
  it('removes the tab and leaves the rest of the window untouched', () => {
    const session = makeSession([
      makeWindow({
        bounds: { left: 1, top: 2, width: 300, height: 400 },
        tabs: [tab('https://a/'), tab('https://b/'), tab('https://c/')],
      }),
    ]);

    const next = removeTabFromSession(session, 0, 1);

    expect(next?.windows[0].tabs.map((entry) => entry.url)).toEqual(['https://a/', 'https://c/']);
    expect(next?.windows[0].bounds).toEqual({ left: 1, top: 2, width: 300, height: 400 });
    expect(next?.name).toBe('Fixture');
    expect(next?.updatedAt).toBe(2_000);
  });

  it('recomputes the content hash', () => {
    const session = makeSession([makeWindow()]);

    const next = removeTabFromSession(session, 0, 0);

    expect(next?.contentHash).toBe(contentHash(next?.windows ?? []));
    expect(next?.contentHash).not.toBe('stale123');
  });

  it('drops a group left with no tabs and remaps the indices of the others', () => {
    const session = makeSession([
      makeWindow({
        groups: [
          { title: 'Solo', color: 'red', collapsed: false },
          { title: 'Pair', color: 'blue', collapsed: true },
        ],
        tabs: [tab('https://solo/', 0), tab('https://p1/', 1), tab('https://p2/', 1)],
      }),
    ]);

    const next = removeTabFromSession(session, 0, 0);

    expect(next?.windows[0].groups).toEqual([{ title: 'Pair', color: 'blue', collapsed: true }]);
    expect(next?.windows[0].tabs.map((entry) => entry.groupIndex)).toEqual([0, 0]);
  });

  it('keeps a group that still has members', () => {
    const session = makeSession([
      makeWindow({
        groups: [{ title: 'Pair', color: 'blue', collapsed: false }],
        tabs: [tab('https://p1/', 0), tab('https://p2/', 0)],
      }),
    ]);

    const next = removeTabFromSession(session, 0, 0);

    expect(next?.windows[0].groups).toHaveLength(1);
    expect(next?.windows[0].tabs.map((entry) => entry.groupIndex)).toEqual([0]);
  });

  it('removes the window when its last tab goes', () => {
    const session = makeSession([
      makeWindow({ tabs: [tab('https://only/')] }),
      makeWindow({ tabs: [tab('https://keep/')] }),
    ]);

    const next = removeTabFromSession(session, 0, 0);

    expect(next?.windows).toHaveLength(1);
    expect(next?.windows[0].tabs[0].url).toBe('https://keep/');
  });

  it('returns null when the last tab of the last window goes', () => {
    const session = makeSession([makeWindow({ tabs: [tab('https://only/')] })]);

    expect(removeTabFromSession(session, 0, 0)).toBeNull();
  });

  it('never mutates the session it was given', () => {
    const session = makeSession([makeWindow()]);
    const before = structuredClone(session);

    removeTabFromSession(session, 0, 0);

    expect(session).toEqual(before);
  });

  it('throws a RangeError for an out-of-range window or tab index', () => {
    const session = makeSession([makeWindow()]);

    expect(() => removeTabFromSession(session, 1, 0)).toThrow(RangeError);
    expect(() => removeTabFromSession(session, -1, 0)).toThrow(RangeError);
    expect(() => removeTabFromSession(session, 0, 2)).toThrow(RangeError);
    expect(() => removeTabFromSession(session, 0, -1)).toThrow(RangeError);
  });
});

describe('removeWindowFromSession', () => {
  it('removes the window and keeps the others in order', () => {
    const session = makeSession([
      makeWindow({ tabs: [tab('https://one/')] }),
      makeWindow({ tabs: [tab('https://two/')] }),
      makeWindow({ tabs: [tab('https://three/')] }),
    ]);

    const next = removeWindowFromSession(session, 1);

    expect(next?.windows.map((window) => window.tabs[0].url)).toEqual([
      'https://one/',
      'https://three/',
    ]);
    expect(next?.contentHash).toBe(contentHash(next?.windows ?? []));
  });

  it('returns null when the last window goes', () => {
    expect(removeWindowFromSession(makeSession([makeWindow()]), 0)).toBeNull();
  });

  it('throws a RangeError for an out-of-range index', () => {
    const session = makeSession([makeWindow()]);

    expect(() => removeWindowFromSession(session, 1)).toThrow(RangeError);
    expect(() => removeWindowFromSession(session, -1)).toThrow(RangeError);
  });
});

describe('pickWindow', () => {
  const session: Session = {
    schemaVersion: 1,
    id: 'abc',
    kind: 'saved',
    name: 'Fixture',
    origin: 'manual',
    createdAt: 1,
    updatedAt: 2,
    windows: [
      makeWindow({ tabs: [tab('https://a.example/')] }),
      makeWindow({ tabs: [tab('https://b.example/')] }),
    ],
  };

  it('returns a session containing only the requested window', () => {
    const picked = pickWindow(session, 1);
    expect(picked.windows).toEqual([session.windows[1]]);
    expect(picked.id).toBe('abc');
    expect(picked.name).toBe('Fixture');
  });

  it('does not mutate the original session', () => {
    pickWindow(session, 0);
    expect(session.windows).toHaveLength(2);
  });

  it('throws a RangeError for an out-of-range index', () => {
    expect(() => pickWindow(session, 2)).toThrow(RangeError);
    expect(() => pickWindow(session, -1)).toThrow(RangeError);
  });
});
