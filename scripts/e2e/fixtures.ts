/**
 * Realistic `Session` fixtures for release screenshots and QA, plus the code that writes them
 * straight into `chrome.storage.local` through the extension service worker.
 *
 * The shapes here mirror `src/types.ts` (imported by relative path - these scripts run under
 * `tsx`, which does not know Vite's `@/` alias). Chrome runtime ids are never part of a snapshot,
 * so nothing in here needs a live browser to be built: the fixtures are plain data.
 */

import type { Worker } from '@playwright/test';

import {
  type GroupSnapshot,
  type NoteEntry,
  NOTES_SCHEMA_VERSION,
  type NotesIndex,
  type NotesSummary,
  SESSION_SCHEMA_VERSION,
  type Session,
  type SessionIndex,
  type SessionSummary,
  type TabSnapshot,
  type VideoNotes,
  type WindowSnapshot,
} from '../../src/types';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

interface TabSeed {
  url: string;
  title: string;
}

/** A pool of plausible, boring, work-day tabs. Nothing here is ever fetched. */
const TAB_POOL: TabSeed[] = [
  { url: 'https://mail.google.com/mail/u/0/#inbox', title: 'Inbox (12) - Gmail' },
  { url: 'https://calendar.google.com/calendar/u/0/r/week', title: 'Team calendar - Week' },
  {
    url: 'https://github.com/acme/tab-organizer/pulls',
    title: 'Pull requests · acme/tab-organizer',
  },
  {
    url: 'https://github.com/acme/tab-organizer/issues/412',
    title: 'Restore order is wrong · Issue #412',
  },
  { url: 'https://github.com/acme/tab-organizer/actions', title: 'Actions · acme/tab-organizer' },
  {
    url: 'https://developer.chrome.com/docs/extensions/reference/api/tabGroups',
    title: 'chrome.tabGroups - Chrome for Developers',
  },
  {
    url: 'https://developer.chrome.com/docs/extensions/reference/api/storage',
    title: 'chrome.storage - Chrome for Developers',
  },
  {
    url: 'https://developer.mozilla.org/en-US/docs/Web/API/Web_Locks_API',
    title: 'Web Locks API - MDN',
  },
  {
    url: 'https://stackoverflow.com/questions/tagged/google-chrome-extension',
    title: 'Newest questions - Stack Overflow',
  },
  { url: 'https://news.ycombinator.com/', title: 'Hacker News' },
  { url: 'https://www.figma.com/file/sessions-dashboard', title: 'Sessions dashboard - Figma' },
  {
    url: 'https://linear.app/acme/issue/TAB-118',
    title: 'TAB-118 Session import preview - Linear',
  },
  { url: 'https://linear.app/acme/team/TAB/cycle/active', title: 'Active cycle - Linear' },
  {
    url: 'https://docs.google.com/document/d/sessions-spec/edit',
    title: 'Sessions spec - Google Docs',
  },
  { url: 'https://www.notion.so/acme/Release-checklist', title: 'Release checklist - Notion' },
  { url: 'https://vitejs.dev/guide/build.html', title: 'Building for Production - Vite' },
  { url: 'https://react.dev/reference/react/useEffect', title: 'useEffect - React' },
  { url: 'https://tailwindcss.com/docs/upgrade-guide', title: 'Upgrade guide - Tailwind CSS' },
  {
    url: 'https://www.typescriptlang.org/docs/handbook/2/narrowing.html',
    title: 'Narrowing - TypeScript',
  },
  { url: 'https://oxc.rs/docs/guide/usage/linter/rules', title: 'Rules - Oxlint' },
  { url: 'https://vitest.dev/api/expect.html', title: 'expect - Vitest' },
  { url: 'https://playwright.dev/docs/chrome-extensions', title: 'Chrome extensions - Playwright' },
  {
    url: 'https://chromewebstore.google.com/category/extensions/productivity',
    title: 'Productivity - Chrome Web Store',
  },
  { url: 'https://www.youtube.com/watch?v=extension-deep-dive', title: 'MV3 deep dive - YouTube' },
  { url: 'https://en.wikipedia.org/wiki/Tab_(interface)', title: 'Tab (interface) - Wikipedia' },
  {
    url: 'https://www.google.com/search?q=chrome+session+manager',
    title: 'chrome session manager - Google Search',
  },
  { url: 'https://excalidraw.com/#room=restore-flow', title: 'Restore flow - Excalidraw' },
  { url: 'https://sentry.io/organizations/acme/issues/?query=restore', title: 'Issues - Sentry' },
  {
    url: 'https://analytics.google.com/analytics/web/#/report-home',
    title: 'Reports snapshot - Analytics',
  },
  { url: 'https://www.reddit.com/r/chrome_extensions/', title: 'r/chrome_extensions' },
];

