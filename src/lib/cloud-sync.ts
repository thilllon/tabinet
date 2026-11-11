/**
 * The cloud sync engine (GitHub issue #170): moves saved sessions, the settings and YouTube notes
 * with their screenshots (#221) between this device and the sync server (#165), end-to-end
 * encrypted with the key from #166. Snapshots (`kind: 'history'`) never sync; Keep turns one into
 * a saved session, which then does.
 *
 * Records: a saved session is `{ kind: 'session', id, updatedAt }` with the whole `Session` body
 * encrypted inside; a deleted one is its tombstone (`deleted: true`, `updatedAt` = when it was
 * deleted, `TOMBSTONE_PAYLOAD` encrypted inside); the settings are one record
 * `{ kind: 'settings', id: 'settings' }` holding the sort settings, the session settings and the
 * language; one video's notes are `{ kind: 'notes', id: <videoId> }` with the whole `VideoNotes`
 * inside, and one screenshot `{ kind: 'image', id: <imageId> }` with its data URL inside (its
 * `updatedAt` is when it was stored or deleted: a picture never changes). Last writer wins by
 * `updatedAt`, as on the server. The server keeps at most `CLOUD_IMAGE_LIMIT` live screenshots per
 * account and refuses one more (`rejected`); such a picture stays on this device, is offered again
 * once a screenshot is deleted, and Settings > Account says so once.
 *
 * The server is not trusted: every record, a tombstone included, is encrypted with its
 * `kind`/`id`/`updatedAt`/`deleted` as AES-GCM additional data (`encryptRecord()`), so a record
 * the server forged, moved to another id or kind, replayed under a newer `updatedAt` or turned
 * into a tombstone does not decrypt. It is skipped and reported, never applied.
 *
 * `syncNow()` pulls the change feed, then pushes what this device changed (the dirty sets in
 * `cloudSyncMeta`, `src/lib/cloud-sync-state.ts`). It runs under its own Web Lock, so the page and
 * the worker never sync at once; network calls happen outside the sessions lock, and every local
 * write goes through `sessionRepo` or `notesRepo` (`applyRemote()` for what the server sent).
 *
 * The settings apply path (`writeReceivedSettings()`) is the one place sessions code writes
 * `chrome.storage.sync`: the sort settings and `uiLanguage` live there, so applying settings from
 * another device must write them there. `readLocalSettings()` is the matching read.
 *
 * Everything here is a no-op while cloud sync is unconfigured (`isCloudSyncEnabled()`), and
 * nothing touches `chrome.*` while the module body runs.
 */
import {
  type CloudApiOptions,
  CloudUnauthorizedError,
  getRecords,
  postRecords,
} from '@/lib/cloud-api';
import { CLOUD_ACCOUNT_KEY, CLOUD_SYNC_KEY, forgetCloudAccount } from '@/lib/cloud-auth';
import { isCloudSyncEnabled } from '@/lib/cloud-config';
import { CloudDecryptError, decryptRecord, encryptRecord } from '@/lib/cloud-crypto';
import {
  CLOUD_SYNC_META_KEY,
  type CloudSyncMeta,
  freshSyncMeta,
  loadSyncContext,
  readSyncMeta,
  readSyncMetaFor,
  type SyncContext,
  syncWorkGrew,
  withKnownVersion,
  withHeldImages,
  writeSyncMeta,
} from '@/lib/cloud-sync-state';
import { errorMessage, ExplainedError } from '@/lib/error-message';
import { uiLanguageReady } from '@/lib/i18n';
import { isRecord, isSession } from '@/lib/import-guards';
import { notesRepo, parseRemoteNotes } from '@/lib/notes-repo';
import { fnv1a32 } from '@/lib/session-hash';
import { normalizeSettings, SETTINGS_KEY, sessionRepo, withLock } from '@/lib/session-repo';
import { parseSortSettings, SORT_SETTING_KEYS } from '@/lib/sort-settings';
import { parseUiLanguage, UI_LANGUAGE_KEY, type UiLanguage } from '@/lib/ui-language';
import { isImageDataUrl } from '@/lib/youtube-video';
import type {
  CloudRecord,
  CloudRecordKind,
  CloudRecordWithSeq,
  Session,
  SessionSettings,
  SortSettings,
  VideoNotes,
} from '@/types';

/** The periodic sync alarm, every `SYNC_PERIOD_MINUTES` while ready. */
export const CLOUD_SYNC_ALARM = 'cloud-sync';
/** The one-shot alarm about a minute after a local change. */
export const CLOUD_SYNC_SOON_ALARM = 'cloud-sync-soon';
export const SYNC_PERIOD_MINUTES = 15;
const SYNC_SOON_MINUTES = 1;

/** The Web Lock one sync holds from start to end, shared by the page and the worker. */
const SYNC_LOCK_NAME = 'tabinet:cloud-sync';

/** The id of the one settings record. */
const SETTINGS_RECORD_ID = 'settings';

