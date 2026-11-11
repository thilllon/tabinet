import { isCloudSyncEnabled } from '@/lib/cloud-config';
import {
  type CloudSyncMeta,
  emptyTrack,
  type NoteChanges,
  readSyncMeta,
  type RecordTrack,
  trackNoteChanges,
  trackVersion,
  withHeldImages,
  withNoteChanges,
  writeSyncMeta,
} from '@/lib/cloud-sync-state';
import { isRecord } from '@/lib/import-guards';
import { MalformedRecordError, UnknownSchemaVersionError } from '@/lib/session-migrate';
import { type RemoteApplyOutcome, withLock } from '@/lib/session-repo';
import { canonicalVideoUrl, isImageDataUrl } from '@/lib/youtube-video';
import {
  NOTES_SCHEMA_VERSION,
  type NoteEntry,
  type NotesIndex,
  type NotesSummary,
  type VideoNotes,
} from '@/types';

/**
 * YouTube notes in `chrome.storage.local`: the ONLY writer of the notes keys, in the same shape as
 * `sessionRepo` (src/lib/session-repo.ts), under a Web Lock of its own so a notes write never
 * waits on a session write or the other way round.
 *
 * - `notes:<videoId>`: one `VideoNotes` body per video.
 * - `notesIndex`: `NotesSummary[]`, newest `updatedAt` first, the list of videos with notes.
 * - `noteImage:<imageId>`: a screenshot (a WebP data URL), referenced by one entry's `imageId`.
 *
 * Write order is image, then body, then index; deletion is body, then index, then images. An
 * interruption leaves an orphan body or image, which `reconcile()` re-indexes or removes, never an
 * index entry or a reference to something that is not there.
 *
 * Cloud sync (src/lib/cloud-sync.ts): every write records itself in the sync bookkeeping
 * (`trackNoteChanges()`), and `applyRemote()` applies what the server sent. Both take the sessions
 * lock inside the notes lock, because the bookkeeping is written under the sessions lock. The order
 * is always notes, then sessions: nothing holding the sessions lock ever waits for the notes lock.
 */

export const NOTES_INDEX_KEY = 'notesIndex';
export const NOTES_LOCK_NAME = 'tabinet:notes';

const NOTES_KEY_PREFIX = 'notes:';
const IMAGE_KEY_PREFIX = 'noteImage:';

export function notesKey(videoId: string): string {
  return `${NOTES_KEY_PREFIX}${videoId}`;
}

export function noteImageKey(imageId: string): string {
  return `${IMAGE_KEY_PREFIX}${imageId}`;
}

// Fallback serialization for runtimes without Web Locks (page-local only).
let fallbackChain: Promise<unknown> = Promise.resolve();

function withNotesLock<T>(fn: () => Promise<T>): Promise<T> {
  const locks = typeof navigator === 'undefined' ? undefined : navigator.locks;
  if (locks === undefined) {
    const run = fallbackChain.then(fn, fn);
    fallbackChain = run.catch(() => undefined);
    return run;
  }
  return new Promise<T>((resolve, reject) => {
    locks
      .request(NOTES_LOCK_NAME, async () => {
        try {
          resolve(await fn());
        } catch (err) {
          reject(err);
        }
      })
      .catch(reject);
  });
}

// ---------------------------------------------------------------------------
// Validation (stored data is read back, never trusted)
// ---------------------------------------------------------------------------

function isNoteEntry(value: unknown): value is NoteEntry {
  return (
    isRecord(value) &&
    typeof value.id === 'string' &&
    typeof value.at === 'number' &&
    Number.isFinite(value.at) &&
    typeof value.text === 'string' &&
    (value.imageId === undefined || typeof value.imageId === 'string') &&
    typeof value.createdAt === 'number' &&
    typeof value.updatedAt === 'number'
  );
}

/** A stored body, checked; a future schema throws `UnknownSchemaVersionError`, anything else broken `MalformedRecordError`. */
function parseVideoNotes(value: unknown): VideoNotes {
  if (!isRecord(value)) {
    throw new MalformedRecordError('Notes body is not an object');
  }
  if (value.schemaVersion !== NOTES_SCHEMA_VERSION) {
    throw new UnknownSchemaVersionError(value.schemaVersion);
  }
  if (
    typeof value.videoId !== 'string' ||
    typeof value.url !== 'string' ||
    typeof value.title !== 'string' ||
    typeof value.createdAt !== 'number' ||
    typeof value.updatedAt !== 'number' ||
    !Array.isArray(value.entries) ||
    !value.entries.every(isNoteEntry)
  ) {
    throw new MalformedRecordError('Notes body is malformed');
  }
  return {
    schemaVersion: NOTES_SCHEMA_VERSION,
    videoId: value.videoId,
    url: value.url,
    title: value.title,
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
    entries: value.entries,
  };
}

