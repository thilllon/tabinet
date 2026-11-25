/**
 * Cloud sync v2's local bookkeeping (spec 8.1): `cloudSyncMetaV2` in `chrome.storage.local`, which
 * says what this device still has to send, what the server sent or accepted, where in the feed
 * it is (`cursor`), what is held for a cap or blocked as unreadable here, and how the last run
 * went. Every write of it is a read-modify-write inside the sessions lock
 * (`withSessionsLock()`), and every local change writes it in the same `set` as the change
 * (invariant 12): `stageSessionChanges()` returns the entry the session repository adds to its
 * own `set`.
 *
 * The bookkeeping belongs to one `(accountId, keyId)`: another pair starts it afresh (and drops
 * every `cloudRaw:*`). It outlives a sign-out, an expiry and a 401: changes are still recorded,
 * so signing in again with the same key sends them. While unconfigured nothing here reads
 * storage.
 */
import { POLICY } from '@/constants';
import { isCloudSyncEnabled } from '@/lib/cloud-config';
import {
  CLOUD_ACCOUNT_KEY,
  CLOUD_KEY_KEY,
  CLOUD_OWNER_KEY,
  CLOUD_RAW_PREFIX,
  CLOUD_SYNC_META_KEY,
  cloudStoredFrom,
  setThenClean,
  withSessionsLock,
} from '@/lib/cloud-storage';
import type {
  Blocked,
  CloudAccountV2,
  CloudKeyV2,
  CloudSyncMeta,
  DocTrack,
  Held,
  ImageTrack,
  RecordTrack,
  Usage,
  Version,
} from '@/types';

export { CLOUD_SYNC_META_KEY } from '@/lib/cloud-storage';
export type { CloudSyncMeta } from '@/types';

/** What a sync runs with: the live, confirmed account and the data key of that account. */
export interface SyncContext {
  account: CloudAccountV2;
  key: CloudKeyV2;
}

/** The context in a `storage.local.get` result, or `null` when not ready (spec 10.2). Pure. */
export function contextFrom(stored: Record<string, unknown>, now: number): SyncContext | null {
  const { account, key } = cloudStoredFrom(stored);
  if (account === null || account.expiresAt <= now || !account.uploadConfirmed) {
    return null;
  }
  if (key === null || key.accountId !== account.accountId) {
    return null;
  }
  return { account, key };
}

/** The sync context when configured and ready, else `null`. No read while unconfigured. */
export async function loadSyncContext(now: number = Date.now()): Promise<SyncContext | null> {
  if (!isCloudSyncEnabled()) {
    return null;
  }
  return contextFrom(
    await chrome.storage.local.get([CLOUD_ACCOUNT_KEY, CLOUD_KEY_KEY, CLOUD_OWNER_KEY]),
    now,
  );
}

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function isStampMap(value: unknown): value is Record<string, number> {
  return isObject(value) && Object.values(value).every(isCount);
}

function isVersion(value: unknown): value is Version {
  return isObject(value) && isCount(value.at) && typeof value.deleted === 'boolean';
}

function parseTrack(value: unknown): RecordTrack | null {
  if (
    !isObject(value) ||
    !isStampMap(value.dirty) ||
    !isStampMap(value.deleted) ||
    !isStampMap(value.known)
  ) {
    return null;
  }
  return { dirty: { ...value.dirty }, deleted: { ...value.deleted }, known: { ...value.known } };
}

