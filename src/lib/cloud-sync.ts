/**
 * The cloud sync engine, protocol v2 (spec section 10): moves saved sessions, the settings, doc
 * collections (`DOC_STORES`) and their screenshots between this device and the sync server, end
 * to end encrypted with the data key. Snapshots never sync.
 *
 * One run (`syncNow()`, 10.2): the bookkeeping of this `(accountId, keyId)`, tracking started for
 * what is not tracked yet, held items retried, received settings finished, then the pull: the
 * NDJSON feed read batch by batch, each batch decrypted and checked outside the locks, applied
 * store by store in one write each, and only then the cursor stored (10.3, 10.6). A pull without
 * its end line fails the run before any push (invariant 6). Then the restamp of what is too far
 * ahead (10.4) and the push passes, deletions first (10.7).
 *
 * The server is not trusted: every record is decrypted against its metadata, a doc's envelope and
 * HMAC id are checked, and what cannot be read is never applied (`unreadable`), while what this
 * build cannot apply is held with its raw record (`blocked`, 8.3). Network calls never run inside a
 * lock (invariant 11). The settings apply path is the one place sessions code writes
 * `chrome.storage.sync`. Everything is a no-op while cloud sync is unconfigured.
 */
import { POLICY } from '@/constants';
import {
  type CloudApiOptions,
  CloudHttpError,
  CloudTimeoutError,
  CloudUnauthorizedError,
  inWorker,
  isValidRecordId,
  postRecords,
  streamRecords,
} from '@/lib/cloud-api';
import { isCloudSyncEnabled } from '@/lib/cloud-config';
import { CloudDecryptError, decryptRecord, encryptRecord } from '@/lib/cloud-crypto';
import {
  type AnyDocStore,
  applyDocBatch,
  type DocTx,
  checkDoc,
  type DecodedDoc,
  docRef,
  readOutgoingDocs,
  StaleMetaError,
  startDocTracking,
} from '@/lib/cloud-docs';
import {
  CLOUD_ACCOUNT_KEY,
  CLOUD_KEY_KEY,
  cloudRawKey,
  cloudStoredFrom,
  removeAccountIfToken,
  setThenClean,
  withSessionsLock,
} from '@/lib/cloud-storage';
import { upgradeCloudStorage } from '@/lib/cloud-storage';
import {
  CLOUD_SYNC_META_KEY,
  type CloudSyncMeta,
  ensureSyncMeta,
  hasPendingWork,
  isHeld,
  loadSyncContext,
  localChangeMade,
  readSyncMeta,
  readSyncMetaFor,
  type SyncContext,
  syncWorkGrew,
  withKnown,
  withKnownImage,
  withLocalChange,
  writeSyncMeta,
} from '@/lib/cloud-sync-state';
import { DOC_STORES } from '@/lib/doc-collections';
import { errorMessage, ExplainedError } from '@/lib/error-message';
import { uiLanguageReady } from '@/lib/i18n';
import { isRecord, isSession } from '@/lib/import-guards';
import { fnv1a32 } from '@/lib/session-hash';
import {
  normalizeSettings,
  type RemoteSessionChange,
  SETTINGS_KEY,
  sessionRepo,
} from '@/lib/session-repo';
import { parseSortSettings, SORT_SETTING_KEYS } from '@/lib/sort-settings';
import { parseUiLanguage, UI_LANGUAGE_KEY, type UiLanguage } from '@/lib/ui-language';
import { isImageDataUrl } from '@/lib/youtube-video';
import type {
  RecordIn,
  RecordKind,
  RecordOut,
  Session,
  SessionSettings,
  SortSettings,
  Usage,
  WriteResult,
} from '@/types';

/** The periodic sync alarm, every `POLICY.sync.periodMinutes` while ready. */
export const CLOUD_SYNC_ALARM = 'cloud-sync';
/** The one-shot alarm behind the debounce timer (which dies with the worker), and for retries. */
export const CLOUD_SYNC_SOON_ALARM = 'cloud-sync-soon';
/** How often another device's changes are looked for. */
export const SYNC_PERIOD_MINUTES = POLICY.sync.periodMinutes;
/** The shortest delay Chrome accepts for an alarm (Chrome 120+). */
export const SYNC_FALLBACK_MS = POLICY.sync.fallbackMs;
/** The Web Lock one sync holds from start to end, shared by the page and the worker. */
export const SYNC_LOCK_NAME = 'tabinet:cloud-sync';
/** What the largest ciphertext the server accepts leaves for one item, in KB, for Settings. */
export const SYNC_ITEM_MAX_KB = Math.floor((POLICY.record.maxCiphertextBytes * 3) / 4 / 1024);

const SETTINGS_ID = 'settings';
const SETTINGS_REF = 'settings:settings';
const TOMBSTONE = { deleted: true } as const;

/** The wait after the `failures`th failed run in a row: 30 seconds, doubled up to the period. Pure. */
export function retryDelayMs(failures: number): number {
  return Math.min(SYNC_FALLBACK_MS * 2 ** (failures - 1), SYNC_PERIOD_MINUTES * 60_000);
}

/** How long an automatic run still has to wait for `retryAt`; none while nothing fails. Pure. */
export function retryWaitMs(meta: CloudSyncMeta, now: number): number {
  if ((meta.failures ?? 0) === 0 || meta.retryAt === undefined) {
    return 0;
  }
  const wait = meta.retryAt - now;
  return wait > 1000 && wait <= SYNC_PERIOD_MINUTES * 60_000 ? wait : 0;
}

/** The settings as they travel inside the settings record. */
export interface SyncedSettings {
  sort: SortSettings;
  sessionSettings: SessionSettings;
  uiLanguage: UiLanguage;
}

export interface SyncResult {
  outcome: 'synced' | 'skipped' | 'notReady' | 'failed';
  /** Remote changes applied on this device. */
  pulled: number;
  /** Local changes the server accepted. */
  pushed: number;
}

export interface SyncOptions extends CloudApiOptions {
  /** Run only if still called for once the sync lock is ours (see `stillCalledFor()`). */
  onlyIf?: 'changed' | 'due' | 'periodic';
  /** The doc stores; `DOC_STORES` when omitted (tests pass their own collections). */
  stores?: readonly AnyDocStore[];
}

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

export function parseSyncedSettings(value: unknown): SyncedSettings | null {
  if (!isRecord(value)) {
    return null;
  }
  return {
    sort: parseSortSettings(value.sort),
    sessionSettings: normalizeSettings(value.sessionSettings),
    uiLanguage: parseUiLanguage(value.uiLanguage),
  };
}

/** A stable fingerprint of the settings, field by field in a fixed order. Pure. */
export function settingsFingerprint(settings: SyncedSettings): string {
  const { sessionSettings: session } = settings;
  return fnv1a32(
    JSON.stringify([
      SORT_SETTING_KEYS.map((key) => settings.sort[key]),
      [
        session.historyEnabled,
        session.historyIntervalMinutes,
        session.historyMaxSnapshots,
        session.restoreLazy,
      ],
      settings.uiLanguage,
    ]),
  );
}

/** A received session body as a saved session with the record's id, or `null`. Pure. */
export function parseSyncedSession(value: unknown, id: string): Session | null {
  return isSession(value) && value.kind === 'saved' && value.id === id ? value : null;
}

function utf8Length(text: string): number {
  return new TextEncoder().encode(text).length;
}

/** The bytes `record` adds to a `POST /v2/records` body (its JSON and a comma). */
export function recordBytes(record: RecordIn): number {
  return utf8Length(JSON.stringify(record)) + 1;
}

/** Splits `records` into bodies of at most `maxCount` records and `maxBytes` bytes, in order. Pure. */
export function splitIntoBatches<T extends RecordIn>(
  records: readonly T[],
  maxCount: number = POLICY.request.maxRecordsPerPush,
  maxBytes: number = POLICY.request.pushBatchBytes,
): T[][] {
  const envelope = utf8Length('{"records":[]}');
  const batches: T[][] = [];
  let current: T[] = [];
  let bytes = envelope;
  for (const record of records) {
    const size = recordBytes(record);
    if (current.length > 0 && (current.length >= maxCount || bytes + size > maxBytes)) {
      batches.push(current);
      current = [];
      bytes = envelope;
    }
    current.push(record);
    bytes += size;
  }
  if (current.length > 0) {
    batches.push(current);
  }
  return batches;
}