function isSummary(value: unknown): value is NotesSummary {
  return (
    isRecord(value) &&
    typeof value.videoId === 'string' &&
    typeof value.url === 'string' &&
    typeof value.title === 'string' &&
    typeof value.entryCount === 'number' &&
    typeof value.createdAt === 'number' &&
    typeof value.updatedAt === 'number'
  );
}

function parseIndex(value: unknown): NotesIndex {
  if (value === undefined || value === null) {
    return { schemaVersion: NOTES_SCHEMA_VERSION, notes: [] };
  }
  if (!isRecord(value)) {
    throw new MalformedRecordError('Notes index is not an object');
  }
  if (value.schemaVersion !== NOTES_SCHEMA_VERSION) {
    throw new UnknownSchemaVersionError(value.schemaVersion);
  }
  if (!Array.isArray(value.notes) || !value.notes.every(isSummary)) {
    throw new MalformedRecordError('Notes index is malformed');
  }
  return { schemaVersion: NOTES_SCHEMA_VERSION, notes: value.notes };
}

// ---------------------------------------------------------------------------
// Storage helpers (call inside the lock)
// ---------------------------------------------------------------------------

export function toNotesSummary(notes: VideoNotes): NotesSummary {
  return {
    videoId: notes.videoId,
    url: notes.url,
    title: notes.title,
    entryCount: notes.entries.length,
    createdAt: notes.createdAt,
    updatedAt: notes.updatedAt,
  };
}

async function readIndex(): Promise<NotesIndex> {
  const raw: Record<string, unknown> = await chrome.storage.local.get(NOTES_INDEX_KEY);
  return parseIndex(raw[NOTES_INDEX_KEY]);
}

async function writeIndex(notes: NotesSummary[]): Promise<void> {
  const index: NotesIndex = {
    schemaVersion: NOTES_SCHEMA_VERSION,
    notes: [...notes].sort((a, b) => b.updatedAt - a.updatedAt),
  };
  await chrome.storage.local.set({ [NOTES_INDEX_KEY]: index });
}

async function readBody(videoId: string): Promise<VideoNotes | undefined> {
  const key = notesKey(videoId);
  const raw: Record<string, unknown> = await chrome.storage.local.get(key);
  const value = raw[key];
  return value === undefined || value === null ? undefined : parseVideoNotes(value);
}

/** Body first, then index. The index is read (and so validated) before anything is written. */
async function writeBodyAndIndex(notes: VideoNotes): Promise<void> {
  const index = await readIndex();
  await chrome.storage.local.set({ [notesKey(notes.videoId)]: notes });
  const others = index.notes.filter((summary) => summary.videoId !== notes.videoId);
  await writeIndex([...others, toNotesSummary(notes)]);
}

/** Body, then index, then the images it referenced. */
async function removeBodyAndIndex(notes: VideoNotes): Promise<void> {
  const index = await readIndex();
  await chrome.storage.local.remove(notesKey(notes.videoId));
  await writeIndex(index.notes.filter((summary) => summary.videoId !== notes.videoId));
  const images = imageIdsOf(notes.entries);
  if (images.length > 0) {
    await chrome.storage.local.remove(images.map(noteImageKey));
  }
}

async function readImage(imageId: string): Promise<string | undefined> {
  const key = noteImageKey(imageId);
  const raw: Record<string, unknown> = await chrome.storage.local.get(key);
  const value = raw[key];
  return typeof value === 'string' && isImageDataUrl(value) ? value : undefined;
}

function imageIdsOf(entries: readonly NoteEntry[]): string[] {
  return entries.flatMap((entry) => (entry.imageId === undefined ? [] : [entry.imageId]));
}

/** Records note-side writes for cloud sync; nothing at all while sync is unconfigured. In the notes lock. */
async function track(changes: NoteChanges): Promise<void> {
  if (isCloudSyncEnabled()) {
    await withLock(() => trackNoteChanges(changes));
  }
}