function parseDocTrack(value: unknown): DocTrack | null {
  if (
    !isObject(value) ||
    typeof value.recordId !== 'string' ||
    !(value.seq === null || isCount(value.seq)) ||
    !(value.known === null || isVersion(value.known)) ||
    !(value.pending === null || isVersion(value.pending)) ||
    !Array.isArray(value.sent) ||
    !value.sent.every(
      (sent) => isObject(sent) && isCount(sent.at) && typeof sent.hash === 'string',
    ) ||
    !(value.parent === undefined || typeof value.parent === 'string') ||
    !(value.autoCopy === undefined || value.autoCopy === true)
  ) {
    return null;
  }
  const track: DocTrack = {
    recordId: value.recordId,
    seq: value.seq,
    known: value.known === null ? null : { ...value.known },
    pending: value.pending === null ? null : { ...value.pending },
    sent: value.sent.map((sent: { at: number; hash: string }) => ({
      at: sent.at,
      hash: sent.hash,
    })),
  };
  if (value.parent !== undefined) {
    track.parent = value.parent;
  }
  if (value.autoCopy === true) {
    track.autoCopy = true;
  }
  return track;
}

function parseMap<T>(value: unknown, parse: (item: unknown) => T | null): Record<string, T> | null {
  if (!isObject(value)) {
    return null;
  }
  const out: Record<string, T> = {};
  for (const [key, item] of Object.entries(value)) {
    const parsed = parse(item);
    if (parsed === null) {
      return null;
    }
    out[key] = parsed;
  }
  return out;
}

const parseHeld = (value: unknown): Held | null =>
  isObject(value) &&
  isCount(value.stamp) &&
  (value.reason === 'image_limit' || value.reason === 'storage_limit') &&
  isCount(value.usage)
    ? { stamp: value.stamp, reason: value.reason, usage: value.usage }
    : null;

const parseBlocked = (value: unknown): Blocked | null =>
  isObject(value) &&
  isCount(value.at) &&
  (value.reason === 'localUnreadable' ||
    value.reason === 'newer' ||
    value.reason === 'unknownType') &&
  typeof value.raw === 'string'
    ? { at: value.at, reason: value.reason, raw: value.raw }
    : null;

const OPTIONAL_COUNTS = [
  'settingsSyncedAt',
  'pushBatchBytes',
  'tooLarge',
  'lastAttemptAt',
  'changedAt',
  'failures',
  'retryAt',
] as const;

/** The stored bookkeeping, or `undefined` when there is none or it is damaged. Pure. */
export function parseSyncMeta(value: unknown): CloudSyncMeta | undefined {
  if (
    !isObject(value) ||
    value.schemaVersion !== 2 ||
    typeof value.accountId !== 'string' ||
    typeof value.keyId !== 'string' ||
    !isCount(value.cursor) ||
    !isCount(value.settingsUpdatedAt) ||
    typeof value.settingsDirty !== 'boolean' ||
    !isCount(value.conflicts) ||
    !isCount(value.conflictsNoticed) ||
    !(value.lastSyncAt === null || isCount(value.lastSyncAt)) ||
    !Array.isArray(value.started) ||
    !value.started.every((item) => typeof item === 'string') ||
    !isStampMap(value.unreadable) ||
    !(value.settingsHash === undefined || typeof value.settingsHash === 'string') ||
    !(value.pendingSettings === undefined || isObject(value.pendingSettings)) ||
    !(value.lastError === undefined || typeof value.lastError === 'string') ||
    !(
      value.usage === undefined ||
      (isObject(value.usage) && isCount(value.usage.bytes) && isCount(value.usage.screenshots))
    ) ||
    !OPTIONAL_COUNTS.every((key) => value[key] === undefined || isCount(value[key]))
  ) {
    return undefined;
  }
  const sessions = parseTrack(value.sessions);
  const imageTrack = parseTrack(value.images);
  const owner = isObject(value.images) ? value.images.owner : undefined;
  const docs = parseMap(value.docs, parseDocTrack);
  const held = parseMap(value.held, parseHeld);
  const blocked = parseMap(value.blocked, parseBlocked);
  if (
    sessions === null ||
    imageTrack === null ||
    !isObject(owner) ||
    !Object.values(owner).every((ref) => typeof ref === 'string') ||
    docs === null ||
    held === null ||
    blocked === null
  ) {
    return undefined;
  }
  const meta: CloudSyncMeta = {
    schemaVersion: 2,
    accountId: value.accountId,
    keyId: value.keyId,
    cursor: value.cursor,
    sessions,
    images: { ...imageTrack, owner: { ...(owner as Record<string, string>) } },
    docs,
    started: [...value.started],
    settingsUpdatedAt: value.settingsUpdatedAt,
    settingsDirty: value.settingsDirty,
    held,
    blocked,
    unreadable: { ...value.unreadable },
    conflicts: value.conflicts,
    conflictsNoticed: value.conflictsNoticed,
    lastSyncAt: value.lastSyncAt,
  };
  for (const key of OPTIONAL_COUNTS) {
    const count = value[key];
    if (isCount(count)) {
      meta[key] = count;
    }
  }
  if (value.settingsHash !== undefined) {
    meta.settingsHash = value.settingsHash;
  }
  if (value.pendingSettings !== undefined) {
    meta.pendingSettings = { ...value.pendingSettings };
  }
  if (value.heldNoticed === true) {
    meta.heldNoticed = true;
  }
  if (value.rereadFeed === true) {
    meta.rereadFeed = true;
  }
  if (value.pullIncomplete === true) {
    meta.pullIncomplete = true;
  }
  if (value.lastError !== undefined) {
    meta.lastError = value.lastError;
  }
  if (isObject(value.usage)) {
    meta.usage = {
      bytes: value.usage.bytes as number,
      screenshots: value.usage.screenshots as number,
    };
  }
  return meta;
}

