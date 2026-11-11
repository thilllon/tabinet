import { describe, expect, it, vi } from 'vitest';

import { LAZY_AUTO_THRESHOLD } from '@/constants';
import {
  clampToScreen,
  executeRestore,
  isLazyRestore,
  isTabsCannotBeEditedError,
  loadSanitizeOptions,
  planRestore,
  type RestoreOptions,
  type RestorePlan,
  type SanitizeOptions,
  sanitizeRestoreUrl,
  screenRectOf,
  withRetryOnce,
} from '@/lib/session-restore';
import {
  SESSION_SCHEMA_VERSION,
  type Session,
  type TabSnapshot,
  type WindowSnapshot,
} from '@/types';

import { getChromeFake } from './chrome-fake';

/** The Marvellous Suspender's placeholder page; any suspender of its family is recognised. */
const SUSPENDED_PREFIX = 'chrome-extension://noogafoofpebimajpfpamcfhoaifemoa/suspended.html#';
const OTHER_SUSPENDER_PREFIX =
  'chrome-extension://klbibkeccnjlkjkiokjodocebajanakg/suspended.html#';

const SANITIZE: SanitizeOptions = {
  ownExtensionId: 'fakeextid',
  fileAccessAllowed: false,
};

function tab(overrides: Partial<TabSnapshot> = {}): TabSnapshot {
  return {
    url: 'https://example.com/',
    title: 'Example',
    pinned: false,
    active: false,
    ...overrides,
  };
}

function urls(count: number, prefix = 'https://site.test/'): TabSnapshot[] {
  return Array.from({ length: count }, (_, i) => tab({ url: `${prefix}${i}` }));
}

function win(tabs: TabSnapshot[], overrides: Partial<WindowSnapshot> = {}): WindowSnapshot {
  return { state: 'normal', focused: false, groups: [], tabs, ...overrides };
}

function session(windows: WindowSnapshot[]): Session {
  return {
    schemaVersion: SESSION_SCHEMA_VERSION,
    id: 'sess',
    kind: 'saved',
    name: 'Test',
    origin: 'manual',
    createdAt: 1,
    updatedAt: 1,
    windows,
  };
}

function options(overrides: Partial<RestoreOptions> = {}): RestoreOptions {
  return { target: { kind: 'newWindows' }, lazy: 'auto', sanitize: SANITIZE, ...overrides };
}

describe('sanitizeRestoreUrl', () => {
  it.each([
    'http://example.com/',
    'https://example.com/path?q=1#h',
    'ftp://files.example.com/pub/',
    'chrome://settings/',
    'chrome://extensions/shortcuts',
    'about:blank',
    'chrome-extension://fakeextid/app.html',
  ])('allows %s', (url) => {
    expect(sanitizeRestoreUrl(url, SANITIZE)).toBe(url);
  });

  it.each([
    'javascript:alert(1)',
    'data:text/html,<h1>hi</h1>',
    'blob:https://example.com/uuid',
    'view-source:https://example.com/',
    'chrome-extension://otherid/popup.html',
    'about:newtab',
    'about:srcdoc',
    'not a url',
    '',
  ])('rejects %s', (url) => {
    expect(sanitizeRestoreUrl(url, SANITIZE)).toBeNull();
  });

  it('allows file:// only when file access is granted', () => {
    const url = 'file:///Users/me/doc.html';

    expect(sanitizeRestoreUrl(url, SANITIZE)).toBeNull();
    expect(sanitizeRestoreUrl(url, { ...SANITIZE, fileAccessAllowed: true })).toBe(url);
  });

  it('unwraps suspender wrappers before checking the scheme', () => {
    const wrapped = `${SUSPENDED_PREFIX}ttl=Docs&uri=https://docs.example.com/p?x=1`;

    expect(sanitizeRestoreUrl(wrapped, SANITIZE)).toBe('https://docs.example.com/p?x=1');
  });

  it('unwraps verbatim: query with &, +, %XX escapes and a #fragment survive', () => {
    const real = 'https://www.youtube.com/watch?v=abc&list=PL123&q=a+b&p=%2Fusr%2Fbin#t=42';

    expect(sanitizeRestoreUrl(`${SUSPENDED_PREFIX}ttl=YouTube&pos=0&uri=${real}`, SANITIZE)).toBe(
      real,
    );
  });

  it('rejects a wrapper whose uri parameter is empty or relative', () => {
    expect(sanitizeRestoreUrl(`${SUSPENDED_PREFIX}ttl=Docs&uri=`, SANITIZE)).toBeNull();
    expect(sanitizeRestoreUrl(`${SUSPENDED_PREFIX}uri=/foo`, SANITIZE)).toBeNull();
  });

  it('rejects a wrapper whose inner url is not allowed', () => {
    const wrapped = `${SUSPENDED_PREFIX}uri=javascript:alert(1)`;

    expect(sanitizeRestoreUrl(wrapped, SANITIZE)).toBeNull();
  });

  it('rejects a wrapper without a uri parameter', () => {
    expect(sanitizeRestoreUrl(`${SUSPENDED_PREFIX}ttl=Docs`, SANITIZE)).toBeNull();
  });

  it('unwraps any suspender of the family, with no configured id', () => {
    const wrapped = `${OTHER_SUSPENDER_PREFIX}ttl=Docs&pos=0&uri=https://docs.example.com/`;

    expect(sanitizeRestoreUrl(wrapped, SANITIZE)).toBe('https://docs.example.com/');
  });

  it('never unwraps a uri= in the query of an ordinary page', () => {
    const url = 'https://a.com/?uri=https://b.com/';

    expect(sanitizeRestoreUrl(url, SANITIZE)).toBe(url);
  });

  it('rejects a foreign chrome-extension page that is not a suspended page', () => {
    expect(
      sanitizeRestoreUrl(
        'chrome-extension://klbibkeccnjlkjkiokjodocebajanakg/options.html#uri=https://a.com/',
        SANITIZE,
      ),
    ).toBeNull();
  });

  it('opens our own extension pages as they are, never unwrapped', () => {
    const own =
      'chrome-extension://abcdefghijklmnopabcdefghijklmnop/suspended.html#uri=https://a.com/';

    expect(
      sanitizeRestoreUrl(own, { ...SANITIZE, ownExtensionId: 'abcdefghijklmnopabcdefghijklmnop' }),
    ).toBe(own);
  });

  it('does not alter the url text (no normalization)', () => {
    expect(sanitizeRestoreUrl('https://Example.com', SANITIZE)).toBe('https://Example.com');
  });
});

