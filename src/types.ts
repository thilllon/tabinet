export type SortBy = 'url' | 'title' | 'custom';

export type GroupFrom = 'leftToRight' | 'rightToLeft';

export type DuplicateTabHandling = 'none' | 'closeAllButOne' | 'group';

export type GroupingMode = 'subdomain' | 'domain';

export interface SortSettings {
  sortBy: SortBy;
  groupFrom: GroupFrom;
  preserveOrderWithinGroups: boolean;
  groupSuspendedTabs: boolean;
  sortPinnedTabs: boolean;
  duplicateTabHandling: DuplicateTabHandling;
  groupingMode: GroupingMode;
}

// ---------------------------------------------------------------------------
// Sessions (save / restore). Chrome runtime ids are never persisted.
// ---------------------------------------------------------------------------

export const SESSION_SCHEMA_VERSION = 1 as const;
export type SessionId = string; // crypto.randomUUID()
export type SessionKind = 'saved' | 'history';
export type SessionOrigin = 'manual' | 'alarm' | 'startup' | 'recovered' | 'import';
export type TabGroupColor = `${chrome.tabGroups.Color}`; // same form as hashStringToColor()

export interface TabSnapshot {
  url: string; // pendingUrl ?? url; suspender wrappers unwrapped via unwrapSuspendedUrl()
  title: string;
  pinned: boolean;
  active: boolean; // at most one true per window
  groupIndex?: number; // index into WindowSnapshot.groups; MUST be absent when pinned
}

export interface GroupSnapshot {
  title: string;
  color: TabGroupColor;
  collapsed: boolean;
}

export interface WindowBounds {
  left: number;
  top: number;
  width: number;
  height: number;
}

export interface WindowSnapshot {
  state: 'normal' | 'minimized' | 'maximized' | 'fullscreen';
  focused: boolean;
  bounds?: WindowBounds; // only when state === 'normal'
  groups: GroupSnapshot[]; // first-appearance order
  tabs: TabSnapshot[]; // tab-strip order; pinned first (Chrome invariant)
}

export interface Session {
  schemaVersion: typeof SESSION_SCHEMA_VERSION;
  id: SessionId;
  kind: SessionKind;
  name: string;
  origin: SessionOrigin;
  createdAt: number; // epoch ms
  updatedAt: number;
  protected?: boolean; // history only: exempt from pruning (recovered)
  /**
   * The `protected` flag above was set by `markRecovered()`. Crash recovery pins one snapshot
   * per browser start, so without this marker the pins would accumulate forever and no cleanup
   * could tell them from any other protected snapshot. Only still-marked snapshots beyond the
   * newest few are demoted back to prunable (`demoteAutoProtected`). Never set on a
   * `kind: 'saved'` session.
   */
  autoProtected?: boolean;
  contentHash?: string; // FNV-1a over windows->tabs (url, pinned, groupIndex, group title)
  windows: WindowSnapshot[]; // normal, non-incognito windows only; empty windows dropped
}

/**
 * Why the body behind an index entry cannot be read. There is one reason today: the
 * record was written by a newer schema version than this build understands, so `migrateSession`
 * refuses it. `reconcile()` marks the entry instead of dropping it, so a store written by a newer
 * Tabinet and then opened by an older one still lists its sessions -- read-only, with an
 * explanation -- rather than showing an empty dashboard while the bodies sit on disk.
 */
export interface UnreadableSession {
  reason: 'unknown-schema';
  /** The `schemaVersion` found on the stored body; always > SESSION_SCHEMA_VERSION. */
  version: number;
}

export interface SessionSummary {
  // what the index holds
  id: SessionId;
  kind: SessionKind;
  name: string;
  origin: SessionOrigin;
  createdAt: number;
  updatedAt: number;
  protected?: boolean;
  autoProtected?: boolean; // `protected` came from crash recovery, not the user (see Session)
  contentHash?: string;
  windowCount: number;
  tabCount: number;
  bytes: number; // JSON length at last write
  /**
   * Set only by `reconcile()`, for a body this build cannot migrate. The row is rendered inert
   * (no restore / rename / export / expand, delete still available) and `windowCount`/`tabCount`
   * are not to be trusted -- nothing could read the body to count them.
   */
  unreadable?: UnreadableSession;
}

export interface SessionIndex {
  schemaVersion: typeof SESSION_SCHEMA_VERSION;
  sessions: SessionSummary[]; // newest first
}

