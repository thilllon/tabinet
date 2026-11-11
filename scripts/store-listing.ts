/**
 * Everything typed into the Chrome Web Store Developer Dashboard, as data. Edit the text here;
 * `pnpm store:bundle` writes it into `release/store-<version>/SUBMIT.md` and
 * `src/tests/store-listing.test.ts` checks it on every `pnpm test`.
 *
 * Title and Summary are not here: the store reads them out of the package (`extName` and
 * `extDescription` in `public/_locales/<code>/messages.json`), so they are changed there.
 * Each Description is plain text in its own language; everything else is English.
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  DEFAULT_LOCALE,
  SUPPORTED_LOCALES,
  type SupportedLocale,
  YOUTUBE_ORIGINS,
} from '../src/constants';

/** Store listing > Description, per language: pasted as it is (no Markdown, at most 500). */
export const STORE_DESCRIPTIONS: Record<ListingLocale, string> = {
  en: `One click on the icon sorts every tab in the window by site, title or URL, groups them and clears duplicates.

• Save windows as sessions and restore them later, with tab groups and pinned tabs
• Automatic snapshots bring your tabs back after a crash
• Assemble! pulls every window into one
• Search, import and export your sessions

No tracking. Optional sync is end-to-end encrypted; without it, nothing leaves your device.

Guide and FAQ: https://thilllon.github.io/tabinet/support/`,
  ko: `아이콘을 한 번 누르면 창의 모든 탭이 사이트, 제목, URL 순으로 정렬되고 그룹으로 묶이며 중복 탭이 정리됩니다.

• 창을 세션으로 저장했다가 탭 그룹, 고정 탭까지 그대로 복원
• 자동 스냅샷으로 브라우저가 꺼져도 탭 복구
• 모두 모으기로 여러 창을 한 창에
• 세션 검색, 가져오기, 내보내기

추적은 없습니다. 동기화는 선택 기능이며 나만 아는 암호 문구로 종단 간 암호화됩니다. 동기화를 켜지 않으면 데이터는 기기 밖으로 나가지 않습니다.

사용법과 FAQ: https://thilllon.github.io/tabinet/ko/support/`,
  es: `Un clic en el icono ordena las pestañas de la ventana por sitio, título o URL, las agrupa y quita duplicados.

• Guarda ventanas como sesiones y restáuralas con sus grupos y pestañas fijadas
• Las instantáneas automáticas recuperan tus pestañas tras un fallo
• ¡Reunir! junta todas las ventanas en una
• Busca, importa y exporta sesiones

Sin rastreo. Sincronización opcional cifrada de extremo a extremo; sin ella, nada sale del equipo.

Ayuda y guía: https://thilllon.github.io/tabinet/es/support/`,
  ja: `アイコンをクリックするだけで、ウィンドウ内のすべてのタブをサイト、タイトル、URL 順に並べ替え、グループにまとめ、重複タブを整理します。

• ウィンドウをセッションとして保存し、タブグループや固定タブごと復元
• 自動スナップショットで、クラッシュ後もタブを復旧
• 集合！ですべてのウィンドウを 1 つに
• セッションの検索、インポート、エクスポート

追跡なし。タブのデータはこのデバイスに保存され、Google アカウントでログインして同期をオンにした場合だけ、あなただけが知るパスフレーズでエンドツーエンド暗号化して送信されます。同期は任意です。

使い方と FAQ: https://thilllon.github.io/tabinet/ja/support/`,
};

/** Store listing tab: the fields besides Description and images. */
export const PRODUCT_DETAILS = {
  category: 'Functionality & UI',
  homepageUrl: 'https://thilllon.github.io/tabinet/',
  supportUrl: 'https://thilllon.github.io/tabinet/support/',
  privacyPolicyUrl: 'https://thilllon.github.io/tabinet/privacy/',
  matureContent: 'No',
  promoVideo: 'None (the store takes a YouTube URL only)',
} as const;