async function allKeys(): Promise<string[]> {
  const area = chrome.storage.local;
  // `getKeys()` is Chrome 130+; older Chrome reads every value instead.
  if (typeof area.getKeys === 'function') {
    return area.getKeys();
  }
  return Object.keys(await area.get(null));
}

/** Seconds into the video, never negative, never NaN. */
function cleanTime(at: number): number {
  return Number.isFinite(at) && at > 0 ? at : 0;
}

/** A timestamp strictly after `previous`, so every edit moves `updatedAt` forward. */
function after(previous: number, now: number): number {
  return now > previous ? now : previous + 1;
}

// ---------------------------------------------------------------------------
// The repository
// ---------------------------------------------------------------------------

export interface NoteVideo {
  videoId: string;
  /** The title as the page shows it now; an empty one keeps the stored title. */
  title: string;
}

export interface NewNote {
  at: number;
  text: string;
  /** A screenshot to keep with the note, as a base64 image data URL (`isImageDataUrl`). */
  image?: string;
}

/** A deleted note as `removeEntry` hands it back, with its picture, so Undo can put both back. */
export interface RemovedNote {
  entry: NoteEntry;
  /** The screenshot's data URL, when the note had one and it was still stored. */
  image?: string;
}

export interface NoteEdit {
  text?: string;
  at?: number;
}

// ---------------------------------------------------------------------------
// Cloud sync
// ---------------------------------------------------------------------------

/** A change received from the sync server, for `notesRepo.applyRemote()`. */
export type RemoteNotesChange =
  | { type: 'notes'; notes: VideoNotes }
  | { type: 'notesDeleted'; videoId: string; updatedAt: number }
  | { type: 'image'; imageId: string; image: string; updatedAt: number }
  | { type: 'imageDeleted'; imageId: string; updatedAt: number };

/**
 * A received notes body for `videoId`, checked like a stored one, with the canonical url of the id;
 * `null` when it is not one (another video, a newer schema, anything malformed). Pure.
 */
export function parseRemoteNotes(value: unknown, videoId: string): VideoNotes | null {
  try {
    const notes = parseVideoNotes(value);
    return notes.videoId === videoId ? { ...notes, url: canonicalVideoUrl(videoId) } : null;
  } catch {
    return null;
  }
}

/** `track` with the pending entries of `id` dropped and `remoteAt` remembered. Pure. */
function settled(track: RecordTrack, id: string, remoteAt: number): RecordTrack {
  const dirty = { ...track.dirty };
  const deleted = { ...track.deleted };
  delete dirty[id];
  delete deleted[id];
  return {
    dirty,
    deleted,
    known: { ...track.known, [id]: Math.max(track.known[id] ?? 0, remoteAt) },
  };
}

/**
 * The bar a live record must clear when there is no copy here: this device's pending deletion and
 * the newest version of the id it ever knew. Pure.
 */
function floorOf(track: RecordTrack, id: string): number | undefined {
  const floors = [track.deleted[id], track.known[id]].filter((at) => at !== undefined);
  return floors.length > 0 ? Math.max(...floors) : undefined;
}

/** A remote tombstone with no copy here: raises the mark, settles a pending deletion it covers. Pure. */
function afterRemoteTombstone(track: RecordTrack, id: string, remoteAt: number): RecordTrack {
  const next: RecordTrack = {
    dirty: track.dirty,
    deleted: { ...track.deleted },
    known: { ...track.known, [id]: Math.max(track.known[id] ?? 0, remoteAt) },
  };
  const tombstone = track.deleted[id];
  if (tombstone !== undefined && remoteAt >= tombstone) {
    delete next.deleted[id];
  }
  return next;
}

