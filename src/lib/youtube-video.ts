import type { NoteEntry } from '@/types';

/**
 * Pure helpers for YouTube notes: which video a url shows, its canonical url, the title a tab
 * shows for it, and how a time in the video is written. No `chrome.*`.
 */

/** YouTube's video ids: 11 characters of the url-safe base64 alphabet. */
const VIDEO_ID = /^[A-Za-z0-9_-]{11}$/;

/** The hosts a watch page lives on: the bare domain, www, m (mobile) and music. */
const YOUTUBE_HOSTS = new Set([
  'youtube.com',
  'www.youtube.com',
  'm.youtube.com',
  'music.youtube.com',
]);

/** Path prefixes that carry the id as their next segment: `/shorts/<id>`, `/live/<id>`. */
const ID_PATH_PREFIXES = ['shorts', 'live'];

function validId(candidate: string | null | undefined): string | undefined {
  return candidate !== null && candidate !== undefined && VIDEO_ID.test(candidate)
    ? candidate
    : undefined;
}

/**
 * The video a url shows, or `undefined` when it is not one video: `watch?v=<id>`, `youtu.be/<id>`,
 * `/shorts/<id>` and `/live/<id>`, on youtube.com, www, m and music. http or https; anything else
 * (a channel, the home page, a playlist without `v=`, a malformed id) is `undefined`.
 */
export function parseVideoId(url: string | undefined): string | undefined {
  if (url === undefined || url === '') {
    return undefined;
  }
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return undefined;
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    return undefined;
  }
  const host = parsed.hostname.toLowerCase();
  const segments = parsed.pathname.split('/').filter((segment) => segment !== '');
  if (host === 'youtu.be' || host === 'www.youtu.be') {
    return validId(segments[0]);
  }
  if (!YOUTUBE_HOSTS.has(host)) {
    return undefined;
  }
  if (segments.length === 1 && segments[0] === 'watch') {
    return validId(parsed.searchParams.get('v'));
  }
  if (segments.length >= 2 && ID_PATH_PREFIXES.includes(segments[0] ?? '')) {
    return validId(segments[1]);
  }
  return undefined;
}

/** The one url notes are stored under, whatever form of it they were taken on. */
export function canonicalVideoUrl(videoId: string): string {
  return `https://www.youtube.com/watch?v=${videoId}`;
}

/**
 * The video's title from a tab or page title: YouTube writes `(3) Title - YouTube`, the count
 * being unread notifications. Both are dropped; an empty result stays empty.
 */
export function cleanVideoTitle(title: string | undefined): string {
  if (title === undefined) {
    return '';
  }
  return title
    .replace(/^\(\d+\+?\)\s+/, '')
    .replace(/\s+-\s+YouTube( Music)?$/, '')
    .trim();
}

/**
 * A time in the video as YouTube writes it: `m:ss` under an hour, `h:mm:ss` from an hour on.
 * Fractions are cut, not rounded, so a note taken at 59.9 s reads 0:59 and seeks to where it was
 * taken. A negative or non-finite time reads 0:00.
 */
export function formatTimestamp(seconds: number): string {
  const whole = Number.isFinite(seconds) && seconds > 0 ? Math.floor(seconds) : 0;
  const hours = Math.floor(whole / 3600);
  const minutes = Math.floor((whole % 3600) / 60);
  const secs = String(whole % 60).padStart(2, '0');
  if (hours > 0) {
    return `${hours}:${String(minutes).padStart(2, '0')}:${secs}`;
  }
  return `${minutes}:${secs}`;
}

/** The entries in video order; two at the same time stay in the order they were written. */
export function entriesByTime(entries: readonly NoteEntry[]): NoteEntry[] {
  return [...entries].sort((a, b) => a.at - b.at || a.createdAt - b.createdAt);
}

/** The tab the notes panel follows, when it shows one YouTube video. */
export interface ActiveVideo {
  tabId: number;
  videoId: string;
  /** The tab's title, cleaned (`cleanVideoTitle`); may be empty while the page loads. */
  title: string;
}

/** What the notes panel shows for a tab: its video, or `null` when it shows none. */
export function activeVideoOf(tab: chrome.tabs.Tab | undefined): ActiveVideo | null {
  if (tab?.id === undefined) {
    return null;
  }
  // A tab still navigating has its new address in `pendingUrl` and an empty `url`.
  const videoId = parseVideoId(tab.url !== undefined && tab.url !== '' ? tab.url : tab.pendingUrl);
  if (videoId === undefined) {
    return null;
  }
  return { tabId: tab.id, videoId, title: cleanVideoTitle(tab.title) };
}

/** Whether two answers of `activeVideoOf` show the same thing, so the panel can skip a redraw. */
export function sameActiveVideo(a: ActiveVideo | null, b: ActiveVideo | null): boolean {
  if (a === null || b === null) {
    return a === b;
  }
  return a.tabId === b.tabId && a.videoId === b.videoId && a.title === b.title;
}

/** A base64 `data:` URL of a WebP, PNG or JPEG picture: the only images notes keep. */
export function isImageDataUrl(value: string): boolean {
  return /^data:image\/(?:webp|png|jpeg);base64,[A-Za-z0-9+/]+={0,2}$/.test(value);
}