/** Distribution tab. */
export const DISTRIBUTION = {
  visibility: 'Public',
  regions: 'All regions',
  pricing: 'Free',
} as const;

/** Privacy tab > Single purpose. */
export const SINGLE_PURPOSE = `Organize browser tabs: sort and group the tabs of the current window (by URL, title or domain, optionally removing or grouping duplicates), gather every window into one, pause the videos of every YouTube tab on request, keep timestamped notes on a YouTube video in Chrome's side panel, and save, restore, search, import and export sets of windows and tabs as sessions, stored locally on the device and, only if the user signs in to the optional sync, keep saved sessions, notes and settings in step across their devices end-to-end encrypted.`;

/** Privacy tab > one justification per manifest permission (the test keeps the two lists equal). */
export const PERMISSION_JUSTIFICATIONS: Record<string, string> = {
  tabs: `Required to read tab URLs and titles for sorting, for saving sessions and for the dashboard's live list of open windows, and to create tabs when restoring. Uses chrome.tabs.query()/chrome.windows.getAll() to read, chrome.tabs.move() to reorder and chrome.tabs.create()/chrome.tabs.discard() to restore. Tab data is stored in local extension storage on the device when the user saves a session or while automatic snapshots run. It is transmitted only if the user signs in to the optional sync, and then only saved sessions, end-to-end encrypted on the device; automatic snapshots never leave the device.`,
  tabGroups: `Required to sort existing tab groups by title, to group duplicate tabs when the user enables that option, and to recreate a session's tab groups (title, color, collapsed state) on restore. Uses chrome.tabGroups.query(), move() and update().`,
  storage: `Required to persist user preferences (sort method, grouping mode, duplicate handling, the extension's display language) via chrome.storage.sync, and to store saved sessions, automatic snapshots and session settings (tab URLs, titles, pinned state, group names/colors and window layout) via chrome.storage.local on the device, together with the optional sync's sign-in state and encryption key. Nothing is sent through Chrome's own sync (chrome.storage.sync holds preferences only). The user can delete any session, or all session data, from the dashboard.`,
  contextMenus: `Adds "Assemble!" (gather every window's tabs into the current one), "Save all windows as session", "Pause all YouTube videos" and "YouTube notes" (opens the notes side panel) to the extension icon's right-click menu (contexts: ['action'] only; no menu items are added to web pages).`,
  unlimitedStorage: `Lets saved sessions and snapshots exceed the default 10 MB chrome.storage.local quota for users with thousands of tabs. This permission only raises the local quota; it uploads nothing (the optional sync, if the user signs in, is a separate feature described under identity).`,
  favicon: `Displays site icons next to tabs in the dashboard by reading Chrome's local favicon cache through chrome-extension://<id>/_favicon/. No favicon is fetched from the network and no favicon data is stored.`,
  scripting: `Used only on YouTube, in two features the user starts. "Pause all YouTube videos" (the icon's right-click menu or its keyboard shortcut): chrome.scripting.executeScript() runs one function packaged with the extension in each open YouTube tab; it calls pause() on every video and audio element that is playing and returns only how many it paused. "YouTube notes" (the side panel): while the panel is open on a YouTube video, a packaged function reads that video's current time, length, paused state and the page title, and, when the user asks, seeks the video to a note's time, pauses and resumes it while a note is written, or draws the frame on screen into a picture (WebP, at most 1280 pixels wide) when the user presses Screenshot. Nothing else is read from the page, and nothing read is transmitted by itself; the notes the user writes (with the video's id, title, times and any screenshots) are stored locally, and sent end-to-end encrypted only if the user signs in to the optional sync. It can run only on the optional host permission https://*.youtube.com/*, which the user grants in Settings or in the notes panel and can remove in Settings; without it no script runs anywhere.`,
  sidePanel: `Hosts "YouTube notes", a page of the extension (notes-panel.html) in Chrome's side panel where the user writes timestamped notes on the YouTube video in the active tab. chrome.sidePanel.open() is called only when the user chooses "YouTube notes" from the icon's right-click menu, its keyboard shortcut or the button on the extension's page; clicking the toolbar icon never opens it. The notes are stored in chrome.storage.local on the device; they are transmitted only if the user signs in to the optional sync, and then end-to-end encrypted like saved sessions (see identity).`,
  alarms: `A chrome.alarms timer that wakes the service worker on the user's chosen interval (any whole number of minutes from 1 to 1440; 5 by default) to take an automatic local snapshot of open windows for crash recovery. When the user turns snapshots off, no alarm exists. The worker still wakes briefly at browser start, on install or update, and when a setting changes, in every case to do local bookkeeping only. While the user is signed in to the optional sync, a second alarm (every 15 minutes, and once a minute after a change) runs the encrypted sync; signed out, no sync alarm exists.`,
  identity: `Used only for the optional cloud sync of saved sessions, YouTube notes (with their screenshots) and settings, and only when the user presses "Sign in with Google" in Settings > Account: chrome.identity.getAuthToken() asks Chrome for a Google access token for the account Chrome is signed in to, with the openid and email scopes only. The token is sent once to the extension's own sync server, which checks it with Google to learn the account's email address and stable Google account id, then the token is discarded and never stored. No other Google data is requested. Without signing in, chrome.identity is never called.`,
};

