import { POLICY } from '@/constants';
import { isCloudSyncEnabled } from '@/lib/cloud-config';
import {
  readSyncMeta,
  type SessionChanges,
  trackSessionChanges,
  withKnownVersion,
  writeSyncMeta,
} from '@/lib/cloud-sync-state';
import { LocalizedError } from '@/lib/error-message';
import { t } from '@/lib/i18n';
import {
  futureSchemaVersion,
  migrateIndex,
  migrateSession,
  UnknownSchemaVersionError,
} from '@/lib/session-migrate';
import { defaultSessionName } from '@/lib/session-naming';
import {
  DEFAULT_SESSION_SETTINGS,
  SESSION_SCHEMA_VERSION,
  type Session,
  type SessionId,
  type SessionIndex,
  type SessionSettings,
  type SessionSummary,
} from '@/types';

export const INDEX_KEY = 'sessionIndex';
export const SETTINGS_KEY = 'sessionSettings';
export const HISTORY_META_KEY = 'historyMeta';
// The extension's name before Tabinet. Kept: a lock name is shared by every page and the worker,
// so renaming it would let an old page and a new worker write at once during an update.
export const LOCK_NAME = 'tab-organizer:sessions';

const SESSION_KEY_PREFIX = 'session:';

export function sessionKey(id: SessionId): string {
  return `${SESSION_KEY_PREFIX}${id}`;
}

function idFromKey(key: string): string | undefined {
  return key.startsWith(SESSION_KEY_PREFIX) ? key.slice(SESSION_KEY_PREFIX.length) : undefined;
}

// Fallback serialization for runtimes without Web Locks (page-local only).
let fallbackChain: Promise<unknown> = Promise.resolve();

export function withLock<T>(fn: () => Promise<T>): Promise<T> {
  const locks = typeof navigator === 'undefined' ? undefined : navigator.locks;
  if (locks === undefined) {
    const run = fallbackChain.then(fn, fn);
    fallbackChain = run.catch(() => undefined);
    return run;
  }
  return new Promise<T>((resolve, reject) => {
    locks
      .request(LOCK_NAME, async () => {
        try {
          resolve(await fn());
        } catch (err) {
          reject(err);
        }
      })
      .catch(reject);
  });
}

export function toSummary(session: Session, bytes: number): SessionSummary {
  const summary: SessionSummary = {
    id: session.id,
    kind: session.kind,
    name: session.name,
    origin: session.origin,
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
    windowCount: session.windows.length,
    tabCount: session.windows.reduce((count, win) => count + win.tabs.length, 0),
    bytes,
  };
  if (session.protected !== undefined) {
    summary.protected = session.protected;
  }
  if (session.autoProtected !== undefined) {
    summary.autoProtected = session.autoProtected;
  }
  if (session.contentHash !== undefined) {
    summary.contentHash = session.contentHash;
  }
  return summary;
}

function sortNewestFirst(sessions: SessionSummary[]): SessionSummary[] {
  return [...sessions].sort((a, b) => b.updatedAt - a.updatedAt);
}

/** Byte length (not UTF-16 code units) - matches Chrome's quota accounting. */
function byteLength(json: string): number {
  return new TextEncoder().encode(json).length;
}

async function readIndex(): Promise<SessionIndex> {
  const raw: Record<string, unknown> = await chrome.storage.local.get(INDEX_KEY);
  return migrateIndex(raw[INDEX_KEY]);
}

async function writeIndex(sessions: SessionSummary[]): Promise<void> {
  const index: SessionIndex = {
    schemaVersion: SESSION_SCHEMA_VERSION,
    sessions: sortNewestFirst(sessions),
  };
  await chrome.storage.local.set({ [INDEX_KEY]: index });
}

async function readRawBody(id: SessionId): Promise<unknown> {
  const key = sessionKey(id);
  const raw: Record<string, unknown> = await chrome.storage.local.get(key);
  return raw[key];
}

async function readBody(id: SessionId): Promise<Session | undefined> {
  const record = await readRawBody(id);
  if (record === undefined || record === null) {
    return undefined;
  }
  return migrateSession(record);
}

/**
 * Body first, then index: an interruption between the two writes leaves an orphan body
 * (re-indexed by `reconcile()`), never a dangling index entry. The index is read -- and thereby
 * validated -- before the body is written, so an unreadable index fails the call without leaving
 * behind a body nothing can list. Must be called inside withLock.
 */
