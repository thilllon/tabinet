/**
 * Doc records (spec section 11): one synced item per memo or YouTube note, `kind: 'doc'`, an
 * opaque HMAC id, `{type, version, data}` encrypted inside. A collection declares its type and
 * how to read and compare its items (`DocCollection`); its store gives the engine a transaction
 * over its own storage (`DocStore`). The engine's generic steps are here: the envelope check,
 * `resolveDoc()` (pure, 11.2), tracking start, applying a batch, reading what to send, and the
 * one way a store records its own write (`trackLocalDocChange()`).
 *
 * Every store transaction takes its own lock, then the sessions lock, and commits everything it
 * staged in one `set` (10.6). Nothing here touches `chrome.*` itself.
 */
import { POLICY } from '@/constants';
import { docRecordId, memoCopyId, sha256Base64Url } from '@/lib/cloud-crypto';
import { stampOf } from '@/lib/cloud-sync-state';
import type { CloudSyncMeta, DocTrack, RecordOut, Version } from '@/types';

export interface DocCollection<Live extends { id: string }, Deleted extends { id: string }> {
  /** `^[a-z][A-Za-z0-9]{0,31}$`. */
  type: string;
  /** A positive integer. */
  version: number;
  conflict: 'lastWriter' | 'keepBoth';
  /** Exact keys. */
  parseLive(data: unknown): Live | null;
  /** Exact keys. */
  parseDeleted(data: unknown): Deleted | null;
  /** The deleted data of a local item, for its tombstone (`parent` from its track). */
  deletedOf(localId: string, parent: string | undefined): Deleted;
  /** A change of parent for an existing ref is unusable. */
  parentOf?(data: Live | Deleted): string;
  /** The screenshot this item references. */
  imageOf?(data: Live): string | undefined;
  /** Fixed field order; a deletion is `["deleted"]`. */
  fingerprint(data: Live): unknown[];
  /** Required when `conflict` is `'keepBoth'`. */
  keepBoth?: {
    textOf(data: Live): string;
    makeCopy(data: Live, copyId: string, originalId: string, now: number): Live;
  };
}

/** A local item as the store reads it; `at` is its stamp. */
export type LocalDoc<Live> =
  | { state: 'none' }
  | { state: 'live'; data: Live; at: number }
  | { state: 'unreadable' };

export interface DocTx<Live, Deleted> {
  /** A working copy, written in the commit. */
  readonly meta: CloudSyncMeta;
  read(localId: string): Promise<LocalDoc<Live>>;
  /** For tracking start; `imageAt` is the stamp of the item's screenshot, if it has one. */
  listLive(): Promise<{ data: Live; at: number; imageAt?: number }[]>;
  /** Staged. */
  put(data: Live, at: number): void;
  /** Staged; the store derives what else goes with it (a note's picture). */
  remove(deleted: Deleted, at: number): void;
  readImage?(id: string): Promise<string | null | 'unreadable'>;
  putImage?(id: string, dataUrl: string): void;
  removeImage?(id: string): void;
  /** By a readable local item. */
  imageReferenced?(id: string): Promise<boolean>;
  /** Any key, e.g. `cloudRaw:*`; `null` deletes. */
  stage(key: string, value: unknown): void;
}

export interface DocStore<Live extends { id: string }, Deleted extends { id: string }> {
  collection: DocCollection<Live, Deleted>;
  /** Its own lock, then the sessions lock; everything staged is committed as one `set`. */
  transact<T>(run: (tx: DocTx<Live, Deleted>) => Promise<T>): Promise<T>;
}

// The engine handles stores of any collection the same way.
// oxlint-disable-next-line typescript/no-explicit-any -- a store of any collection, read through its own parsers
export type AnyDocStore = DocStore<any, any>;

const TYPE = /^[a-z][A-Za-z0-9]{0,31}$/;

/** The bookkeeping a transaction found is not the run's any more: it writes nothing. */
export class StaleMetaError extends Error {
  constructor() {
    super('The sync bookkeeping belongs to another account or key');
    this.name = 'StaleMetaError';
  }
}