/**
 * Privacy tab > host permission justification, one per optional host permission of the manifest
 * (the test keeps the two lists equal). Nothing is requested at install.
 */
export const OPTIONAL_HOST_PERMISSION_JUSTIFICATIONS: Record<string, string> = {
  [YOUTUBE_ORIGINS[0]]: `Optional, never requested at install: the user grants it by turning on "Access to YouTube" in Settings, or in the "YouTube notes" side panel, when they want to use "Pause all YouTube videos" (the right-click menu item opens Settings until it is granted) or YouTube notes, and can remove it in Settings at any time. With it, the extension pauses the video and audio elements of open YouTube tabs when the user asks, and the notes panel reads the time, length, paused state and title of the video it shows and, on the user's request, seeks or pauses it or takes a screenshot of the frame on screen. Nothing is read from YouTube pages beyond that, and nothing about them is transmitted. It covers youtube.com and its subdomains (www, m, music).`,
};

/** Privacy tab > host permissions, content scripts and remote code. */
export const HOST_PERMISSIONS_AND_REMOTE_CODE = `Host permissions: none at install; one optional host permission, ${YOUTUBE_ORIGINS.join(', ')}, granted only by the user in Settings (see its justification). Content scripts: none declared; on the user's command, chrome.scripting injects functions packaged with the extension into YouTube tabs to pause their videos, and, while the notes side panel is open on a video, to read its time and title, to seek it and, when the user presses Screenshot, to capture the frame on screen. Remote code: not used.`;

/** Privacy tab > Data usage. */
export const DATA_USAGE = `Without the optional sync, the extension transmits no user data: when the user saves a session, or while automatic snapshots are enabled (the default), tab URLs, titles and window/group layout are written to chrome.storage.local on the user's device, and the user can delete them at any time (per session, per snapshot, or all at once with "Delete all session data"). Sync is off until the user signs in with Google in Settings > Account. Then the extension's own server (hosted on Vercel, database on Neon, Singapore region) receives the account's email address and Google account id, and issues a session token. Saved sessions (tab URLs, titles, groups), YouTube notes (the video's id, title and address, the note texts with their times, and the screenshots the user took; at most 100 screenshots per account are kept on the server, any more stay on the device) and settings are encrypted on the device with AES-GCM under a key derived from a passphrase only the user knows, which is never sent, so the server stores ciphertext it cannot read; automatic snapshots never leave the device. The data is used only to sync the user's own devices: never sold, never used for ads or analytics, never shared except with those hosting providers to run the service. "Delete cloud data" in Settings > Account deletes the account and everything stored for it on the server. Export creates a file or clipboard text only when the user explicitly asks for it. "Pause all YouTube videos" runs only in YouTube tabs, only after the user allowed access to YouTube, and only presses pause. "YouTube notes" keeps the notes the user writes, with the video's id, title, the times in it and any screenshots the user takes of the video, in chrome.storage.local on the device (synced only as described above, end-to-end encrypted, if the user signs in); to do so it reads the video's current time and title from the YouTube tab, and the frame on screen when the user presses Screenshot, nothing else.`;