/** Applies a notes record or its tombstone. Inside both locks. */
async function applyRemoteNotes(
  meta: CloudSyncMeta,
  notesTrack: RecordTrack,
  change: Extract<RemoteNotesChange, { type: 'notes' | 'notesDeleted' }>,
  serverWinsTies: boolean,
): Promise<RemoteApplyOutcome> {
  const id = change.type === 'notes' ? change.notes.videoId : change.videoId;
  const remoteAt = change.type === 'notes' ? change.notes.updatedAt : change.updatedAt;
  let local: VideoNotes | undefined;
  try {
    local = await readBody(id);
  } catch {
    // A body this build cannot read is never overwritten or deleted.
    return 'unchanged';
  }
  const tombstone = notesTrack.deleted[id];
  if (local === undefined) {
    if (change.type === 'notesDeleted') {
      await writeSyncMeta({ ...meta, notes: afterRemoteTombstone(notesTrack, id, remoteAt) });
      return tombstone !== undefined && remoteAt < tombstone ? 'kept-local' : 'unchanged';
    }
    const floor = floorOf(notesTrack, id);
    if (floor !== undefined && remoteAt <= floor) {
      return tombstone !== undefined ? 'kept-local' : 'unchanged';
    }
    await writeBodyAndIndex(change.notes);
    await writeSyncMeta({ ...meta, notes: settled(notesTrack, id, remoteAt) });
    return 'applied';
  }
  const localAt = Math.max(local.updatedAt, tombstone ?? 0);
  const remoteWins = remoteAt > localAt || (serverWinsTies && remoteAt === localAt);
  if (!remoteWins) {
    if (localAt > remoteAt && notesTrack.dirty[id] === undefined && tombstone === undefined) {
      // This device's copy is newer and yet not pending (the server lost a write): send it again.
      await writeSyncMeta({
        ...meta,
        notes: { ...notesTrack, dirty: { ...notesTrack.dirty, [id]: local.updatedAt } },
      });
    }
    return localAt > remoteAt ? 'kept-local' : 'unchanged';
  }
  let dropped: string[];
  if (change.type === 'notes') {
    const kept = new Set(imageIdsOf(change.notes.entries));
    dropped = imageIdsOf(local.entries).filter((imageId) => !kept.has(imageId));
    await writeBodyAndIndex(change.notes);
    if (dropped.length > 0) {
      await chrome.storage.local.remove(dropped.map(noteImageKey));
    }
  } else {
    dropped = imageIdsOf(local.entries);
    await removeBodyAndIndex(local);
  }
  // The screenshots of notes the winning copy does not have are gone here; their tombstones go to
  // the server, or a picture this device sent would stay there, counted, with nothing showing it.
  const next = { ...meta, notes: settled(notesTrack, id, remoteAt) };
  await writeSyncMeta(withNoteChanges(next, { imagesDeleted: dropped }, Date.now()));
  return 'applied';
}

/** Applies a screenshot record or its tombstone. Inside both locks. */
async function applyRemoteImage(
  meta: CloudSyncMeta,
  images: RecordTrack,
  change: Extract<RemoteNotesChange, { type: 'image' | 'imageDeleted' }>,
  serverWinsTies: boolean,
): Promise<RemoteApplyOutcome> {
  const id = change.imageId;
  const remoteAt = change.updatedAt;
  const local = await readImage(id);
  const tombstone = images.deleted[id];
  if (change.type === 'image') {
    if (local !== undefined) {
      // A picture never changes: the server has this one, at least as new as anything pending here.
      const dirty = images.dirty[id];
      const next: RecordTrack = settled(images, id, remoteAt);
      if (dirty !== undefined && dirty > remoteAt) {
        next.dirty[id] = dirty;
      }
      await writeSyncMeta({ ...meta, images: next });
      return 'unchanged';
    }
    const floor = floorOf(images, id);
    if (floor !== undefined && remoteAt <= floor) {
      return tombstone !== undefined ? 'kept-local' : 'unchanged';
    }
    await chrome.storage.local.set({ [noteImageKey(id)]: change.image });
    await writeSyncMeta({ ...meta, images: settled(images, id, remoteAt) });
    return 'applied';
  }
  if (local === undefined) {
    await writeSyncMeta({ ...meta, images: afterRemoteTombstone(images, id, remoteAt) });
    return tombstone !== undefined && remoteAt < tombstone ? 'kept-local' : 'unchanged';
  }
  const held = meta.heldImages?.[id];
  const localAt = Math.max(trackVersion(images, id), held ?? 0);
  const remoteWins = remoteAt > localAt || (serverWinsTies && remoteAt === localAt);
  if (!remoteWins) {
    if (localAt > remoteAt && images.dirty[id] === undefined && held === undefined) {
      await writeSyncMeta({
        ...meta,
        images: { ...images, dirty: { ...images.dirty, [id]: localAt } },
      });
    }
    return localAt > remoteAt ? 'kept-local' : 'unchanged';
  }
  await chrome.storage.local.remove(noteImageKey(id));
  const rest = { ...meta.heldImages };
  delete rest[id];
  await writeSyncMeta(withHeldImages({ ...meta, images: settled(images, id, remoteAt) }, rest));
  return 'applied';
}