function seedAt(index: number): TabSeed {
  const seed = TAB_POOL[index % TAB_POOL.length];
  const round = Math.floor(index / TAB_POOL.length);
  if (round === 0) {
    return seed;
  }
  // Keep every url distinct once the pool wraps, without inventing new hostnames.
  const separator = seed.url.includes('?') ? '&' : '?';
  return { url: `${seed.url}${separator}page=${round + 1}`, title: `${seed.title} (${round + 1})` };
}

interface GroupPlan extends GroupSnapshot {
  /** How many of this window's tabs belong to the group. */
  size: number;
}

interface WindowPlan {
  pinned: number;
  groups: GroupPlan[];
  /** Tabs outside any group. */
  loose: number;
  state?: WindowSnapshot['state'];
  focused?: boolean;
  bounds?: WindowSnapshot['bounds'];
}

/**
 * Builds one window: pinned tabs first (a Chrome invariant the snapshot keeps), then each group's
 * tabs contiguously, then the ungrouped ones. Exactly one tab is active, and it is never inside a
 * collapsed group - the same invariants `planRestore` enforces.
 */
function buildWindow(plan: WindowPlan, cursor: { index: number }): WindowSnapshot {
  const tabs: TabSnapshot[] = [];
  const groups: GroupSnapshot[] = plan.groups.map(({ size: _size, ...group }) => group);

  for (let i = 0; i < plan.pinned; i++) {
    const seed = seedAt(cursor.index++);
    tabs.push({ url: seed.url, title: seed.title, pinned: true, active: false });
  }

  plan.groups.forEach((group, groupIndex) => {
    for (let i = 0; i < group.size; i++) {
      const seed = seedAt(cursor.index++);
      tabs.push({ url: seed.url, title: seed.title, pinned: false, active: false, groupIndex });
    }
  });

  for (let i = 0; i < plan.loose; i++) {
    const seed = seedAt(cursor.index++);
    tabs.push({ url: seed.url, title: seed.title, pinned: false, active: false });
  }

  // Prefer a loose tab, then a tab in an expanded group, then a pinned one.
  const activeIndex = tabs.findIndex(
    (tab) => !tab.pinned && tab.groupIndex === undefined && tab.active === false,
  );
  const fallbackIndex = tabs.findIndex(
    (tab) => tab.groupIndex === undefined || groups[tab.groupIndex].collapsed === false,
  );
  const chosen = activeIndex >= 0 ? activeIndex : Math.max(fallbackIndex, 0);
  if (tabs.length > 0) {
    tabs[chosen] = { ...tabs[chosen], active: true };
  }

  const snapshot: WindowSnapshot = {
    state: plan.state ?? 'normal',
    focused: plan.focused ?? false,
    groups,
    tabs,
  };
  if (snapshot.state === 'normal') {
    snapshot.bounds = plan.bounds ?? { left: 60, top: 40, width: 1440, height: 900 };
  }
  return snapshot;
}

interface SessionPlan {
  id: string;
  name: string;
  kind: Session['kind'];
  origin: Session['origin'];
  /** Milliseconds before `now`. */
  ago: number;
  windows: WindowPlan[];
  protected?: boolean;
}

function buildSession(plan: SessionPlan, now: number): Session {
  const cursor = { index: 0 };
  const at = now - plan.ago;
  const session: Session = {
    schemaVersion: SESSION_SCHEMA_VERSION,
    id: plan.id,
    kind: plan.kind,
    name: plan.name,
    origin: plan.origin,
    createdAt: at,
    updatedAt: at,
    windows: plan.windows.map((window) => buildWindow(window, cursor)),
  };
  if (plan.protected !== undefined) {
    session.protected = plan.protected;
  }
  return session;
}