// ---------------------------------------------------------------------------
// Reading and writing (inside the sessions lock when written back)
// ---------------------------------------------------------------------------

export async function readSyncMeta(): Promise<CloudSyncMeta | undefined> {
  const stored = await chrome.storage.local.get(CLOUD_SYNC_META_KEY);
  return parseSyncMeta(stored[CLOUD_SYNC_META_KEY]);
}

export function belongsTo(meta: CloudSyncMeta, context: SyncContext): boolean {
  return meta.accountId === context.account.accountId && meta.keyId === context.key.keyId;
}

export async function readSyncMetaFor(context: SyncContext): Promise<CloudSyncMeta | undefined> {
  const meta = await readSyncMeta();
  return meta !== undefined && belongsTo(meta, context) ? meta : undefined;
}

export async function writeSyncMeta(meta: CloudSyncMeta): Promise<void> {
  await chrome.storage.local.set({ [CLOUD_SYNC_META_KEY]: meta });
}

export function emptyTrack(): RecordTrack {
  return { dirty: {}, deleted: {}, known: {} };
}

/** Fresh bookkeeping for `context`: nothing tracked yet, settings dirty at 0 (8.1, 10.2). Pure. */
export function freshSyncMeta(context: SyncContext): CloudSyncMeta {
  return {
    schemaVersion: 2,
    accountId: context.account.accountId,
    keyId: context.key.keyId,
    cursor: 0,
    sessions: emptyTrack(),
    images: { ...emptyTrack(), owner: {} },
    docs: {},
    started: [],
    settingsUpdatedAt: 0,
    settingsDirty: true,
    held: {},
    blocked: {},
    unreadable: {},
    conflicts: 0,
    conflictsNoticed: 0,
    lastSyncAt: null,
  };
}

/** Every `cloudRaw:*` key in storage. */
export async function listRawKeys(): Promise<string[]> {
  const local = chrome.storage.local as chrome.storage.LocalStorageArea & {
    getKeys?: () => Promise<string[]>;
  };
  const keys =
    typeof local.getKeys === 'function'
      ? await local.getKeys()
      : Object.keys(await local.get(null));
  return keys.filter((key) => key.startsWith(CLOUD_RAW_PREFIX));
}

/**
 * The bookkeeping of `context`, started afresh when there is none or it belongs to another pair
 * (every `cloudRaw:*` is dropped then, in the same `set`). Inside the sessions lock.
 */