/** What one `POST /v1/records` may carry: the server's 100 records, and 3.5 MiB of its 4 MiB body. */
export const PUSH_MAX_RECORDS = 100;
export const PUSH_MAX_BYTES = 3.5 * 1024 * 1024;
/** The largest ciphertext the server accepts (1 MiB of base64). */
const MAX_CIPHERTEXT_CHARS = 1024 * 1024;

/** Record ids the server accepts. */
const RECORD_ID = /^[A-Za-z0-9_-]{1,64}$/;

/** The settings as they travel inside the settings record. */
export interface SyncedSettings {
  sort: SortSettings;
  sessionSettings: SessionSettings;
  uiLanguage: UiLanguage;
}

export interface SyncResult {
  outcome: 'synced' | 'notReady' | 'failed';
  /** Remote changes applied on this device. */
  pulled: number;
  /** Local changes the server accepted. */
  pushed: number;
}

export interface SyncOptions extends CloudApiOptions {
  /** Records per `GET /v1/records` page; the server's default (500) when omitted. */
  pageSize?: number;
}

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

/** The received settings, every part validated with its default as fallback; `null` if not an object. */
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

/** The bytes `record` adds to a `POST /v1/records` body (its JSON and a comma). */
export function recordBytes(record: CloudRecord): number {
  return utf8Length(JSON.stringify(record)) + 1;
}

/**
 * Splits `records` into request bodies of at most `maxCount` records and `maxBytes` bytes
 * (`{"records":[...]}` included), in order. A record too big for any batch on its own is left to
 * the caller, which never passes one. Pure.
 */