/** Whether a transaction's bookkeeping is the run's; throwing aborts the commit. */
export type MetaGuard = (meta: CloudSyncMeta) => boolean;

function guard(meta: CloudSyncMeta, belongs: MetaGuard | undefined): void {
  if (belongs !== undefined && !belongs(meta)) {
    throw new StaleMetaError();
  }
}

export function docRef(type: string, localId: string): string {
  return `${type}:${localId}`;
}

// ---------------------------------------------------------------------------
// The envelope (11.1)
// ---------------------------------------------------------------------------

export type DocCheck =
  | { state: 'ok'; store: AnyDocStore; type: string; data: { id: string } }
  | { state: 'held'; reason: 'newer' | 'unknownType'; ref: string }
  | { state: 'unreadable' };

/**
 * Checks a decrypted doc against its record: exactly `type`, `version`, `data`, a valid type and
 * a positive integer version, a string `data.id`, and the HMAC id of `(type, data.id)` equal to
 * the record id. A known type and version must parse (live or deleted by the record); a higher
 * version or an unknown type is held. Anything else is unreadable.
 */
export async function checkDoc(
  dek: string,
  record: Pick<RecordOut, 'id' | 'deleted'>,
  content: unknown,
  stores: readonly AnyDocStore[],
): Promise<DocCheck> {
  if (typeof content !== 'object' || content === null || Array.isArray(content)) {
    return { state: 'unreadable' };
  }
  const value = content as Record<string, unknown>;
  const keys = Object.keys(value);
  const { type, version, data } = value;
  if (
    keys.length !== 3 ||
    !keys.every((key) => key === 'type' || key === 'version' || key === 'data') ||
    typeof type !== 'string' ||
    !TYPE.test(type) ||
    typeof version !== 'number' ||
    !Number.isInteger(version) ||
    version < 1 ||
    typeof data !== 'object' ||
    data === null ||
    typeof (data as { id?: unknown }).id !== 'string'
  ) {
    return { state: 'unreadable' };
  }
  const id = (data as { id: string }).id;
  if ((await docRecordId(dek, type, id)) !== record.id) {
    return { state: 'unreadable' };
  }
  const store = stores.find((candidate) => candidate.collection.type === type);
  if (store === undefined) {
    return { state: 'held', reason: 'unknownType', ref: docRef(type, id) };
  }
  if (version > store.collection.version) {
    return { state: 'held', reason: 'newer', ref: docRef(type, id) };
  }
  const parsed = record.deleted
    ? store.collection.parseDeleted(data)
    : store.collection.parseLive(data);
  if (parsed === null || version !== store.collection.version) {
    return { state: 'unreadable' };
  }
  return { state: 'ok', store, type, data: parsed };
}

/** `b64u(SHA-256(json(fingerprint)))`, `["deleted"]` for a deletion. */
export async function docHash<Live extends { id: string }>(
  collection: DocCollection<Live, { id: string }>,
  data: Live | null,
): Promise<string> {
  return sha256Base64Url(
    JSON.stringify(data === null ? ['deleted'] : collection.fingerprint(data)),
  );
}

// ---------------------------------------------------------------------------
// resolveDoc (11.2), pure
// ---------------------------------------------------------------------------

export interface RemoteDoc<Live, Deleted> {
  at: number;
  deleted: boolean;
  data: Live | Deleted;
  seq: number;
  /** `docHash()` of the remote content. */
  hash: string;
}

export type DocAction = 'hold' | 'keep' | 'take' | 'copy';

export interface DocResolution {
  action: DocAction;
  /** The track afterwards (unchanged for `'hold'`). */
  track: DocTrack;
  /** A kept local version restamped to this (body and bookkeeping in one write). */
  restamp?: number;
}

/**
 * What a remote doc record does here (11.2). Echoes and replays (at or below `known`) never
 * apply content; a push of this device whose answer was lost (it matches `sent`) settles
 * without a copy; otherwise the remote version becomes `known` and, against a pending local
 * version, `lastWriter` keeps the later stamp (remote wins a tie) and `keepBoth` keeps both texts
 * (`'copy'`), an edit beating a deletion. An untouched automatic copy always yields. A kept
 * pending version at or below `known` is restamped above it, else it would be stale forever.
 */