export async function ensureSyncMeta(context: SyncContext): Promise<CloudSyncMeta> {
  const existing = await readSyncMetaFor(context);
  if (existing !== undefined) {
    return existing;
  }
  const meta = freshSyncMeta(context);
  const entries: Record<string, unknown> = { [CLOUD_SYNC_META_KEY]: meta };
  for (const key of await listRawKeys()) {
    entries[key] = null;
  }
  await setThenClean(entries);
  return meta;
}

/** After a confirmed deletion: the bookkeeping of `accountId` and every raw copy go. */
export async function dropSyncMetaFor(accountId: string): Promise<void> {
  await withSessionsLock(async () => {
    const meta = await readSyncMeta();
    const entries: Record<string, unknown> = {};
    if (meta === undefined || meta.accountId === accountId) {
      entries[CLOUD_SYNC_META_KEY] = null;
    }
    for (const key of await listRawKeys()) {
      entries[key] = null;
    }
    await setThenClean(entries);
  });
}

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

/**
 * A stamp as it may enter the bookkeeping (8.2): a safe integer of at least 1, else 1; one more
 * than `maxClockAheadMs` ahead of `now` becomes `now`. Pure.
 */
export function stampOf(value: unknown, now: number): number {
  const floored = typeof value === 'number' ? Math.floor(value) : Number.NaN;
  const stamp = Number.isSafeInteger(floored) && floored >= 1 ? floored : 1;
  return stamp > now + POLICY.record.maxClockAheadMs ? now : stamp;
}

/** `meta` with a change of this device's own recorded at `now`, always moving forward. Pure. */
export function withLocalChange(meta: CloudSyncMeta, now: number): CloudSyncMeta {
  return { ...meta, changedAt: Math.max(now, (meta.changedAt ?? 0) + 1) };
}

/** Whether a `storage.onChanged` change of the bookkeeping is a change of this device's own. Pure. */
export function localChangeMade(oldValue: unknown, newValue: unknown): boolean {
  const changedAt = parseSyncMeta(newValue)?.changedAt;
  return changedAt !== undefined && changedAt !== parseSyncMeta(oldValue)?.changedAt;
}

/** Whether `ref` is held at `stamp` (an edit, a new stamp, releases it by itself). Pure. */
export function isHeld(meta: CloudSyncMeta, ref: string, stamp: number): boolean {
  return meta.held[ref]?.stamp === stamp;
}

/** The refs with something to send, held and blocked ones left out. Pure. */
export function pendingRefs(meta: CloudSyncMeta): string[] {
  const refs: string[] = [];
  const add = (ref: string, stamp: number) => {
    if (!isHeld(meta, ref, stamp) && meta.blocked[ref] === undefined) {
      refs.push(ref);
    }
  };
  for (const [id, stamp] of Object.entries(meta.sessions.dirty)) {
    add(`session:${id}`, stamp);
  }
  for (const [id, stamp] of Object.entries(meta.sessions.deleted)) {
    add(`session:${id}`, stamp);
  }
  for (const [id, stamp] of Object.entries(meta.images.dirty)) {
    add(`image:${id}`, stamp);
  }
  for (const [id, stamp] of Object.entries(meta.images.deleted)) {
    add(`image:${id}`, stamp);
  }
  for (const [ref, track] of Object.entries(meta.docs)) {
    if (track.pending !== null) {
      add(ref, track.pending.at);
    }
  }
  return refs;
}

/** Whether something waits to be sent or written (10.2). Pure. */
export function hasPendingWork(meta: CloudSyncMeta): boolean {
  return (
    (meta.settingsDirty && !isHeld(meta, 'settings:settings', meta.settingsUpdatedAt)) ||
    meta.pendingSettings !== undefined ||
    meta.pullIncomplete === true ||
    pendingRefs(meta).length > 0
  );
}

/**
 * Whether the bookkeeping gained something to send between two readings: a pending entry that
 * is new or has a new stamp. Clearing entries, the cursor and results do not count. Pure.
 */