function isTombstonePayload(value: unknown): boolean {
  return isRecord(value) && Object.keys(value).length === 1 && value.deleted === true;
}

/** An item too large for the server: it stays on this device and the run reports it. */
class ItemTooLargeError extends ExplainedError {
  constructor(ref: string) {
    super(`${ref} is over the server's record size`, 'errorCloudItemTooLarge');
    this.name = 'ItemTooLargeError';
  }
}

// ---------------------------------------------------------------------------
// Settings (the one chrome.storage.sync access of sessions code)
// ---------------------------------------------------------------------------

export async function readLocalSettings(): Promise<SyncedSettings> {
  const stored: Record<string, unknown> = await chrome.storage.sync.get([
    ...SORT_SETTING_KEYS,
    UI_LANGUAGE_KEY,
  ]);
  return {
    sort: parseSortSettings(stored),
    sessionSettings: await sessionRepo.getSettings(),
    uiLanguage: parseUiLanguage(stored[UI_LANGUAGE_KEY]),
  };
}

/**
 * `meta` with the settings marked clean or dirty for `currentHash`, `meta` itself when nothing
 * changes. A real change stamps them now; a `'check'` only marks settings that differ. Pure.
 */
export function settingsState(
  meta: CloudSyncMeta,
  currentHash: string,
  reason: 'changed' | 'check',
  now: number,
): CloudSyncMeta {
  if (meta.settingsHash !== undefined && currentHash === meta.settingsHash) {
    const syncedAt = meta.settingsSyncedAt ?? meta.settingsUpdatedAt;
    if (!meta.settingsDirty && meta.settingsUpdatedAt === syncedAt) {
      return meta;
    }
    return { ...meta, settingsDirty: false, settingsUpdatedAt: syncedAt };
  }
  if (reason === 'check' && meta.settingsDirty) {
    return meta;
  }
  return {
    ...meta,
    settingsDirty: true,
    settingsUpdatedAt: Math.max(now, meta.settingsUpdatedAt + 1),
  };
}

/**
 * Brings `settingsDirty` in line with the settings as they are now (state-based, so applying the
 * server's settings cannot echo). Nothing is marked while received settings are still being
 * written; returns whether such an apply is pending.
 */
export async function noteSettingsChange(
  reason: 'changed' | 'check' = 'changed',
  now: number = Date.now(),
): Promise<boolean> {
  if (!isCloudSyncEnabled()) {
    return false;
  }
  return withSessionsLock(async () => {
    const meta = await readSyncMeta();
    if (meta === undefined) {
      return false;
    }
    if (meta.pendingSettings !== undefined) {
      return true;
    }
    const next = settingsState(meta, settingsFingerprint(await readLocalSettings()), reason, now);
    if (next !== meta) {
      const edited = reason === 'changed' && next.settingsDirty;
      await writeSyncMeta(edited ? withLocalChange(next, now) : next);
    }
    return false;
  });
}

// ---------------------------------------------------------------------------
// The run
// ---------------------------------------------------------------------------

function withSyncLock<T>(fn: () => Promise<T>): Promise<T> {
  const locks = typeof navigator === 'undefined' ? undefined : navigator.locks;
  if (locks === undefined) {
    return fn();
  }
  return locks.request(SYNC_LOCK_NAME, fn);
}

/** The run's account or key is no longer the stored one: it sends and applies nothing more. */
class StaleRunError extends Error {
  constructor() {
    super('The account or key changed during the sync');
    this.name = 'StaleRunError';
  }
}

async function isCurrent(context: SyncContext): Promise<boolean> {
  const stored = await loadSyncContext();
  return (
    stored !== null &&
    stored.account.token === context.account.token &&
    stored.account.accountId === context.account.accountId &&
    stored.key.keyId === context.key.keyId &&
    stored.key.dek === context.key.dek
  );
}

async function assertCurrent(context: SyncContext): Promise<void> {
  if (!(await isCurrent(context))) {
    throw new StaleRunError();
  }
}

interface RunState {
  context: SyncContext;
  options: SyncOptions;
  stores: readonly AnyDocStore[];
  worker: boolean;
  startedAt: number;
  pulled: number;
  pushed: number;
  problems: unknown[];
  /** The bookkeeping as the push read it: work that appears after it needs another run. */
  collected?: CloudSyncMeta;
  /** Whether the run already reset the backoff on its first progress. */
  progressed: boolean;
  /** The latest usage the server reported. */
  usage?: Usage;
  /** A held item was released during this run. */
  released: boolean;
}

const belongsTo = (run: RunState) => (meta: CloudSyncMeta) =>
  meta.accountId === run.context.account.accountId && meta.keyId === run.context.key.keyId;

/**
 * Read-modify-write of the run's bookkeeping under the sessions lock. The first write that
 * records progress also resets the backoff (10.1): `failures = 1`, a retry 30 s out.
 */
async function updateMeta(
  run: RunState,
  update: (meta: CloudSyncMeta) => CloudSyncMeta,
  progress = false,
): Promise<void> {
  await withSessionsLock(async () => {
    const meta = await readSyncMetaFor(run.context);
    if (meta === undefined) {
      throw new StaleRunError();
    }
    let next = update(meta);
    if (progress && !run.progressed) {
      run.progressed = true;
      const retryAt = Date.now() + SYNC_FALLBACK_MS;
      next = { ...next, failures: 1, retryAt };
      await armNoLaterThan(retryAt);
    }
    if (next !== meta) {
      await writeSyncMeta(next);
    }
  });
}

async function readMeta(run: RunState): Promise<CloudSyncMeta> {
  const meta = await readSyncMetaFor(run.context);
  if (meta === undefined) {
    throw new StaleRunError();
  }
  return meta;
}

// ---------------------------------------------------------------------------
// Decoding (outside the locks)
// ---------------------------------------------------------------------------

type Decoded =
  | { type: 'session'; record: RecordOut; session: Session | null }
  | { type: 'settings'; record: RecordOut; settings: SyncedSettings }
  | { type: 'image'; record: RecordOut; dataUrl: string | null }
  | { type: 'doc'; record: RecordOut; store: AnyDocStore; data: { id: string } }
  | { type: 'held'; record: RecordOut; ref: string; reason: 'newer' | 'unknownType' }
  | { type: 'unreadable'; record: RecordOut; undecryptable?: true };

/**
 * Decrypts and checks one record; anything that fails is `unreadable`, never applied. Only an
 * AES failure is `undecryptable`: a record that decrypts was written by a device holding the key,
 * so content this build cannot check (a newer schema) is never re-based over (8.3).
 */
async function decode(run: RunState, record: RecordOut): Promise<Decoded> {
  const { kind, id, updatedAt, deleted } = record;
  let content: unknown;
  try {
    content = await decryptRecord(run.context.key.dek, { kind, id, updatedAt, deleted }, record);
  } catch {
    return { type: 'unreadable', record, undecryptable: true };
  }
  if (deleted && kind !== 'doc' && !isTombstonePayload(content)) {
    return { type: 'unreadable', record };
  }
  switch (kind) {
    case 'session': {
      if (deleted) {
        return { type: 'session', record, session: null };
      }
      const session = parseSyncedSession(content, id);
      return session === null || session.updatedAt !== updatedAt
        ? { type: 'unreadable', record }
        : { type: 'session', record, session };
    }
    case 'settings': {
      const settings = deleted || id !== SETTINGS_ID ? null : parseSyncedSettings(content);
      return settings === null
        ? { type: 'unreadable', record }
        : { type: 'settings', record, settings };
    }
    case 'image': {
      if (deleted) {
        return { type: 'image', record, dataUrl: null };
      }
      return typeof content === 'string' && isImageDataUrl(content)
        ? { type: 'image', record, dataUrl: content }
        : { type: 'unreadable', record };
    }
    case 'doc': {
      const check = await checkDoc(run.context.key.dek, record, content, run.stores);
      if (check.state === 'ok') {
        return { type: 'doc', record, store: check.store, data: check.data };
      }
      return check.state === 'held'
        ? { type: 'held', record, ref: check.ref, reason: check.reason }
        : { type: 'unreadable', record };
    }
  }
}