export function resolveDoc<Live extends { id: string }, Deleted extends { id: string }>(
  collection: DocCollection<Live, Deleted>,
  track: DocTrack | undefined,
  local: LocalDoc<Live>,
  remote: RemoteDoc<Live, Deleted>,
  recordId: string,
): DocResolution {
  const base: DocTrack = track ?? {
    recordId,
    seq: null,
    known: null,
    pending: local.state === 'live' ? { at: local.at, deleted: false } : null,
    sent: [],
  };
  if (local.state === 'unreadable') {
    return { action: 'hold', track: base };
  }
  const next: DocTrack = {
    ...base,
    recordId: base.recordId === '' ? recordId : base.recordId,
    known: base.known === null ? null : { ...base.known },
    pending: base.pending === null ? null : { ...base.pending },
    sent: [...base.sent],
  };
  if (next.pending !== null && !next.pending.deleted && local.state === 'none') {
    next.pending = null;
  }
  const keep = (): DocResolution => {
    if (next.pending !== null && next.known !== null && next.pending.at <= next.known.at) {
      next.pending = { ...next.pending, at: next.known.at + 1 };
      return { action: 'keep', track: next, restamp: next.pending.at };
    }
    return { action: 'keep', track: next };
  };
  const take = (): DocResolution => {
    next.pending = null;
    delete next.autoCopy;
    return { action: 'take', track: next };
  };

  if (next.known !== null && remote.at <= next.known.at) {
    next.seq = remote.seq;
    if (
      remote.at < next.known.at &&
      next.pending === null &&
      (next.known.deleted || local.state === 'live')
    ) {
      next.pending = { ...next.known };
    }
    if (remote.at === next.known.at && next.pending !== null && next.pending.at === next.known.at) {
      next.pending = null;
    }
    return keep();
  }

  const remoteVersion: Version = { at: remote.at, deleted: remote.deleted };
  if (next.sent.some((sent) => sent.at === remote.at && sent.hash === remote.hash)) {
    next.known = remoteVersion;
    next.seq = remote.seq;
    next.sent = [];
    if (next.pending !== null && next.pending.at === remote.at) {
      next.pending = null;
    }
    return keep();
  }

  next.known = remoteVersion;
  next.seq = remote.seq;
  next.sent = [];
  if (next.pending === null || next.autoCopy === true) {
    return take();
  }
  if (collection.conflict === 'lastWriter') {
    return remote.at >= next.pending.at ? take() : keep();
  }
  if (next.pending.deleted) {
    return take();
  }
  if (
    !remote.deleted &&
    local.state === 'live' &&
    collection.keepBoth !== undefined &&
    collection.keepBoth.textOf(local.data) === collection.keepBoth.textOf(remote.data as Live)
  ) {
    return take();
  }
  // Both versions are kept: the local text becomes a copy, then the remote one is taken.
  next.pending = null;
  delete next.autoCopy;
  return { action: 'copy', track: next };
}

// ---------------------------------------------------------------------------
// The engine's generic steps
// ---------------------------------------------------------------------------

/** A doc stamp (10.4): `max(now, previous + 1, known.at + 1, pending.at + 1)`. Pure. */
export function nextDocStamp(track: DocTrack | undefined, previous: number, now: number): number {
  return Math.max(now, previous + 1, (track?.known?.at ?? 0) + 1, (track?.pending?.at ?? 0) + 1);
}

/** A screenshot stamp (10.4): `max(now, version + 1)`. Pure. */
export function nextImageStamp(meta: CloudSyncMeta, id: string, now: number): number {
  const version = Math.max(
    meta.images.dirty[id] ?? 0,
    meta.images.deleted[id] ?? 0,
    meta.images.known[id] ?? 0,
  );
  return Math.max(now, version + 1);
}