/** Privacy tab > the three certifications: all apply, tick every one. */
export const DATA_CERTIFICATIONS: readonly string[] = [
  'Does not sell user data to third parties.',
  "Does not use or transfer user data for purposes unrelated to the item's core functionality.",
  'Does not use or transfer user data to determine creditworthiness or for lending purposes.',
];

/**
 * Privacy tab > data types: tick these, with this justification. The optional sync sends the
 * Google account email (personally identifiable information) and holds a session token
 * (authentication information); saved sessions carry tab URLs (web history) and page titles
 * (website content), and YouTube notes carry a video's address and title and the user's own
 * notes and screenshots of it (website content), all sent only end-to-end encrypted, but declared
 * rather than left out.
 */
export const DATA_TYPES = {
  ticked: [
    'Personally identifiable information',
    'Authentication information',
    'Web history',
    'Website content',
  ],
  justification: `Web history and website content: URLs and page titles of the user's tabs are stored locally on the device when the user saves a session and by the automatic snapshot feature (on by default, can be turned off). Website content also covers YouTube notes: the address and title of the video, the notes the user writes on it and the screenshots of it the user takes, stored locally. Only if the user signs in to the optional sync are saved sessions (never snapshots) and YouTube notes with their screenshots sent to the extension's sync server, end-to-end encrypted with a key derived from the user's passphrase, which the server never receives and so cannot read them. Personally identifiable information: with sync, the Google account's email address (and Google's account id) is sent to the sync server to identify the account. Authentication information: with sync, the server issues a session token kept in local extension storage (the server stores only its hash; valid 90 days); the Google access token used to sign in is passed once and never stored. Nothing is sold, used for ads or analytics, or shared beyond the hosting providers.`,
  notCollected: 'health, financial, personal communications, location, user activity',
} as const;

/**
 * Test instructions tab, for the reviewer. No test account is needed: username and password stay
 * empty, and the optional sync signs in with the reviewer's own Google account.
 */
export const TEST_INSTRUCTIONS = `No test account is needed; leave the username and password empty. Steps 1 to 8 run entirely on the device. Step 9 (optional cloud sync) signs in with whatever Google account Chrome is signed in to.

1. Open a few tabs from different sites in one window, in mixed order, with one address open twice.
2. Click the toolbar icon. There is no popup: the tabs are sorted by URL (site first) at once and the duplicate tab is closed.
3. Right-click the icon and choose "Save all windows as session". The icon shows a check mark for a moment.
4. Right-click the icon and choose "Options". The Tabinet page opens; its sidebar has Open tabs, Saved and Automatic snapshots. Pick the saved session and click Open to restore it.
5. With two or more windows open, right-click the icon and choose "Assemble! (move every window's tabs into this one)". Every tab moves into the current window.
6. On that page, the Settings button at the top opens Settings: set Sort by to Custom and click the toolbar icon again; tabs from the same site now sit next to each other, the first site seen first. Set Duplicate tabs to "Group them" to put duplicate tabs into a tab group instead of closing them. Automatic snapshots, the language and Backup (export, import) are there too.
7. Open two YouTube videos, in different windows, and play both. Right-click the icon and choose "Pause all YouTube videos". The first time, Settings opens instead: in its YouTube section turn on "Access to YouTube" and accept Chrome's prompt, then choose the menu item again. Both videos pause where they were; choosing it again resumes nothing. Turning the same switch off takes the access back.
8. On a YouTube video, right-click the icon and choose "YouTube notes": Chrome's side panel opens beside the page. With access to YouTube allowed (step 7, or the "Access to YouTube" switch in the panel), click Add note at (the button shows the video's current time), type a note and press Ctrl+Enter (Command+Enter on a Mac). Click the note's time to jump the video back there; the pencil and bin buttons edit and delete it. Click Screenshot to add a note holding the frame on screen; click its thumbnail to see it large.
9. Optional sync: in Settings, the Account section, click "Sign in with Google" and approve Chrome's prompt (openid and email only). Then "Create a sync passphrase": type a passphrase of 8 or more characters twice and click "Create passphrase". Saved sessions, YouTube notes (with their screenshots) and settings now sync, encrypted on the device; "Sync now" runs one at once. On a second Chrome profile signed in to the same Google account, "Unlock" with the same passphrase brings the saved sessions and notes over. "Delete cloud data" removes everything stored on the server; "Sign out" stops syncing. The sessions and notes on the device stay either way.

Without step 9 no data leaves the device.`;