export const notesRepo = {
  /** Every video with notes, newest first. */
  async listSummaries(): Promise<NotesSummary[]> {
    return (await readIndex()).notes;
  },

  /** One video's notes, or `undefined` when it has none. */
  async get(videoId: string): Promise<VideoNotes | undefined> {
    return readBody(videoId);
  },

  /**
   * Adds one note to a video, creating the video's notes on the first one, and returns the stored
   * entry. The title is refreshed from `video` when it carries one (YouTube titles change).
   * A screenshot is stored first, in the same lock, so `reconcile()` can never find it between
   * its write and the note that references it. Rejects an image that is not an image data URL.
   */
  addEntry(video: NoteVideo, note: NewNote, now: number = Date.now()): Promise<NoteEntry> {
    return withNotesLock(async () => {
      if (note.image !== undefined && !isImageDataUrl(note.image)) {
        throw new MalformedRecordError('A note screenshot must be an image data URL');
      }
      const existing = await readBody(video.videoId);
      const entry: NoteEntry = {
        id: crypto.randomUUID(),
        at: cleanTime(note.at),
        text: note.text,
        createdAt: now,
        updatedAt: now,
      };
      if (note.image !== undefined) {
        const imageId = crypto.randomUUID();
        await chrome.storage.local.set({ [noteImageKey(imageId)]: note.image });
        entry.imageId = imageId;
      }
      const notes: VideoNotes = existing ?? {
        schemaVersion: NOTES_SCHEMA_VERSION,
        videoId: video.videoId,
        url: canonicalVideoUrl(video.videoId),
        title: video.title,
        createdAt: now,
        updatedAt: now,
        entries: [],
      };
      const written: VideoNotes = {
        ...notes,
        title: video.title === '' ? notes.title : video.title,
        updatedAt: after(existing?.updatedAt ?? now - 1, now),
        entries: [...notes.entries, entry],
      };
      await writeBodyAndIndex(written);
      await track({
        notesChanged: [[written.videoId, written.updatedAt]],
        imagesStored: imageIdsOf([entry]),
      });
      return entry;
    });
  },

  /**
   * Puts back a deleted note exactly as it was (the Undo of a deletion), with its screenshot,
   * creating the video's notes again if that was its last one. An entry with the same id is
   * replaced. Without the picture's data (or with data that is not an image) the reference is kept
   * only if an image is still stored under it.
   */
  restoreEntry(video: NoteVideo, removed: RemovedNote, now: number = Date.now()): Promise<void> {
    return withNotesLock(async () => {
      const { entry, image } = removed;
      const existing = await readBody(video.videoId);
      const restored: NoteEntry = { ...entry };
      const stored: string[] = [];
      if (restored.imageId !== undefined) {
        const key = noteImageKey(restored.imageId);
        if (image !== undefined && isImageDataUrl(image)) {
          await chrome.storage.local.set({ [key]: image });
          stored.push(restored.imageId);
        } else if ((await readImage(restored.imageId)) === undefined) {
          delete restored.imageId;
        }
      }
      const notes: VideoNotes = existing ?? {
        schemaVersion: NOTES_SCHEMA_VERSION,
        videoId: video.videoId,
        url: canonicalVideoUrl(video.videoId),
        title: video.title,
        createdAt: entry.createdAt,
        updatedAt: now,
        entries: [],
      };
      const written: VideoNotes = {
        ...notes,
        updatedAt: after(existing?.updatedAt ?? now - 1, now),
        entries: [...notes.entries.filter((other) => other.id !== entry.id), restored],
      };
      await writeBodyAndIndex(written);
      await track({ notesChanged: [[written.videoId, written.updatedAt]], imagesStored: stored });
    });
  },

  /** Changes one note's text or time. Resolves `false` when the note is gone. */
  updateEntry(
    videoId: string,
    entryId: string,
    edit: NoteEdit,
    now: number = Date.now(),
  ): Promise<boolean> {
    return withNotesLock(async () => {
      const notes = await readBody(videoId);
      const target = notes?.entries.find((entry) => entry.id === entryId);
      if (notes === undefined || target === undefined) {
        return false;
      }
      const changed: NoteEntry = {
        ...target,
        text: edit.text ?? target.text,
        at: edit.at === undefined ? target.at : cleanTime(edit.at),
        updatedAt: after(target.updatedAt, now),
      };
      const written: VideoNotes = {
        ...notes,
        updatedAt: after(notes.updatedAt, now),
        entries: notes.entries.map((entry) => (entry.id === entryId ? changed : entry)),
      };
      await writeBodyAndIndex(written);
      await track({ notesChanged: [[written.videoId, written.updatedAt]] });
      return true;
    });
  },

  /**
   * Deletes one note and its image, and returns both (for an Undo), or `undefined` when it was
   * already gone. Deleting a video's last note deletes the video's notes.
   */
  removeEntry(
    videoId: string,
    entryId: string,
    now: number = Date.now(),
  ): Promise<RemovedNote | undefined> {
    return withNotesLock(async () => {
      const notes = await readBody(videoId);
      const target = notes?.entries.find((entry) => entry.id === entryId);
      if (notes === undefined || target === undefined) {
        return undefined;
      }
      const removed: RemovedNote = { entry: target };
      if (target.imageId !== undefined) {
        const image = await readImage(target.imageId);
        if (image !== undefined) {
          removed.image = image;
        }
      }
      const rest = notes.entries.filter((entry) => entry.id !== entryId);
      if (rest.length === 0) {
        await removeBodyAndIndex(notes);
        await track({
          notesDeleted: [[notes.videoId, notes.updatedAt]],
          imagesDeleted: imageIdsOf(notes.entries),
        });
        return removed;
      }
      const written: VideoNotes = {
        ...notes,
        updatedAt: after(notes.updatedAt, now),
        entries: rest,
      };
      await writeBodyAndIndex(written);
      if (target.imageId !== undefined) {
        await chrome.storage.local.remove(noteImageKey(target.imageId));
      }
      await track({
        notesChanged: [[written.videoId, written.updatedAt]],
        imagesDeleted: imageIdsOf([target]),
      });
      return removed;
    });
  },

  /** Deletes every note on a video, with their images. */
  remove(videoId: string): Promise<void> {
    return withNotesLock(async () => {
      const notes = await readBody(videoId);
      if (notes !== undefined) {
        await removeBodyAndIndex(notes);
        await track({
          notesDeleted: [[notes.videoId, notes.updatedAt]],
          imagesDeleted: imageIdsOf(notes.entries),
        });
        return;
      }
      const index = await readIndex();
      if (index.notes.some((summary) => summary.videoId === videoId)) {
        await writeIndex(index.notes.filter((summary) => summary.videoId !== videoId));
      }
    });
  },

  /** A note's screenshot as an image data URL, or `undefined` when it is gone or not an image. */
  getImage(imageId: string): Promise<string | undefined> {
    return readImage(imageId);
  },

  /**
   * Applies a change received from the sync server (`src/lib/cloud-sync.ts`), never recorded as a
   * change of this device. Last writer wins by `updatedAt` as for saved sessions
   * (`sessionRepo.applyRemote()`), decided under the notes lock against the copy as it is now; with
   * no copy here a live record must be newer than this device's pending deletion and every version
   * it has known, so a replay of deleted notes or a deleted screenshot cannot bring them back.
   *
   * A screenshot's version is its stamp in the bookkeeping (a picture never changes). It is stored
   * even when no note here references it yet: its note may come later in the feed. When the notes
   * that win no longer reference a screenshot this device has, the picture is deleted here and its
   * tombstone recorded, so the server does not keep it.
   *
   * Does nothing (`'unchanged'`) before a sync of this version started tracking notes.
   */
  applyRemote(
    change: RemoteNotesChange,
    options: { serverWinsTies?: boolean } = {},
  ): Promise<RemoteApplyOutcome> {
    return withNotesLock(() =>
      withLock(async () => {
        const meta = await readSyncMeta();
        if (meta?.notes === undefined || meta.images === undefined) {
          return 'unchanged';
        }
        const ties = options.serverWinsTies === true;
        if (change.type === 'notes' || change.type === 'notesDeleted') {
          return applyRemoteNotes(meta, meta.notes, change, ties);
        }
        if (change.type === 'image' && !isImageDataUrl(change.image)) {
          throw new MalformedRecordError('A note screenshot must be an image data URL');
        }
        return applyRemoteImage(meta, meta.images, change, ties);
      }),
    );
  },

  /**
   * Starts tracking notes for cloud sync, once: every video's notes and every stored screenshot a
   * note references are marked dirty (a screenshot stamped with its note's `createdAt`), and the
   * change feed is read again from the start, because a version from before notes moved its cursor
   * past records it never asked for. Under both locks, so no note written meanwhile goes untracked.
   * Resolves whether it started now.
   */
  startSyncTracking(): Promise<boolean> {
    return withNotesLock(() =>
      withLock(async () => {
        const meta = await readSyncMeta();
        if (meta === undefined || (meta.notes !== undefined && meta.images !== undefined)) {
          return false;
        }
        const notes = emptyTrack();
        const images = emptyTrack();
        const keys = (await allKeys()).filter((key) => key.startsWith(NOTES_KEY_PREFIX));
        const raw: Record<string, unknown> = await chrome.storage.local.get(keys);
        const stamps = new Map<string, number>();
        for (const key of keys) {
          let body: VideoNotes;
          try {
            body = parseVideoNotes(raw[key]);
          } catch {
            continue;
          }
          notes.dirty[body.videoId] = body.updatedAt;
          for (const entry of body.entries) {
            if (entry.imageId !== undefined) {
              stamps.set(entry.imageId, Math.max(1, entry.createdAt));
            }
          }
        }
        const imageKeys = [...stamps.keys()].map(noteImageKey);
        const pictures: Record<string, unknown> =
          imageKeys.length > 0 ? await chrome.storage.local.get(imageKeys) : {};
        for (const [imageId, stamp] of stamps) {
          const value = pictures[noteImageKey(imageId)];
          if (typeof value === 'string' && isImageDataUrl(value)) {
            images.dirty[imageId] = stamp;
          }
        }
        await writeSyncMeta({ ...meta, cursor: 0, notes, images });
        return true;
      }),
    );
  },

  /**
   * The repair pass: re-indexes bodies the index lacks, drops index entries without a body (or
   * whose summary no longer matches it), and removes images no note references. An unreadable
   * index is rebuilt from the bodies; a body from a newer version is kept as it is and left out of
   * the index, and the images it may reference are kept too.
   */
  reconcile(): Promise<{ reindexed: number; dropped: number; images: number }> {
    return withNotesLock(async () => {
      const keys = await allKeys();
      const bodyKeys = keys.filter((key) => key.startsWith(NOTES_KEY_PREFIX));
      const imageKeys = keys.filter((key) => key.startsWith(IMAGE_KEY_PREFIX));
      const raw: Record<string, unknown> = await chrome.storage.local.get([
        NOTES_INDEX_KEY,
        ...bodyKeys,
      ]);
      let index: NotesIndex;
      let indexBroken = false;
      try {
        index = parseIndex(raw[NOTES_INDEX_KEY]);
      } catch {
        index = { schemaVersion: NOTES_SCHEMA_VERSION, notes: [] };
        indexBroken = true;
      }
      const summaries: NotesSummary[] = [];
      const referenced = new Set<string>();
      let unreadable = false;
      for (const key of bodyKeys) {
        try {
          const notes = parseVideoNotes(raw[key]);
          summaries.push(toNotesSummary(notes));
          for (const imageId of imageIdsOf(notes.entries)) {
            referenced.add(noteImageKey(imageId));
          }
        } catch {
          unreadable = true;
        }
      }
      const known = new Map(index.notes.map((summary) => [summary.videoId, summary]));
      const live = new Set(summaries.map((summary) => summary.videoId));
      let reindexed = 0;
      for (const summary of summaries) {
        const listed = known.get(summary.videoId);
        if (listed === undefined || JSON.stringify(listed) !== JSON.stringify(summary)) {
          reindexed += 1;
        }
      }
      const dropped = index.notes.filter((summary) => !live.has(summary.videoId)).length;
      if (reindexed > 0 || dropped > 0 || indexBroken) {
        await writeIndex(summaries);
      }
      // An unreadable body may reference images we cannot see, so none are removed then.
      const orphans = unreadable ? [] : imageKeys.filter((key) => !referenced.has(key));
      if (orphans.length > 0) {
        await chrome.storage.local.remove(orphans);
      }
      return { reindexed, dropped, images: orphans.length };
    });
  },
};
