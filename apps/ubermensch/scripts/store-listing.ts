/**
 * Every text typed into the Chrome Web Store dashboard for Übermensch, as data. Title and Summary
 * come from the package (`extName` / `extDescription` in public/_locales). src/tests/store-listing.test.ts
 * checks the limits and that the permission justifications match the manifest; store-bundle.ts
 * writes all of it into release/store-<version>/SUBMIT.md.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';

import {
  DEFAULT_LOCALE,
  DOCS_ORIGINS,
  DRIVE_FILE_FIELDS,
  POLICY,
  PRIVACY_URL,
  SITE_URL,
  SUPPORT_URL,
  SUPPORTED_LOCALES,
  type SupportedLocale,
} from '../src/constants.ts';

export const LISTING_LOCALES = SUPPORTED_LOCALES;
export type ListingLocale = SupportedLocale;
export const DEFAULT_LISTING_LOCALE: ListingLocale = DEFAULT_LOCALE;

export const LOCALE_NAMES: Record<ListingLocale, string> = {
  en: 'English',
  es: 'Spanish',
  ko: 'Korean',
  ja: 'Japanese',
};

/** One plain-text Description per language, pasted as it is (no Markdown, at most 500 characters). */
export const STORE_DESCRIPTIONS: Record<ListingLocale, string> = {
  en: `Übermensch is a home for small tools that save a few clicks every day.

Drive path: Google Docs, Sheets and Slides show where a file lives, next to its title: "My Drive › Projects › 2026". Each folder links to Google Drive.

Turn on access to Google Docs in the settings, click "Show folder" and sign in with Google. Only file and folder names are read, never content, and only from Google's API.

Help: ${SUPPORT_URL}`,
  es: `Übermensch reúne pequeñas herramientas que ahorran unos clics cada día.

Ruta de Drive: Documentos, Hojas y Presentaciones muestran dónde está el archivo, junto a su título: "Mi unidad › Proyectos › 2026". Cada carpeta enlaza a Google Drive.

Activa el acceso a Documentos de Google en la configuración, haz clic en "Ver carpeta" e inicia sesión con Google. Solo se leen nombres, nunca el contenido.

Ayuda: ${SUPPORT_URL}`,
  ko: `Übermensch는 매일 몇 번의 클릭을 줄여 주는 작은 도구 모음입니다.

Drive 경로: Google 문서, 스프레드시트, 프레젠테이션의 제목 옆에 파일이 있는 위치를 보여 줍니다. 예: "내 드라이브 › 프로젝트 › 2026". 폴더마다 Google Drive에서 여는 링크가 걸립니다.

설정에서 Google 문서 접근을 켜고 "폴더 보기"를 클릭해 Google로 로그인하세요. 파일과 폴더 이름만 읽고 내용은 읽지 않습니다. 데이터는 Google API 외에는 어디로도 가지 않습니다.

도움말: ${SUPPORT_URL}`,
  ja: `Übermensch は、毎日の数クリックを省く小さなツール集です。

Drive パス: Google ドキュメント、スプレッドシート、スライドのタイトルの横に、ファイルの場所を表示します。例: 「マイドライブ › プロジェクト › 2026」。フォルダごとに Google Drive で開くリンクが付きます。

設定で Google ドキュメントへのアクセスをオンにし、「フォルダを表示」をクリックして Google でログインします。読むのはファイル名とフォルダ名だけで、内容は読みません。データは Google の API 以外には送られません。

サポート: ${SUPPORT_URL}`,
};

export const PRODUCT_DETAILS = {
  category: 'Workflow & Planning',
  homepageUrl: SITE_URL,
  supportUrl: SUPPORT_URL,
  privacyPolicyUrl: PRIVACY_URL,
  matureContent: 'No',
} as const;

export const DISTRIBUTION = {
  visibility: 'Public',
  regions: 'All regions',
  pricing: 'Free',
} as const;

export const SINGLE_PURPOSE = `Small productivity helpers for Google's editors. Its one feature today: show the Google Drive folder path of the open Google Docs, Sheets or Slides file next to the file's title, each folder linking to that folder in Google Drive.`;