describe('clampToScreen', () => {
  const screen = { availWidth: 1440, availHeight: 900 };

  it('returns bounds unchanged when fully on screen', () => {
    const bounds = { left: 100, top: 50, width: 800, height: 600 };

    expect(clampToScreen(bounds, screen)).toEqual(bounds);
  });

  it('moves a window with negative origin onto the screen and shrinks it', () => {
    expect(clampToScreen({ left: -200, top: -100, width: 800, height: 600 }, screen)).toEqual({
      left: 0,
      top: 0,
      width: 600,
      height: 500,
    });
  });

  it('shrinks a window that overflows the right/bottom edge', () => {
    expect(clampToScreen({ left: 1000, top: 700, width: 800, height: 600 }, screen)).toEqual({
      left: 1000,
      top: 700,
      width: 440,
      height: 200,
    });
  });

  it('passes a sliver of overlap through unchanged rather than dropping the bounds', () => {
    // Only 140px wide / 150px tall of these is on this screen. Dropping the bounds would default-
    // place the window on the primary screen, i.e. punish a window straddling the seam harder
    // than one wholly on another monitor (passed through, below) -- and its own monitor, when
    // attached, still puts it back exactly where it was.
    const sliverRight = { left: 1300, top: 0, width: 800, height: 600 };
    const sliverBottom = { left: 0, top: 750, width: 800, height: 600 };

    expect(clampToScreen(sliverRight, screen)).toEqual(sliverRight);
    expect(clampToScreen(sliverBottom, screen)).toEqual(sliverBottom);
  });

  it('clamps a half-overlapping window but leaves a non-overlapping one alone', () => {
    // Half on this screen: worth clamping, the visible part is well over 200x200.
    expect(clampToScreen({ left: 1040, top: 500, width: 800, height: 600 }, screen)).toEqual({
      left: 1040,
      top: 500,
      width: 400,
      height: 400,
    });
    // No overlap at all: unchanged.
    const elsewhere = { left: 1600, top: 0, width: 800, height: 600 };
    expect(clampToScreen(elsewhere, screen)).toEqual(elsewhere);
  });

  it('returns undefined for a window that is already tiny', () => {
    expect(clampToScreen({ left: 0, top: 0, width: 199, height: 600 }, screen)).toBeUndefined();
    expect(clampToScreen({ left: 5000, top: 0, width: 800, height: 100 }, screen)).toBeUndefined();
  });

  it('passes bounds through unchanged when they do not touch this screen (another monitor)', () => {
    const right = { left: 2000, top: 0, width: 800, height: 600 };
    const leftOf = { left: -1000, top: 100, width: 800, height: 600 };
    const above = { left: 100, top: -700, width: 800, height: 600 };
    const below = { left: 100, top: 900, width: 800, height: 600 };

    expect(clampToScreen(right, screen)).toEqual(right);
    expect(clampToScreen(leftOf, screen)).toEqual(leftOf);
    expect(clampToScreen(above, screen)).toEqual(above);
    expect(clampToScreen(below, screen)).toEqual(below);
  });

  it('treats a window touching the edge without overlapping as off-screen', () => {
    const bounds = { left: 1440, top: 0, width: 800, height: 600 };

    expect(clampToScreen(bounds, screen)).toEqual(bounds);
  });

  it('clamps into a screen whose origin is offset by availLeft/availTop', () => {
    // Secondary monitor to the right of a 1440-wide primary, with a 30px top bar.
    const secondary = { availLeft: 1440, availTop: 30, availWidth: 1920, availHeight: 1050 };

    const inside = { left: 1500, top: 100, width: 800, height: 600 };
    expect(clampToScreen(inside, secondary)).toEqual(inside);
    expect(clampToScreen({ left: 1000, top: 0, width: 800, height: 600 }, secondary)).toEqual({
      left: 1440,
      top: 30,
      width: 360,
      height: 570,
    });
    expect(clampToScreen({ left: 3000, top: 100, width: 800, height: 600 }, secondary)).toEqual({
      left: 3000,
      top: 100,
      width: 360,
      height: 600,
    });
    // Entirely on the primary: not this screen, so untouched.
    const primary = { left: 100, top: 100, width: 800, height: 600 };
    expect(clampToScreen(primary, secondary)).toEqual(primary);
  });
});

describe('screenRectOf', () => {
  it('copies availLeft/availTop when Chrome exposes them, and omits them otherwise', () => {
    const chromeScreen = { availLeft: 1440, availTop: 30, availWidth: 1920, availHeight: 1050 };
    const plainScreen = { availWidth: 1440, availHeight: 900 };
    const bogusScreen = { availLeft: 'x', availWidth: 1440, availHeight: 900 };

    expect(screenRectOf(chromeScreen)).toEqual({
      availLeft: 1440,
      availTop: 30,
      availWidth: 1920,
      availHeight: 1050,
    });
    expect(screenRectOf(plainScreen)).toEqual({ availWidth: 1440, availHeight: 900 });
    expect(screenRectOf(bogusScreen)).toEqual({ availWidth: 1440, availHeight: 900 });
  });
});

describe('isLazyRestore', () => {
  it("mirrors the planner: 'always' is lazy, 'never' is not, 'auto' is lazy above 10 tabs", () => {
    expect(isLazyRestore('always', 1)).toBe(true);
    expect(isLazyRestore('never', 500)).toBe(false);
    expect(isLazyRestore('auto', LAZY_AUTO_THRESHOLD)).toBe(false);
    expect(isLazyRestore('auto', LAZY_AUTO_THRESHOLD + 1)).toBe(true);
  });
});

