/**
 * Cloud sync's local bookkeeping (GitHub issue #170): `cloudSyncMeta` in `chrome.storage.local`,
 * which says what this device still has to send (the dirty sets), where in the server's change
 * feed it is (`cursor`) and how the last run went. It is the only module that writes that key.
 *
 * Every write here is a read-modify-write and runs inside the sessions lock (`withLock()` in
 * `src/lib/session-repo.ts`), so a session write marking itself dirty and a sync clearing an entry
 * never race. `sessionRepo` calls `trackSessionChanges()` from inside its own lock; the sync engine
 * (`src/lib/cloud-sync.ts`) wraps its calls in `withLock()`. This module imports nothing from the
 * session repository, so the repository can import it.
 *
 * Nothing is tracked unless cloud sync is configured (`isCloudSyncEnabled()`) and a first sync
 * started the bookkeeping (`startSyncMeta()`). Once started it outlives the account being ready:
 * an expired token, a 401 or a sign-out keep it, and changes made meanwhile are still recorded, so
 * signing in again with the same key resumes it and sends them (a deletion included). Another key
 * starts it afresh. It is bound to the key alone, never to the email the server reports: the
 * server is not trusted, and a different spelling of the email must not wipe the marks that stop
 * it from rolling data back (`settingsUpdatedAt`, `knownVersions`, the pending deletions). The
 * key is random per account (`createKeySetup()`), so the same key means the same account's data.
 * While unconfigured no function here reads storage.
 */
import { CLOUD_ACCOUNT_KEY, CLOUD_SYNC_KEY, isCloudAccount } from '@/lib/cloud-auth';
import { isCloudSyncEnabled } from '@/lib/cloud-config';
import { isRecord } from '@/lib/import-guards';
import { fnv1a32 } from '@/lib/session-hash';
import type { CloudAccount, SessionId } from '@/types';

/** `chrome.storage.local` key of the bookkeeping. */
export const CLOUD_SYNC_META_KEY = 'cloudSyncMeta';

export interface CloudSyncMeta {
  /**
   * The account email when the bookkeeping started, for information only: the server supplies it,
   * so it never decides whether the bookkeeping is kept (`belongsTo()`).
   */
  owner: string;
  /** Fingerprint of the sync key it was started with; another key starts it again. */
  keyId: string;
  /** The server's change feed position: the last `seq` this device has read. */
  cursor: number;
  /** When the last sync finished (ms), or `null` before the first. */
  lastSyncAt: number | null;
  /** Why the last sync did not fully succeed, in the UI language of that moment. */
  lastError?: string;
  /** Saved sessions changed here and not yet accepted by the server: id to `updatedAt`. */
  dirtySessions: Record<SessionId, number>;
  /** Saved sessions deleted here and not yet accepted by the server: id to deletion time. */
  deletedSessions: Record<SessionId, number>;
  /**
   * The newest `updatedAt` this device has applied, deleted or had accepted for each saved
   * session id, kept for good (also once the session and its pending tombstone are gone). A record
   * from the server at or below it is old, so a replay of a deleted session's last live record
   * cannot bring it back.
   */
  knownVersions: Record<SessionId, number>;
  /** When the settings last changed on this device (0: not since sync started). */
  settingsUpdatedAt: number;
  /** Whether the settings differ from what was last exchanged with the server. */
  settingsDirty: boolean;
  /** Fingerprint of the settings last exchanged with the server, when there was an exchange. */
  settingsHash?: string;
  /** The `updatedAt` of those settings. */
  settingsSyncedAt?: number;
  /**
   * Settings received from the server and not yet fully written here (the page reloading on a new
   * language, or the worker stopping, can cut the writes short). While present, a local settings
   * change is not taken for an edit of this device's own; the next sync finishes writing them.
   */
  pendingSettings?: Record<string, unknown>;
}

/** What a sync runs with: the live account and the raw key, as stored on this device. */
export interface SyncContext {
  account: CloudAccount;
  rawKey: string;
  keyId: string;
}

/** A short fingerprint of the raw key, so the bookkeeping notices a key change. Pure. */
export function keyFingerprint(rawKey: string): string {
  return fnv1a32(rawKey);
}

function isCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function isStampMap(value: unknown): value is Record<string, number> {
  return isRecord(value) && !Array.isArray(value) && Object.values(value).every(isCount);
}