// ---------------------------------------------------------------------------
// Applying (10.6)
// ---------------------------------------------------------------------------

type AnyDocTx = DocTx<{ id: string }, { id: string }>;

/** The store that holds screenshots, if any. */
function imageStore(run: RunState): AnyDocStore | undefined {
  return run.stores.find((store) => store.collection.imageOf !== undefined);
}

/**
 * Applies a batch store by store, each in one write: sessions, then each doc store with its
 * screenshots, then the settings, then the held and unreadable marks. Records of one batch are
 * resolved in order over one state. Returns the refs it held (blocked) again.
 */
async function applyBatch(
  run: RunState,
  decoded: readonly Decoded[],
  serverWinsTies: boolean,
): Promise<Set<string>> {
  const belongs = belongsTo(run);
  const sessions = decoded.filter((item) => item.type === 'session');
  if (sessions.length > 0) {
    const changes: RemoteSessionChange[] = sessions.map((item) =>
      item.session === null
        ? {
            type: 'deleted',
            id: item.record.id,
            updatedAt: item.record.updatedAt,
            raw: item.record,
          }
        : { type: 'session', session: item.session, raw: item.record },
    );
    const outcomes = await sessionRepo.applyRemoteBatch(changes, { serverWinsTies, belongs });
    if (outcomes === null) {
      throw new StaleRunError();
    }
    run.pulled += outcomes.filter((outcome) => outcome === 'applied').length;
  }
  const now = Date.now();
  const heldLocal: { ref: string; record: RecordOut }[] = [];
  const images = decoded.filter((item) => item.type === 'image');
  const screenshots = imageStore(run);
  if (images.length > 0 && screenshots === undefined) {
    heldLocal.push(
      ...images.map((item) => ({ ref: `image:${item.record.id}`, record: item.record })),
    );
  }
  for (const store of run.stores) {
    const docs: DecodedDoc[] = decoded
      .filter((item) => item.type === 'doc' && item.store === store)
      .map((item) => (item.type === 'doc' ? { record: item.record, data: item.data } : null))
      .filter((item): item is DecodedDoc => item !== null);
    // The screenshots go in the same write as their store's docs, after them (10.6).
    const after =
      store === screenshots && images.length > 0
        ? (tx: AnyDocTx) => applyImagesIn(run, tx, images, serverWinsTies, now)
        : undefined;
    const result = await applyDocBatch(store, docs, run.context.key.dek, now, belongs, after);
    run.pulled += result.applied;
    heldLocal.push(...result.held);
  }
  const settings = decoded.filter((item) => item.type === 'settings').at(-1);
  if (settings !== undefined) {
    if (
      await applySettingsRecord(run, settings.settings, settings.record.updatedAt, serverWinsTies)
    ) {
      run.pulled += 1;
    }
  }
  const held = [
    ...decoded
      .filter((item) => item.type === 'held')
      .map((item) => ({ ref: item.ref, record: item.record, reason: item.reason })),
    ...heldLocal.map((item) => ({ ...item, reason: 'localUnreadable' as const })),
  ];
  const unreadable = decoded
    .filter((item) => item.type === 'unreadable')
    .map((item) => item.record);
  const readable = decoded.filter((item) => item.type !== 'unreadable').map((item) => item.record);
  if (unreadable.length > 0) {
    run.problems.push(new CloudDecryptError(`${unreadable.length} records could not be read`));
  }
  if (held.some((item) => item.reason !== 'localUnreadable')) {
    run.problems.push(new ExplainedError('Items need a newer version', 'errorCloudNewerData'));
  }
  await markHeldAndUnreadable(run, held, unreadable, readable);
  return new Set(held.map((item) => item.ref));
}

/** The blocked and unreadable marks of a batch, with every raw copy, in one write (8.3). */
async function markHeldAndUnreadable(
  run: RunState,
  held: readonly {
    ref: string;
    record: RecordOut;
    reason: 'newer' | 'unknownType' | 'localUnreadable';
  }[],
  unreadable: readonly RecordOut[],
  readable: readonly RecordOut[],
): Promise<void> {
  if (held.length === 0 && unreadable.length === 0 && readable.length === 0) {
    return;
  }
  await withSessionsLock(async () => {
    const meta = await readSyncMetaFor(run.context);
    if (meta === undefined) {
      throw new StaleRunError();
    }
    const entries: Record<string, unknown> = {};
    const next: CloudSyncMeta = {
      ...meta,
      blocked: { ...meta.blocked },
      unreadable: { ...meta.unreadable },
    };
    for (const record of readable) {
      delete next.unreadable[`${record.kind}:${record.id}`];
    }
    for (const record of unreadable) {
      next.unreadable[`${record.kind}:${record.id}`] = record.updatedAt;
    }
    for (const { ref, record, reason } of held) {
      const existing = next.blocked[ref];
      // Replay floor: only a newer record replaces the raw copy.
      if (existing !== undefined && record.updatedAt <= existing.at) {
        continue;
      }
      const raw = cloudRawKey(record.kind, record.id);
      if (existing !== undefined && existing.raw !== raw) {
        entries[existing.raw] = null;
      }
      next.blocked[ref] = { at: record.updatedAt, reason, raw };
      entries[raw] = record;
    }
    entries[CLOUD_SYNC_META_KEY] = next;
    await setThenClean(entries);
  });
}

/**
 * Screenshots (10.5), inside the screenshot store's transaction after its docs: immutable, the newer stamp wins; a
 * tombstone never removes a picture a readable local item references (it is marked to send
 * again instead); with no copy here a live picture must be newer than every floor.
 */
async function applyImagesIn(
  run: RunState,
  tx: AnyDocTx,
  images: readonly { record: RecordOut; dataUrl: string | null }[],
  serverWinsTies: boolean,
  now: number,
): Promise<number> {
  if (!belongsTo(run)(tx.meta)) {
    throw new StaleMetaError();
  }
  const meta = tx.meta;
  let applied = 0;
  for (const { record, dataUrl } of images) {
    const id = record.id;
    const at = record.updatedAt;
    const local = (await tx.readImage?.(id)) ?? null;
    if (local === 'unreadable') {
      continue;
    }
    const dirty = meta.images.dirty[id];
    const deleted = meta.images.deleted[id];
    const pending = Math.max(dirty ?? 0, deleted ?? 0);
    const wins = at > pending || (serverWinsTies && at === pending);
    const known = meta.images.known[id];
    meta.images.known = withKnownImage(meta.images, id, at).known;
    delete meta.unreadable[`image:${id}`];
    if (dataUrl === null) {
      if (await tx.imageReferenced?.(id)) {
        if (local !== null) {
          meta.images.dirty[id] = Math.max(now, at + 1);
          delete meta.images.deleted[id];
          meta.changedAt = Math.max(now, (meta.changedAt ?? 0) + 1);
        }
        continue;
      }
      if (!wins) {
        continue;
      }
      delete meta.images.dirty[id];
      delete meta.images.deleted[id];
      delete meta.images.owner[id];
      if (local !== null) {
        tx.removeImage?.(id);
        applied += 1;
      }
      continue;
    }
    if (local === null) {
      const floor = Math.max(deleted ?? 0, known ?? 0);
      if (at <= floor && (deleted !== undefined || known !== undefined)) {
        continue;
      }
      tx.putImage?.(id, dataUrl);
      delete meta.images.deleted[id];
      delete meta.images.owner[id];
      applied += 1;
      continue;
    }
    if (wins) {
      delete meta.images.dirty[id];
      delete meta.images.deleted[id];
    }
  }
  return applied;
}