export function splitIntoBatches(
  records: readonly CloudRecord[],
  maxCount: number = PUSH_MAX_RECORDS,
  maxBytes: number = PUSH_MAX_BYTES,
): CloudRecord[][] {
  const envelope = utf8Length('{"records":[]}');
  const batches: CloudRecord[][] = [];
  let current: CloudRecord[] = [];
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

/** A record too big for the server: it stays on this device and the run reports it. */
class RecordTooLargeError extends ExplainedError {
  constructor(kind: CloudRecordKind, id: string) {
    super(
      `The ${kind} record ${id} is over the server's record size`,
      kind === 'session' ? 'errorCloudRecordTooLarge' : 'errorCloudNoteTooLarge',
    );
    this.name = 'RecordTooLargeError';
  }
}

/** A write the server refused for a reason this version does not know. */
class RecordRejectedError extends ExplainedError {
  constructor(kind: string, id: string, reason: string | undefined) {
    super(
      `The server refused the ${kind} record ${id} (${reason ?? 'no reason'})`,
      'errorCloudRejected',
    );
    this.name = 'RecordRejectedError';
  }
}

/** Why the server refuses a screenshot over the account's cap (server/src/types.ts). */
const IMAGE_LIMIT_REASON = 'image_limit';

/** What a tombstone's ciphertext holds: the deletion, authenticated like any other record. */
const TOMBSTONE_PAYLOAD = { deleted: true } as const;

/** Whether a decrypted tombstone says what its metadata says. Pure. */
function isTombstonePayload(value: unknown): boolean {
  return isRecord(value) && Object.keys(value).length === 1 && value.deleted === true;
}

/** A record that decrypted to something this version cannot use. */
class UnusableRecordError extends ExplainedError {
  constructor(kind: string, id: string) {
    super(`The ${kind} record ${id} has an unexpected shape`, 'errorCloudDecrypt');
    this.name = 'UnusableRecordError';
  }
}

// ---------------------------------------------------------------------------
// Settings (the one chrome.storage.sync access of sessions code)
// ---------------------------------------------------------------------------

/** The settings as they are on this device. */
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
 * Brings `settingsDirty` in line with the settings as they are now: clean when they equal what was
 * last exchanged with the server (also when a change was undone, or when the writes are the
 * server's own settings arriving), dirty and stamped now otherwise. Run on every change of a
 * setting once sync has started (also while not ready, like the session tracking), and before a
 * push. Being state-based, it cannot echo: settings applied from the server read back as
 * unchanged however their writes interleave.
 *
 * While settings received from the server are still being written (`pendingSettings`), nothing is
 * marked: the local settings are half old, half new, and taking them for an edit would send that
 * mix back over the other device's change. Returns whether such an apply is pending, so the
 * caller can ask for the sync that finishes it.
 */
export async function noteSettingsChange(
  reason: 'changed' | 'check' = 'changed',
  now: number = Date.now(),
): Promise<boolean> {
  if (!isCloudSyncEnabled()) {
    return false;
  }
  return withLock(async () => {
    const meta = await readSyncMeta();
    if (meta === undefined) {
      return false;
    }
    if (meta.pendingSettings !== undefined) {
      return true;
    }
    const next = settingsState(meta, settingsFingerprint(await readLocalSettings()), reason, now);
    if (next !== meta) {
      await writeSyncMeta(next);
    }
    return false;
  });
}

/**
 * `meta` with the settings marked clean or dirty for `currentHash`, `meta` itself when nothing
 * changes. A real change (`'changed'`) stamps the settings now; a `'check'` (before a push) only
 * marks settings that differ dirty when they were not, and leaves a pending stamp alone. Pure.
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

// ---------------------------------------------------------------------------
// The sync run
// ---------------------------------------------------------------------------

function withSyncLock<T>(fn: () => Promise<T>): Promise<T> {
  const locks = typeof navigator === 'undefined' ? undefined : navigator.locks;
  if (locks === undefined) {
    return fn();
  }
  return locks.request(SYNC_LOCK_NAME, fn);
}

/**
 * The bookkeeping for this account and key, started on the first sync: every saved session and
 * the settings marked dirty, the feed read from the start.
 */
async function startSyncMeta(context: SyncContext): Promise<CloudSyncMeta> {
  return withLock(async () => {
    const existing = await readSyncMetaFor(context);
    if (existing !== undefined) {
      return existing;
    }
    const saved: Record<string, number> = {};
    for (const summary of await sessionRepo.listSummaries()) {
      if (summary.kind === 'saved' && summary.unreadable === undefined) {
        saved[summary.id] = summary.updatedAt;
      }
    }
    const meta = freshSyncMeta(context, saved);
    await writeSyncMeta(meta);
    return meta;
  });
}

/** Read-modify-write of the bookkeeping under the sessions lock, while it is still this account's. */
async function updateMeta(
  context: SyncContext,
  update: (meta: CloudSyncMeta) => CloudSyncMeta,
): Promise<void> {
  await withLock(async () => {
    const meta = await readSyncMetaFor(context);
    if (meta !== undefined) {
      await writeSyncMeta(update(meta));
    }
  });
}

interface RunState {
  context: SyncContext;
  options: SyncOptions;
  pulled: number;
  pushed: number;
  /** Problems that did not stop the run (a record that does not decrypt, one too large). */
  problems: unknown[];
  /** A screenshot tombstone reached the server in this run (pulled, or pushed and applied). */
  imageDeletedOnServer: boolean;
}

/**
 * The record's content, checked against its metadata (the additional data it was encrypted with);
 * anything that does not decrypt is a `CloudDecryptError`. A tombstone is decrypted like any
 * record: one with an empty or forged ciphertext never deletes anything.
 */
async function decrypt(run: RunState, record: CloudRecord): Promise<unknown> {
  const { kind, id, updatedAt, deleted } = record;
  try {
    return await decryptRecord(run.context.rawKey, { kind, id, updatedAt, deleted }, record);
  } catch (err: unknown) {
    if (err instanceof CloudDecryptError) {
      throw err;
    }
    // Not base64, say: as unreadable as a ciphertext that fails its check.
    throw new CloudDecryptError(`The ${record.kind} record ${record.id} is not a ciphertext`);
  }
}

/** Applies one record from the server. Whether it changed anything here. */
async function applyRecord(
  run: RunState,
  record: CloudRecord,
  serverWinsTies: boolean,
): Promise<boolean> {
  // Decrypted first, whatever it is: nothing the server says outside the ciphertext is trusted.
  const content = await decrypt(run, record);
  if (record.kind === 'settings') {
    const settings = record.deleted ? null : parseSyncedSettings(content);
    if (settings === null || record.id !== SETTINGS_RECORD_ID) {
      throw new UnusableRecordError(record.kind, record.id);
    }
    return applySettingsRecord(run.context, settings, record.updatedAt, serverWinsTies);
  }
  if (record.deleted && !isTombstonePayload(content)) {
    throw new UnusableRecordError(record.kind, record.id);
  }
  if (record.kind === 'notes' || record.kind === 'image') {
    return applyNotesRecord(record, content, serverWinsTies);
  }
  if (record.deleted) {
    const outcome = await sessionRepo.applyRemote(
      { type: 'deleted', id: record.id, updatedAt: record.updatedAt },
      { serverWinsTies },
    );
    return outcome === 'applied';
  }
  const session = parseSyncedSession(content, record.id);
  if (session === null || session.updatedAt !== record.updatedAt) {
    throw new UnusableRecordError(record.kind, record.id);
  }
  const outcome = await sessionRepo.applyRemote({ type: 'session', session }, { serverWinsTies });
  return outcome === 'applied';
}

/** A notes or screenshot record, through `notesRepo.applyRemote()`. Its content is already decrypted. */
async function applyNotesRecord(
  record: CloudRecord,
  content: unknown,
  serverWinsTies: boolean,
): Promise<boolean> {
  const { id, updatedAt } = record;
  const options = { serverWinsTies };
  if (record.kind === 'notes') {
    if (record.deleted) {
      const outcome = await notesRepo.applyRemote(
        { type: 'notesDeleted', videoId: id, updatedAt },
        options,
      );
      return outcome === 'applied';
    }
    const notes = parseRemoteNotes(content, id);
    if (notes === null || notes.updatedAt !== updatedAt) {
      throw new UnusableRecordError(record.kind, id);
    }
    return (await notesRepo.applyRemote({ type: 'notes', notes }, options)) === 'applied';
  }
  if (record.deleted) {
    const outcome = await notesRepo.applyRemote(
      { type: 'imageDeleted', imageId: id, updatedAt },
      options,
    );
    return outcome === 'applied';
  }
  if (typeof content !== 'string' || !isImageDataUrl(content)) {
    throw new UnusableRecordError(record.kind, id);
  }
  const outcome = await notesRepo.applyRemote(
    { type: 'image', imageId: id, image: content, updatedAt },
    options,
  );
  return outcome === 'applied';
}

/**
 * Last writer wins for the settings record, against `settingsUpdatedAt`. When the server's are
 * newer they are put in use: the bookkeeping first, under the lock where the decision is made
 * (their fingerprint, and the settings themselves as `pendingSettings`, so the change listener
 * takes none of the writes below for a change of this device's own), then the writes
 * (`writeReceivedSettings()`), which clear `pendingSettings` when they are all done. A run cut
 * short in between leaves them pending, and the next sync writes them again before anything else.
 */
async function applySettingsRecord(
  context: SyncContext,
  settings: SyncedSettings,
  updatedAt: number,
  serverWinsTies: boolean,
): Promise<boolean> {
  const apply = await withLock(async () => {
    const meta = await readSyncMetaFor(context);
    if (meta === undefined) {
      return false;
    }
    const remoteWins =
      updatedAt > meta.settingsUpdatedAt ||
      (serverWinsTies && updatedAt === meta.settingsUpdatedAt);
    if (!remoteWins) {
      if (updatedAt < meta.settingsUpdatedAt && !meta.settingsDirty) {
        // This device's settings are newer and yet not pending (the server lost a write): send them.
        await writeSyncMeta({ ...meta, settingsDirty: true });
      }
      return false;
    }
    await writeSyncMeta({
      ...meta,
      settingsHash: settingsFingerprint(settings),
      settingsSyncedAt: updatedAt,
      settingsUpdatedAt: updatedAt,
      settingsDirty: false,
      pendingSettings: { ...settings },
    });
    return true;
  });
  if (!apply) {
    return false;
  }
  await writeReceivedSettings(context, settings);
  return true;
}

/**
 * Writes received settings on this device, then marks them written. The session settings go first
 * and the language last: in the app page a new `uiLanguage` reloads the page as soon as it lands
 * (`followUiLanguageChanges()`), and nothing after it may be needed. `pendingSettings` is cleared
 * only when it still holds these settings (a newer record may have replaced them meanwhile).
 */
async function writeReceivedSettings(
  context: SyncContext,
  settings: SyncedSettings,
): Promise<void> {
  await sessionRepo.setSettings(settings.sessionSettings);
  await chrome.storage.sync.set({ ...settings.sort, [UI_LANGUAGE_KEY]: settings.uiLanguage });
  const written = settingsFingerprint(settings);
  await updateMeta(context, (meta) => {
    const pending = parseSyncedSettings(meta.pendingSettings);
    if (pending === null || settingsFingerprint(pending) !== written) {
      return meta;
    }
    const next = { ...meta };
    delete next.pendingSettings;
    return next;
  });
}

/** Finishes writing settings an earlier run received but could not write to the end. */
async function resumeSettingsApply(context: SyncContext): Promise<void> {
  const meta = await readSyncMetaFor(context);
  const pending = parseSyncedSettings(meta?.pendingSettings);
  if (pending !== null) {
    await writeReceivedSettings(context, pending);
  }
}

/** Applies one record, keeping a failure to read it as a problem of the run. */
async function applyRecordSafely(
  run: RunState,
  record: CloudRecord,
  serverWinsTies: boolean,
): Promise<boolean> {
  try {
    return await applyRecord(run, record, serverWinsTies);
  } catch (err: unknown) {
    if (err instanceof ExplainedError && err.userKey === 'errorCloudDecrypt') {
      // Never deletes or changes anything here: the record is skipped, the local copy stays.
      console.warn(`[tabinet:sync] skipped ${record.kind} record ${record.id}`, err.message);
      run.problems.push(err);
      return false;
    }
    throw err;
  }
}

/**
 * Reads the change feed from the stored cursor to its end, storing the cursor after each page. When
 * a page asked for it (`rereadFeed`: notes that won here reference a screenshot this device had
 * already removed), the feed is read once more from the start in the same run.
 */
async function pull(run: RunState): Promise<void> {
  const meta = await readSyncMetaFor(run.context);
  if (meta === undefined) {
    return;
  }
  await pullFrom(run, meta.rereadFeed === true ? 0 : meta.cursor);
  let reread = false;
  await updateMeta(run.context, (current) => {
    if (current.rereadFeed !== true) {
      return current;
    }
    reread = true;
    const next = { ...current, cursor: 0 };
    delete next.rereadFeed;
    return next;
  });
  if (reread) {
    await pullFrom(run, 0);
  }
}

async function pullFrom(run: RunState, start: number): Promise<void> {
  let cursor = start;
  for (;;) {
    const page = await getRecords(
      run.context.account.token,
      cursor,
      run.options.pageSize,
      run.options,
    );
    // Screenshots after everything else on the page: a picture whose note is on the same page then
    // lands after that note, never as an orphan the repair pass could take for a leftover.
    const ordered = [
      ...page.records.filter((record) => record.kind !== 'image'),
      ...page.records.filter((record) => record.kind === 'image'),
    ];
    for (const record of ordered) {
      if (record.kind === 'image' && record.deleted) {
        run.imageDeletedOnServer = true;
      }
      if (await applyRecordSafely(run, record, false)) {
        run.pulled += 1;
      }
    }
    cursor = Math.max(cursor, page.next);
    await updateMeta(run.context, (current) => ({ ...current, cursor }));
    if (!page.hasMore || page.records.length === 0) {
      return;
    }
  }
}

/** Which bookkeeping set a pushed record came from. */
type OutgoingSet = 'dirty' | 'deleted' | 'settings';

/** One record to push and the bookkeeping entry it settles. */
interface Outgoing {
  record: CloudRecord;
  /** Which set the record came from (of its kind) and the stamp it had when read. */
  entry: { set: OutgoingSet; stamp: number; hash?: string };
}

/** The kinds tracked in a `RecordTrack` of `cloudSyncMeta`. */
type TrackedKind = 'notes' | 'image';

function trackKey(kind: TrackedKind): 'notes' | 'images' {
  return kind === 'notes' ? 'notes' : 'images';
}

/** Encrypts one live record, or reports it too large (it then stays pending, and local). */
async function outgoingRecord(
  run: RunState,
  recordMeta: { kind: CloudRecordKind; id: string; updatedAt: number },
  value: unknown,
  stamp: number,
): Promise<Outgoing | undefined> {
  const meta = { ...recordMeta, deleted: false };
  const payload = await encryptRecord(run.context.rawKey, meta, value);
  if (payload.ciphertext.length > MAX_CIPHERTEXT_CHARS) {
    run.problems.push(new RecordTooLargeError(recordMeta.kind, recordMeta.id));
    return undefined;
  }
  return { record: { ...meta, ...payload }, entry: { set: 'dirty', stamp } };
}

/** The tombstones of one kind\'s pending deletions. */
async function outgoingTombstones(
  run: RunState,
  kind: CloudRecordKind,
  deleted: Record<string, number>,
): Promise<Outgoing[]> {
  const outgoing: Outgoing[] = [];
  for (const [id, deletedAt] of Object.entries(deleted)) {
    if (!RECORD_ID.test(id)) {
      continue;
    }
    const recordMeta = { kind, id, updatedAt: deletedAt, deleted: true };
    const payload = await encryptRecord(run.context.rawKey, recordMeta, TOMBSTONE_PAYLOAD);
    outgoing.push({
      record: { ...recordMeta, ...payload },
      entry: { set: 'deleted', stamp: deletedAt },
    });
  }
  return outgoing;
}

/** The notes (`kind: 'notes'`) and screenshots (`kind: 'image'`) this device has to send. */
async function collectNotesOutgoing(
  run: RunState,
  meta: CloudSyncMeta,
): Promise<{ notes: Outgoing[]; images: Outgoing[] }> {
  const notes: Outgoing[] = [];
  const images: Outgoing[] = [];
  if (meta.notes === undefined || meta.images === undefined) {
    return { notes, images };
  }
  for (const [id, stamp] of Object.entries(meta.notes.dirty)) {
    if (!RECORD_ID.test(id)) {
      continue;
    }
    let body: VideoNotes | undefined;
    try {
      body = await notesRepo.get(id);
    } catch {
      body = undefined;
    }
    if (body === undefined) {
      // Gone (its tombstone is pending instead) or unreadable here: nothing to send.
      await updateMeta(run.context, (current) => dropEntry(current, 'notes', 'dirty', id, stamp));
      continue;
    }
    const item = await outgoingRecord(
      run,
      { kind: 'notes', id, updatedAt: body.updatedAt },
      body,
      stamp,
    );
    if (item !== undefined) {
      notes.push(item);
    }
  }
  notes.push(...(await outgoingTombstones(run, 'notes', meta.notes.deleted)));
  for (const [id, stamp] of Object.entries(meta.images.dirty)) {
    if (!RECORD_ID.test(id)) {
      continue;
    }
    const image = await notesRepo.getImage(id);
    if (image === undefined) {
      await updateMeta(run.context, (current) => dropEntry(current, 'image', 'dirty', id, stamp));
      continue;
    }
    // A picture has no `updatedAt` of its own: the stamp it was stored with is its version.
    const item = await outgoingRecord(run, { kind: 'image', id, updatedAt: stamp }, image, stamp);
    if (item !== undefined) {
      images.push(item);
    }
  }
  images.push(...(await outgoingTombstones(run, 'image', meta.images.deleted)));
  return { notes, images };
}

async function collectOutgoing(run: RunState): Promise<Outgoing[]> {
  // Settings first: bring the dirty flag in line with the settings as they are now.
  await noteSettingsChange('check');
  const meta = await readSyncMetaFor(run.context);
  if (meta === undefined) {
    return [];
  }
  const outgoing: Outgoing[] = [];

  const dirtyIds = Object.keys(meta.dirtySessions).filter((id) => RECORD_ID.test(id));
  const { bodies } = await sessionRepo.getMany(dirtyIds);
  for (const id of dirtyIds) {
    const stamp = meta.dirtySessions[id];
    const body = bodies.get(id);
    if (stamp === undefined) {
      continue;
    }
    if (body === undefined || body.kind !== 'saved') {
      // Gone (its tombstone is pending instead) or not a saved session: nothing to send.
      await updateMeta(run.context, (current) => dropEntry(current, 'session', 'dirty', id, stamp));
      continue;
    }
    const item = await outgoingRecord(
      run,
      { kind: 'session', id, updatedAt: body.updatedAt },
      body,
      stamp,
    );
    if (item !== undefined) {
      outgoing.push(item);
    }
  }
  outgoing.push(...(await outgoingTombstones(run, 'session', meta.deletedSessions)));

  // Notes before their screenshots, so another device reads a note before its picture.
  const { notes, images } = await collectNotesOutgoing(run, meta);
  outgoing.push(...notes);

  if (meta.settingsDirty) {
    const settings = await readLocalSettings();
    const recordMeta = {
      kind: 'settings',
      id: SETTINGS_RECORD_ID,
      updatedAt: meta.settingsUpdatedAt,
      deleted: false,
    } as const;
    const payload = await encryptRecord(run.context.rawKey, recordMeta, settings);
    outgoing.push({
      record: { ...recordMeta, ...payload },
      entry: {
        set: 'settings',
        stamp: meta.settingsUpdatedAt,
        hash: settingsFingerprint(settings),
      },
    });
  }
  outgoing.push(...images);
  return outgoing;
}

/**
 * `meta` without the entry `id` of `set` for `kind`, when it still has the `stamp` it was sent
 * with. Pure.
 */
function dropEntry(
  meta: CloudSyncMeta,
  kind: CloudRecordKind,
  set: 'dirty' | 'deleted',
  id: string,
  stamp: number,
): CloudSyncMeta {
  if (kind === 'notes' || kind === 'image') {
    const key = trackKey(kind);
    const track = meta[key];
    if (track === undefined || track[set][id] !== stamp) {
      return meta;
    }
    const entries = { ...track[set] };
    delete entries[id];
    return { ...meta, [key]: { ...track, [set]: entries } };
  }
  const key = set === 'dirty' ? 'dirtySessions' : 'deletedSessions';
  if (meta[key][id] !== stamp) {
    return meta;
  }
  const entries = { ...meta[key] };
  delete entries[id];
  return { ...meta, [key]: entries };
}

/** `meta` with `stamp` remembered as a version of `id` of `kind`, never lowering it. Pure. */
function withKnown(
  meta: CloudSyncMeta,
  kind: CloudRecordKind,
  id: string,
  stamp: number,
): CloudSyncMeta {
  if (kind !== 'notes' && kind !== 'image') {
    return withKnownVersion(meta, id, stamp);
  }
  const key = trackKey(kind);
  const track = meta[key];
  if (track === undefined || (track.known[id] ?? 0) >= stamp) {
    return meta;
  }
  return { ...meta, [key]: { ...track, known: { ...track.known, [id]: stamp } } };
}

/**
 * `meta` after the server accepted `item`; an entry changed again since is left pending. A
 * record's stamp is remembered in `knownVersions` (or its kind's `known`) either way, so the
 * server cannot later pass off anything older as new. Pure.
 */
export function afterApplied(
  meta: CloudSyncMeta,
  entry: Outgoing['entry'],
  kind: CloudRecordKind,
  id: string,
): CloudSyncMeta {
  if (entry.set === 'settings') {
    if (!meta.settingsDirty || meta.settingsUpdatedAt !== entry.stamp) {
      return meta;
    }
    return {
      ...meta,
      settingsDirty: false,
      settingsHash: entry.hash,
      settingsSyncedAt: entry.stamp,
    };
  }
  return withKnown(dropEntry(meta, kind, entry.set, id, entry.stamp), kind, id, entry.stamp);
}

/**
 * `meta` after the server refused screenshot `id` over the account's cap: the picture is held back
 * (it stays here and is offered again once a screenshot is deleted somewhere). An entry changed
 * since is left pending. Pure.
 */
export function afterImageRefused(meta: CloudSyncMeta, id: string, stamp: number): CloudSyncMeta {
  const dropped = dropEntry(meta, 'image', 'dirty', id, stamp);
  if (dropped === meta) {
    return meta;
  }
  return withHeldImages(dropped, { ...meta.heldImages, [id]: stamp });
}

/**
 * `meta` with every held-back screenshot pending again, once a deletion made room on the server.
 * One the server still refuses is held back again by that push. Pure.
 */
export function withHeldImagesReleased(meta: CloudSyncMeta): CloudSyncMeta {
  const held = meta.heldImages;
  if (held === undefined || meta.images === undefined) {
    return meta;
  }
  const dirty = { ...meta.images.dirty };
  for (const [id, stamp] of Object.entries(held)) {
    if (meta.images.deleted[id] === undefined) {
      dirty[id] = Math.max(dirty[id] ?? 0, stamp);
    }
  }
  return { ...withHeldImages(meta, {}), images: { ...meta.images, dirty } };
}

/** After a screenshot was deleted on the server in this run, the held-back ones are offered again. */
async function releaseHeldImages(run: RunState): Promise<void> {
  if (!run.imageDeletedOnServer) {
    return;
  }
  run.imageDeletedOnServer = false;
  await updateMeta(run.context, withHeldImagesReleased);
}

async function push(run: RunState): Promise<void> {
  const outgoing = await collectOutgoing(run);
  const byKey = new Map(outgoing.map((item) => [`${item.record.kind}:${item.record.id}`, item]));
  for (const batch of splitIntoBatches(outgoing.map((item) => item.record))) {
    const results = await postRecords(run.context.account.token, batch, run.options);
    const applied: { kind: CloudRecordKind; id: string; entry: Outgoing['entry'] }[] = [];
    for (const result of results) {
      const item = byKey.get(`${result.kind}:${result.id}`);
      if (item === undefined) {
        continue;
      }
      if (result.status === 'applied') {
        applied.push({ kind: result.kind, id: result.id, entry: item.entry });
        if (result.kind === 'image' && item.record.deleted) {
          run.imageDeletedOnServer = true;
        }
        continue;
      }
      if (result.status === 'rejected') {
        await applyRejected(run, item, result.reason);
        continue;
      }
      // Stale: the server's copy is as new or newer and wins. Applying it drops the pending entry,
      // unless this device changed the item again meanwhile (then it is sent next time).
      if (result.current !== undefined) {
        await applyStale(run, item, result.current);
      }
    }
    if (applied.length > 0) {
      run.pushed += applied.length;
      await updateMeta(run.context, (meta) =>
        applied.reduce(
          (current, { kind, id, entry }) => afterApplied(current, entry, kind, id),
          meta,
        ),
      );
    }
  }
}

/**
 * A write the server refused. A screenshot over the account's cap is held back, quietly: Settings
 * says so once. Anything else stays pending and is reported.
 */
async function applyRejected(
  run: RunState,
  item: Outgoing,
  reason: string | undefined,
): Promise<void> {
  const { kind, id, deleted } = item.record;
  if (kind === 'image' && !deleted && reason === IMAGE_LIMIT_REASON) {
    await updateMeta(run.context, (meta) => afterImageRefused(meta, id, item.entry.stamp));
    return;
  }
  run.problems.push(new RecordRejectedError(kind, id, reason));
}

async function applyStale(
  run: RunState,
  item: Outgoing,
  current: CloudRecordWithSeq,
): Promise<void> {
  if (current.kind !== item.record.kind || current.id !== item.record.id) {
    // An answer about another record settles nothing: the entry stays pending.
    run.problems.push(new UnusableRecordError(current.kind, current.id));
    return;
  }
  try {
    await applyRecord(run, current, true);
  } catch (err: unknown) {
    if (!(err instanceof ExplainedError && err.userKey === 'errorCloudDecrypt')) {
      throw err;
    }
    console.warn(`[tabinet:sync] the server's ${current.kind} ${current.id} does not decrypt`);
    run.problems.push(err);
    const { set, stamp } = item.entry;
    if (set === 'deleted') {
      // A deletion stays pending: dropping it on the word of an unreadable record would leave
      // nothing here to refuse a later replay of the record's old body with. It is offered again.
      return;
    }
    // The server's copy cannot be read here. This device's copy is kept untouched and no longer
    // offered, so the push does not repeat forever.
    if (set === 'dirty') {
      const { kind, id } = item.record;
      await updateMeta(run.context, (meta) => dropEntry(meta, kind, set, id, stamp));
    } else {
      await updateMeta(run.context, (meta) =>
        meta.settingsUpdatedAt === stamp ? { ...meta, settingsDirty: false } : meta,
      );
    }
  }
}

/** Remembers that Settings said screenshots are held back, so it says so only once. */
export async function markHeldImagesNoticed(): Promise<void> {
  await withLock(async () => {
    const meta = await readSyncMeta();
    if (meta?.heldImages !== undefined && meta.heldImagesNoticed !== true) {
      await writeSyncMeta({ ...meta, heldImagesNoticed: true });
    }
  });
}

/** Records how the run ended: `lastSyncAt` and `lastError`, in the UI language. */
async function finish(context: SyncContext, problem: unknown): Promise<void> {
  let lastError: string | undefined;
  if (problem !== undefined) {
    // The worker words text only once the language chosen in Settings is known.
    await uiLanguageReady();
    lastError = errorMessage(problem);
  }
  const now = Date.now();
  await updateMeta(context, (meta) => {
    const next: CloudSyncMeta = { ...meta, lastSyncAt: now };
    if (lastError === undefined) {
      delete next.lastError;
    } else {
      next.lastError = lastError;
    }
    return next;
  });
}

/**
 * One sync: pull the server's changes, then push this device's. `'notReady'` while unconfigured,
 * signed out or without the key; `'failed'` when the server could not be reached or refused (the
 * dirty sets stay, so the next run retries; a 401 signs this device out); `'synced'` otherwise,
 * also when single records were skipped (they are named in `lastError`).
 */
export async function syncNow(options: SyncOptions = {}): Promise<SyncResult> {
  if (!isCloudSyncEnabled()) {
    return { outcome: 'notReady', pulled: 0, pushed: 0 };
  }
  return withSyncLock(async () => {
    const context = await loadSyncContext();
    if (context === null) {
      // A token that expired writes nothing, so no storage change cleared the alarms: do it here,
      // or the periodic alarm would keep waking the worker for nothing.
      await ensureSyncAlarm();
      return { outcome: 'notReady', pulled: 0, pushed: 0 };
    }
    const run: RunState = {
      context,
      options,
      pulled: 0,
      pushed: 0,
      problems: [],
      imageDeletedOnServer: false,
    };
    try {
      await startSyncMeta(context);
      await notesRepo.startSyncTracking();
      await resumeSettingsApply(context);
      await pull(run);
      await releaseHeldImages(run);
      await push(run);
      await releaseHeldImages(run);
    } catch (err: unknown) {
      if (err instanceof CloudUnauthorizedError) {
        // Signed out on the server: forget the account like every other 401 (#166). The
        // bookkeeping stays, so what was not sent yet (deletions too) goes after signing in again.
        await forgetCloudAccount();
        return { outcome: 'failed', pulled: run.pulled, pushed: run.pushed };
      }
      console.warn('[tabinet:sync] sync failed', err);
      await finish(context, err);
      return { outcome: 'failed', pulled: run.pulled, pushed: run.pushed };
    }
    await finish(context, run.problems[0]);
    return { outcome: 'synced', pulled: run.pulled, pushed: run.pushed };
  });
}

// ---------------------------------------------------------------------------
// Triggers (wired by src/service-worker.ts)
// ---------------------------------------------------------------------------

export function isSyncAlarm(name: string): boolean {
  return name === CLOUD_SYNC_ALARM || name === CLOUD_SYNC_SOON_ALARM;
}

/**
 * Arms the periodic sync while this device is ready, and clears both sync alarms otherwise. Does
 * nothing at all while cloud sync is unconfigured.
 */
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
    delayInMinutes: SYNC_PERIOD_MINUTES,
    periodInMinutes: SYNC_PERIOD_MINUTES,
  });
}