/** One entry per permission in the manifest (src/tests/store-listing.test.ts checks the match). */
export const PERMISSION_JUSTIFICATIONS: Record<string, string> = {
  identity: `Used only when the user clicks "Show folder" next to a document's title: chrome.identity.launchWebAuthFlow() opens Google's sign-in for the account the document is open in (passed as login_hint) and returns an access token with the single scope https://www.googleapis.com/auth/drive.metadata.readonly. The token is kept in chrome.storage.session (memory only, cleared when Chrome closes) and sent only to www.googleapis.com. It is never requested at page load or in the background.`,
  storage: `chrome.storage.session holds the Google access tokens (per account, until they expire or Chrome closes) and, for at most ${POLICY.cache.fileTtlMs / 60000} to ${POLICY.cache.driveTtlMs / 60000} minutes, the names and parent ids of the files and folders already looked up, so the same path is not requested again on every page. Nothing is written to disk, chrome.storage.local or Chrome sync.`,
  scripting: `chrome.scripting.registerContentScripts() registers the extension's one packaged content script on docs.google.com (Docs, Sheets and Slides editors) after the user grants that optional host permission, and unregisters it when the permission is removed; chrome.scripting.executeScript() injects the same packaged file into Docs tabs already open at the moment of the grant. The script adds the folder path next to the title; it reads the page address and the signed-in account's address shown by Google's account button, nothing else.`,
};

export const OPTIONAL_HOST_PERMISSION_JUSTIFICATIONS: Record<string, string> = {
  'https://docs.google.com/*': `Requested only when the user turns on "Access to Google Docs" in the extension's settings, and removable there. It lets the packaged content script show the file's Drive folder path next to the title in Docs, Sheets and Slides. The script reads the file id and account index from the address and the signed-in address from Google's account button; it never reads document content.`,
};

export const HOST_PERMISSIONS_AND_REMOTE_CODE = `Host permissions: none at install; one optional host permission, ${DOCS_ORIGINS.join(', ')}, granted only by the user in the settings. Calls to https://www.googleapis.com/drive/v3 are made from the service worker with the user's token (Google's API allows them by CORS; no host permission is needed). Content scripts: none declared in the manifest; one packaged script is registered at run time after the grant. Remote code: not used.`;

export const DATA_USAGE = `Übermensch has no server of its own and collects nothing. When the user clicks "Show folder" and signs in with Google, the extension asks Google's Drive API, with the user's own token, for the open file's metadata only: id, name, parent folder ids, shared drive id, owner's display name and type (fields=${DRIVE_FILE_FIELDS}), then the same for each parent folder, and the shared drive's name. It never requests file content. The token and these names are kept in Chrome's in-memory session storage for a few minutes and are gone when Chrome closes. Nothing is sold, used for ads or analytics, or sent anywhere except Google's API.`;

export const DATA_CERTIFICATIONS: readonly string[] = [
  'I do not sell or transfer user data to third parties, outside of the approved use cases.',
  "I do not use or transfer user data for purposes that are unrelated to my item's single purpose.",
  'I do not use or transfer user data to determine creditworthiness or for lending purposes.',
];

export const DATA_TYPES = {
  ticked: ['Personally identifiable information', 'Authentication information', 'Website content'],
  justification: `Personally identifiable information: the signed-in Google account's email address (read from Google's account button on the Docs page and confirmed with Drive's about.get) and file owners' display names, used only to pick the right account and to show "owner: name" when a folder is not visible. Authentication information: the Google access token, kept in memory (chrome.storage.session) until it expires or Chrome closes. Website content: the names of the open file and its parent folders, read from the Drive API and kept in memory for a few minutes. None of it leaves the device except in requests to Google's own API.`,
  notCollected: 'health, financial, personal communications, location, web history, user activity',
} as const;

export const TEST_INSTRUCTIONS = `No test account is needed: use any Google account that has a file in a folder of its My Drive.
1. Click the toolbar icon: the settings page opens.
2. Turn on "Access to Google Docs" and accept Chrome's prompt.
3. Open a Google Docs, Sheets or Slides file of that account. Next to the title, "Show folder" appears.
4. Click "Show folder" and sign in with Google (Google may warn that the app is not verified yet while verification is pending; choose Advanced, then continue). The folder path appears, for example "My Drive › Folder". Each folder opens in Google Drive.
5. Open a file shared with you that is not in your Drive: "Location not visible · owner: name" appears.
6. On the settings page, "Sign out" forgets the account and "Clear cached folder names" empties the cache.`;

export const DESCRIPTION_MAX_CHARS = 500;
export const CWS_SUMMARY_MAX_CHARS = 132;

export const LOCALES_SOURCE = path.resolve(import.meta.dirname, '..', 'public', '_locales');

/** One message from a language's messages.json. */
export function readLocaleMessage(locale: string, key: string): string {
  const parsed: unknown = JSON.parse(
    readFileSync(path.join(LOCALES_SOURCE, locale, 'messages.json'), 'utf-8'),
  );
  const entry: unknown =
    typeof parsed === 'object' && parsed !== null ? Reflect.get(parsed, key) : undefined;
  const message: unknown =
    typeof entry === 'object' && entry !== null ? Reflect.get(entry, 'message') : undefined;
  if (typeof message !== 'string') {
    throw new Error(`${locale}/messages.json has no ${key}`);
  }
  return message;
}