/** Last writer wins for the settings record; the writes follow (`writeReceivedSettings()`). */
async function applySettingsRecord(
  run: RunState,
  settings: SyncedSettings,
  updatedAt: number,
  serverWinsTies: boolean,
): Promise<boolean> {
  let apply = false;
  await updateMeta(run, (meta) => {
    const remoteWins =
      updatedAt > meta.settingsUpdatedAt ||
      (serverWinsTies && updatedAt === meta.settingsUpdatedAt);
    if (!remoteWins) {
      if (updatedAt < meta.settingsUpdatedAt && !meta.settingsDirty) {
        return { ...meta, settingsDirty: true };
      }
      return meta;
    }
    apply = true;
    return {
      ...meta,
      settingsHash: settingsFingerprint(settings),
      settingsSyncedAt: updatedAt,
      settingsUpdatedAt: updatedAt,
      settingsDirty: false,
      pendingSettings: { ...settings },
    };
  });
  if (apply) {
    await writeReceivedSettings(run, settings);
  }
  return apply;
}

/** Writes received settings here (the language last), then clears `pendingSettings`. */
async function writeReceivedSettings(run: RunState, settings: SyncedSettings): Promise<void> {
  await assertCurrent(run.context);
  await sessionRepo.setSettings(settings.sessionSettings);
  await assertCurrent(run.context);
  await chrome.storage.sync.set({ ...settings.sort, [UI_LANGUAGE_KEY]: settings.uiLanguage });
  const written = settingsFingerprint(settings);
  await updateMeta(run, (meta) => {
    const pending = parseSyncedSettings(meta.pendingSettings);
    if (pending === null || settingsFingerprint(pending) !== written) {
      return meta;
    }
    const next = { ...meta };
    delete next.pendingSettings;
    return next;
  });
}

async function resumeSettingsApply(run: RunState): Promise<void> {
  const pending = parseSyncedSettings((await readMeta(run)).pendingSettings);
  if (pending !== null) {
    await writeReceivedSettings(run, pending);
  }
}

/**
 * At the start of a run (8.3): every held ref this build can now apply (a body that reads now, a
 * type or version it knows now) is applied from its raw copy through the normal rule, and only
 * once that is stored do its raw copy and mark go, in one write. A run cut in between applies it
 * again next time, which the replay floors make harmless; the other order would lose the record,
 * since the cursor is already past it.
 */
async function retryBlocked(run: RunState): Promise<void> {
  const meta = await readMeta(run);
  const entries = Object.entries(meta.blocked);
  if (entries.length === 0) {
    return;
  }
  const stored = await chrome.storage.local.get(entries.map(([, blocked]) => blocked.raw));
  const decoded: Decoded[] = [];
  const done = new Map<string, number>();
  for (const [ref, blocked] of entries) {
    const raw: unknown = stored[blocked.raw];
    if (!isRecord(raw)) {
      done.set(ref, blocked.at);
      continue;
    }
    const item = await decode(run, raw as unknown as RecordOut);
    if (item.type === 'held' || item.type === 'unreadable') {
      continue;
    }
    if (blocked.reason === 'localUnreadable' && !(await localReadsNow(run, ref))) {
      continue;
    }
    decoded.push(item);
    done.set(ref, blocked.at);
  }
  const heldAgain = decoded.length > 0 ? await applyBatch(run, decoded, false) : new Set<string>();
  if (done.size === 0) {
    return;
  }
  await withSessionsLock(async () => {
    const current = await readSyncMetaFor(run.context);
    if (current === undefined) {
      throw new StaleRunError();
    }
    const blocked = { ...current.blocked };
    const cleanup: Record<string, unknown> = {};
    for (const [ref, at] of done) {
      const entry = blocked[ref];
      // Held again by the apply, or replaced by a newer record: the mark stays.
      if (entry === undefined || heldAgain.has(ref) || entry.at !== at) {
        continue;
      }
      cleanup[entry.raw] = null;
      delete blocked[ref];
    }
    if (Object.keys(cleanup).length === 0) {
      return;
    }
    await setThenClean({ ...cleanup, [CLOUD_SYNC_META_KEY]: { ...current, blocked } });
  });
}

async function localReadsNow(run: RunState, ref: string): Promise<boolean> {
  const at = ref.indexOf(':');
  const kind = ref.slice(0, at);
  const id = ref.slice(at + 1);
  if (kind === 'session') {
    return sessionRepo.get(id).then(
      () => true,
      () => false,
    );
  }
  const store = run.stores.find((candidate) => candidate.collection.type === kind);
  if (store === undefined) {
    return kind === 'image' && imageStore(run) !== undefined;
  }
  return store.transact(async (tx) => (await tx.read(id)).state !== 'unreadable');
}

// ---------------------------------------------------------------------------
// Pull (10.3)
// ---------------------------------------------------------------------------

/** Reads the feed to a complete end. `false`: stopped at `maxRequestsPerRun` with more to read. */
async function pull(run: RunState): Promise<boolean> {
  let rewound = false;
  for (let requests = 0; ; requests += 1) {
    let meta = await readMeta(run);
    if (meta.rereadFeed === true) {
      await updateMeta(run, (current) => {
        const next = { ...current, cursor: 0 };
        delete next.rereadFeed;
        return next;
      });
      meta = await readMeta(run);
    }
    if (requests >= POLICY.pull.maxRequestsPerRun) {
      await updateMeta(run, (current) => ({ ...current, pullIncomplete: true }));
      return false;
    }
    await assertCurrent(run.context);
    let again = false;
    let ended: { cursor: number; complete: boolean } | undefined;
    for await (const event of streamRecords(
      run.context.account.token,
      run.context.key.keyId,
      meta.cursor,
      { ...run.options, inWorker: run.worker },
    )) {
      if (event.type === 'start') {
        run.usage = event.usage;
        if (event.through < meta.cursor) {
          if (rewound) {
            // A second rewind in one run: read nothing more now.
            continue;
          }
          // The database was rewound: read it again from 0, once a run.
          rewound = true;
          await updateMeta(run, (current) => ({ ...current, cursor: 0, usage: event.usage }));
          again = true;
          break;
        }
        continue;
      }
      if (event.type === 'batch') {
        await assertCurrent(run.context);
        const decoded = await Promise.all(event.records.map((record) => decode(run, record)));
        await applyBatch(run, decoded, false);
        await updateMeta(
          run,
          (current) => ({ ...current, cursor: event.cursor, usage: run.usage ?? current.usage }),
          true,
        );
        continue;
      }
      ended = event;
    }
    if (again) {
      continue;
    }
    if (ended === undefined) {
      throw new ExplainedError('The stream ended without its end line', 'errorCloudInterrupted');
    }
    const end = ended;
    await updateMeta(run, (current) => ({
      ...current,
      cursor: end.cursor,
      usage: run.usage ?? current.usage,
    }));
    if (!end.complete) {
      continue;
    }
    const after = await readMeta(run);
    if (after.rereadFeed === true) {
      continue;
    }
    if (after.pullIncomplete === true) {
      await updateMeta(run, (current) => {
        const next = { ...current };
        delete next.pullIncomplete;
        return next;
      });
    }
    return true;
  }
}

// ---------------------------------------------------------------------------
// Restamp (10.4)
// ---------------------------------------------------------------------------