/** A local change of a store's own, for `trackLocalDocChange()`. */
export interface LocalDocChange<Live, Deleted> {
  localId: string;
  /** The item before the change, when there was one (its screenshot may go). */
  before: Live | null;
  after: { live: Live } | { deleted: Deleted };
  /** The item's stamp before the change (its body's `updatedAt`), 0 for a new one. */
  previousAt: number;
  now: number;
}

/**
 * Records a store's own write in the working bookkeeping, inside its `transact()`, and returns
 * the stamp the store writes the item with. Nothing is tracked before the collection's tracking
 * started for this key (that start offers every item anyway). A deletion of an item with a
 * screenshot records the screenshot's tombstone and its owner (10.5); a new screenshot is dirty.
 */
export function trackLocalDocChange<Live extends { id: string }, Deleted extends { id: string }>(
  tx: DocTx<Live, Deleted>,
  collection: DocCollection<Live, Deleted>,
  change: LocalDocChange<Live, Deleted>,
): number {
  const meta = tx.meta as CloudSyncMeta & { docs: Record<string, DocTrack> };
  const ref = docRef(collection.type, change.localId);
  const track = meta.docs[ref];
  const stamp = nextDocStamp(track, change.previousAt, change.now);
  if (!meta.started.includes(collection.type)) {
    return stamp;
  }
  const deleted = 'deleted' in change.after;
  const next: DocTrack = track ?? { recordId: '', seq: null, known: null, pending: null, sent: [] };
  next.pending = { at: stamp, deleted };
  delete next.autoCopy;
  const data = 'live' in change.after ? change.after.live : change.after.deleted;
  if (collection.parentOf !== undefined) {
    next.parent = collection.parentOf(data);
  }
  meta.docs[ref] = next;
  const imageBefore = change.before === null ? undefined : collection.imageOf?.(change.before);
  const imageAfter = 'live' in change.after ? collection.imageOf?.(change.after.live) : undefined;
  if (meta.started.includes('image')) {
    if (imageAfter !== undefined && imageAfter !== imageBefore) {
      meta.images.dirty[imageAfter] = nextImageStamp(meta, imageAfter, change.now);
      delete meta.images.deleted[imageAfter];
      delete meta.images.owner[imageAfter];
    }
    if (imageBefore !== undefined && imageBefore !== imageAfter) {
      meta.images.deleted[imageBefore] = nextImageStamp(meta, imageBefore, change.now);
      meta.images.owner[imageBefore] = ref;
      delete meta.images.dirty[imageBefore];
    }
  }
  meta.changedAt = Math.max(change.now, (meta.changedAt ?? 0) + 1);
  return stamp;
}

/**
 * Starts tracking a collection for this key, once (`started`): every live item pending at its
 * validated stamp, its screenshot dirty. Whether it started now.
 */
export async function startDocTracking(
  store: AnyDocStore,
  dek: string,
  now: number,
  belongs?: MetaGuard,
): Promise<boolean> {
  return store.transact(async (tx) => {
    const { collection } = store;
    const meta = tx.meta;
    guard(meta, belongs);
    if (meta.started.includes(collection.type)) {
      return false;
    }
    const withImages = tx.readImage !== undefined;
    for (const { data, at, imageAt } of await tx.listLive()) {
      const ref = docRef(collection.type, data.id);
      const track: DocTrack = meta.docs[ref] ?? {
        recordId: await docRecordId(dek, collection.type, data.id),
        seq: null,
        known: null,
        pending: null,
        sent: [],
      };
      track.pending = { at: stampOf(at, now), deleted: false };
      if (collection.parentOf !== undefined) {
        track.parent = collection.parentOf(data);
      }
      meta.docs[ref] = track;
      const image = collection.imageOf?.(data);
      if (withImages && image !== undefined) {
        meta.images.dirty[image] = stampOf(imageAt ?? at, now);
      }
    }
    meta.started.push(collection.type);
    if (withImages && !meta.started.includes('image')) {
      meta.started.push('image');
    }
    return true;
  });
}

/** A doc record decoded and checked for one store. */
export interface DecodedDoc {
  record: RecordOut;
  data: { id: string };
}