/**
 * The dashboard screenshot fixture: two saved sessions (one small enough to read when expanded,
 * one large enough - over 100 tabs - to trigger the restore confirm dialog) and three automatic
 * history snapshots.
 */
export function buildDashboardFixtures(): Session[] {
  const now = Date.now();
  const plans: SessionPlan[] = [
    {
      id: 'ffffffff-0000-4000-8000-000000000001',
      name: 'Work - Monday morning',
      kind: 'saved',
      origin: 'manual',
      ago: 4 * MINUTE,
      windows: [
        {
          pinned: 2,
          groups: [
            { title: 'Review', color: 'blue', collapsed: false, size: 4 },
            { title: 'Docs', color: 'green', collapsed: true, size: 3 },
          ],
          loose: 2,
          focused: true,
          bounds: { left: 40, top: 40, width: 1512, height: 945 },
        },
        {
          pinned: 1,
          groups: [{ title: 'Reading', color: 'purple', collapsed: false, size: 3 }],
          loose: 2,
          bounds: { left: 200, top: 120, width: 1280, height: 800 },
        },
      ],
    },
    {
      id: 'ffffffff-0000-4000-8000-000000000002',
      name: 'Research - everything open',
      kind: 'saved',
      origin: 'manual',
      ago: 25 * MINUTE,
      windows: [
        {
          pinned: 3,
          groups: [
            { title: 'Chrome APIs', color: 'cyan', collapsed: false, size: 14 },
            { title: 'Prior art', color: 'orange', collapsed: true, size: 12 },
          ],
          loose: 11,
        },
        {
          pinned: 2,
          groups: [
            { title: 'Specs', color: 'pink', collapsed: false, size: 16 },
            { title: 'Benchmarks', color: 'yellow', collapsed: false, size: 9 },
          ],
          loose: 10,
        },
        {
          pinned: 1,
          groups: [{ title: 'Inbox zero', color: 'red', collapsed: true, size: 18 }],
          loose: 16,
        },
      ],
    },
    {
      id: 'ffffffff-0000-4000-8000-000000000003',
      name: 'Snapshot - 40 minutes ago',
      kind: 'history',
      origin: 'alarm',
      ago: 40 * MINUTE,
      windows: [
        {
          pinned: 2,
          groups: [{ title: 'Review', color: 'blue', collapsed: false, size: 5 }],
          loose: 4,
          focused: true,
        },
        { pinned: 0, groups: [], loose: 6 },
      ],
    },
    {
      id: 'ffffffff-0000-4000-8000-000000000004',
      name: 'Snapshot - 2 hours ago',
      kind: 'history',
      origin: 'alarm',
      ago: 2 * HOUR,
      windows: [
        {
          pinned: 2,
          groups: [{ title: 'Review', color: 'blue', collapsed: false, size: 4 }],
          loose: 5,
        },
      ],
    },
    {
      id: 'ffffffff-0000-4000-8000-000000000005',
      name: 'Recovered - before the crash',
      kind: 'history',
      origin: 'recovered',
      ago: 26 * HOUR,
      protected: true,
      windows: [
        {
          pinned: 1,
          groups: [{ title: 'Docs', color: 'green', collapsed: false, size: 6 }],
          loose: 7,
        },
        { pinned: 0, groups: [], loose: 3 },
      ],
    },
  ];

  return plans.map((plan) => buildSession(plan, now));
}

function countTabs(session: Session): number {
  return session.windows.reduce((sum, window) => sum + window.tabs.length, 0);
}

/** Mirrors `sessionRepo`'s index entry so the dashboard's `reconcile()` finds nothing to repair. */
function toSummary(session: Session, bytes: number): SessionSummary {
  const summary: SessionSummary = {
    id: session.id,
    kind: session.kind,
    name: session.name,
    origin: session.origin,
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
    windowCount: session.windows.length,
    tabCount: countTabs(session),
    bytes,
  };
  if (session.protected !== undefined) {
    summary.protected = session.protected;
  }
  if (session.contentHash !== undefined) {
    summary.contentHash = session.contentHash;
  }
  return summary;
}