/** The stored bookkeeping, or `undefined` when there is none or it is damaged. Pure. */
export function parseSyncMeta(value: unknown): CloudSyncMeta | undefined {
  if (
    !isRecord(value) ||
    typeof value.owner !== 'string' ||
    typeof value.keyId !== 'string' ||
    !isCount(value.cursor) ||
    !(value.lastSyncAt === null || isCount(value.lastSyncAt)) ||
    !(value.lastError === undefined || typeof value.lastError === 'string') ||
    !isStampMap(value.dirtySessions) ||
    !isStampMap(value.deletedSessions) ||
    !(value.knownVersions === undefined || isStampMap(value.knownVersions)) ||
    !isCount(value.settingsUpdatedAt) ||
    typeof value.settingsDirty !== 'boolean' ||
    !(value.settingsHash === undefined || typeof value.settingsHash === 'string') ||
    !(value.settingsSyncedAt === undefined || isCount(value.settingsSyncedAt)) ||
    !(value.pendingSettings === undefined || isRecord(value.pendingSettings))
  ) {
    return undefined;
  }
  const meta: CloudSyncMeta = {
    owner: value.owner,
    keyId: value.keyId,
    cursor: value.cursor,
    lastSyncAt: value.lastSyncAt,
    dirtySessions: { ...value.dirtySessions },
    deletedSessions: { ...value.deletedSessions },
    knownVersions: { ...value.knownVersions },
    settingsUpdatedAt: value.settingsUpdatedAt,
    settingsDirty: value.settingsDirty,
  };
  if (value.lastError !== undefined) {
    meta.lastError = value.lastError;
  }
  if (value.settingsHash !== undefined) {
    meta.settingsHash = value.settingsHash;
  }
  if (value.settingsSyncedAt !== undefined) {
    meta.settingsSyncedAt = value.settingsSyncedAt;
  }
  if (value.pendingSettings !== undefined) {
    meta.pendingSettings = { ...value.pendingSettings };
  }
  return meta;
}

/** The context in `stored` (a `storage.local.get` result), or `null` when not ready. Pure. */
function contextFrom(stored: Record<string, unknown>, now: number): SyncContext | null {
  const account: unknown = stored[CLOUD_ACCOUNT_KEY];
  const rawKey: unknown = stored[CLOUD_SYNC_KEY];
  if (!isCloudAccount(account) || account.expiresAt <= now) {
    return null;
  }
  if (typeof rawKey !== 'string' || rawKey === '') {
    return null;
  }
  return { account, rawKey, keyId: keyFingerprint(rawKey) };
}

/**
 * Whether `meta` was started for this key. The key alone decides: the account email comes from the
 * untrusted server, which could otherwise reset the anti-rollback marks by naming another. Pure.
 */
export function belongsTo(meta: CloudSyncMeta, context: SyncContext): boolean {
  return meta.keyId === context.keyId;
}

/**
 * The sync context when cloud sync is configured and this device is ready (a live account and its
 * key), else `null`. No storage read at all while unconfigured.
 */
export async function loadSyncContext(now: number = Date.now()): Promise<SyncContext | null> {
  if (!isCloudSyncEnabled()) {
    return null;
  }
  const stored = await chrome.storage.local.get([CLOUD_ACCOUNT_KEY, CLOUD_SYNC_KEY]);
  return contextFrom(stored, now);
}

/** The stored bookkeeping as it is. Inside the sessions lock when the result is written back. */
export async function readSyncMeta(): Promise<CloudSyncMeta | undefined> {
  const stored = await chrome.storage.local.get(CLOUD_SYNC_META_KEY);
  return parseSyncMeta(stored[CLOUD_SYNC_META_KEY]);
}

/** Inside the sessions lock only. */
export async function writeSyncMeta(meta: CloudSyncMeta): Promise<void> {
  await chrome.storage.local.set({ [CLOUD_SYNC_META_KEY]: meta });
}

/**
 * The bookkeeping for `context` when it belongs to it, else `undefined`: tracking only runs for
 * the account and key the first sync started it for. Inside the sessions lock when written back.
 */
export async function readSyncMetaFor(context: SyncContext): Promise<CloudSyncMeta | undefined> {
  const meta = await readSyncMeta();
  return meta !== undefined && belongsTo(meta, context) ? meta : undefined;
}

/**
 * Fresh bookkeeping for the first sync of `context`: the feed read from the start, every saved
 * session (`savedSessions`, id to `updatedAt`) and the settings marked dirty, so this device's data
 * is offered to the server before anything else. The settings carry `updatedAt` 0, "not changed
 * since sync started": a device joining an account takes the settings already there. Pure.
 */