describe('planRestore', () => {
  it('copies url, pinned, active and groupIndex into planned tabs', () => {
    const plan = planRestore(
      session([
        win(
          [
            tab({ url: 'https://a.com/', pinned: true }),
            tab({ url: 'https://b.com/', active: true, groupIndex: 0 }),
            tab({ url: 'https://c.com/' }),
          ],
          { groups: [{ title: 'G', color: 'blue', collapsed: false }] },
        ),
      ]),
      options(),
    );

    expect(plan.target).toEqual({ kind: 'newWindows' });
    expect(plan.windows).toHaveLength(1);
    expect(plan.windows[0].tabs).toEqual([
      { url: 'https://a.com/', pinned: true, active: false },
      { url: 'https://b.com/', pinned: false, active: true, groupIndex: 0 },
      { url: 'https://c.com/', pinned: false, active: false },
    ]);
    expect(plan.windows[0].snapshot.groups[0].title).toBe('G');
    expect(plan.totalTabs).toBe(3);
    expect(plan.skipped).toEqual([]);
  });

  it('keeps the window target', () => {
    const plan = planRestore(
      session([win(urls(1))]),
      options({ target: { kind: 'window', windowId: 7 } }),
    );

    expect(plan.target).toEqual({ kind: 'window', windowId: 7 });
  });

  it('puts 25 tabs in a single chunk', () => {
    const plan = planRestore(session([win(urls(25))]), options());

    expect(plan.windows[0].chunks.map((c) => c.length)).toEqual([25]);
  });

  it('splits 26 tabs into chunks of 25 and 1', () => {
    const plan = planRestore(session([win(urls(26))]), options());

    expect(plan.windows[0].chunks.map((c) => c.length)).toEqual([25, 1]);
    expect(plan.windows[0].chunks.flat()).toEqual(plan.windows[0].tabs);
  });

  it('honours a custom chunkSize', () => {
    const plan = planRestore(session([win(urls(5))]), options({ chunkSize: 2 }));

    expect(plan.windows[0].chunks.map((c) => c.length)).toEqual([2, 2, 1]);
  });

  it('chunks per window, not across windows', () => {
    const plan = planRestore(session([win(urls(30)), win(urls(3))]), options());

    expect(plan.windows[0].chunks.map((c) => c.length)).toEqual([25, 5]);
    expect(plan.windows[1].chunks.map((c) => c.length)).toEqual([3]);
    expect(plan.totalTabs).toBe(33);
  });

  it('moves pinned tabs first, keeping relative order otherwise', () => {
    const plan = planRestore(
      session([
        win([
          tab({ url: 'https://u1.com/' }),
          tab({ url: 'https://p1.com/', pinned: true }),
          tab({ url: 'https://u2.com/' }),
          tab({ url: 'https://p2.com/', pinned: true }),
        ]),
      ]),
      options(),
    );

    expect(plan.windows[0].tabs.map((t) => t.url)).toEqual([
      'https://p1.com/',
      'https://p2.com/',
      'https://u1.com/',
      'https://u2.com/',
    ]);
  });

  it("lazy 'auto' is false at exactly 10 tabs and true at 11", () => {
    expect(planRestore(session([win(urls(10))]), options({ lazy: 'auto' })).windows[0].lazy).toBe(
      false,
    );
    expect(planRestore(session([win(urls(11))]), options({ lazy: 'auto' })).windows[0].lazy).toBe(
      true,
    );
  });

  it("lazy 'auto' counts tabs across all windows", () => {
    const plan = planRestore(session([win(urls(30)), win(urls(21))]), options({ lazy: 'auto' }));

    expect(plan.windows.map((w) => w.lazy)).toEqual([true, true]);
  });

  it("lazy 'auto' counts only tabs that survive sanitize", () => {
    const tabs = [...urls(10), tab({ url: 'javascript:alert(1)' })];

    expect(planRestore(session([win(tabs)]), options({ lazy: 'auto' })).windows[0].lazy).toBe(
      false,
    );
  });

  it("lazy 'always' is true even for one tab, 'never' is false even for many", () => {
    expect(planRestore(session([win(urls(1))]), options({ lazy: 'always' })).windows[0].lazy).toBe(
      true,
    );
    expect(planRestore(session([win(urls(200))]), options({ lazy: 'never' })).windows[0].lazy).toBe(
      false,
    );
  });

  it('collects skipped urls and keeps the remaining tabs', () => {
    const plan = planRestore(
      session([
        win(
          [
            tab({ url: 'https://ok.com/' }),
            tab({ url: 'javascript:alert(1)' }),
            tab({ url: 'file:///secret.html' }),
            tab({ url: 'chrome-extension://otherid/x.html', groupIndex: 0 }),
          ],
          { groups: [{ title: 'G', color: 'red', collapsed: true }] },
        ),
      ]),
      options(),
    );

    expect(plan.skipped).toEqual([
      'javascript:alert(1)',
      'file:///secret.html',
      'chrome-extension://otherid/x.html',
    ]);
    expect(plan.windows[0].tabs.map((t) => t.url)).toEqual(['https://ok.com/']);
    expect(plan.totalTabs).toBe(1);
  });

  it('records the unwrapped url for suspended tabs', () => {
    const plan = planRestore(
      session([win([tab({ url: `${SUSPENDED_PREFIX}uri=https://real.com/` })])]),
      options(),
    );

    expect(plan.windows[0].tabs[0].url).toBe('https://real.com/');
  });

  it('omits a window whose tabs were all skipped but still reports them', () => {
    const plan = planRestore(
      session([win([tab({ url: 'data:text/plain,x' })]), win([tab({ url: 'https://ok.com/' })])]),
      options(),
    );

    expect(plan.windows).toHaveLength(1);
    expect(plan.windows[0].tabs[0].url).toBe('https://ok.com/');
    expect(plan.skipped).toEqual(['data:text/plain,x']);
  });

  it('returns an empty plan for a session with no restorable tabs', () => {
    const plan = planRestore(session([win([tab({ url: 'javascript:void(0)' })])]), options());

    expect(plan.windows).toEqual([]);
    expect(plan.totalTabs).toBe(0);
    expect(plan.skipped).toEqual(['javascript:void(0)']);
  });

  it('throws when a window has more than one active tab', () => {
    const broken = session([
      win([tab({ active: true }), tab({ url: 'https://b.com/', active: true })]),
    ]);

    expect(() => planRestore(broken, options())).toThrow(
      'Invariant violated: more than one active tab',
    );
  });

  it('throws when a pinned tab carries a groupIndex', () => {
    const broken = session([
      win([tab({ pinned: true, groupIndex: 0 })], {
        groups: [{ title: 'G', color: 'blue', collapsed: false }],
      }),
    ]);

    expect(() => planRestore(broken, options())).toThrow(
      'Invariant violated: pinned tab has groupIndex',
    );
  });

  it('throws when a groupIndex points outside the groups array', () => {
    const broken = session([win([tab({ groupIndex: 3 })])]);

    expect(() => planRestore(broken, options())).toThrow(
      'Invariant violated: groupIndex out of range',
    );
  });

  it('does not mutate the session', () => {
    const input = session([
      win([tab({ url: 'https://u.com/' }), tab({ url: 'https://p.com/', pinned: true })]),
    ]);
    const before = JSON.stringify(input);

    planRestore(input, options());

    expect(JSON.stringify(input)).toBe(before);
  });
});

/** 1 pinned, group "Work" (blue, open) with 2 tabs, group "News" (red, collapsed) with 1 tab, 1 loose. */
const WINDOW_A: WindowSnapshot = {
  state: 'normal',
  focused: true,
  bounds: { left: 10, top: 20, width: 800, height: 600 },
  groups: [
    { title: 'Work', color: 'blue', collapsed: false },
    { title: 'News', color: 'red', collapsed: true },
  ],
  tabs: [
    { url: 'https://pinned.example/', title: 'Pinned', pinned: true, active: false },
    { url: 'https://work.example/a', title: 'A', pinned: false, active: false, groupIndex: 0 },
    { url: 'https://work.example/b', title: 'B', pinned: false, active: true, groupIndex: 0 },
    { url: 'https://news.example/', title: 'News', pinned: false, active: false, groupIndex: 1 },
    { url: 'https://loose.example/', title: 'Loose', pinned: false, active: false },
  ],
};

/**
 * The reference fixture: 2 pinned, 2 groups one collapsed, a suspended tab and one `file://`
 * tab. The suspended tab must come back as the page it wraps,
 * and the `file://` tab is the one skip (`fileAccessAllowed: false` in SANITIZE).
 */
const REFERENCE_WINDOW: WindowSnapshot = {
  state: 'normal',
  focused: true,
  groups: [
    { title: 'Work', color: 'blue', collapsed: false },
    { title: 'Reading', color: 'yellow', collapsed: true },
  ],
  tabs: [
    { url: 'https://pin-1.example/', title: 'Pin 1', pinned: true, active: false },
    { url: 'https://pin-2.example/', title: 'Pin 2', pinned: true, active: false },
    { url: 'https://work.example/a', title: 'Work A', pinned: false, active: true, groupIndex: 0 },
    {
      // Saved by the suspender, so the stored url is the wrapper; the restore opens the real page.
      url: `${SUSPENDED_PREFIX}ttl=Suspended&uri=https://work.example/b`,
      title: 'Work B (suspended)',
      pinned: false,
      active: false,
      groupIndex: 0,
    },
    {
      url: 'https://reading.example/',
      title: 'Reading',
      pinned: false,
      active: false,
      groupIndex: 1,
    },
    { url: 'file:///home/user/notes.html', title: 'Notes', pinned: false, active: false },
  ],
};

const WINDOW_B: WindowSnapshot = {
  state: 'normal',
  focused: false,
  groups: [],
  tabs: [
    { url: 'https://b1.example/', title: 'B1', pinned: false, active: true },
    { url: 'https://b2.example/', title: 'B2', pinned: false, active: false },
  ],
};

const WINDOW_MINIMIZED: WindowSnapshot = {
  state: 'minimized',
  focused: false,
  groups: [],
  tabs: [{ url: 'https://min.example/', title: 'Min', pinned: false, active: true }],
};

const WINDOW_FULLSCREEN: WindowSnapshot = {
  state: 'fullscreen',
  focused: false,
  groups: [],
  tabs: [{ url: 'https://full.example/', title: 'Full', pinned: false, active: true }],
};

const WINDOW_MAXIMIZED: WindowSnapshot = {
  state: 'maximized',
  focused: false,
  groups: [],
  tabs: [{ url: 'https://max.example/', title: 'Max', pinned: false, active: true }],
};