/**
 * Replaces whatever the profile holds with `sessions`: every `session:<id>` body plus the
 * `sessionIndex` entry that lists them, written from inside the extension service worker so the
 * dashboard sees exactly what a real save would have left behind.
 */
export async function seedSessions(worker: Worker, sessions: Session[]): Promise<void> {
  const index: SessionIndex = {
    schemaVersion: SESSION_SCHEMA_VERSION,
    sessions: sessions
      .map((session) =>
        toSummary(session, new TextEncoder().encode(JSON.stringify(session)).length),
      )
      .sort((a, b) => b.updatedAt - a.updatedAt),
  };

  await worker.evaluate(
    async (payload: { sessions: Session[]; index: SessionIndex }) => {
      const area = chrome.storage.local;
      const existing =
        typeof area.getKeys === 'function'
          ? await area.getKeys()
          : Object.keys(await area.get(null));
      const stale = existing.filter((key) => key.startsWith('session:'));
      if (stale.length > 0) {
        await area.remove(stale);
      }
      const records: Record<string, unknown> = { sessionIndex: payload.index };
      for (const session of payload.sessions) {
        records[`session:${session.id}`] = session;
      }
      await area.set(records);
    },
    { sessions, index },
  );
}

/*
 * YouTube notes
 */

/** A fixture video: fake ids (11 characters, as YouTube's are) and made-up titles. */
interface VideoPlan {
  videoId: string;
  title: string;
  /** Milliseconds before `now` of the last change. */
  ago: number;
  entries: { at: number; text: string; image?: string }[];
}

const NOTE_VIDEOS: VideoPlan[] = [
  {
    videoId: 'tAbInEtDem0',
    title: 'Building a browser extension, step by step - Workshop',
    ago: 6 * MINUTE,
    entries: [
      {
        at: 42,
        text: 'Manifest first: name, permissions, and the service worker as the one entry point.',
      },
      {
        at: 3 * 60 + 15,
        text: 'The service worker sleeps when idle.\n- register every listener at the top level\n- keep no state in memory',
        image: 'slide-lifecycle',
      },
      {
        at: 7 * 60 + 48,
        text: 'Side panel: one HTML page, opened from a click.',
      },
      {
        at: 12 * 60 + 5,
        text: '',
        image: 'slide-storage',
      },
    ],
  },
  {
    videoId: 'xR7mQ2pLk9w',
    title: 'Typography for interfaces in 20 minutes',
    ago: 3 * HOUR,
    entries: [
      { at: 95, text: 'Line length: 45 to 75 characters reads best.' },
      { at: 8 * 60 + 2, text: 'Pick one scale and stick to it.' },
    ],
  },
];

/** The screenshot slides: text drawn on the "video frame" each fixture picture shows. */
const SLIDES: Record<string, { heading: string; lines: string[] }> = {
  'slide-lifecycle': {
    heading: 'Service worker lifecycle',
    lines: ['install', 'activate', 'idle', 'wake on event'],
  },
  'slide-storage': {
    heading: 'Where data lives',
    lines: ['storage.local', 'storage.sync', 'storage.session'],
  },
};

/** The notes the screenshot fixture shows first: the video with the most entries. */
export const NOTES_FIXTURE_VIDEO_ID = NOTE_VIDEOS[0].videoId;

/**
 * The fixture videos' notes, built against `now`. `text` translates the note texts (written by the
 * person, so in their language); the video titles stay as the sites wrote them.
 */
