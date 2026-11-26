/**
 * Plain data shared by the extension, its scripts and vite.config.ts. No `chrome.*` and no
 * imports here: vite.config.ts and the scripts read this file under Node.
 */

/**
 * Every policy number, and nowhere else: lifetimes, limits and bounds the owner would tune. Read it
 * where it is used (`POLICY.cache.fileTtlMs`), never through a local copy. src/tests/policy.test.ts
 * pins each value, so a change here is a deliberate one.
 */
export const POLICY = {
  cache: {
    /** How long a file's resolved path is reused before Drive is asked again. */
    fileTtlMs: 5 * 60 * 1000,
    /** How long one folder's name and parent are reused (shared by every file below it). */
    folderTtlMs: 10 * 60 * 1000,
    /** How long a shared drive's name and the My Drive root id are reused. */
    driveTtlMs: 30 * 60 * 1000,
  },
  path: {
    /** At most this many folders are walked up from a file; deeper trees show as partial. */
    maxDepth: 25,
    /** The shown path is cut in the middle once its text is longer than this. */
    maxChars: 64,
    /** One folder name longer than this is cut at the end. */
    maxSegmentChars: 32,
  },
  auth: {
    /** A token this close to its expiry is treated as expired, so no request fails half way. */
    expiryMarginMs: 60 * 1000,
  },
  request: {
    /** A Drive API request with no answer after this long counts as a network failure. */
    timeoutMs: 15 * 1000,
  },
} as const;

/**
 * The Google OAuth client this build signs in with: a "Web application" client in Übermensch's own
 * Google Cloud project, with `https://<extension id>.chromiumapp.org/` as its redirect URI. Empty
 * until the owner creates it: sign-in then stays off and the UI says it is not configured.
 */
export const GOOGLE_OAUTH = {
  clientId: '',
  scopes: ['https://www.googleapis.com/auth/drive.metadata.readonly'],
} as const;

/** The one optional host permission, granted from a click in the options page. */
export const DOCS_ORIGINS = ['https://docs.google.com/*'] as const;

/** Where the content script is registered once access is granted: Docs, Sheets and Slides. */
export const DOCS_CONTENT_MATCHES = [
  'https://docs.google.com/document/*',
  'https://docs.google.com/spreadsheets/*',
  'https://docs.google.com/presentation/*',
] as const;

/** The Drive API v3 fields read for each file and folder (decided by the owner; never content). */
export const DRIVE_FILE_FIELDS = 'id,name,parents,driveId,owners(displayName),mimeType';

/** The shipped languages, in the owner's order (never sorted). English is the default. */
export const SUPPORTED_LOCALES = ['en', 'es', 'ko', 'ja'] as const;
export type SupportedLocale = (typeof SUPPORTED_LOCALES)[number];
export const DEFAULT_LOCALE: SupportedLocale = 'en';

/** The project website's pages for this extension. */
export const SITE_URL = 'https://thilllon.github.io/tabinet/ubermensch/';
export const PRIVACY_URL = `${SITE_URL}privacy/`;
export const SUPPORT_URL = `${SITE_URL}support/`;