/** Every pending stamp too far ahead becomes `max(now, known + 1)`, body and bookkeeping together. */
async function restampAhead(run: RunState): Promise<void> {
  const now = Date.now();
  const limit = now + POLICY.record.maxClockAheadMs;
  const meta = await readMeta(run);
  const sessionStamps = [
    ...Object.entries(meta.sessions.dirty),
    ...Object.entries(meta.sessions.deleted),
  ]
    .filter(([, stamp]) => stamp > limit)
    .map(([id]) => [id, Math.max(now, (meta.sessions.known[id] ?? 0) + 1)] as const);
  if (sessionStamps.length > 0) {
    await sessionRepo.restampSaved(sessionStamps, belongsTo(run));
  }
  for (const store of run.stores) {
    await store.transact(async (tx) => {
      if (!belongsTo(run)(tx.meta)) {
        throw new StaleMetaError();
      }
      for (const [ref, track] of Object.entries(tx.meta.docs)) {
        if (
          !ref.startsWith(`${store.collection.type}:`) ||
          track.pending === null ||
          track.pending.at <= limit
        ) {
          continue;
        }
        const at = Math.max(now, (track.known?.at ?? 0) + 1);
        track.pending = { ...track.pending, at };
        if (!track.pending.deleted) {
          const local = await tx.read(ref.slice(store.collection.type.length + 1));
          if (local.state === 'live') {
            tx.put(local.data, at);
          }
        }
      }
    });
  }
  await updateMeta(run, (current) => {
    let changed = false;
    const images = {
      ...current.images,
      dirty: { ...current.images.dirty },
      deleted: { ...current.images.deleted },
    };
    for (const map of [images.dirty, images.deleted]) {
      for (const [id, stamp] of Object.entries(map)) {
        if (stamp > limit) {
          map[id] = Math.max(now, (current.images.known[id] ?? 0) + 1);
          changed = true;
        }
      }
    }
    let next = changed ? { ...current, images } : current;
    if (next.settingsDirty && next.settingsUpdatedAt > limit) {
      next = { ...next, settingsUpdatedAt: Math.max(now, (next.settingsSyncedAt ?? 0) + 1) };
    }
    return next;
  });
}

// ---------------------------------------------------------------------------
// Push (10.7)
// ---------------------------------------------------------------------------

interface OutItem {
  ref: string;
  record: RecordIn;
  stamp: number;
  deleted: boolean;
  /** The settings fingerprint sent, for a settings record. */
  settingsHash?: string;
  store?: AnyDocStore;
}

async function encryptItem(
  run: RunState,
  ref: string,
  kind: RecordKind,
  id: string,
  stamp: number,
  deleted: boolean,
  content: unknown,
  baseSeq?: number | null,
): Promise<OutItem | null> {
  if (!isValidRecordId(kind, id, deleted) || !Number.isSafeInteger(stamp) || stamp < 0) {
    run.problems.push(new ExplainedError(`${ref} cannot be sent`, 'errorCloudRejected'));
    return null;
  }
  const payload = await encryptRecord(
    run.context.key.dek,
    { kind, id, updatedAt: stamp, deleted },
    content,
  );
  const limit = deleted ? POLICY.record.maxTombstoneChars : POLICY.record.maxCiphertextBytes;
  if (payload.ciphertext.length > limit) {
    run.problems.push(new ItemTooLargeError(ref));
    return null;
  }
  const record: RecordIn = { kind, id, updatedAt: stamp, deleted, ...payload };
  if (kind === 'doc') {
    record.baseSeq = baseSeq ?? null;
  }
  return { ref, record, stamp, deleted };
}

type Pass = 'tombstones' | 'imageTombstones' | 'live' | 'liveImages';

/** The items of one pass, read and encrypted now (bodies are never loaded ahead). */
async function collectPass(
  run: RunState,
  pass: Pass,
  only?: ReadonlySet<string>,
): Promise<OutItem[]> {
  const meta = await readMeta(run);
  const wanted = (ref: string, stamp: number) =>
    !isHeld(meta, ref, stamp) &&
    meta.blocked[ref] === undefined &&
    (only === undefined || only.has(ref));
  const items: OutItem[] = [];
  const push = (item: OutItem | null) => {
    if (item !== null) {
      items.push(item);
    }
  };
  if (pass === 'tombstones' || pass === 'live') {
    const deleted = pass === 'tombstones';
    const sessions = deleted ? meta.sessions.deleted : meta.sessions.dirty;
    for (const [id, stamp] of Object.entries(sessions)) {
      const ref = `session:${id}`;
      if (!wanted(ref, stamp)) {
        continue;
      }
      if (deleted) {
        push(await encryptItem(run, ref, 'session', id, stamp, true, TOMBSTONE));
        continue;
      }
      const body = await sessionRepo.get(id).catch(() => undefined);
      if (body === undefined || body.kind !== 'saved' || body.updatedAt !== stamp) {
        continue;
      }
      push(await encryptItem(run, ref, 'session', id, stamp, false, body));
    }
    for (const store of run.stores) {
      const refs = Object.entries(meta.docs)
        .filter(
          ([ref, track]) =>
            ref.startsWith(`${store.collection.type}:`) &&
            track.pending !== null &&
            track.pending.deleted === deleted &&
            wanted(ref, track.pending.at),
        )
        .map(([ref]) => ref);
      if (refs.length === 0) {
        continue;
      }
      for (const doc of await readOutgoingDocs(store, refs, run.context.key.dek, belongsTo(run))) {
        const item = await encryptItem(
          run,
          doc.ref,
          'doc',
          doc.recordId,
          doc.at,
          doc.deleted,
          doc.content,
          doc.baseSeq,
        );
        if (item !== null) {
          items.push({ ...item, store });
        }
      }
    }
    if (!deleted && meta.settingsDirty && wanted(SETTINGS_REF, meta.settingsUpdatedAt)) {
      const settings = await readLocalSettings();
      const item = await encryptItem(
        run,
        SETTINGS_REF,
        'settings',
        SETTINGS_ID,
        meta.settingsUpdatedAt,
        false,
        settings,
      );
      if (item !== null) {
        items.push({ ...item, settingsHash: settingsFingerprint(settings) });
      }
    }
    return items;
  }
  const store = imageStore(run);
  if (store === undefined) {
    return items;
  }
  if (pass === 'imageTombstones') {
    for (const [id, stamp] of Object.entries(meta.images.deleted)) {
      const ref = `image:${id}`;
      const owner = meta.images.owner[id];
      const ownerWaiting =
        owner !== undefined &&
        (meta.blocked[owner] !== undefined || meta.docs[owner]?.pending?.deleted === true);
      if (wanted(ref, stamp) && !ownerWaiting) {
        push(await encryptItem(run, ref, 'image', id, stamp, true, TOMBSTONE));
      }
    }
    return items;
  }
  const dirty = Object.entries(meta.images.dirty).filter(([id, stamp]) =>
    wanted(`image:${id}`, stamp),
  );
  if (dirty.length === 0) {
    return items;
  }
  const pictures = await store.transact(async (tx) => {
    const found: [string, number, string][] = [];
    for (const [id, stamp] of dirty) {
      const picture = await tx.readImage?.(id);
      if (typeof picture === 'string' && picture !== 'unreadable') {
        found.push([id, stamp, picture]);
      } else if (picture === null) {
        delete tx.meta.images.dirty[id];
      }
    }
    return found;
  });
  for (const [id, stamp, picture] of pictures) {
    push(await encryptItem(run, `image:${id}`, 'image', id, stamp, false, picture));
  }
  return items;
}

/** The worker's batch target: the stored one after a timeout, the policy size in a page. */
async function batchTarget(run: RunState): Promise<number> {
  if (!run.worker) {
    return POLICY.request.pushBatchBytes;
  }
  return (await readMeta(run)).pushBatchBytes ?? POLICY.request.pushBatchBytes;
}

/** Releases every held entry whose reason's usage fell since it was refused (10.7). */
function releaseHeld(
  meta: CloudSyncMeta,
  usage: Usage | undefined,
): { meta: CloudSyncMeta; released: boolean } {
  if (usage === undefined) {
    return { meta, released: false };
  }
  const held = { ...meta.held };
  let released = false;
  for (const [ref, entry] of Object.entries(held)) {
    const now = entry.reason === 'storage_limit' ? usage.bytes : usage.screenshots;
    if (now < entry.usage) {
      delete held[ref];
      released = true;
    }
  }
  return released ? { meta: { ...meta, held }, released } : { meta, released };
}

async function releaseNow(run: RunState): Promise<void> {
  await updateMeta(run, (meta) => {
    const result = releaseHeld(meta, run.usage);
    if (result.released) {
      run.released = true;
      return withLocalChange(result.meta, Date.now());
    }
    return meta;
  });
}