/**
 * A sync about a minute from now, while ready. An alarm already waiting is left as it is, so a
 * stream of changes syncs a minute after the first rather than never.
 */
export async function scheduleSoonSync(): Promise<void> {
  if (!isCloudSyncEnabled() || (await loadSyncContext()) === null) {
    return;
  }
  if ((await chrome.alarms.get(CLOUD_SYNC_SOON_ALARM)) !== undefined) {
    return;
  }
  await chrome.alarms.create(CLOUD_SYNC_SOON_ALARM, { delayInMinutes: SYNC_SOON_MINUTES });
}

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
 * The worker's `storage.onChanged` part for sync:
 *
 * - the account or the key changed: the alarms are armed (and a sync is due soon) when this device
 *   is ready, cleared otherwise. The bookkeeping stays either way: changes are still recorded,
 *   and signing in again to the same account and key resumes it;
 * - a setting changed (sort settings or the language in sync storage, `sessionSettings`): the
 *   settings are marked dirty, or clean again when they are back to what the server has; while
 *   received settings are still being written, a sync soon finishes them instead;
 * - `cloudSyncMeta` gained something to send: a sync about a minute later.
 *
 * Returns at once while cloud sync is unconfigured.
 */
export async function handleCloudStorageChange(
  changes: { [key: string]: chrome.storage.StorageChange },
  areaName: string,
): Promise<void> {
  if (!isCloudSyncEnabled()) {
    return;
  }
  if (areaName === 'local' && (CLOUD_ACCOUNT_KEY in changes || CLOUD_SYNC_KEY in changes)) {
    await ensureSyncAlarm();
    if ((await loadSyncContext()) === null) {
      return;
    }
    await scheduleSoonSync();
    return;
  }
  if (touchesSettings(changes, areaName) && (await noteSettingsChange())) {
    await scheduleSoonSync();
  }
  const meta = changes[CLOUD_SYNC_META_KEY];
  if (areaName === 'local' && meta !== undefined && syncWorkGrew(meta.oldValue, meta.newValue)) {
    await scheduleSoonSync();
  }
}