export function buildNotesFixtures(text: (english: string) => string = (s) => s): VideoNotes[] {
  const now = Date.now();
  return NOTE_VIDEOS.map((video) => {
    const at = now - video.ago;
    const entries: NoteEntry[] = video.entries.map((entry, index) => {
      const note: NoteEntry = {
        id: `${video.videoId}-note-${index + 1}`,
        at: entry.at,
        text: entry.text === '' ? '' : text(entry.text),
        createdAt: at - (video.entries.length - index) * MINUTE,
        updatedAt: at - (video.entries.length - index) * MINUTE,
      };
      if (entry.image !== undefined) {
        note.imageId = entry.image;
      }
      return note;
    });
    return {
      schemaVersion: NOTES_SCHEMA_VERSION,
      videoId: video.videoId,
      url: `https://www.youtube.com/watch?v=${video.videoId}`,
      title: video.title,
      createdAt: entries[0].createdAt,
      updatedAt: at,
      entries,
    };
  });
}

/**
 * Replaces the profile's notes with `videos`: each `notes:<videoId>` body, the `noteImage:<id>`
 * pictures they reference (drawn in the service worker with OffscreenCanvas, WebP like a real
 * screenshot) and the `notesIndex` that lists them, as `notesRepo` would have left them.
 */
export async function seedNotes(worker: Worker, videos: VideoNotes[]): Promise<void> {
  const index: NotesIndex = {
    schemaVersion: NOTES_SCHEMA_VERSION,
    notes: videos
      .map((video): NotesSummary => ({
        videoId: video.videoId,
        url: video.url,
        title: video.title,
        entryCount: video.entries.length,
        createdAt: video.createdAt,
        updatedAt: video.updatedAt,
      }))
      .sort((a, b) => b.updatedAt - a.updatedAt),
  };
  const imageIds = videos.flatMap((video) =>
    video.entries.flatMap((entry) => (entry.imageId === undefined ? [] : [entry.imageId])),
  );
  const slides = imageIds.map((id) => ({ id, ...SLIDES[id] }));

  await worker.evaluate(
    async (payload: {
      videos: VideoNotes[];
      index: NotesIndex;
      slides: { id: string; heading: string; lines: string[] }[];
    }) => {
      // A 1280 x 720 "video frame": a dark slide with a heading and a few boxes.
      const draw = async (heading: string, lines: string[]): Promise<string> => {
        const canvas = new OffscreenCanvas(1280, 720);
        const ctx = canvas.getContext('2d');
        if (ctx === null) {
          throw new Error('no 2d context');
        }
        const gradient = ctx.createLinearGradient(0, 0, 1280, 720);
        gradient.addColorStop(0, '#1e293b');
        gradient.addColorStop(1, '#0f172a');
        ctx.fillStyle = gradient;
        ctx.fillRect(0, 0, 1280, 720);
        ctx.fillStyle = '#f8fafc';
        ctx.font = 'bold 64px sans-serif';
        ctx.fillText(heading, 96, 170);
        ctx.font = '40px sans-serif';
        lines.forEach((line, i) => {
          const y = 270 + i * 100;
          ctx.fillStyle = ['#38bdf8', '#a78bfa', '#34d399', '#fbbf24'][i % 4];
          ctx.fillRect(96, y, 56, 56);
          ctx.fillStyle = '#e2e8f0';
          ctx.fillText(line, 180, y + 42);
        });
        const blob = await canvas.convertToBlob({ type: 'image/webp', quality: 0.8 });
        const bytes = new Uint8Array(await blob.arrayBuffer());
        let binary = '';
        for (const byte of bytes) {
          binary += String.fromCharCode(byte);
        }
        return `data:${blob.type};base64,${btoa(binary)}`;
      };

      const area = chrome.storage.local;
      const existing =
        typeof area.getKeys === 'function'
          ? await area.getKeys()
          : Object.keys(await area.get(null));
      const stale = existing.filter(
        (key) => key.startsWith('notes:') || key.startsWith('noteImage:'),
      );
      if (stale.length > 0) {
        await area.remove(stale);
      }
      // Pictures first, then bodies, then the index: the order notesRepo writes in.
      const images: Record<string, string> = {};
      for (const slide of payload.slides) {
        images[`noteImage:${slide.id}`] = await draw(slide.heading, slide.lines);
      }
      await area.set(images);
      const bodies: Record<string, unknown> = {};
      for (const video of payload.videos) {
        bodies[`notes:${video.videoId}`] = video;
      }
      await area.set(bodies);
      await area.set({ notesIndex: payload.index });
    },
    { videos, index, slides },
  );
}