async function writeBodyAndIndex(body: Session): Promise<void> {
  const index = await readIndex();
  const bytes = byteLength(JSON.stringify(body));
  await chrome.storage.local.set({ [sessionKey(body.id)]: body });
  const others = index.sessions.filter((summary) => summary.id !== body.id);
  await writeIndex([...others, toSummary(body, bytes)]);
}

/** Field-by-field: does the index entry still describe this body? */
function sameSummary(a: SessionSummary, b: SessionSummary): boolean {
  return (
    sameUnreadable(a.unreadable, b.unreadable) &&
    a.kind === b.kind &&
    a.name === b.name &&
    a.origin === b.origin &&
    a.createdAt === b.createdAt &&
    a.updatedAt === b.updatedAt &&
    a.protected === b.protected &&
    a.autoProtected === b.autoProtected &&
    a.contentHash === b.contentHash &&
    a.windowCount === b.windowCount &&
    a.tabCount === b.tabCount &&
    a.bytes === b.bytes
  );
}

/**
 * Compared explicitly rather than by identity: the marker is what makes the row inert, so an
 * entry that gains it (a downgrade) or loses it (the user updated again) must be rewritten.
 */
function sameUnreadable(a: SessionSummary['unreadable'], b: SessionSummary['unreadable']): boolean {
  if (a === undefined || b === undefined) {
    return a === b;
  }
  return a.reason === b.reason && a.version === b.version;
}

/**
 * The index entry for a body this build is too old to read. An existing entry is kept
 * and merely marked -- it was written by this schema and its name and counts are true -- while a
 * body with no entry gets a minimal one built from whatever top-level fields survived: only the
 * `name` is worth showing, and `bytes` is real, so the storage meter still accounts for it.
 *
 * A synthesised entry is `kind: 'saved'`, whatever the record claims: that puts it in the saved
 * list (where the read-only row is rendered) and, more importantly, out of reach of the history
 * ring buffer and of "Delete all unprotected" -- neither of which should be able to delete a
 * session this build cannot even read. Counts are 0 because nothing could count them.
 */
function unreadableSummary(
  id: SessionId,
  record: unknown,
  existing: SessionSummary | undefined,
  version: number,
): SessionSummary {
  const bytes = byteLength(JSON.stringify(record));
  const name = isRecord(record) && typeof record.name === 'string' ? record.name : undefined;
  const base: SessionSummary = existing ?? {
    id,
    kind: 'saved',
    name: name === undefined || name === '' ? t('storageUnnamedSession') : name,
    origin: 'manual',
    createdAt: readTimestamp(record, 'createdAt'),
    updatedAt: readTimestamp(record, 'updatedAt'),
    windowCount: 0,
    tabCount: 0,
    bytes,
  };
  return { ...base, bytes, unreadable: { reason: 'unknown-schema', version } };
}