function makeSession(windows: WindowSnapshot[]): Session {
  return {
    schemaVersion: 1,
    id: '11111111-1111-4111-8111-111111111111',
    kind: 'saved',
    name: 'Fixture',
    origin: 'manual',
    createdAt: 1_700_000_000_000,
    updatedAt: 1_700_000_000_000,
    windows,
  };
}

function makePlan(windows: WindowSnapshot[], overrides: Partial<RestoreOptions> = {}): RestorePlan {
  return planRestore(makeSession(windows), {
    target: { kind: 'newWindows' },
    lazy: 'never',
    chunkSize: 25,
    sanitize: SANITIZE,
    ...overrides,
  });
}

interface StripRow {
  url: string;
  pinned: boolean;
  active: boolean;
  group: string | null;
}

/** The tab strip of `windowId` in index order, with the group title resolved. */
function stripOf(windowId: number): StripRow[] {
  const fake = getChromeFake();
  return [...fake.state.tabs.values()]
    .filter((tab) => tab.windowId === windowId)
    .sort((a, b) => a.index - b.index)
    .map((tab) => {
      const group = tab.groupId === -1 ? undefined : fake.state.groups.get(tab.groupId);
      return { url: tab.url, pinned: tab.pinned, active: tab.active, group: group?.title ?? null };
    });
}

function newWindowIds(before: Set<number>): number[] {
  return [...getChromeFake().state.windows.keys()].filter((id) => !before.has(id));
}

function snapshotWindowIds(): Set<number> {
  return new Set(getChromeFake().state.windows.keys());
}

describe('isTabsCannotBeEditedError', () => {
  it('matches the Chrome drag-lock message, case-insensitively', () => {
    expect(
      isTabsCannotBeEditedError(
        new Error('Tabs cannot be edited right now (user may be dragging a tab).'),
      ),
    ).toBe(true);
    expect(isTabsCannotBeEditedError('tabs CANNOT BE EDITED')).toBe(true);
    expect(isTabsCannotBeEditedError(new Error('No window with id: 9'))).toBe(false);
    expect(isTabsCannotBeEditedError(undefined)).toBe(false);
  });
});

describe('withRetryOnce', () => {
  it('retries exactly once when shouldRetry says so', async () => {
    let calls = 0;
    const result = await withRetryOnce(
      async () => {
        calls += 1;
        if (calls === 1) {
          throw new Error('cannot be edited');
        }
        return 'ok';
      },
      () => true,
    );
    expect(result).toBe('ok');
    expect(calls).toBe(2);
  });

  it('does not retry when shouldRetry returns false', async () => {
    let calls = 0;
    await expect(
      withRetryOnce(
        async () => {
          calls += 1;
          throw new Error('fatal');
        },
        () => false,
      ),
    ).rejects.toThrow('fatal');
    expect(calls).toBe(1);
  });

  it('rethrows the second failure', async () => {
    let calls = 0;
    await expect(
      withRetryOnce(
        async () => {
          calls += 1;
          throw new Error(`fail ${calls}`);
        },
        () => true,
      ),
    ).rejects.toThrow('fail 2');
  });
});