export interface DocBatchResult {
  applied: number;
  /** Refs whose local body could not be read: the engine holds them with their raw record. */
  held: { ref: string; record: RecordOut }[];
  /** A pending doc left after a stale answer, to send once more in this run. */
  retry: string[];
}

/**
 * Applies `records` (all of `store`'s type, in feed order) in one transaction: `resolveDoc()` per
 * record over one working state, so a copy made by one is visible to the next; content taken,
 * copies made, kept versions restamped; screenshots follow their notes (10.5). `after` runs in the
 * same transaction once the docs are applied (the engine's screenshot records, 10.6).
 */
export async function applyDocBatch(
  store: AnyDocStore,
  records: readonly DecodedDoc[],
  dek: string,
  now: number,
  belongs?: MetaGuard,
  after?: (tx: DocTx<{ id: string }, { id: string }>) => Promise<number>,
): Promise<DocBatchResult> {
  const { collection } = store;
  const result: DocBatchResult = { applied: 0, held: [], retry: [] };
  if (records.length === 0 && after === undefined) {
    return result;
  }
  return store.transact(async (tx) => {
    const meta = tx.meta;
    guard(meta, belongs);
    for (const { record, data } of records) {
      const ref = docRef(collection.type, data.id);
      const local = await tx.read(data.id);
      const remote: RemoteDoc<{ id: string }, { id: string }> = {
        at: record.updatedAt,
        deleted: record.deleted,
        data,
        seq: record.seq,
        hash: await docHash(collection, record.deleted ? null : data),
      };
      const track = meta.docs[ref];
      if (
        track?.parent !== undefined &&
        collection.parentOf !== undefined &&
        collection.parentOf(data) !== track.parent
      ) {
        // A change of parent for an existing ref is unusable.
        continue;
      }
      const resolution = resolveDoc(collection, track, local, remote, record.id);
      if (resolution.action === 'hold') {
        result.held.push({ ref, record });
        continue;
      }
      const nextTrack = resolution.track;
      if (collection.parentOf !== undefined) {
        nextTrack.parent = collection.parentOf(data);
      }
      meta.docs[ref] = nextTrack;
      delete meta.unreadable[`doc:${record.id}`];
      if (resolution.action === 'keep') {
        if (resolution.restamp !== undefined && local.state === 'live') {
          tx.put(local.data, resolution.restamp);
        }
        continue;
      }
      if (resolution.action === 'copy' && local.state === 'live') {
        await makeCopy(tx, store, local.data, data.id, record.updatedAt, dek, now);
      }
      const before = local.state === 'live' ? local.data : null;
      if (record.deleted) {
        if (local.state === 'live') {
          tx.remove(data, record.updatedAt);
          result.applied += 1;
        }
      } else {
        tx.put(data, record.updatedAt);
        result.applied += 1;
      }
      await followImages(
        tx,
        collection,
        ref,
        before,
        record.deleted ? null : data,
        record.updatedAt,
        now,
      );
    }
    if (after !== undefined) {
      result.applied += await after(tx);
    }
    return result;
  });
}

/** The copy of a keepBoth conflict (11.4): the same copy id on every device and replay. */
async function makeCopy(
  tx: DocTx<{ id: string }, { id: string }>,
  store: AnyDocStore,
  local: { id: string },
  originalId: string,
  remoteAt: number,
  dek: string,
  now: number,
): Promise<void> {
  const { collection } = store;
  const keepBoth = collection.keepBoth;
  if (keepBoth === undefined) {
    return;
  }
  const text = keepBoth.textOf(local);
  for (let n = 0; ; n += 1) {
    const candidate = await memoCopyId(originalId, text, n);
    const existing = await tx.read(candidate);
    if (existing.state === 'live' && keepBoth.textOf(existing.data) === text) {
      return;
    }
    const ref = docRef(collection.type, candidate);
    if (existing.state === 'none' && tx.meta.docs[ref] === undefined) {
      const at = Math.max(now, remoteAt + 1);
      tx.put(keepBoth.makeCopy(local, candidate, originalId, now), at);
      tx.meta.docs[ref] = {
        recordId: await docRecordId(dek, collection.type, candidate),
        seq: null,
        known: null,
        pending: { at, deleted: false },
        sent: [],
        autoCopy: true,
      };
      tx.meta.conflicts += 1;
      tx.meta.changedAt = Math.max(now, (tx.meta.changedAt ?? 0) + 1);
      return;
    }
  }
}