/** A stored epoch-ms field, or 0 - an unreadable row sorts to the end rather than throwing. */
function readTimestamp(record: unknown, field: string): number {
  if (!isRecord(record)) {
    return 0;
  }
  const value = record[field];
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

async function listStorageKeys(): Promise<string[]> {
  const area = chrome.storage.local;
  if (typeof area.getKeys === 'function') {
    return area.getKeys();
  }
  const all: Record<string, unknown> = await area.get(null);
  return Object.keys(all);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/**
 * The stored snapshot interval as the alarm will use it: a finite number is rounded to whole
 * minutes and clamped into `POLICY.snapshots.intervalMinutes`; anything
 * that is not a number at all falls back to the default.
 */
export function normalizeHistoryInterval(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return DEFAULT_SESSION_SETTINGS.historyIntervalMinutes;
  }
  return Math.min(
    POLICY.snapshots.intervalMinutes.max,
    Math.max(POLICY.snapshots.intervalMinutes.min, Math.round(value)),
  );
}

/** A stored or received `sessionSettings` value, every field validated with its default as fallback. */
export function normalizeSettings(value: unknown): SessionSettings {
  if (!isRecord(value)) {
    return { ...DEFAULT_SESSION_SETTINGS };
  }
  const interval = value.historyIntervalMinutes;
  const max = value.historyMaxSnapshots;
  const lazy = value.restoreLazy;
  return {
    historyEnabled:
      typeof value.historyEnabled === 'boolean'
        ? value.historyEnabled
        : DEFAULT_SESSION_SETTINGS.historyEnabled,
    historyIntervalMinutes: normalizeHistoryInterval(interval),
    historyMaxSnapshots:
      typeof max === 'number' && Number.isInteger(max) && max >= POLICY.snapshots.keep.min
        ? max
        : DEFAULT_SESSION_SETTINGS.historyMaxSnapshots,
    restoreLazy:
      lazy === 'auto' || lazy === 'always' || lazy === 'never'
        ? lazy
        : DEFAULT_SESSION_SETTINGS.restoreLazy,
  };
}

async function readSettings(): Promise<SessionSettings> {
  const raw: Record<string, unknown> = await chrome.storage.local.get(SETTINGS_KEY);
  return normalizeSettings(raw[SETTINGS_KEY]);
}

/** What `sessionRepo.getMany` read: the bodies it could migrate, and why the rest failed. */
interface BatchedBodies {
  bodies: Map<SessionId, Session>;
  /** Ids whose stored record could not be migrated, keyed to the error `migrateSession` threw. */
  failed: Map<SessionId, unknown>;
}

export const sessionRepo = {
  async listSummaries(): Promise<SessionSummary[]> {
    const index = await readIndex();
    return sortNewestFirst(index.sessions);
  },

  get(id: SessionId): Promise<Session | undefined> {
    return readBody(id);
  },

  /**
   * Several bodies in ONE `chrome.storage.local.get([...keys])`: a read that needs more than one
   * body batches them into a single request. The search corpus's idle pre-warm is the caller this
   * exists for.
   *
   * Each record is migrated on its own, so one bad body cannot fail the batch: ids whose body is
   * gone are simply absent from `bodies`, and ids whose record could not be migrated are in
   * `failed` with the error that says why (the caller decides whether that is worth reporting).
   * Duplicate ids are read once. This is a read: it takes no lock and writes nothing.
   */
  async getMany(ids: readonly SessionId[]): Promise<BatchedBodies> {
    const bodies = new Map<SessionId, Session>();
    const failed = new Map<SessionId, unknown>();
    const unique = [...new Set(ids)];
    if (unique.length === 0) {
      return { bodies, failed };
    }
    const records: Record<string, unknown> = await chrome.storage.local.get(
      unique.map((id) => sessionKey(id)),
    );
    for (const id of unique) {
      const record = records[sessionKey(id)];
      if (record === undefined || record === null) {
        continue;
      }
      try {
        bodies.set(id, migrateSession(record));
      } catch (err) {
        failed.set(id, err);
      }
    }
    return { bodies, failed };
  },

  put(session: Session): Promise<void> {
    return withLock(async () => {
      const body: Session = { ...session, updatedAt: Date.now() };
      await writeBodyAndIndex(body);
      await trackSessionChanges(savedChange(body));
    });
  },

  rename(id: SessionId, name: string): Promise<void> {
    return withLock(async () => {
      const existing = await readBody(id);
      if (existing === undefined) {
        throw new LocalizedError(t('storageSessionNotFound', id));
      }
      const next: Session = { ...existing, name };
      stampEdit(existing, next);
      await writeBodyAndIndex(next);
      await trackSessionChanges(savedChange(next));
    });
  },

  /**
   * Read-modify-write of one session under the lock (editing a saved session).
   * `mutate` receives the stored body and returns the replacement, or `null` to delete the session
   * (removing the last window of a session is a delete). The body is rewritten first and the index
   * entry re-derived from it, so counts and `bytes` always describe what is stored.
   *
   * `updatedAt` is written exactly as `mutate` leaves it: an in-place edit keeps the session where
   * it is in the newest-first list instead of jumping it to the top. The exception is a build with
   * cloud sync configured, where an edit to a saved session moves `updatedAt` forward (`stampEdit`):
   * the server keeps the copy with the newest `updatedAt`, so an edit that kept it would be lost.
   * Resolves with the session as written, or `null` when it was deleted; throws when `id` has no
   * body.
   */
  update(id: SessionId, mutate: (session: Session) => Session | null): Promise<Session | null> {
    return withLock(async () => {
      const existing = await readBody(id);
      if (existing === undefined) {
        throw new LocalizedError(t('storageSessionNotFound', id));
      }
      const next = mutate(existing);
      if (next === null) {
        // Same path as remove(): body, index, then the `historyMeta` staleness check.
        await removeBodiesAndIndex(await readIndex(), [id]);
        await trackSessionChanges(savedDeletion([existing]));
        return null;
      }
      if (next.id !== id) {
        // Would write the body under a different key and leave the original orphaned.
        throw new TypeError(`update() must not change the session id (${id} -> ${next.id})`);
      }
      stampEdit(existing, next);
      await writeBodyAndIndex(next);
      await trackSessionChanges(savedChange(next));
      return next;
    });
  },

  remove(id: SessionId): Promise<void> {
    return withLock(async () => {
      // Index read first (validated), then body, then index -- see writeBodyAndIndex. Deleting a
      // single snapshot goes through the same helper as pruneHistory/removeAllHistory so it too
      // drops a `historyMeta` left fingerprinting the snapshot just removed: otherwise the next
      // alarm compares against a hash nothing holds and returns 'skipped-unchanged' forever.
      const index = await readIndex();
      await removeBodiesAndIndex(index, [id]);
      await trackSessionChanges(savedDeletion(index.sessions.filter((entry) => entry.id === id)));
    });
  },

  removeAll(): Promise<void> {
    return withLock(async () => {
      // Read before anything is removed, for the tombstones; an unreadable index has no saved
      // sessions to tell the server about.
      let saved: SessionSummary[] = [];
      try {
        saved = (await readIndex()).sessions;
      } catch {
        saved = [];
      }
      const keys = await listStorageKeys();
      const bodyKeys = keys.filter((key) => idFromKey(key) !== undefined);
      if (bodyKeys.length > 0) {
        await chrome.storage.local.remove(bodyKeys);
      }
      await chrome.storage.local.remove([INDEX_KEY, HISTORY_META_KEY]);
      await trackSessionChanges(savedDeletion(saved));
    });
  },

  /**
   * Applies a change received from the sync server (`src/lib/cloud-sync.ts`): a saved session, or
   * the tombstone of one. Not recorded in the dirty sets, because it came from the server. Last
   * writer wins by `updatedAt`, decided here under the lock against the copy as it is now:
   *
   * - the remote change is newer (or `serverWinsTies` and equally new, for a `stale` answer): the
   *   session is written, or deleted, with the server's `updatedAt` kept exactly, and any pending
   *   entry of this device for it is dropped (`'applied'`);
   * - this device's copy (or pending tombstone) is newer: nothing is written and the copy is made
   *   pending if it was not, so the server gets it on the next push (`'kept-local'`);
   * - the same `updatedAt` (this device's own write coming back), nothing to delete, a snapshot,
   *   or a body this build cannot read: nothing happens (`'unchanged'`). A snapshot or an unreadable
   *   body is never overwritten or deleted by a remote change.
   *
   * With no copy here, the bar is the pending tombstone and `knownVersions`, the newest version of
   * the id this device ever applied, deleted or had accepted: a live record must be strictly newer
   * (no tie, even for a `stale` answer), so a server replaying a deleted session's last record
   * byte for byte cannot bring it back. A remote tombstone with no copy here deletes nothing; it
   * raises the mark and settles a pending tombstone that is not newer than it.
   */
  applyRemote(change: RemoteSessionChange, options: { serverWinsTies?: boolean } = {}) {
    return withLock(async (): Promise<RemoteApplyOutcome> => {
      const id = change.type === 'session' ? change.session.id : change.id;
      const remoteAt = change.type === 'session' ? change.session.updatedAt : change.updatedAt;
      const index = await readIndex();
      const summary = index.sessions.find((entry) => entry.id === id);
      if (summary !== undefined && (summary.kind === 'history' || summary.unreadable)) {
        return 'unchanged';
      }
      let local: Session | undefined;
      try {
        local = await readBody(id);
      } catch {
        return 'unchanged';
      }
      if (local !== undefined && local.kind !== 'saved') {
        return 'unchanged';
      }
      const meta = await readSyncMeta();
      const tombstone = meta?.deletedSessions[id];

      if (local === undefined) {
        // Nothing here: the floor is this device's pending deletion and the newest version it has
        // ever known of the id. A record at or below it is old, whatever the server says: that is
        // what keeps a replay of a deleted session's last live record from bringing it back.
        const floors = [tombstone, meta?.knownVersions[id]].filter((at) => at !== undefined);
        const floor = floors.length > 0 ? Math.max(...floors) : undefined;
        if (change.type === 'deleted') {
          // Nothing to delete. A deletion at or after the pending one settles it.
          if (meta !== undefined) {
            let next = withKnownVersion(meta, id, remoteAt);
            if (tombstone !== undefined && remoteAt >= tombstone) {
              const deletedSessions = { ...next.deletedSessions };
              delete deletedSessions[id];
              next = { ...next, deletedSessions };
            }
            if (next !== meta) {
              await writeSyncMeta(next);
            }
          }
          return tombstone !== undefined && remoteAt < tombstone ? 'kept-local' : 'unchanged';
        }
        if (floor !== undefined && remoteAt <= floor) {
          return tombstone !== undefined ? 'kept-local' : 'unchanged';
        }
        await writeBodyAndIndex(change.session);
        await settleRemote(id, remoteAt);
        return 'applied';
      }

      const localAt = Math.max(local.updatedAt, tombstone ?? 0);
      const remoteWins =
        remoteAt > localAt || (options.serverWinsTies === true && remoteAt === localAt);

      if (!remoteWins) {
        if (localAt > remoteAt && meta !== undefined) {
          if (meta.dirtySessions[id] === undefined && tombstone === undefined) {
            await writeSyncMeta({
              ...meta,
              dirtySessions: { ...meta.dirtySessions, [id]: local.updatedAt },
            });
          }
          return 'kept-local';
        }
        return localAt > remoteAt ? 'kept-local' : 'unchanged';
      }

      if (change.type === 'session') {
        await writeBodyAndIndex(change.session);
      } else {
        await removeBodiesAndIndex(index, [id]);
      }
      await settleRemote(id, remoteAt);
      return 'applied';
    });
  },

  /**
   * Repairs the index from the bodies: drops entries whose body is gone, re-indexes
   * orphan bodies (a `put` interrupted between its two writes) and re-derives entries that no
   * longer describe their body (a `rename` interrupted the same way). A malformed body is
   * skipped, keeping whatever index entry it had.
   *
   * A body written by a *newer* schema version is the one failure that is kept rather than
   * skipped: its entry is marked `unreadable` -- synthesising one when the body has no
   * entry at all -- so the dashboard can list it as an inert row the user can still delete.
   * Skipping it instead was the real hazard: after a downgrade the index is itself unreadable,
   * this pass rebuilds it from the bodies, and every skipped body would vanish from the list
   * while sitting untouched on disk, with nothing to tell the user why.
   *
   * This is the one read path that tolerates an unreadable index (future schema version, or
   * garbage): it is the repair path, so it treats such an index as empty and rebuilds it from
   * the bodies -- which are validated one at a time below, so a damaged index costs nothing but
   * the entries of bodies that are themselves damaged. Reading it strictly instead would be
   * self-perpetuating: every reconcile() would throw on the same index and nothing would ever
   * repair it. Mutations (`put`/`remove`/`listSummaries`) keep rejecting -- see writeBodyAndIndex.
   */
  reconcile(): Promise<{ reindexed: number; dropped: number }> {
    return withLock(async () => {
      const keys = await listStorageKeys();
      const ids = keys
        .map((key) => idFromKey(key))
        .filter((id): id is SessionId => id !== undefined);
      const bodyIds = new Set(ids);

      let indexUnreadable = false;
      let index: SessionIndex;
      try {
        index = await readIndex();
      } catch {
        indexUnreadable = true;
        index = { schemaVersion: SESSION_SCHEMA_VERSION, sessions: [] };
      }
      const indexed = new Map(index.sessions.map((summary) => [summary.id, summary]));
      const dropped = index.sessions.filter((summary) => !bodyIds.has(summary.id)).length;

      const records: Record<string, unknown> =
        ids.length > 0 ? await chrome.storage.local.get(ids.map((id) => sessionKey(id))) : {};
      const kept: SessionSummary[] = [];
      let reindexed = 0;
      for (const id of ids) {
        const record = records[sessionKey(id)];
        const existing = indexed.get(id);
        let summary: SessionSummary;
        try {
          // toSummary is inside the try too: a malformed nested window (e.g. `windows: [null]`)
          // passes migrateSession's shallow checks and must cost this body only, not the pass.
          summary = toSummary(migrateSession(record), byteLength(JSON.stringify(record)));
        } catch (err) {
          const version = futureSchemaVersion(err);
          if (version === undefined) {
            // Damaged, not from the future: nothing readable to show, so it keeps its old entry
            // (if any) and is otherwise left out, exactly as before.
            if (existing !== undefined) {
              kept.push(existing);
            }
            continue;
          }
          summary = unreadableSummary(id, record, existing, version);
        }
        if (existing !== undefined && sameSummary(existing, summary)) {
          kept.push(existing);
          continue;
        }
        kept.push(summary);
        reindexed += 1;
      }

      // Forced when the stored index could not be read: with no bodies at all (or only
      // unmigratable ones) both counters stay 0, and skipping the write would leave the damaged
      // index in place forever.
      if (reindexed > 0 || dropped > 0 || indexUnreadable) {
        await writeIndex(kept);
      }
      return { reindexed, dropped };
    });
  },

  /**
   * Eager migration pass over every stored session body (e.g. on extension update). For schema
   * v1 `migrateSession` is the identity, so nothing is rewritten today; this is forward-looking
   * for a future schema bump. A body that fails migration (unknown schema version, or malformed)
   * is left untouched and not counted - reconcile()/read-time migration handle it from there.
   */
  migrateAll(): Promise<{ migrated: number }> {
    return withLock(async () => {
      const keys = await listStorageKeys();
      const ids = keys
        .map((key) => idFromKey(key))
        .filter((id): id is SessionId => id !== undefined);

      const index = await readIndex();
      const summaries = new Map(index.sessions.map((summary) => [summary.id, summary]));

      let migrated = 0;
      let indexChanged = false;
      for (const id of ids) {
        const raw = await readRawBody(id);
        if (raw === undefined) {
          continue;
        }
        let session: Session;
        try {
          session = migrateSession(raw);
        } catch (err) {
          if (err instanceof UnknownSchemaVersionError || err instanceof TypeError) {
            continue;
          }
          throw err;
        }
        const migratedJson = JSON.stringify(session);
        if (migratedJson === JSON.stringify(raw)) {
          continue;
        }
        await chrome.storage.local.set({ [sessionKey(id)]: session });
        summaries.set(id, toSummary(session, byteLength(migratedJson)));
        migrated += 1;
        indexChanged = true;
      }

      if (indexChanged) {
        await writeIndex([...summaries.values()]);
      }
      return { migrated };
    });
  },

  getSettings(): Promise<SessionSettings> {
    return readSettings();
  },

  setSettings(patch: Partial<SessionSettings>): Promise<void> {
    return withLock(async () => {
      const current = await readSettings();
      const next: SessionSettings = normalizeSettings({ ...current, ...patch });
      await chrome.storage.local.set({ [SETTINGS_KEY]: next });
    });
  },

  // ---- History snapshots (`historyMeta`) ----

  /** `historyMeta` - dedupe baseline for `takeHistorySnapshot()`; `undefined` until the first snapshot. */
  getHistoryMeta(): Promise<HistoryMeta | undefined> {
    return readHistoryMeta();
  },

  setHistoryMeta(meta: HistoryMeta): Promise<void> {
    return withLock(async () => {
      await chrome.storage.local.set({ [HISTORY_META_KEY]: meta });
    });
  },

  /**
   * Ring buffer: keeps the newest `max` unprotected `kind: 'history'` sessions and removes the
   * rest, oldest first. Never touches `kind: 'saved'` or protected snapshots. Returns the removed
   * ids (oldest first); the index is rewritten once, under a single lock.
   */
  pruneHistory(max: number): Promise<SessionId[]> {
    return withLock(async () => {
      const index = await readIndex();
      const unprotected = index.sessions.filter(isUnprotectedHistory).sort(oldestFirst);
      const excess = unprotected.length - Math.max(0, Math.floor(max));
      if (excess <= 0) {
        return [];
      }
      const ids = unprotected.slice(0, excess).map((summary) => summary.id);
      await removeBodiesAndIndex(index, ids);
      return ids;
    });
  },

  /**
   * Turns a history snapshot into the crash-recovery entry: `origin: 'recovered'`, protected,
   * renamed. `updatedAt` is kept so the snapshot stays in its chronological place in the index.
   * The pin is marked `autoProtected` so `demoteAutoProtected()` can later tell it apart.
   */
  markRecovered(id: SessionId, name: string): Promise<void> {
    return updateBody(id, (existing) => ({
      ...existing,
      origin: 'recovered',
      protected: true,
      autoProtected: true,
      name,
    }));
  },

  /**
   * Caps the pins crash recovery hands out: keeps the `keep` newest `autoProtected` snapshots
   * and clears `protected`/`autoProtected` on the rest, which puts them back in the ring buffer's
   * reach (they are demoted, never deleted here -- the ring ages them out like any other
   * snapshot, and "Delete all unprotected" can reach them). Without it every browser start would
   * add one permanently exempt snapshot: total history would be `historyMaxSnapshots` + one per
   * start, growing without bound, and neither remedy the storage meter names could touch them.
   *
   * A snapshot protected some other way is never touched: `isPromotable` never nominates an
   * already-protected snapshot, so `autoProtected` can only ever be true on a pin nobody asked for. Newest is by capture time, like the ring buffer.
   * One lock for the whole pass: N body writes, then a single index write. Returns the demoted
   * ids (newest first).
   */
  demoteAutoProtected(keep: number): Promise<SessionId[]> {
    return withLock(async () => {
      const index = await readIndex();
      const pinned = index.sessions
        .filter((summary) => summary.autoProtected === true)
        .sort(newestFirst);
      const stale = pinned.slice(Math.max(0, Math.floor(keep)));
      if (stale.length === 0) {
        return [];
      }
      const summaries = new Map(index.sessions.map((summary) => [summary.id, summary]));
      const demoted: SessionId[] = [];
      for (const summary of stale) {
        let body: Session | undefined;
        try {
          body = await readBody(summary.id);
        } catch {
          // A body that no longer migrates keeps its index entry (as in reconcile): skipping it
          // costs one stale pin, rewriting it blindly would cost the snapshot.
          continue;
        }
        if (body === undefined) {
          continue;
        }
        const next: Session = { ...body, protected: false };
        delete next.autoProtected;
        await chrome.storage.local.set({ [sessionKey(next.id)]: next });
        summaries.set(next.id, toSummary(next, byteLength(JSON.stringify(next))));
        demoted.push(next.id);
      }
      if (demoted.length > 0) {
        await writeIndex([...summaries.values()]);
      }
      return demoted;
    });
  },

  /**
   * "Save as session": copies a (history) session into a brand-new `kind: 'saved'` session with
   * a fresh id, `origin: 'manual'`, `createdAt`/`updatedAt` = now and no `protected` flag. The
   * source is left untouched. Default name: the saved-session form stamped with the source's
   * capture time ("Session 2026-08-29 14:03 · 3 windows · 87 tabs").
   */
  duplicateAsSaved(id: SessionId, name?: string): Promise<Session> {
    return withLock(async () => {
      const source = await readBody(id);
      if (source === undefined) {
        throw new LocalizedError(t('storageSessionNotFound', id));
      }
      const now = Date.now();
      const tabCount = source.windows.reduce((count, win) => count + win.tabs.length, 0);
      const copy: Session = {
        schemaVersion: SESSION_SCHEMA_VERSION,
        id: crypto.randomUUID(),
        kind: 'saved',
        name:
          name ?? defaultSessionName(new Date(source.createdAt), source.windows.length, tabCount),
        origin: 'manual',
        createdAt: now,
        updatedAt: now,
        windows: source.windows,
      };
      if (source.contentHash !== undefined) {
        copy.contentHash = source.contentHash;
      }
      await writeBodyAndIndex(copy);
      await trackSessionChanges(savedChange(copy));
      return copy;
    });
  },

  /**
   * Deletes every `kind: 'history'` session (only the unprotected ones when `unprotectedOnly`).
   * Saved sessions are never touched. Returns the removed ids.
   */
  removeAllHistory(options: { unprotectedOnly: boolean }): Promise<SessionId[]> {
    return withLock(async () => {
      const index = await readIndex();
      const ids = index.sessions
        .filter((summary) =>
          options.unprotectedOnly ? isUnprotectedHistory(summary) : isHistory(summary),
        )
        .map((summary) => summary.id);
      await removeBodiesAndIndex(index, ids);
      return ids;
    });
  },
};

// ---------------------------------------------------------------------------
// Cloud sync hooks (src/lib/cloud-sync-state.ts holds the bookkeeping)
// ---------------------------------------------------------------------------

/** A change received from the sync server, for `sessionRepo.applyRemote()`. */
export type RemoteSessionChange =
  | { type: 'session'; session: Session }
  | { type: 'deleted'; id: SessionId; updatedAt: number };

export type RemoteApplyOutcome = 'applied' | 'kept-local' | 'unchanged';

/**
 * After a remote change was applied: this device's pending entries for `id` are dropped (the
 * remote change replaced them) and `remoteAt` is remembered in `knownVersions`. Inside the lock.
 */
async function settleRemote(id: SessionId, remoteAt: number): Promise<void> {
  const current = await readSyncMeta();
  if (current === undefined) {
    return;
  }
  const dirtySessions = { ...current.dirtySessions };
  const deletedSessions = { ...current.deletedSessions };
  delete dirtySessions[id];
  delete deletedSessions[id];
  await writeSyncMeta(
    withKnownVersion({ ...current, dirtySessions, deletedSessions }, id, remoteAt),
  );
}

/** The dirty-set entry for a written session: saved sessions only, snapshots never sync. */
function savedChange(session: Session): SessionChanges {
  return session.kind === 'saved' ? { changed: [[session.id, session.updatedAt]] } : {};
}

/** The tombstones for removed sessions: saved ones only. */
function savedDeletion(removed: readonly (Session | SessionSummary)[]): SessionChanges {
  return {
    deleted: removed
      .filter((entry) => entry.kind === 'saved')
      .map((entry) => [entry.id, entry.updatedAt] as const),
  };
}

/**
 * With cloud sync configured, an edit to a saved session moves its `updatedAt` forward (to now,
 * and always past the old value), so the server's last-writer-wins rule keeps the edit. Without it
 * nothing changes: an edit keeps the session's place in the list, as it always has.
 */
function stampEdit(previous: Session, next: Session): void {
  if (next.kind === 'saved' && isCloudSyncEnabled()) {
    next.updatedAt = Math.max(Date.now(), previous.updatedAt + 1);
  }
}

// ---------------------------------------------------------------------------
// History snapshot helpers
// ---------------------------------------------------------------------------

/** `chrome.storage.local` key `historyMeta`. */
interface HistoryMeta {
  /** `contentHash` of the newest history snapshot; identical captures are skipped. */
  lastHash: string;
  /** Epoch ms of that snapshot's write. */
  lastSnapshotAt: number;
}

function normalizeHistoryMeta(value: unknown): HistoryMeta | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  if (typeof value.lastHash !== 'string' || typeof value.lastSnapshotAt !== 'number') {
    return undefined;
  }
  return { lastHash: value.lastHash, lastSnapshotAt: value.lastSnapshotAt };
}