/**
 * Limit for the Description, set by the owner: a hook, a few lines and a link to the website.
 * The store itself allows 16,000.
 */
export const DESCRIPTION_MAX_CHARS = 500;
/** Chrome Web Store limit for the Summary (manifest `description`, i.e. `extDescription`). */
export const CWS_SUMMARY_MAX_CHARS = 132;

/** The listing's languages, default first: the languages the extension ships in. */
export const LISTING_LOCALES = SUPPORTED_LOCALES;
export type ListingLocale = SupportedLocale;
/** The manifest's `default_locale`: what every language without its own listing shows. */
export const DEFAULT_LISTING_LOCALE: ListingLocale = DEFAULT_LOCALE;

/** English names, for headings in SUBMIT.md and log lines. */
export const LOCALE_NAMES: Record<ListingLocale, string> = {
  en: 'English',
  ko: 'Korean',
  es: 'Spanish',
  ja: 'Japanese',
};

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const LOCALES_SOURCE = path.resolve(__dirname, '..', 'public', '_locales');

export function isListingLocale(code: string): code is ListingLocale {
  return (LISTING_LOCALES as readonly string[]).includes(code);
}

interface MessageEntry {
  message: string;
}

/**
 * One message of `<localesDir>/<locale>/messages.json`, or `undefined` when the file or the key is
 * missing. Chrome matches message names case-insensitively, so this does too.
 */
export function readLocaleMessage(
  localesDir: string,
  locale: string,
  key: string,
): string | undefined {
  let messages: Record<string, MessageEntry | undefined>;
  try {
    messages = JSON.parse(readFileSync(path.join(localesDir, locale, 'messages.json'), 'utf-8'));
  } catch {
    return undefined;
  }
  const exact = messages[key];
  if (exact !== undefined) {
    return exact.message;
  }
  const lower = key.toLowerCase();
  const loose = Object.entries(messages).find(([name]) => name.toLowerCase() === lower);
  return loose?.[1]?.message;
}

export function validateDescription(description: string): void {
  if (description.length > DESCRIPTION_MAX_CHARS) {
    throw new Error(
      `Description is ${description.length.toLocaleString('en-US')} characters; the Chrome Web Store is kept to at most ${DESCRIPTION_MAX_CHARS}`,
    );
  }
}

/** The store Summary is the manifest `description`, which comes from `extDescription`. */
export function validateSummary(summary: string): void {
  if (summary.length > CWS_SUMMARY_MAX_CHARS) {
    throw new Error(
      `Summary is ${summary.length} characters; the Chrome Web Store allows at most ${CWS_SUMMARY_MAX_CHARS}`,
    );
  }
}