/** Sends `items` in batches; resolves the refs to send once more in this run. */
async function send(run: RunState, items: readonly OutItem[]): Promise<Set<string>> {
  const retry = new Set<string>();
  let target = await batchTarget(run);
  let index = 0;
  while (index < items.length) {
    const [batch] = splitIntoBatches(
      items.slice(index).map((item) => item.record),
      POLICY.request.maxRecordsPerPush,
      target,
    );
    const count = batch?.length ?? 0;
    const sent = items.slice(index, index + count);
    index += count;
    await assertCurrent(run.context);
    let answer: { results: WriteResult[]; usage: Usage };
    try {
      answer = await postRecords(
        run.context.account.token,
        run.context.key.keyId,
        sent.map((item) => item.record),
        { ...run.options, inWorker: run.worker },
      );
    } catch (err: unknown) {
      if (err instanceof CloudTimeoutError && run.worker) {
        const size = Math.max(Math.floor(target / 2), recordBytes(sent[0]!.record) + 32);
        await updateMeta(run, (meta) => ({ ...meta, pushBatchBytes: size }));
      }
      throw err;
    }
    if (run.worker && target < POLICY.request.pushBatchBytes) {
      target = Math.min(target * 2, POLICY.request.pushBatchBytes);
      const grown = target;
      await updateMeta(run, (meta) => {
        const next = { ...meta };
        if (grown >= POLICY.request.pushBatchBytes) {
          delete next.pushBatchBytes;
        } else {
          next.pushBatchBytes = grown;
        }
        return next;
      });
    }
    const { results, usage } = answer;
    if (
      results.length !== sent.length ||
      results.some(
        (result, at) => result.kind !== sent[at]!.record.kind || result.id !== sent[at]!.record.id,
      )
    ) {
      throw new ExplainedError(
        'The push results do not match the records',
        'errorCloudBadResponse',
      );
    }
    run.usage = usage;
    for (const ref of await settle(run, sent, results)) {
      retry.add(ref);
    }
    await releaseNow(run);
  }
  return retry;
}

/** The bookkeeping after one push answer (10.7). Resolves the refs to send again. */
async function settle(
  run: RunState,
  sent: readonly OutItem[],
  results: readonly WriteResult[],
): Promise<string[]> {
  const retry: string[] = [];
  const stale: { item: OutItem; current: RecordOut }[] = [];
  let heldNow = false;
  await updateMeta(
    run,
    (found) => {
      let meta: CloudSyncMeta = {
        ...found,
        sessions: {
          ...found.sessions,
          dirty: { ...found.sessions.dirty },
          deleted: { ...found.sessions.deleted },
        },
        images: {
          ...found.images,
          dirty: { ...found.images.dirty },
          deleted: { ...found.images.deleted },
          owner: { ...found.images.owner },
        },
        docs: { ...found.docs },
        held: { ...found.held },
        unreadable: { ...found.unreadable },
      };
      const usage = run.usage;
      results.forEach((result, at) => {
        const item = sent[at]!;
        const id = item.record.id;
        const localId = item.ref.slice(item.ref.indexOf(':') + 1);
        if (result.status === 'applied' || result.status === 'absent') {
          run.pushed += result.status === 'applied' ? 1 : 0;
          delete meta.unreadable[`${item.record.kind}:${id}`];
          delete meta.held[item.ref];
          if (item.record.kind === 'session') {
            const map = item.deleted ? meta.sessions.deleted : meta.sessions.dirty;
            if (map[localId] === item.stamp) {
              delete map[localId];
            }
            meta.sessions = withKnown(meta.sessions, localId, item.stamp);
          } else if (item.record.kind === 'image') {
            const map = item.deleted ? meta.images.deleted : meta.images.dirty;
            if (map[localId] === item.stamp) {
              delete map[localId];
              if (item.deleted) {
                delete meta.images.owner[localId];
              }
            }
            meta.images = withKnownImage(meta.images, localId, item.stamp);
          } else if (item.record.kind === 'settings') {
            if (meta.settingsUpdatedAt === item.stamp) {
              meta.settingsDirty = false;
              meta.settingsHash = item.settingsHash;
              meta.settingsSyncedAt = item.stamp;
            }
          } else {
            const track = meta.docs[item.ref];
            if (track !== undefined) {
              const known =
                track.known === null || track.known.at < item.stamp
                  ? { at: item.stamp, deleted: item.deleted }
                  : track.known;
              meta.docs[item.ref] = {
                ...track,
                seq: result.status === 'applied' ? result.seq : track.seq,
                known,
                sent: [],
                pending: track.pending?.at === item.stamp ? null : track.pending,
              };
            }
          }
          return;
        }
        if (result.status === 'rejected') {
          if (result.reason === 'clock_ahead') {
            run.problems.push(new ExplainedError(`${item.ref} is dated ahead`, 'errorCloudClock'));
            return;
          }
          if (Object.keys(meta.held).length === 0) {
            delete meta.heldNoticed;
          }
          meta.held[item.ref] = {
            stamp: item.stamp,
            reason: result.reason,
            usage:
              result.reason === 'storage_limit' ? (usage?.bytes ?? 0) : (usage?.screenshots ?? 0),
          };
          heldNow = true;
          return;
        }
        // stale
        if ('withheld' in result) {
          retry.push(item.ref);
          return;
        }
        if (result.current === null) {
          const track = meta.docs[item.ref];
          if (track !== undefined) {
            meta.docs[item.ref] = { ...track, seq: null };
          }
          retry.push(item.ref);
          return;
        }
        stale.push({ item, current: result.current });
      });
      if (heldNow) {
        meta = { ...meta };
      }
      return meta;
    },
    results.some((result) => result.status === 'applied' || result.status === 'absent'),
  );
  let rereadNoted = (await readMeta(run)).rereadFeed === true;
  for (const { item, current } of stale) {
    if (current.kind !== item.record.kind || current.id !== item.record.id) {
      continue;
    }
    const decoded = await decode(run, current);
    if (decoded.type === 'unreadable') {
      if (decoded.undecryptable === true) {
        await rebase(run, item, current);
        retry.push(item.ref);
      } else {
        await keepUnderUnreadable(run, item, current);
      }
      continue;
    }
    await applyBatch(run, [decoded], true);
    let meta = await readMeta(run);
    if (meta.rereadFeed === true && !rereadNoted) {
      // A winning note needs a picture gone here (10.5): during a push that moves `changedAt`,
      // so the next run reads the feed again soon rather than at the periodic check.
      rereadNoted = true;
      await updateMeta(run, (found) => ({
        ...found,
        changedAt: Math.max(Date.now(), (found.changedAt ?? 0) + 1),
      }));
      meta = await readMeta(run);
    }
    if (item.record.kind === 'doc' && meta.docs[item.ref]?.pending != null) {
      retry.push(item.ref);
    }
  }
  return retry;
}

/**
 * A stale answer that decrypts but this build cannot read (invariant 13): never pushed over. The
 * pending change stays as it is, unstamped, and the stored row is marked unreadable.
 */
async function keepUnderUnreadable(
  run: RunState,
  item: OutItem,
  current: RecordOut,
): Promise<void> {
  run.problems.push(new CloudDecryptError(`The stored ${item.ref} could not be read`));
  await updateMeta(run, (meta) => ({
    ...meta,
    unreadable: { ...meta.unreadable, [`${current.kind}:${current.id}`]: current.updatedAt },
  }));
}

/**
 * An undecryptable stale answer (8.3): its seq and stamp are plain metadata, so the pending local
 * version is re-based on that seq and restamped above it, to be sent once more. Nothing is learned
 * from its content, and the pending change is never cleared.
 */