async function readHistoryMeta(): Promise<HistoryMeta | undefined> {
  const raw: Record<string, unknown> = await chrome.storage.local.get(HISTORY_META_KEY);
  return normalizeHistoryMeta(raw[HISTORY_META_KEY]);
}

function isHistory(summary: SessionSummary): boolean {
  return summary.kind === 'history';
}

function isUnprotectedHistory(summary: SessionSummary): boolean {
  return isHistory(summary) && summary.protected !== true;
}

/** Capture time decides age (rename/protect keep `updatedAt`, but `createdAt` never moves). */
function oldestFirst(a: SessionSummary, b: SessionSummary): number {
  return a.createdAt - b.createdAt || a.updatedAt - b.updatedAt || a.id.localeCompare(b.id);
}

function newestFirst(a: SessionSummary, b: SessionSummary): number {
  return -oldestFirst(a, b);
}

/** Read-modify-write of one body and its summary under the lock. Not for use inside withLock. */
function updateBody(id: SessionId, update: (existing: Session) => Session): Promise<void> {
  return withLock(async () => {
    const existing = await readBody(id);
    if (existing === undefined) {
      throw new LocalizedError(t('storageSessionNotFound', id));
    }
    await writeBodyAndIndex(update(existing));
  });
}

/**
 * Delete order: bodies first, then the index, then drop `historyMeta` when the
 * snapshot it fingerprints is gone - otherwise the next `takeHistorySnapshot()` would skip a
 * state that no stored snapshot holds any more. Must be called inside withLock.
 */
async function removeBodiesAndIndex(index: SessionIndex, ids: SessionId[]): Promise<void> {
  if (ids.length === 0) {
    return;
  }
  await chrome.storage.local.remove(ids.map((id) => sessionKey(id)));
  const removed = new Set(ids);
  const remaining = index.sessions.filter((summary) => !removed.has(summary.id));
  await writeIndex(remaining);

  const meta = await readHistoryMeta();
  if (meta === undefined) {
    return;
  }
  const stillHeld = remaining.some(
    (summary) => isHistory(summary) && summary.contentHash === meta.lastHash,
  );
  if (!stillHeld) {
    await chrome.storage.local.remove(HISTORY_META_KEY);
  }
}