export function freshSyncMeta(
  context: SyncContext,
  savedSessions: Readonly<Record<SessionId, number>>,
): CloudSyncMeta {
  return {
    owner: context.account.email,
    keyId: context.keyId,
    cursor: 0,
    lastSyncAt: null,
    dirtySessions: { ...savedSessions },
    deletedSessions: {},
    knownVersions: {},
    settingsUpdatedAt: 0,
    settingsDirty: true,
  };
}

/** `meta` with `updatedAt` remembered for `id`, never lowering what is there. Pure. */
export function withKnownVersion(
  meta: CloudSyncMeta,
  id: SessionId,
  updatedAt: number,
): CloudSyncMeta {
  const known = meta.knownVersions[id];
  if (known !== undefined && known >= updatedAt) {
    return meta;
  }
  return { ...meta, knownVersions: { ...meta.knownVersions, [id]: updatedAt } };
}

/** Saved-session writes for the dirty sets: what changed (with its new `updatedAt`) or was deleted. */
export interface SessionChanges {
  changed?: readonly (readonly [SessionId, number])[];
  /** Each deleted session with the `updatedAt` it had, so its tombstone is newer than it. */
  deleted?: readonly (readonly [SessionId, number])[];
}

/**
 * `meta` with `changes` recorded: a change replaces a pending tombstone, a deletion replaces a
 * pending change. A tombstone is stamped `now`, or just after the session's own `updatedAt` when
 * that is later (a copy made on a device whose clock runs ahead), and remembered in
 * `knownVersions`. Pure.
 */
export function withSessionChanges(
  meta: CloudSyncMeta,
  changes: SessionChanges,
  now: number,
): CloudSyncMeta {
  const dirtySessions = { ...meta.dirtySessions };
  const deletedSessions = { ...meta.deletedSessions };
  const knownVersions = { ...meta.knownVersions };
  for (const [id, updatedAt] of changes.changed ?? []) {
    dirtySessions[id] = updatedAt;
    delete deletedSessions[id];
  }
  for (const [id, updatedAt] of changes.deleted ?? []) {
    const deletedAt = Math.max(now, updatedAt + 1);
    deletedSessions[id] = deletedAt;
    knownVersions[id] = Math.max(knownVersions[id] ?? 0, deletedAt);
    delete dirtySessions[id];
  }
  return { ...meta, dirtySessions, deletedSessions, knownVersions };
}

/**
 * Records saved-session writes in the dirty sets. Called by `sessionRepo` from inside its lock,
 * after the write. A no-op (no storage read) while cloud sync is unconfigured, and a no-op before
 * the first sync started the bookkeeping (it marks every saved session dirty anyway). It records
 * also while the device is not ready (an expired token, signed out): the bookkeeping is resumed
 * when the same account and key sign in again, and what changed meanwhile must be sent then.
 */
export async function trackSessionChanges(
  changes: SessionChanges,
  now: number = Date.now(),
): Promise<void> {
  if (!isCloudSyncEnabled()) {
    return;
  }
  if ((changes.changed?.length ?? 0) === 0 && (changes.deleted?.length ?? 0) === 0) {
    return;
  }
  const meta = await readSyncMeta();
  if (meta === undefined) {
    return;
  }
  await writeSyncMeta(withSessionChanges(meta, changes, now));
}

/**
 * Whether a `storage.onChanged` change of `cloudSyncMeta` added something to send: a session id
 * that was not pending before (or is pending with a newer stamp), or settings that became dirty.
 * Clearing entries, moving the cursor and recording a result do not count. Pure.
 */
export function syncWorkGrew(oldValue: unknown, newValue: unknown): boolean {
  const next = parseSyncMeta(newValue);
  if (next === undefined) {
    return false;
  }
  const previous = parseSyncMeta(oldValue);
  const grew = (before: Record<string, number> | undefined, after: Record<string, number>) =>
    Object.entries(after).some(([id, stamp]) => before?.[id] !== stamp);
  return (
    grew(previous?.dirtySessions, next.dirtySessions) ||
    grew(previous?.deletedSessions, next.deletedSessions) ||
    (next.settingsDirty &&
      (previous?.settingsDirty !== true || previous.settingsUpdatedAt !== next.settingsUpdatedAt))
  );
}

/** What Settings > Account shows about syncing. */
export interface SyncStatus {
  lastSyncAt: number | null;
  lastError: string | undefined;
}

/** The last run's time and error for Settings; nothing before this account's first sync. */
export async function loadSyncStatus(): Promise<SyncStatus> {
  const context = await loadSyncContext();
  const meta = context === null ? undefined : await readSyncMetaFor(context);
  return { lastSyncAt: meta?.lastSyncAt ?? null, lastError: meta?.lastError };
}