async function rebase(run: RunState, item: OutItem, current: RecordOut): Promise<void> {
  const now = Date.now();
  const stamp = Math.max(item.stamp, current.updatedAt + 1);
  run.problems.push(new CloudDecryptError(`The stored ${item.ref} could not be read`));
  if (stamp > now + POLICY.record.maxClockAheadMs) {
    return;
  }
  if (item.record.kind === 'session') {
    await sessionRepo.restampSaved([[item.ref.slice('session:'.length), stamp]], belongsTo(run));
  } else if (item.record.kind === 'doc' && item.store !== undefined) {
    const store = item.store;
    await store.transact(async (tx) => {
      if (!belongsTo(run)(tx.meta)) {
        throw new StaleMetaError();
      }
      const track = tx.meta.docs[item.ref];
      if (track?.pending == null) {
        return;
      }
      track.seq = current.seq;
      track.pending = { ...track.pending, at: Math.max(track.pending.at, stamp) };
      if (!track.pending.deleted) {
        const local = await tx.read(item.ref.slice(store.collection.type.length + 1));
        if (local.state === 'live') {
          tx.put(local.data, track.pending.at);
        }
      }
    });
  }
  await updateMeta(run, (meta) => {
    const next = {
      ...meta,
      unreadable: { ...meta.unreadable, [`${current.kind}:${current.id}`]: current.updatedAt },
    };
    if (item.record.kind === 'image') {
      const id = item.record.id;
      const images = {
        ...next.images,
        dirty: { ...next.images.dirty },
        deleted: { ...next.images.deleted },
      };
      const map = item.deleted ? images.deleted : images.dirty;
      if (map[id] !== undefined) {
        map[id] = Math.max(map[id], stamp);
      }
      return { ...next, images };
    }
    if (item.record.kind === 'settings' && next.settingsDirty) {
      return { ...next, settingsUpdatedAt: Math.max(next.settingsUpdatedAt, stamp) };
    }
    return next;
  });
}

/** One pass, and the retries of what its answers asked to send again (each ref once more). */
async function runPass(run: RunState, pass: Pass, only?: ReadonlySet<string>): Promise<void> {
  let retry = await send(run, await collectPass(run, pass, only));
  const retried = new Set<string>();
  for (let rounds = 0; retry.size > 0 && rounds < 10; rounds += 1) {
    const again = new Set([...retry].filter((ref) => !retried.has(ref) || rounds > 0));
    for (const ref of again) {
      retried.add(ref);
    }
    const items = await collectPass(run, pass, again);
    if (items.length === 0) {
      return;
    }
    const before = retry.size;
    retry = await send(run, items);
    if (retry.size >= before && rounds > 0) {
      // Withheld forever, or a server that keeps answering stale: the rest waits for the next run.
      return;
    }
  }
}

async function push(run: RunState): Promise<void> {
  await noteSettingsChange('check');
  run.collected = await readMeta(run);
  await releaseNow(run);
  run.released = false;
  await runPass(run, 'tombstones');
  await runPass(run, 'imageTombstones');
  await runPass(run, 'live');
  await runPass(run, 'liveImages');
  if (run.released) {
    // Once more for what was released in this run, never a third time.
    run.released = false;
    await runPass(run, 'live');
    await runPass(run, 'liveImages');
  }
}

// ---------------------------------------------------------------------------
// Start, finish and the alarms
// ---------------------------------------------------------------------------

/** Remembers that Settings said items are held back, so it says so once (also for stage 3). */
export { markConflictsNoticed, markHeldNoticed, readSyncNotices } from '@/lib/cloud-sync-state';

async function finish(run: RunState, failed: boolean, problem: unknown): Promise<void> {
  let lastError: string | undefined;
  if (problem !== undefined) {
    await uiLanguageReady();
    lastError = errorMessage(problem);
  }
  const now = Date.now();
  await withSessionsLock(async () => {
    if (!(await isCurrent(run.context))) {
      return;
    }
    const meta = await readSyncMetaFor(run.context);
    if (meta === undefined) {
      return;
    }
    const next: CloudSyncMeta = { ...meta };
    if (lastError === undefined) {
      delete next.lastError;
    } else {
      next.lastError = lastError;
    }
    if (failed) {
      next.failures = Math.max(1, meta.failures ?? 0);
      next.retryAt = now + retryDelayMs(next.failures);
      await chrome.alarms.create(CLOUD_SYNC_SOON_ALARM, { when: next.retryAt });
    } else {
      next.lastSyncAt = meta.pullIncomplete === true ? meta.lastSyncAt : now;
      delete next.failures;
      delete next.retryAt;
      const tooLarge = run.problems.filter((item) => item instanceof ItemTooLargeError).length;
      if (tooLarge > 0) {
        next.tooLarge = tooLarge;
      } else {
        delete next.tooLarge;
      }
      const newWork =
        run.collected !== undefined &&
        (meta.changedAt !== run.collected.changedAt || syncWorkGrew(run.collected, meta));
      if (meta.pullIncomplete === true) {
        await armNoLaterThan(now + SYNC_FALLBACK_MS);
      } else if (hasPendingWork(meta) && newWork) {
        await armNoLaterThan(now + SYNC_FALLBACK_MS);
      } else {
        await chrome.alarms.clear(CLOUD_SYNC_SOON_ALARM);
      }
    }
    await writeSyncMeta(next);
  });
}

async function armNoLaterThan(when: number): Promise<void> {
  const waiting = await chrome.alarms.get(CLOUD_SYNC_SOON_ALARM);
  if (waiting === undefined || waiting.scheduledTime > when) {
    await chrome.alarms.create(CLOUD_SYNC_SOON_ALARM, { when });
  }
}

/** Whether a conditional run is still called for, decided with the sync lock held. */
async function stillCalledFor(
  context: SyncContext,
  onlyIf: NonNullable<SyncOptions['onlyIf']>,
): Promise<boolean> {
  return withSessionsLock(async () => {
    const meta = await readSyncMetaFor(context);
    if (meta === undefined) {
      return onlyIf !== 'changed';
    }
    const now = Date.now();
    if ((meta.failures ?? 0) > 0) {
      if (onlyIf === 'changed') {
        return false;
      }
      const wait = retryWaitMs(meta, now);
      if (wait > 0) {
        await chrome.alarms.create(CLOUD_SYNC_SOON_ALARM, { when: now + wait });
      }
      return wait === 0;
    }
    if (onlyIf === 'periodic') {
      return true;
    }
    if (!hasPendingWork(meta)) {
      await chrome.alarms.clear(CLOUD_SYNC_SOON_ALARM);
      return false;
    }
    return onlyIf === 'changed' || (await chrome.alarms.get(CLOUD_SYNC_SOON_ALARM)) !== undefined;
  });
}

/** Before the first request: the run counts as failed until `finish()` says otherwise. */
async function markRunStarted(run: RunState): Promise<void> {
  if ((await chrome.alarms.get(CLOUD_SYNC_ALARM)) === undefined) {
    await ensureSyncAlarm();
  }
  await withSessionsLock(async () => {
    await assertCurrent(run.context);
    const meta = await ensureSyncMeta(run.context);
    const failures = (meta.failures ?? 0) + 1;
    const retryAt = run.startedAt + retryDelayMs(failures);
    await chrome.alarms.create(CLOUD_SYNC_SOON_ALARM, { when: retryAt });
    await writeSyncMeta({ ...meta, failures, retryAt, lastAttemptAt: run.startedAt });
  });
}

/** Tracking start for sessions, each doc collection and the screenshots (11.1). */
async function startTracking(run: RunState): Promise<void> {
  const belongs = belongsTo(run);
  await sessionRepo.startSyncTracking(belongs);
  for (const store of run.stores) {
    await startDocTracking(store, run.context.key.dek, Date.now(), belongs);
  }
}

/** An extension call this often keeps the worker alive while a body streams (10.1). */
function startKeepAlive(): () => void {
  const timer = setInterval(() => {
    chrome.runtime.getPlatformInfo().catch(() => undefined);
  }, POLICY.sync.keepAliveMs);
  return () => clearInterval(timer);
}

/**
 * One sync (10.2). `'notReady'` while unconfigured or not ready, also when that happened during
 * the run; `'failed'` when the server could not be reached, refused, or a pull was cut (nothing is
 * pushed then; a 401 removes that bearer's account); `'synced'` otherwise, also with single
 * records skipped (named in `lastError`); `'skipped'` when `options.onlyIf` found nothing to do.
 */