export function syncWorkGrew(oldValue: unknown, newValue: unknown): boolean {
  const next = parseSyncMeta(newValue);
  if (next === undefined) {
    return false;
  }
  const previous = parseSyncMeta(oldValue);
  const grew = (before: Record<string, number> | undefined, after: Record<string, number>) =>
    Object.entries(after).some(([id, stamp]) => before?.[id] !== stamp);
  const docsGrew = Object.entries(next.docs).some(
    ([ref, track]) =>
      track.pending !== null && previous?.docs[ref]?.pending?.at !== track.pending.at,
  );
  return (
    grew(previous?.sessions.dirty, next.sessions.dirty) ||
    grew(previous?.sessions.deleted, next.sessions.deleted) ||
    grew(previous?.images.dirty, next.images.dirty) ||
    grew(previous?.images.deleted, next.images.deleted) ||
    docsGrew ||
    (next.settingsDirty &&
      (previous?.settingsDirty !== true || previous.settingsUpdatedAt !== next.settingsUpdatedAt))
  );
}

/** Saved-session writes for the bookkeeping. */
export interface SessionChanges {
  changed?: readonly (readonly [string, number])[];
  /** Each deleted session with the `updatedAt` it had, so its tombstone is newer than it. */
  deleted?: readonly (readonly [string, number])[];
}

/**
 * `meta` with saved-session `changes` recorded: a change replaces a pending deletion and the
 * other way round. A deletion is stamped `now`, or just after the session's own stamp when that
 * is later; `known` is left alone (10.4). Every stamp is validated (`stampOf()`). Pure.
 */
export function withSessionChanges(
  meta: CloudSyncMeta,
  changes: SessionChanges,
  now: number,
): CloudSyncMeta {
  const sessions: RecordTrack = {
    dirty: { ...meta.sessions.dirty },
    deleted: { ...meta.sessions.deleted },
    known: meta.sessions.known,
  };
  for (const [id, updatedAt] of changes.changed ?? []) {
    sessions.dirty[id] = stampOf(updatedAt, now);
    delete sessions.deleted[id];
  }
  for (const [id, updatedAt] of changes.deleted ?? []) {
    sessions.deleted[id] = Math.max(now, stampOf(updatedAt, now) + 1);
    delete sessions.dirty[id];
  }
  return { ...meta, sessions };
}

/**
 * The bookkeeping entry a saved-session write adds to its own `set`, or nothing: unconfigured,
 * no bookkeeping yet, or no tracking started for sessions. Inside the sessions lock.
 */
export async function stageSessionChanges(
  changes: SessionChanges,
  now: number = Date.now(),
): Promise<Record<string, unknown>> {
  if (!isCloudSyncEnabled()) {
    return {};
  }
  if ((changes.changed?.length ?? 0) === 0 && (changes.deleted?.length ?? 0) === 0) {
    return {};
  }
  const meta = await readSyncMeta();
  if (meta === undefined || !meta.started.includes('session')) {
    return {};
  }
  return { [CLOUD_SYNC_META_KEY]: withLocalChange(withSessionChanges(meta, changes, now), now) };
}

/** `track` with `stamp` remembered as known for `id`, never lowering it. Pure. */
export function withKnown(track: RecordTrack, id: string, stamp: number): RecordTrack {
  const known = track.known[id];
  return known !== undefined && known >= stamp
    ? track
    : { ...track, known: { ...track.known, [id]: stamp } };
}

/** `images` with the same `known` rule. Pure. */
export function withKnownImage(images: ImageTrack, id: string, stamp: number): ImageTrack {
  const known = images.known[id];
  return known !== undefined && known >= stamp
    ? images
    : { ...images, known: { ...images.known, [id]: stamp } };
}

// ---------------------------------------------------------------------------
// Status and notices (for Settings and stage 3)
// ---------------------------------------------------------------------------