export interface SessionSettings {
  // chrome.storage.local key 'sessionSettings' (device-local; NOT sync)
  historyEnabled: boolean; // default true (owner decision)
  /**
   * Whole minutes between automatic snapshots, default 5. The Settings view offers 5, 10 and 30 or
   * any value the user types; `normalizeSettings` clamps whatever is stored into
   * [HISTORY_INTERVAL_MIN_MINUTES, HISTORY_INTERVAL_MAX_MINUTES].
   */
  historyIntervalMinutes: number;
  historyMaxSnapshots: number; // default 20 unprotected
  restoreLazy: 'auto' | 'always' | 'never'; // default 'auto' = discard when tabCount > LAZY_AUTO_THRESHOLD (src/constants.ts)
}

/**
 * Bounds for `historyIntervalMinutes`. Chrome accepts `periodInMinutes >= 0.5` for a packed
 * extension, so 1 minute is safely above its floor; a day is the longest interval that still makes
 * sense for crash recovery.
 */
export const HISTORY_INTERVAL_MIN_MINUTES = 1;
export const HISTORY_INTERVAL_MAX_MINUTES = 1440;

export const DEFAULT_SESSION_SETTINGS: SessionSettings = {
  historyEnabled: true,
  historyIntervalMinutes: 5,
  historyMaxSnapshots: 20,
  restoreLazy: 'auto',
};

export type ExportFormat = 'json' | 'markdown' | 'text' | 'html' | 'csv';

export interface ExportBundle {
  /** The format id, from the extension's name before Tabinet. Never renamed: older versions only import files carrying it. */
  app: 'tab-organizer';
  schemaVersion: typeof SESSION_SCHEMA_VERSION;
  exportedAt: number;
  sessions: Session[];
}

// ---------------------------------------------------------------------------
// Cloud sync (src/lib/cloud-*.ts; the server contract is GitHub issue #165)
// ---------------------------------------------------------------------------

/**
 * How the sync key is derived from the passphrase, as the server keeps it (`PUT /v1/keys`). It
 * holds nothing secret: the salt, and `check`, the fixed text `tabinet-key-check-v1` encrypted
 * under the key, so a passphrase can be tested without the server ever seeing one. Base64 values.
 */
export interface CloudKeySetup {
  kdf: { name: 'PBKDF2'; hash: 'SHA-256'; iterations: number };
  salt: string;
  check: string;
  checkIv: string;
}

/** One AES-GCM ciphertext and its 12-byte iv, both base64. */
export interface EncryptedPayload {
  iv: string;
  ciphertext: string;
}

export type CloudRecordKind = 'session' | 'settings';

/** A record as the server stores it: everything readable lives inside `ciphertext`. */
export interface CloudRecord extends EncryptedPayload {
  kind: CloudRecordKind;
  id: string;
  updatedAt: number;
  deleted: boolean;
}

/** A record read back from the server, with its place in the change feed. */
export interface CloudRecordWithSeq extends CloudRecord {
  seq: number;
}

/**
 * The signed-in account, in `chrome.storage.local` under `cloudAccount`: the server's bearer
 * token, when it expires (ms since the epoch) and the Google address it belongs to.
 */
export interface CloudAccount {
  token: string;
  expiresAt: number;
  email: string;
}

// ---------------------------------------------------------------------------
// YouTube notes (the side panel, src/pages/notes-panel.tsx; stored by src/lib/notes-repo.ts)
// ---------------------------------------------------------------------------

export const NOTES_SCHEMA_VERSION = 1 as const;

/** One timestamped note on a video. */
export interface NoteEntry {
  id: string;
  /** Where in the video it was taken, in seconds. */
  at: number;
  /** Markdown, shown as plain preformatted text. */
  text: string;
  /** A screenshot stored under `noteImage:<imageId>` (a WebP data URL). */
  imageId?: string;
  createdAt: number;
  updatedAt: number;
}

/** Every note on one video, stored under `notes:<videoId>`. */
export interface VideoNotes {
  schemaVersion: typeof NOTES_SCHEMA_VERSION;
  /** YouTube's 11-character video id. */
  videoId: string;
  /** `https://www.youtube.com/watch?v=<videoId>`, whatever form of the url the notes were taken on. */
  url: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  entries: NoteEntry[];
}

/** One line of `notesIndex`: enough to list the videos without reading their notes. */
export interface NotesSummary {
  videoId: string;
  url: string;
  title: string;
  entryCount: number;
  createdAt: number;
  updatedAt: number;
}

/** `notesIndex`: the summaries, newest `updatedAt` first. */
export interface NotesIndex {
  schemaVersion: typeof NOTES_SCHEMA_VERSION;
  notes: NotesSummary[];
}