export async function syncNow(options: SyncOptions = {}): Promise<SyncResult> {
  if (!isCloudSyncEnabled()) {
    return { outcome: 'notReady', pulled: 0, pushed: 0 };
  }
  return withSyncLock(async () => {
    await upgradeCloudStorage();
    const context = await loadSyncContext();
    if (context === null) {
      await ensureSyncAlarm();
      return { outcome: 'notReady', pulled: 0, pushed: 0 };
    }
    if (
      options.signal?.aborted === true ||
      (options.onlyIf !== undefined && !(await stillCalledFor(context, options.onlyIf)))
    ) {
      return { outcome: 'skipped', pulled: 0, pushed: 0 };
    }
    const run: RunState = {
      context,
      options,
      stores: options.stores ?? DOC_STORES,
      worker: options.inWorker ?? inWorker(),
      startedAt: Date.now(),
      pulled: 0,
      pushed: 0,
      problems: [],
      progressed: false,
      released: false,
    };
    const stopKeepAlive = startKeepAlive();
    try {
      await markRunStarted(run);
      await startTracking(run);
      await retryBlocked(run);
      await resumeSettingsApply(run);
      if (await pull(run)) {
        await restampAhead(run);
        await push(run);
      }
    } catch (err: unknown) {
      if (
        err instanceof StaleRunError ||
        err instanceof StaleMetaError ||
        !(await isCurrent(context))
      ) {
        return { outcome: 'notReady', pulled: run.pulled, pushed: run.pushed };
      }
      if (err instanceof CloudUnauthorizedError) {
        await removeAccountIfToken(context.account.token);
        return { outcome: 'failed', pulled: run.pulled, pushed: run.pushed };
      }
      console.warn('[tabinet:sync] sync failed', err instanceof Error ? err.message : err);
      await finish(run, true, err);
      return { outcome: 'failed', pulled: run.pulled, pushed: run.pushed };
    } finally {
      stopKeepAlive();
    }
    await finish(run, false, run.problems[0]);
    return { outcome: 'synced', pulled: run.pulled, pushed: run.pushed };
  });
}

/** Whether a failed request means the cloud has another key (sync pauses until Settings acts). */
export function isKeyChange(err: unknown): boolean {
  return (
    err instanceof CloudHttpError && (err.code === 'key_mismatch' || err.code === 'key_missing')
  );
}

// ---------------------------------------------------------------------------
// Triggers (wired by src/service-worker.ts)
// ---------------------------------------------------------------------------

export function isSyncAlarm(name: string): boolean {
  return name === CLOUD_SYNC_ALARM || name === CLOUD_SYNC_SOON_ALARM;
}

/** Arms the periodic sync while ready, clears both sync alarms otherwise; nothing while unconfigured. */
export async function ensureSyncAlarm(): Promise<void> {
  if (!isCloudSyncEnabled()) {
    return;
  }
  if ((await loadSyncContext()) === null) {
    await Promise.all([
      chrome.alarms.clear(CLOUD_SYNC_ALARM),
      chrome.alarms.clear(CLOUD_SYNC_SOON_ALARM),
    ]);
    return;
  }
  await chrome.alarms.create(CLOUD_SYNC_ALARM, {
    delayInMinutes: POLICY.sync.periodMinutes,
    periodInMinutes: POLICY.sync.periodMinutes,
  });
}

/** The fallback behind the timer: a sync no later than `SYNC_FALLBACK_MS` from now, while ready. */
export async function scheduleSoonSync(): Promise<void> {
  if (!isCloudSyncEnabled()) {
    return;
  }
  await withSessionsLock(async () => {
    const context = await loadSyncContext();
    if (context === null) {
      return;
    }
    const meta = await readSyncMetaFor(context);
    const now = Date.now();
    const retryWait = meta === undefined ? 0 : retryWaitMs(meta, now);
    await armNoLaterThan(now + Math.max(SYNC_FALLBACK_MS, retryWait));
  });
}

/** The first thing when the soon alarm fires, before any await: a one-shot alarm is gone as it fires. */
export async function rearmFallback(): Promise<void> {
  if (!isCloudSyncEnabled()) {
    return;
  }
  await chrome.alarms.create(CLOUD_SYNC_SOON_ALARM, { when: Date.now() + SYNC_FALLBACK_MS });
}

/** At browser start, install and update: the periodic alarm, and the soon alarm when work waits. */
export async function resumeSync(): Promise<void> {
  await ensureSyncAlarm();
  if (!isCloudSyncEnabled()) {
    return;
  }
  await withSessionsLock(async () => {
    const context = await loadSyncContext();
    if (context === null) {
      return;
    }
    const meta = await readSyncMetaFor(context);
    const failing = (meta?.failures ?? 0) > 0;
    if (meta !== undefined && !failing && !hasPendingWork(meta)) {
      return;
    }
    const soon = Date.now() + SYNC_FALLBACK_MS;
    await armNoLaterThan(soon);
    if (meta !== undefined && failing && (meta.retryAt ?? 0) > soon) {
      await writeSyncMeta({ ...meta, retryAt: soon });
    }
  });
}

/** What a storage change asks of the worker's timers. */
export type SyncTrigger = 'now' | 'soon' | 'stop' | 'none';

function touchesSettings(
  changes: { [key: string]: chrome.storage.StorageChange },
  areaName: string,
): boolean {
  if (areaName === 'sync') {
    return UI_LANGUAGE_KEY in changes || SORT_SETTING_KEYS.some((key) => key in changes);
  }
  return areaName === 'local' && SETTINGS_KEY in changes;
}

/**
 * Whether an account or key change is one a sync starts for: a change of token, account, keyId
 * or data key. A generation update is not (spec 10.1). Pure.
 */
export function readinessChanged(changes: {
  [key: string]: chrome.storage.StorageChange;
}): boolean {
  const before = cloudStoredFrom({
    [CLOUD_ACCOUNT_KEY]: changes[CLOUD_ACCOUNT_KEY]?.oldValue,
    [CLOUD_KEY_KEY]: changes[CLOUD_KEY_KEY]?.oldValue,
  });
  const after = cloudStoredFrom({
    [CLOUD_ACCOUNT_KEY]: changes[CLOUD_ACCOUNT_KEY]?.newValue,
    [CLOUD_KEY_KEY]: changes[CLOUD_KEY_KEY]?.newValue,
  });
  const accountChanged =
    CLOUD_ACCOUNT_KEY in changes &&
    (before.account?.token !== after.account?.token ||
      before.account?.accountId !== after.account?.accountId ||
      before.account?.uploadConfirmed !== after.account?.uploadConfirmed);
  const keyChanged =
    CLOUD_KEY_KEY in changes &&
    (before.key?.keyId !== after.key?.keyId ||
      before.key?.dek !== after.key?.dek ||
      before.key?.accountId !== after.key?.accountId);
  return accountChanged || keyChanged;
}

/**
 * The worker's `storage.onChanged` part for sync: the account or the key became ready (`'now'`)
 * or not (`'stop'`); a setting changed (marked dirty or clean); a change of this device's own
 * (`'soon'`). A run's own bookkeeping writes ask for nothing. `'none'` at once while unconfigured.
 */
export async function handleCloudStorageChange(
  changes: { [key: string]: chrome.storage.StorageChange },
  areaName: string,
): Promise<SyncTrigger> {
  if (!isCloudSyncEnabled()) {
    return 'none';
  }
  if (areaName === 'local' && (CLOUD_ACCOUNT_KEY in changes || CLOUD_KEY_KEY in changes)) {
    if (!readinessChanged(changes)) {
      return 'none';
    }
    const arrived = [CLOUD_ACCOUNT_KEY, CLOUD_KEY_KEY].some(
      (key) => changes[key]?.newValue !== undefined && changes[key]?.newValue !== null,
    );
    if (arrived) {
      await rearmFallback();
    }
    await ensureSyncAlarm();
    return (await loadSyncContext()) === null ? 'stop' : 'now';
  }
  if (touchesSettings(changes, areaName) && (await noteSettingsChange())) {
    await scheduleSoonSync();
  }
  const meta = changes[CLOUD_SYNC_META_KEY];
  if (areaName !== 'local' || meta === undefined) {
    return 'none';
  }
  if (!localChangeMade(meta.oldValue, meta.newValue) || (await loadSyncContext()) === null) {
    return 'none';
  }
  await scheduleSoonSync();
  return 'soon';
}

/** The doc ref of a local item (for stores). */
export { docRef };