/** What Settings > Account shows about syncing. */
export interface SyncStatus {
  lastSyncAt: number | null;
  lastAttemptAt: number | null;
  changedAt: number | null;
  pending: boolean;
  failing: boolean;
  unreadable: number;
  tooLarge: number;
  lastError: string | undefined;
  /** Valid held refs, both reasons. */
  held: number;
  heldByReason: { storage: number; screenshots: number };
  heldNoticed: boolean;
  usage: Usage | null;
  conflicts: number;
  /** The last pull ended with more to read. */
  pullIncomplete: boolean;
}

/** The valid held refs by reason: a held entry counts only while its stamp is the pending one. */
export function heldByReason(meta: CloudSyncMeta): { storage: number; screenshots: number } {
  const counts = { storage: 0, screenshots: 0 };
  for (const [ref, held] of Object.entries(meta.held)) {
    if (pendingStampOf(meta, ref) === held.stamp) {
      if (held.reason === 'storage_limit') {
        counts.storage += 1;
      } else {
        counts.screenshots += 1;
      }
    }
  }
  return counts;
}

/** The stamp `ref` waits to send with, if any. Pure. */
export function pendingStampOf(meta: CloudSyncMeta, ref: string): number | undefined {
  const at = ref.indexOf(':');
  const kind = ref.slice(0, at);
  const id = ref.slice(at + 1);
  if (kind === 'session') {
    return meta.sessions.dirty[id] ?? meta.sessions.deleted[id];
  }
  if (kind === 'image') {
    return meta.images.dirty[id] ?? meta.images.deleted[id];
  }
  if (kind === 'settings') {
    return meta.settingsDirty ? meta.settingsUpdatedAt : undefined;
  }
  return meta.docs[ref]?.pending?.at;
}

export async function loadSyncStatus(): Promise<SyncStatus> {
  const context = await loadSyncContext();
  const meta = context === null ? undefined : await readSyncMetaFor(context);
  const held = meta === undefined ? { storage: 0, screenshots: 0 } : heldByReason(meta);
  return {
    lastSyncAt: meta?.lastSyncAt ?? null,
    lastAttemptAt: meta?.lastAttemptAt ?? null,
    changedAt: meta?.changedAt ?? null,
    pending: meta !== undefined && hasPendingWork(meta),
    failing: (meta?.failures ?? 0) > 0,
    unreadable: Object.keys(meta?.unreadable ?? {}).length,
    tooLarge: meta?.tooLarge ?? 0,
    lastError: meta?.lastError,
    held: held.storage + held.screenshots,
    heldByReason: held,
    heldNoticed: meta?.heldNoticed === true,
    usage: meta?.usage ?? null,
    conflicts: meta?.conflicts ?? 0,
    pullIncomplete: meta?.pullIncomplete === true,
  };
}

/** For stage 3's notices: held refs by reason, and the conflict counts. */
export async function readSyncNotices(): Promise<{
  heldByReason: { storage: number; screenshots: number };
  heldNoticed: boolean;
  conflicts: number;
  conflictsNoticed: number;
}> {
  const meta = await readSyncMeta();
  return {
    heldByReason: meta === undefined ? { storage: 0, screenshots: 0 } : heldByReason(meta),
    heldNoticed: meta?.heldNoticed === true,
    conflicts: meta?.conflicts ?? 0,
    conflictsNoticed: meta?.conflictsNoticed ?? 0,
  };
}

/** Settings said that items are held; again only once the held set next becomes non-empty. */
export async function markHeldNoticed(): Promise<void> {
  await withSessionsLock(async () => {
    const meta = await readSyncMeta();
    if (meta !== undefined && meta.heldNoticed !== true) {
      await writeSyncMeta({ ...meta, heldNoticed: true });
    }
  });
}

/** `conflictsNoticed = max(conflictsNoticed, count)`. */
export async function markConflictsNoticed(count: number): Promise<void> {
  await withSessionsLock(async () => {
    const meta = await readSyncMeta();
    if (meta !== undefined && count > meta.conflictsNoticed) {
      await writeSyncMeta({ ...meta, conflictsNoticed: Math.min(count, meta.conflicts) });
    }
  });
}