/**
 * Screenshots after a doc's content changed here (10.5): the winning item drops a pending
 * deletion of the picture it references (a picture already gone here is read again from the
 * feed); a picture the item no longer references goes, with its tombstone recorded.
 */
async function followImages(
  tx: DocTx<{ id: string }, { id: string }>,
  collection: DocCollection<{ id: string }, { id: string }>,
  ref: string,
  before: { id: string } | null,
  after: { id: string } | null,
  at: number,
  now: number,
): Promise<void> {
  if (collection.imageOf === undefined || tx.readImage === undefined) {
    return;
  }
  const meta = tx.meta;
  const imageBefore = before === null ? undefined : collection.imageOf(before);
  const imageAfter = after === null ? undefined : collection.imageOf(after);
  if (imageAfter !== undefined) {
    if (meta.images.deleted[imageAfter] !== undefined) {
      delete meta.images.deleted[imageAfter];
      delete meta.images.owner[imageAfter];
    }
    if ((await tx.readImage(imageAfter)) === null && meta.images.known[imageAfter] !== undefined) {
      delete meta.images.known[imageAfter];
      meta.rereadFeed = true;
    }
  }
  if (imageBefore !== undefined && imageBefore !== imageAfter) {
    tx.removeImage?.(imageBefore);
    if (meta.started.includes('image')) {
      meta.images.deleted[imageBefore] = Math.max(nextImageStamp(meta, imageBefore, now), at);
      meta.images.owner[imageBefore] = ref;
      delete meta.images.dirty[imageBefore];
    }
  }
}

/** One doc to send, its body and stamp read together under the store's locks. */
export interface OutgoingDoc {
  ref: string;
  recordId: string;
  at: number;
  deleted: boolean;
  content: { type: string; version: number; data: { id: string } };
  baseSeq: number | null;
  hash: string;
}

/**
 * The docs among `refs` to send now, body and stamp read together. A pending live version whose
 * item is gone is dropped; an unreadable one is skipped. Each sent version is remembered in
 * `sent` (at most `POLICY.sync.sentVersions`, deduplicated) before the POST.
 */
export async function readOutgoingDocs(
  store: AnyDocStore,
  refs: readonly string[],
  dek: string,
  belongs?: MetaGuard,
): Promise<OutgoingDoc[]> {
  const { collection } = store;
  return store.transact(async (tx) => {
    guard(tx.meta, belongs);
    const out: OutgoingDoc[] = [];
    for (const ref of refs) {
      const track = tx.meta.docs[ref];
      if (track?.pending == null) {
        continue;
      }
      const localId = ref.slice(collection.type.length + 1);
      let data: { id: string };
      if (track.pending.deleted) {
        data = collection.deletedOf(localId, track.parent);
      } else {
        const local = await tx.read(localId);
        if (local.state === 'none') {
          track.pending = null;
          continue;
        }
        if (local.state === 'unreadable') {
          continue;
        }
        data = local.data;
      }
      if (track.recordId === '') {
        track.recordId = await docRecordId(dek, collection.type, localId);
      }
      const hash = await docHash(collection, track.pending.deleted ? null : data);
      const sent = track.sent.filter(
        (entry) => entry.at !== track.pending!.at || entry.hash !== hash,
      );
      sent.push({ at: track.pending.at, hash });
      track.sent = sent.slice(-POLICY.sync.sentVersions);
      out.push({
        ref,
        recordId: track.recordId,
        at: track.pending.at,
        deleted: track.pending.deleted,
        content: { type: collection.type, version: collection.version, data },
        baseSeq: track.seq,
        hash,
      });
    }
    return out;
  });
}