describe('executeRestore', () => {
  it('recreates the tab strip: order, pinned, groups (title/colour/collapsed) and active tab', async () => {
    const before = snapshotWindowIds();
    const result = await executeRestore(makePlan([WINDOW_A]));

    const created = newWindowIds(before);
    expect(created).toHaveLength(1);
    const windowId = created[0];

    expect(stripOf(windowId)).toEqual([
      { url: 'https://pinned.example/', pinned: true, active: false, group: null },
      { url: 'https://work.example/a', pinned: false, active: false, group: 'Work' },
      { url: 'https://work.example/b', pinned: false, active: true, group: 'Work' },
      { url: 'https://news.example/', pinned: false, active: false, group: 'News' },
      { url: 'https://loose.example/', pinned: false, active: false, group: null },
    ]);

    const groups = [...getChromeFake().state.groups.values()]
      .filter((group) => group.windowId === windowId)
      .map(({ title, color, collapsed }) => ({ title, color, collapsed }));
    expect(groups).toEqual([
      { title: 'Work', color: 'blue', collapsed: false },
      { title: 'News', color: 'red', collapsed: true },
    ]);

    expect(result).toEqual({ restored: 5, discarded: 0, skipped: [], errors: [] });
  });

  it('recreates the reference fixture and reports 1 skipped', async () => {
    // A restore of the fixture recreates order/pinned/groups/collapsed/active and reports the
    // file:// tab as skipped. The pieces have their own tests; this is the fixture as written.
    const before = snapshotWindowIds();

    const result = await executeRestore(makePlan([REFERENCE_WINDOW]));

    const created = newWindowIds(before);
    expect(created).toHaveLength(1);
    const windowId = created[0];

    expect(stripOf(windowId)).toEqual([
      { url: 'https://pin-1.example/', pinned: true, active: false, group: null },
      { url: 'https://pin-2.example/', pinned: true, active: false, group: null },
      { url: 'https://work.example/a', pinned: false, active: true, group: 'Work' },
      // Unwrapped: the suspender's wrapper never comes back.
      { url: 'https://work.example/b', pinned: false, active: false, group: 'Work' },
      { url: 'https://reading.example/', pinned: false, active: false, group: 'Reading' },
    ]);

    const groups = [...getChromeFake().state.groups.values()]
      .filter((group) => group.windowId === windowId)
      .map(({ title, color, collapsed }) => ({ title, color, collapsed }));
    expect(groups).toEqual([
      { title: 'Work', color: 'blue', collapsed: false },
      { title: 'Reading', color: 'yellow', collapsed: true },
    ]);

    expect(result).toEqual({
      restored: 5,
      discarded: 0,
      skipped: ['file:///home/user/notes.html'],
      errors: [],
    });
    expect(getChromeFake().state.windows.get(windowId)?.focused).toBe(true);
  });

  it('applies clamped bounds for normal windows and focuses the snapshot-focused window last', async () => {
    const before = snapshotWindowIds();
    await executeRestore(makePlan([WINDOW_B, WINDOW_A]), {
      screen: { availWidth: 500, availHeight: 400 },
    });
    const [winB, winA] = newWindowIds(before);
    const fake = getChromeFake();
    const a = fake.state.windows.get(winA);
    const b = fake.state.windows.get(winB);
    expect(a?.focused).toBe(true);
    expect(b?.focused).toBe(false);
    expect({ left: a?.left, top: a?.top, width: a?.width, height: a?.height }).toEqual({
      left: 10,
      top: 20,
      width: 490,
      height: 380,
    });
  });

  it('never focuses a restored minimized window (focusing it would un-minimize it)', async () => {
    const updateSpy = vi.spyOn(chrome.windows, 'update');

    await executeRestore(makePlan([WINDOW_MINIMIZED]));

    // No window of the session is focusable, so the focus call is skipped altogether and the
    // window the user was on keeps the focus.
    expect(updateSpy.mock.calls.filter(([, info]) => info.focused === true)).toEqual([]);
    vi.restoreAllMocks();
  });

  it('falls back to the last non-minimized window when no snapshot was focused', async () => {
    const updateSpy = vi.spyOn(chrome.windows, 'update');

    const before = snapshotWindowIds();
    await executeRestore(makePlan([WINDOW_B, WINDOW_MINIMIZED]));
    const [winB] = newWindowIds(before);

    const focusCalls = updateSpy.mock.calls.filter(([, info]) => info.focused === true);
    expect(focusCalls.map(([id]) => id)).toEqual([winB]);
    vi.restoreAllMocks();
  });

  it('still focuses the snapshot-focused window when a minimized one is restored after it', async () => {
    const updateSpy = vi.spyOn(chrome.windows, 'update');

    const before = snapshotWindowIds();
    await executeRestore(makePlan([WINDOW_A, WINDOW_MINIMIZED]));
    const [winA] = newWindowIds(before);

    const focusCalls = updateSpy.mock.calls.filter(([, info]) => info.focused === true);
    expect(focusCalls.map(([id]) => id)).toEqual([winA]);
    vi.restoreAllMocks();
  });

  it('removes the about:blank placeholder after activating the session tab', async () => {
    const updateSpy = vi.spyOn(chrome.tabs, 'update');
    const removeSpy = vi.spyOn(chrome.tabs, 'remove');

    const before = snapshotWindowIds();
    await executeRestore(makePlan([WINDOW_A]));
    const [windowId] = newWindowIds(before);

    expect(updateSpy).toHaveBeenCalledTimes(1);
    expect(removeSpy).toHaveBeenCalledTimes(1);
    expect(updateSpy.mock.invocationCallOrder[0]).toBeLessThan(
      removeSpy.mock.invocationCallOrder[0],
    );
    expect(stripOf(windowId).some((row) => row.url === 'about:blank')).toBe(false);
    vi.restoreAllMocks();
  });

  it('orders: all creates before grouping, style before collapse, placeholder removed last', async () => {
    const createSpy = vi.spyOn(chrome.tabs, 'create');
    const groupSpy = vi.spyOn(chrome.tabs, 'group');
    const groupUpdateSpy = vi.spyOn(chrome.tabGroups, 'update');
    const removeSpy = vi.spyOn(chrome.tabs, 'remove');

    await executeRestore(makePlan([WINDOW_A]));

    const createOrder = createSpy.mock.invocationCallOrder;
    const groupOrder = groupSpy.mock.invocationCallOrder;
    expect(createOrder).toHaveLength(5);
    expect(groupOrder).toHaveLength(2);
    // Group after all tabs: every tabs.create precedes the first tabs.group.
    expect(Math.max(...createOrder)).toBeLessThan(Math.min(...groupOrder));

    const updates = groupUpdateSpy.mock.calls.map((args, i) => ({
      props: args[1],
      order: groupUpdateSpy.mock.invocationCallOrder[i],
    }));
    const styleCalls = updates.filter(({ props }) => props.title !== undefined);
    const collapseCalls = updates.filter(
      ({ props }) => props.collapsed !== undefined && props.title === undefined,
    );
    expect(styleCalls).toHaveLength(2);
    expect(collapseCalls).toHaveLength(2);
    // Each tabs.group precedes its own tabGroups.update({ title, color }).
    for (let i = 0; i < groupOrder.length; i++) {
      expect(groupOrder[i]).toBeLessThan(styleCalls[i].order);
    }
    // Collapse after grouping, and the placeholder is removed last.
    const lastStyle = Math.max(...styleCalls.map((call) => call.order));
    const removeOrder = removeSpy.mock.invocationCallOrder[0];
    for (const call of collapseCalls) {
      expect(call.order).toBeGreaterThan(lastStyle);
      expect(call.order).toBeLessThan(removeOrder);
    }
    vi.restoreAllMocks();
  });

  it('reports every tab of a window whose windows.create fails and keeps restoring', async () => {
    const fake = getChromeFake();
    fake.failNext('windows.create', 1, 'Invalid value for bounds');
    const progress: [number, number][] = [];
    const before = snapshotWindowIds();

    const result = await executeRestore(makePlan([WINDOW_B, WINDOW_A]), {
      onProgress: (done, total) => {
        progress.push([done, total]);
      },
    });

    // WINDOW_B (no bounds) fails outright; WINDOW_A is still restored in full.
    expect(newWindowIds(before)).toHaveLength(1);
    expect(result.restored).toBe(5);
    expect(result.errors).toEqual([
      { url: 'https://b1.example/', message: 'Invalid value for bounds' },
      { url: 'https://b2.example/', message: 'Invalid value for bounds' },
    ]);
    expect(progress).toEqual([
      [2, 7],
      [7, 7],
    ]);
  });

  it('retries windows.create without bounds when Chrome rejects the bounds', async () => {
    const fake = getChromeFake();
    fake.failNext('windows.create', 1, 'Invalid value for bounds');
    const createSpy = vi.spyOn(chrome.windows, 'create');
    const before = snapshotWindowIds();

    const result = await executeRestore(makePlan([WINDOW_A]), {
      screen: { availWidth: 1920, availHeight: 1080 },
    });

    expect(result.errors).toEqual([]);
    expect(result.restored).toBe(5);
    expect(createSpy).toHaveBeenCalledTimes(2);
    const [windowId] = newWindowIds(before);
    const win = fake.state.windows.get(windowId);
    // The retry carries no left/top/width/height: the fake falls back to its defaults (0, 0).
    expect({ left: win?.left, top: win?.top }).toEqual({ left: 0, top: 0 });
    vi.restoreAllMocks();
  });

  it('uses the tab ids returned by tabs.discard when grouping lazily restored windows', async () => {
    const fake = getChromeFake();
    // Some Chrome versions replace the discarded tab (new id); the returned Tab is the live one.
    const discardWithNewId = async (tabId?: number): Promise<chrome.tabs.Tab | undefined> => {
      if (tabId === undefined) {
        return undefined;
      }
      const old = fake.state.tabs.get(tabId);
      if (old === undefined) {
        throw new Error(`No tab with id: ${tabId}`);
      }
      const replacement = { ...old, id: fake.state.nextId.tab, discarded: true };
      fake.state.nextId.tab += 1;
      fake.state.tabs.delete(tabId);
      fake.state.tabs.set(replacement.id, replacement);
      return chrome.tabs.get(replacement.id);
    };
    vi.spyOn(chrome.tabs, 'discard').mockImplementation(discardWithNewId);
    const before = snapshotWindowIds();

    const result = await executeRestore(makePlan([WINDOW_A], { lazy: 'always' }));
    const [windowId] = newWindowIds(before);

    expect(result.errors).toEqual([]);
    expect(stripOf(windowId).map((row) => [row.url, row.group])).toEqual([
      ['https://pinned.example/', null],
      ['https://work.example/a', 'Work'],
      ['https://work.example/b', 'Work'],
      ['https://news.example/', 'News'],
      ['https://loose.example/', null],
    ]);
    vi.restoreAllMocks();
  });

  it('keeps going when one tabs.create fails and reports the error', async () => {
    const fake = getChromeFake();
    // The placeholder window is created by windows.create, so the first tabs.create is the pinned tab.
    fake.failNext('tabs.create', 1, 'No window with id: 999');

    const before = snapshotWindowIds();
    const result = await executeRestore(makePlan([WINDOW_A]));
    const [windowId] = newWindowIds(before);

    expect(result.restored).toBe(4);
    expect(result.errors).toEqual([
      { url: 'https://pinned.example/', message: 'No window with id: 999' },
    ]);
    expect(stripOf(windowId).map((row) => row.url)).toEqual([
      'https://work.example/a',
      'https://work.example/b',
      'https://news.example/',
      'https://loose.example/',
    ]);
  });

  it('retries once on "Tabs cannot be edited right now"', async () => {
    const fake = getChromeFake();
    fake.failNext(
      'tabs.create',
      1,
      'Tabs cannot be edited right now (user may be dragging a tab).',
    );
    const createSpy = vi.spyOn(chrome.tabs, 'create');

    const result = await executeRestore(makePlan([WINDOW_B]));

    expect(result.errors).toEqual([]);
    expect(result.restored).toBe(2);
    // 2 tabs + 1 retry
    expect(createSpy).toHaveBeenCalledTimes(3);
    vi.restoreAllMocks();
  });

  it('never discards the active or pinned tab in lazy mode, and reports the discarded count', async () => {
    const discardSpy = vi.spyOn(chrome.tabs, 'discard');
    const before = snapshotWindowIds();

    const result = await executeRestore(makePlan([WINDOW_A], { lazy: 'always' }));
    const [windowId] = newWindowIds(before);
    const fake = getChromeFake();

    expect(result.discarded).toBe(3);

    const discardedUrls = [...fake.state.tabs.values()]
      .filter((tab) => tab.windowId === windowId && tab.discarded)
      .map((tab) => tab.url)
      .sort();
    expect(discardedUrls).toEqual([
      'https://loose.example/',
      'https://news.example/',
      'https://work.example/a',
    ]);

    const discardedIds = discardSpy.mock.calls.map(([id]) => id);
    const forbidden = [...fake.state.tabs.values()]
      .filter((tab) => tab.windowId === windowId && (tab.pinned || tab.active))
      .map((tab) => tab.id);
    for (const id of forbidden) {
      expect(discardedIds).not.toContain(id);
    }
    vi.restoreAllMocks();
  });

  it('stops between chunks when the signal aborts, keeping already created tabs', async () => {
    const controller = new AbortController();
    const progress: [number, number][] = [];
    const before = snapshotWindowIds();

    const result = await executeRestore(makePlan([WINDOW_A, WINDOW_B], { chunkSize: 2 }), {
      signal: controller.signal,
      onProgress: (done, total) => {
        progress.push([done, total]);
        if (done === 2) {
          controller.abort();
        }
      },
    });

    const created = newWindowIds(before);
    expect(created).toHaveLength(1);
    const strip = stripOf(created[0]);
    expect(strip.map((row) => row.url)).toEqual([
      'https://pinned.example/',
      'https://work.example/a',
    ]);
    expect(strip.some((row) => row.url === 'about:blank')).toBe(false);
    expect(progress).toEqual([[2, 7]]);
    expect(result.restored).toBe(2);
  });

  it('retries tabs.group once on "Tabs cannot be edited right now"', async () => {
    const fake = getChromeFake();
    fake.failNext('tabs.group', 1, 'Tabs cannot be edited right now');
    const groupSpy = vi.spyOn(chrome.tabs, 'group');
    const before = snapshotWindowIds();

    const result = await executeRestore(makePlan([WINDOW_A]));
    const [windowId] = newWindowIds(before);

    expect(result.errors).toEqual([]);
    expect(result.restored).toBe(5);
    // 2 groups + 1 retry
    expect(groupSpy).toHaveBeenCalledTimes(3);
    const groups = [...fake.state.groups.values()]
      .filter((group) => group.windowId === windowId)
      .map(({ title, color, collapsed }) => ({ title, color, collapsed }));
    expect(groups).toEqual([
      { title: 'Work', color: 'blue', collapsed: false },
      { title: 'News', color: 'red', collapsed: true },
    ]);
    vi.restoreAllMocks();
  });

  it('reports a group whose tabs.group rejects twice, without losing the other group, the created tabs, or the placeholder cleanup', async () => {
    const fake = getChromeFake();
    fake.failNext('tabs.group', 2, 'Tabs cannot be edited right now');
    const removeSpy = vi.spyOn(chrome.tabs, 'remove');
    const before = snapshotWindowIds();

    const result = await executeRestore(makePlan([WINDOW_A]));
    const [windowId] = newWindowIds(before);

    // 'Work' (grouped first) exhausts both injected failures; 'News' groups normally afterwards.
    expect(result.errors).toEqual([
      { url: 'group:Work', message: 'Tabs cannot be edited right now' },
    ]);
    expect(result.restored).toBe(5);
    const groups = [...fake.state.groups.values()]
      .filter((group) => group.windowId === windowId)
      .map(({ title, color, collapsed }) => ({ title, color, collapsed }));
    expect(groups).toEqual([{ title: 'News', color: 'red', collapsed: true }]);
    // The tabs that were meant for 'Work' still exist, just ungrouped.
    const workRows = stripOf(windowId).filter((row) => row.url.startsWith('https://work.example/'));
    expect(workRows.every((row) => row.group === null)).toBe(true);
    expect(removeSpy).toHaveBeenCalledTimes(1);
    vi.restoreAllMocks();
  });

  it('restores into an existing window: no placeholder, existing active tab stays active, no window state change', async () => {
    const fake = getChromeFake();
    const [existingWindowId] = [...fake.state.windows.keys()];
    await chrome.tabs.create({
      windowId: existingWindowId,
      url: 'https://existing.example/',
      active: true,
    });
    const removeSpy = vi.spyOn(chrome.tabs, 'remove');
    const updateWindowSpy = vi.spyOn(chrome.windows, 'update');
    const before = snapshotWindowIds();

    const result = await executeRestore(
      makePlan([WINDOW_A], { target: { kind: 'window', windowId: existingWindowId } }),
    );

    expect(newWindowIds(before)).toHaveLength(0);
    expect(result.errors).toEqual([]);
    expect(result.restored).toBe(5);
    expect(removeSpy).not.toHaveBeenCalled();
    // Chrome's pinned-first invariant puts the newly-created pinned tab ahead of the pre-existing
    // unpinned tab; the rest of the restored tabs are appended after it, in snapshot order.
    expect(stripOf(existingWindowId).map((row) => row.url)).toEqual([
      'https://pinned.example/',
      'https://existing.example/',
      'https://work.example/a',
      'https://work.example/b',
      'https://news.example/',
      'https://loose.example/',
    ]);
    const existingRow = stripOf(existingWindowId).find(
      (row) => row.url === 'https://existing.example/',
    );
    expect(existingRow?.active).toBe(true);
    const stateCalls = updateWindowSpy.mock.calls.filter(([, info]) => info.state !== undefined);
    expect(stateCalls).toEqual([]);
    vi.restoreAllMocks();
  });

  it('restores into an existing window: groups recreated, nothing focused, no placeholder', async () => {
    const fake = getChromeFake();
    const [existingWindowId] = [...fake.state.windows.keys()];
    await chrome.tabs.create({
      windowId: existingWindowId,
      url: 'https://existing.example/',
      active: true,
    });
    const other = await chrome.windows.create({ url: 'https://other.example/', focused: true });
    const updateWindowSpy = vi.spyOn(chrome.windows, 'update');

    const result = await executeRestore(
      makePlan([WINDOW_A], { target: { kind: 'window', windowId: existingWindowId } }),
    );

    expect(result.errors).toEqual([]);
    // The snapshot's groups are recreated fresh in the target window, styled and collapsed.
    const groups = [...fake.state.groups.values()].filter(
      (group) => group.windowId === existingWindowId,
    );
    expect(groups.map((group) => [group.title, group.color, group.collapsed])).toEqual([
      ['Work', 'blue', false],
      ['News', 'red', true],
    ]);
    expect(stripOf(existingWindowId).map((row) => [row.url, row.pinned, row.group])).toEqual([
      ['https://pinned.example/', true, null],
      ['https://existing.example/', false, null],
      ['https://work.example/a', false, 'Work'],
      ['https://work.example/b', false, 'Work'],
      ['https://news.example/', false, 'News'],
      ['https://loose.example/', false, null],
    ]);
    // WINDOW_A is `focused: true`, but a restore into an existing window never steals focus.
    expect(updateWindowSpy.mock.calls.filter(([, info]) => info.focused !== undefined)).toEqual([]);
    expect(fake.state.windows.get(other?.id ?? -1)?.focused).toBe(true);
    vi.restoreAllMocks();
  });

  it('appends every window of a multi-window session into the one target window', async () => {
    const fake = getChromeFake();
    const [existingWindowId] = [...fake.state.windows.keys()];
    const before = snapshotWindowIds();

    const result = await executeRestore(
      makePlan([WINDOW_B, WINDOW_A], { target: { kind: 'window', windowId: existingWindowId } }),
    );

    expect(newWindowIds(before)).toHaveLength(0);
    expect(result.restored).toBe(7);
    expect(stripOf(existingWindowId).map((row) => row.url)).toEqual([
      'https://pinned.example/',
      'https://b1.example/',
      'https://b2.example/',
      'https://work.example/a',
      'https://work.example/b',
      'https://news.example/',
      'https://loose.example/',
    ]);
    // Each snapshot window keeps its own groups even when they land in one browser window.
    expect([...fake.state.groups.values()].map((group) => group.title).sort()).toEqual([
      'News',
      'Work',
    ]);
  });

  it('restores a window spanning multiple chunks in full, with cumulative progress and correct groups', async () => {
    const progress: [number, number][] = [];
    const before = snapshotWindowIds();

    const result = await executeRestore(makePlan([WINDOW_A], { chunkSize: 2 }), {
      onProgress: (done, total) => {
        progress.push([done, total]);
      },
    });
    const [windowId] = newWindowIds(before);

    expect(result.errors).toEqual([]);
    expect(result.restored).toBe(5);
    expect(progress).toEqual([
      [2, 5],
      [4, 5],
      [5, 5],
    ]);
    expect(stripOf(windowId)).toEqual([
      { url: 'https://pinned.example/', pinned: true, active: false, group: null },
      { url: 'https://work.example/a', pinned: false, active: false, group: 'Work' },
      { url: 'https://work.example/b', pinned: false, active: true, group: 'Work' },
      { url: 'https://news.example/', pinned: false, active: false, group: 'News' },
      { url: 'https://loose.example/', pinned: false, active: false, group: null },
    ]);
    const groups = [...getChromeFake().state.groups.values()]
      .filter((group) => group.windowId === windowId)
      .map(({ title, color, collapsed }) => ({ title, color, collapsed }));
    expect(groups).toEqual([
      { title: 'Work', color: 'blue', collapsed: false },
      { title: 'News', color: 'red', collapsed: true },
    ]);
  });

  it('creates a minimized window as normal, then minimizes it after the tabs exist', async () => {
    const createSpy = vi.spyOn(chrome.windows, 'create');
    const updateSpy = vi.spyOn(chrome.windows, 'update');

    const result = await executeRestore(makePlan([WINDOW_MINIMIZED]));

    expect(result.errors).toEqual([]);
    expect(createSpy.mock.calls[0]?.[0]?.state).toBe('normal');
    const stateCalls = updateSpy.mock.calls.filter(([, info]) => info.state !== undefined);
    expect(stateCalls).toHaveLength(1);
    expect(stateCalls[0]?.[1]).toEqual({ state: 'minimized' });
    vi.restoreAllMocks();
  });

  it('creates a fullscreen window as normal, then makes it fullscreen after the tabs exist', async () => {
    const createSpy = vi.spyOn(chrome.windows, 'create');
    const updateSpy = vi.spyOn(chrome.windows, 'update');

    const result = await executeRestore(makePlan([WINDOW_FULLSCREEN]));

    expect(result.errors).toEqual([]);
    expect(createSpy.mock.calls[0]?.[0]?.state).toBe('normal');
    const stateCalls = updateSpy.mock.calls.filter(([, info]) => info.state !== undefined);
    expect(stateCalls).toHaveLength(1);
    expect(stateCalls[0]?.[1]).toEqual({ state: 'fullscreen' });
    vi.restoreAllMocks();
  });

  it('creates a maximized window as normal, then maximizes it after the tabs exist', async () => {
    // Chrome for Testing 151 rejects `windows.create({ state: 'maximized', focused: false })` with
    // "Invalid value for state", so maximized takes the same post-hoc path as minimized/fullscreen.
    const createSpy = vi.spyOn(chrome.windows, 'create');
    const updateSpy = vi.spyOn(chrome.windows, 'update');

    const result = await executeRestore(makePlan([WINDOW_MAXIMIZED]));

    expect(result.errors).toEqual([]);
    expect(createSpy.mock.calls[0]?.[0]?.state).toBe('normal');
    expect(createSpy.mock.calls[0]?.[0]?.focused).toBe(false);
    const stateCalls = updateSpy.mock.calls.filter(([, info]) => info.state !== undefined);
    expect(stateCalls).toHaveLength(1);
    expect(stateCalls[0]?.[1]).toEqual({ state: 'maximized' });
    vi.restoreAllMocks();
  });

  it('waits for navigation to commit before discarding lazily restored tabs, never losing the url', async () => {
    // QA finding (Chrome for Testing 151, 120-tab lazy restore): tabs.discard silently unloads a
    // tab whose navigation has not committed yet, wiping its url. Model the delayed commit via the
    // fake's deferCommit knob, and commit each tab shortly after it appears in state.tabs -- close
    // enough after creation that a naive "discard right after tabs.create resolves" would still
    // race it, but not synchronously, so the fix's poll-until-committed has something to wait for.
    const fake = getChromeFake();
    fake.state.deferCommit = true;
    const committed = new Set<number>();
    const timer = setInterval(() => {
      for (const tab of fake.state.tabs.values()) {
        if (tab.pendingUrl !== undefined && tab.url === '' && !committed.has(tab.id)) {
          committed.add(tab.id);
          fake.commitNavigation(tab.id);
        }
      }
    }, 5);

    const before = snapshotWindowIds();
    const result = await executeRestore(makePlan([WINDOW_A], { lazy: 'always' })).finally(() => {
      clearInterval(timer);
    });
    const [windowId] = newWindowIds(before);

    expect(result.errors).toEqual([]);
    expect(result.restored).toBe(5);
    const rows = [...fake.state.tabs.values()].filter((tab) => tab.windowId === windowId);
    expect(rows.every((tab) => tab.url !== '')).toBe(true);
    const discardedRows = rows.filter((tab) => tab.discarded);
    expect(discardedRows.length).toBeGreaterThan(0);
    expect(discardedRows.every((tab) => tab.url !== '')).toBe(true);
    expect(rows.some((tab) => tab.status === 'unloaded' && tab.url === '')).toBe(false);
  });

  it('stops waiting for uncommitted tabs on the next poll after a cancel, instead of the 5 s timeout', async () => {
    // Lazy restore whose navigations never commit: before the abort check in waitForCommit, a
    // Cancel pressed here was only noticed once the full commit timeout had elapsed.
    const fake = getChromeFake();
    fake.state.deferCommit = true;
    const controller = new AbortController();
    const getSpy = vi.spyOn(chrome.tabs, 'get');
    vi.useFakeTimers();
    try {
      let settled = false;
      const before = snapshotWindowIds();
      const restorePromise = executeRestore(makePlan([WINDOW_A], { lazy: 'always' }), {
        signal: controller.signal,
      }).then((result) => {
        settled = true;
        return result;
      });
      // A couple of 50 ms polls in, every discardable tab is still waiting for its commit.
      await vi.advanceTimersByTimeAsync(120);
      expect(settled).toBe(false);
      expect(getSpy.mock.calls.length).toBeGreaterThan(0);

      controller.abort();
      const pollsBeforeAbort = getSpy.mock.calls.length;
      // One more poll interval is enough: the loop checks the signal before calling tabs.get.
      await vi.advanceTimersByTimeAsync(100);
      expect(settled).toBe(true);
      expect(getSpy.mock.calls.length).toBe(pollsBeforeAbort);

      const result = await restorePromise;
      expect(result.restored).toBe(5);
      expect(result.discarded).toBe(0);
      expect(result.errors).toEqual([]);
      const [windowId] = newWindowIds(before);
      const rows = [...fake.state.tabs.values()].filter((tab) => tab.windowId === windowId);
      // Nothing was discarded while uncommitted, so no url was lost.
      expect(rows.every((tab) => !tab.discarded)).toBe(true);
    } finally {
      vi.useRealTimers();
      vi.restoreAllMocks();
    }
  });

  it('leaves a tab that never commits within the timeout undiscarded, still counting it as restored', async () => {
    const fake = getChromeFake();
    fake.state.deferCommit = true;
    vi.useFakeTimers();
    try {
      const before = snapshotWindowIds();
      const restorePromise = executeRestore(makePlan([WINDOW_A], { lazy: 'always' }));
      await vi.advanceTimersByTimeAsync(6000);
      const result = await restorePromise;
      const [windowId] = newWindowIds(before);

      expect(result.errors).toEqual([]);
      expect(result.restored).toBe(5);
      const rows = [...fake.state.tabs.values()].filter((tab) => tab.windowId === windowId);
      const discardable = rows.filter((tab) => !tab.pinned && !tab.active);
      expect(discardable.length).toBeGreaterThan(0);
      // Never discarded (still loading), and its url was never lost.
      expect(discardable.every((tab) => tab.discarded === false)).toBe(true);
      expect(discardable.every((tab) => tab.url === '')).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
});

/**
 * A 1,000-tab restore completes without freezing, and cancel works.
 * The multi-chunk path is covered at ~26 tabs elsewhere; this pins the shape of a restore two
 * orders of magnitude larger - the chunk count, that every single tab is created, and that a
 * cancel lands on a chunk boundary with the tabs already created kept.
 */
describe('executeRestore at 1,000 tabs', () => {
  const TAB_COUNT = 1_000;

  /** One window of `TAB_COUNT` distinct http tabs, the first active, none pinned or grouped. */
  function bigWindow(): WindowSnapshot {
    return {
      state: 'normal',
      focused: true,
      groups: [],
      tabs: Array.from({ length: TAB_COUNT }, (_, index) => ({
        url: `https://big.example/${index}`,
        title: `Tab ${index}`,
        pinned: false,
        active: index === 0,
      })),
    };
  }

  it('plans 40 chunks of 25 and creates every tab', async () => {
    const plan = makePlan([bigWindow()]);
    const [planned] = plan.windows;

    // The planner is what keeps the page responsive: 25 tabs per chunk, one macrotask apart.
    expect(plan.totalTabs).toBe(TAB_COUNT);
    expect(planned.chunks).toHaveLength(TAB_COUNT / 25);
    expect(planned.chunks.every((chunk) => chunk.length === 25)).toBe(true);
    expect(plan.skipped).toEqual([]);

    const before = snapshotWindowIds();
    const progress: number[] = [];
    const result = await executeRestore(plan, {
      onProgress: (done) => {
        progress.push(done);
      },
    });
    const [windowId] = newWindowIds(before);

    expect(result.errors).toEqual([]);
    expect(result.restored).toBe(TAB_COUNT);
    // One progress tick per chunk, cumulative and in order.
    expect(progress).toHaveLength(TAB_COUNT / 25);
    expect(progress.at(0)).toBe(25);
    expect(progress.at(-1)).toBe(TAB_COUNT);

    const strip = stripOf(windowId);
    expect(strip).toHaveLength(TAB_COUNT);
    expect(strip[0].url).toBe('https://big.example/0');
    expect(strip.at(-1)?.url).toBe(`https://big.example/${TAB_COUNT - 1}`);
    // Every url exactly once, and no about:blank placeholder left behind.
    expect(new Set(strip.map((row) => row.url)).size).toBe(TAB_COUNT);
    expect(strip.some((row) => row.url === 'about:blank')).toBe(false);
  });

  it('stops a cancel on a chunk boundary and keeps what was already created', async () => {
    const controller = new AbortController();
    const progress: number[] = [];
    const before = snapshotWindowIds();

    const result = await executeRestore(makePlan([bigWindow()]), {
      signal: controller.signal,
      onProgress: (done) => {
        progress.push(done);
        // Mid-restore, from the toast's Cancel button.
        if (done === 500) {
          controller.abort();
        }
      },
    });
    const [windowId] = newWindowIds(before);

    // Chunk boundary, not "somewhere around 500": the executor checks the signal between chunks.
    expect(progress.at(-1)).toBe(500);
    expect(progress).toHaveLength(500 / 25);
    // What was kept is reported, and it is exactly what is on screen.
    expect(result.restored).toBe(500);
    const strip = stripOf(windowId);
    expect(strip).toHaveLength(500);
    expect(strip.at(-1)?.url).toBe('https://big.example/499');
    expect(strip.some((row) => row.url === 'about:blank')).toBe(false);
    expect(result.errors).toEqual([]);
  });
});

describe('executeRestore progress reporting', () => {
  it('names the window each chunk belongs to, so the toast can show "Window 2 of 3"', async () => {
    const seen: { done: number; total: number; index: number; count: number }[] = [];

    await executeRestore(makePlan([WINDOW_A, WINDOW_B], { chunkSize: 2 }), {
      onProgress: (done, total, window) => {
        seen.push({ done, total, index: window.index, count: window.count });
      },
    });

    // WINDOW_A: 5 tabs in chunks of 2 (2, 4, 5); WINDOW_B: 2 tabs in one chunk.
    expect(seen).toEqual([
      { done: 2, total: 7, index: 0, count: 2 },
      { done: 4, total: 7, index: 0, count: 2 },
      { done: 5, total: 7, index: 0, count: 2 },
      { done: 7, total: 7, index: 1, count: 2 },
    ]);
  });

  it('names the window of a failed windows.create too', async () => {
    const fake = getChromeFake();
    fake.failNext('windows.create', 1, 'Invalid value for bounds');
    const seen: number[] = [];

    await executeRestore(makePlan([WINDOW_B, WINDOW_A]), {
      onProgress: (_done, _total, window) => {
        seen.push(window.index);
      },
    });

    expect(seen).toEqual([0, 1]);
  });
});

describe('loadSanitizeOptions', () => {
  it('reports our own id and no file access by default', async () => {
    const options = await loadSanitizeOptions();
    expect(options).toEqual({ ownExtensionId: 'fakeextid', fileAccessAllowed: false });
  });

  it('honours file-scheme access', async () => {
    getChromeFake().state.fileAccessAllowed = true;

    const options = await loadSanitizeOptions();
    expect(options.fileAccessAllowed).toBe(true);
  });

  it('reads nothing from chrome.storage.sync, not even a suspender id an older version stored', async () => {
    const fake = getChromeFake();
    fake.state.sync.set('tabSuspenderExtensionId', 'abcdefghijklmnopabcdefghijklmnop');
    const get = vi.spyOn(fake.chrome.storage.sync, 'get');

    const options = await loadSanitizeOptions();
    expect(options).toEqual({ ownExtensionId: 'fakeextid', fileAccessAllowed: false });
    expect(get).not.toHaveBeenCalled();
  });
});
