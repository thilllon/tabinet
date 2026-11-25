// Relative, not `@/`: scripts/ load this file with tsx, from any working directory.
import { POLICY } from './constants';

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
   * Whole minutes between automatic snapshots. The Settings view offers the preset choices or
   * any value the user types; `normalizeSettings` clamps whatever is stored into
   * the bounds of `POLICY.snapshots.intervalMinutes`.
   */
  historyIntervalMinutes: number;
  historyMaxSnapshots: number; // unprotected ones; see POLICY.snapshots.keep
  restoreLazy: 'auto' | 'always' | 'never'; // default 'auto': see POLICY.restore.lazyAboveTabs
}

export const DEFAULT_SESSION_SETTINGS: SessionSettings = {
  historyEnabled: true,
  historyIntervalMinutes: POLICY.snapshots.intervalMinutes.default,
  historyMaxSnapshots: POLICY.snapshots.keep.default,
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
// Cloud sync, protocol v2 (src/lib/cloud-*.ts). The wire shapes are declared verbatim on both
// sides (here and in server/src/types.ts), never imported from the other.
// ---------------------------------------------------------------------------

/** One AES-GCM ciphertext and its 12-byte iv, both base64. */
export interface EncryptedPayload {
  iv: string;
  ciphertext: string;
}

export type WireKey = { keyId: string; generation: number } | null;
export interface Usage {
  bytes: number;
  screenshots: number;
}
export type RecordKind = 'session' | 'settings' | 'image' | 'doc';
export interface RecordOut {
  kind: RecordKind;
  id: string;
  updatedAt: number;
  deleted: boolean;
  iv: string;
  ciphertext: string;
  seq: number;
}
export type RecordIn = Omit<RecordOut, 'seq'> & { baseSeq?: number | null }; // baseSeq: required on doc, absent otherwise
export type WriteResult = { kind: RecordKind; id: string } & (
  | { status: 'applied'; seq: number }
  | { status: 'absent' } // a deletion of a row the server lacks, over the cap: nothing stored, settled
  | { status: 'stale'; current: RecordOut | null } // null only for doc: no row
  | { status: 'stale'; withheld: true } // current not sent, the answer would be too large
  | { status: 'rejected'; reason: 'image_limit' | 'storage_limit' }
  | { status: 'rejected'; reason: 'clock_ahead' }
);
export type PullLine =
  | { type: 'start'; keyId: string; since: number; through: number; usage: Usage }
  | { type: 'record'; record: RecordOut }
  | { type: 'checkpoint'; cursor: number; count: number }
  | { type: 'end'; cursor: number; complete: boolean };
export type ErrorCode =
  | 'bad_request'
  | 'unauthorized'
  | 'google_refused'
  | 'google_account_mismatch'
  | 'proof_invalid'
  | 'not_found'
  | 'method_not_allowed'
  | 'key_exists'
  | 'key_missing'
  | 'key_mismatch'
  | 'generation_conflict'
  | 'upgrade_required'
  | 'payload_too_large'
  | 'key_unavailable'
  | 'internal'
  | 'google_unavailable';

/** The record kinds, in the order the engine applies them. */
export const RECORD_KINDS: readonly RecordKind[] = ['session', 'doc', 'image', 'settings'];

/** The data key wrapped under the passphrase (spec 3.3). Exactly these fields and lengths. */
export interface KeyEnvelope {
  v: 2;
  /** Integer 1..2147483647. */
  generation: number;
  /** b64u of 16 bytes. */
  keyId: string;
  /** b64 of 16 bytes. */
  salt: string;
  /** b64 of 12 bytes. */
  iv: string;
  /** b64 of 48 bytes: AES-GCM(wrapKey, iv, dek). */
  wrapped: string;
}

/** `cloudAccountV2`: the signed-in account. */
export interface CloudAccountV2 {
  accountId: string;
  token: string;
  expiresAt: number;
  email: string;
  uploadConfirmed: boolean;
}
/** `cloudKeyV2`: the data key of an account; `dek` is b64 of 32 bytes. */
export interface CloudKeyV2 {
  accountId: string;
  keyId: string;
  generation: number;
  dek: string;
}
/** `cloudOwnerV2`: whose cloud this device's data last went to. Kept through sign-out. */
export interface CloudOwnerV2 {
  accountId: string | null;
  email: string;
  legacy?: true;
}

export interface Memo {
  schemaVersion: 1;
  id: string;
  text: string;
  createdAt: number;
  updatedAt: number;
  conflictOf?: string;
}
export interface MemoSummary {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  conflict: boolean;
}
export interface MemoDraft {
  schemaVersion: 1;
  id: string;
  text: string;
  /** The text last confirmed saved, then every text whose save started and was not confirmed. */
  bases: (string | null)[];
  at: number;
}

/** Sessions: what still has to be sent, and what the server sent or accepted. */
export interface RecordTrack {
  dirty: Record<string, number>;
  deleted: Record<string, number>;
  /** Raised only by what the server sent or accepted, never by a local deletion. */
  known: Record<string, number>;
}
export interface ImageTrack extends RecordTrack {
  /** Image id to the doc ref whose deletion must be accepted first. */
  owner: Record<string, string>;
}
export interface Version {
  at: number;
  deleted: boolean;
}
export interface DocTrack {
  /** The HMAC id, stored when the track is made. */
  recordId: string;
  /** The server row the next write is based on. */
  seq: number | null;
  /** Newest seen on the server, never lowered, kept for good. */
  known: Version | null;
  pending: Version | null;
  /** Posted, answer not seen; at most `POLICY.sync.sentVersions`. */
  sent: { at: number; hash: string }[];
  /** A note's videoId, needed for its tombstone. */
  parent?: string;
  /** Made by sync as a conflict copy and not edited since. */
  autoCopy?: true;
}
/** `usage`: bytes or screenshots when refused. */
export interface Held {
  stamp: number;
  reason: 'image_limit' | 'storage_limit';
  usage: number;
}
/** `raw`: its `cloudRaw:*` key. */
export interface Blocked {
  at: number;
  reason: 'localUnreadable' | 'newer' | 'unknownType';
  raw: string;
}
export interface CloudSyncMeta {
  schemaVersion: 2;
  accountId: string;
  keyId: string;
  cursor: number;
  sessions: RecordTrack;
  images: ImageTrack;
  /** `"<type>:<local id>"`: usable without the DEK. */
  docs: Record<string, DocTrack>;
  /** `"session"`, and each doc type or `"image"` whose tracking started. */
  started: string[];
  settingsUpdatedAt: number;
  settingsDirty: boolean;
  settingsHash?: string;
  settingsSyncedAt?: number;
  pendingSettings?: Record<string, unknown>;
  /** Refs refused for a cap. */
  held: Record<string, Held>;
  heldNoticed?: boolean;
  /** Refs this build cannot apply: push blocked, raw copy kept. */
  blocked: Record<string, Blocked>;
  /** `"<kind>:<record id>"` to updatedAt: failed decryption or checks. */
  unreadable: Record<string, number>;
  usage?: Usage;
  /** Only grow. */
  conflicts: number;
  conflictsNoticed: number;
  rereadFeed?: true;
  /** The last pull ended at `maxRequestsPerRun` with more to read. */
  pullIncomplete?: true;
  /** The worker's current batch target after a timeout. */
  pushBatchBytes?: number;
  tooLarge?: number;
  lastSyncAt: number | null;
  lastAttemptAt?: number;
  changedAt?: number;
  failures?: number;
  retryAt?: number;
  lastError?: string;
}

export interface AccountInput {
  configured: boolean;
  /** Storage read. */
  loaded: boolean;
  now: number;
  account: CloudAccountV2 | null;
  key: CloudKeyV2 | null;
  /** The last key from sign-in or me; undefined while unknown. */
  server: WireKey | undefined;
}
export type AccountState =
  | 'unconfigured'
  | 'loading'
  | 'signedOut'
  | 'expired'
  | 'confirmAccount'
  | 'keyMismatch'
  | 'ready'
  | 'unknown'
  | 'needsCreate'
  | 'needsUnlock';

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
