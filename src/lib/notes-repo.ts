import {
  type DocCollection,
  type DocStore,
  type DocTx,
  type LocalDoc,
  trackLocalDocChange,
} from '@/lib/cloud-docs';
import { allLocalKeys, runDocTransaction } from '@/lib/doc-store-tx';
import { isRecord } from '@/lib/import-guards';
import { MalformedRecordError, UnknownSchemaVersionError } from '@/lib/session-migrate';
import { canonicalVideoUrl, isImageDataUrl } from '@/lib/youtube-video';
import {
  type CloudSyncMeta,
  NOTES_SCHEMA_VERSION,
  type NoteEntry,
  type NotesIndex,
  type NotesSummary,
  type VideoNotes,
} from '@/types';

/**
 * YouTube notes in `chrome.storage.local`: the ONLY writer of the notes keys, in the same shape as
 * `sessionRepo` (src/lib/session-repo.ts), under a Web Lock of its own so a notes write never
 * waits on a session write; while sync is configured it then takes the sessions lock, where the
 * sync bookkeeping lives (never the other way round).
 *
 * - `notes:<videoId>`: one `VideoNotes` body per video (storage schema 1, unchanged by v10).
 * - `notesIndex`: `NotesSummary[]`, newest `updatedAt` first, the list of videos with notes.
 * - `noteImage:<imageId>`: a screenshot (a WebP data URL), referenced by one entry's `imageId`.
 *
 * Every change is one `set` (spec 10.6, invariant 12): the bodies (or `null`), the index, the
 * screenshots and the sync bookkeeping together; a crash before the cleanup `remove` of the
 * `null` keys changes nothing a reader sees. Synced one doc per entry (spec 11.3,
 * `youtubeNoteStore`, `lastWriter`): a change writes only that entry's doc, deleting a video's
 * notes is one tombstone per entry, and a screenshot syncs as an `image` record.
 */

export const NOTES_INDEX_KEY = 'notesIndex';
export const NOTES_LOCK_NAME = 'tabinet:notes';

const NOTES_KEY_PREFIX = 'notes:';
const IMAGE_KEY_PREFIX = 'noteImage:';
const ID = /^[A-Za-z0-9_-]{1,64}$/;
const VIDEO_ID = /^[A-Za-z0-9_-]{11}$/;

export function notesKey(videoId: string): string {
  return `${NOTES_KEY_PREFIX}${videoId}`;
}

export function noteImageKey(imageId: string): string {
  return `${IMAGE_KEY_PREFIX}${imageId}`;
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

function sortedSummaries(notes: readonly NotesSummary[]): NotesSummary[] {
  return [...notes].sort((a, b) => b.updatedAt - a.updatedAt);
}

async function readIndex(): Promise<NotesIndex> {
  const raw: Record<string, unknown> = await chrome.storage.local.get(NOTES_INDEX_KEY);
  return parseIndex(raw[NOTES_INDEX_KEY]);
}

async function readBody(videoId: string): Promise<VideoNotes | undefined> {
  const key = notesKey(videoId);
  const raw: Record<string, unknown> = await chrome.storage.local.get(key);
  const value = raw[key];
  return value === undefined || value === null ? undefined : parseVideoNotes(value);
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

/** Seconds into the video, never negative, never NaN. */
function cleanTime(at: number): number {
  return Number.isFinite(at) && at > 0 ? at : 0;
}

// ---------------------------------------------------------------------------
// The synced collection (11.3)
// ---------------------------------------------------------------------------

/** One note as it is synced; the record's `updatedAt` is the entry's. */
export interface NoteLive {
  id: string;
  videoId: string;
  /** The video's title when the note was written. */
  title: string;
  at: number;
  text: string;
  imageId?: string;
  createdAt: number;
}

export interface NoteDeleted {
  id: string;
  videoId: string;
}

function exactKeys(value: Record<string, unknown>, keys: string[], optional: string[]): boolean {
  const own = Object.keys(value);
  return (
    keys.every((key) => own.includes(key)) &&
    own.every((key) => keys.includes(key) || optional.includes(key))
  );
}

export const youtubeNoteCollection: DocCollection<NoteLive, NoteDeleted> = {
  type: 'youtubeNote',
  version: 1,
  conflict: 'lastWriter',
  parseLive(data) {
    if (
      !isRecord(data) ||
      !exactKeys(data, ['id', 'videoId', 'title', 'at', 'text', 'createdAt'], ['imageId']) ||
      typeof data.id !== 'string' ||
      !ID.test(data.id) ||
      typeof data.videoId !== 'string' ||
      !VIDEO_ID.test(data.videoId) ||
      typeof data.title !== 'string' ||
      typeof data.at !== 'number' ||
      !Number.isFinite(data.at) ||
      data.at < 0 ||
      typeof data.text !== 'string' ||
      typeof data.createdAt !== 'number' ||
      !Number.isFinite(data.createdAt) ||
      (data.imageId !== undefined && (typeof data.imageId !== 'string' || !ID.test(data.imageId)))
    ) {
      return null;
    }
    const live: NoteLive = {
      id: data.id,
      videoId: data.videoId,
      title: data.title,
      at: data.at,
      text: data.text,
      createdAt: data.createdAt,
    };
    if (data.imageId !== undefined) {
      live.imageId = data.imageId;
    }
    return live;
  },
  parseDeleted(data) {
    return isRecord(data) &&
      exactKeys(data, ['id', 'videoId'], []) &&
      typeof data.id === 'string' &&
      ID.test(data.id) &&
      typeof data.videoId === 'string' &&
      VIDEO_ID.test(data.videoId)
      ? { id: data.id, videoId: data.videoId }
      : null;
  },
  deletedOf: (id, parent) => ({ id, videoId: parent ?? '' }),
  parentOf: (data) => data.videoId,
  imageOf: (data) => ('imageId' in data ? data.imageId : undefined),
  fingerprint: (data) => [data.videoId, data.title, data.at, data.text, data.imageId ?? null],
};

/** An entry of `notes` as it is synced. */
function liveOf(notes: VideoNotes, entry: NoteEntry): NoteLive {
  const live: NoteLive = {
    id: entry.id,
    videoId: notes.videoId,
    title: notes.title,
    at: entry.at,
    text: entry.text,
    createdAt: entry.createdAt,
  };
  if (entry.imageId !== undefined) {
    live.imageId = entry.imageId;
  }
  return live;
}

// ---------------------------------------------------------------------------
// The transaction
// ---------------------------------------------------------------------------

type Body = VideoNotes | null | 'unreadable';

interface NotesTx extends DocTx<NoteLive, NoteDeleted> {
  /** A video's notes (staged changes included), `null` when it has none; throws when unreadable. */
  video(videoId: string): Promise<VideoNotes | null>;
  readImage(id: string): Promise<string | null | 'unreadable'>;
  putImage(id: string, dataUrl: string): void;
  removeImage(id: string): void;
  imageReferenced(id: string): Promise<boolean>;
}

function parseBody(value: unknown): Body {
  if (value === undefined || value === null) {
    return null;
  }
  try {
    return parseVideoNotes(value);
  } catch {
    return 'unreadable';
  }
}

function transact<T>(run: (tx: NotesTx) => Promise<T>): Promise<T> {
  return runDocTransaction(NOTES_LOCK_NAME, async (meta: CloudSyncMeta) => {
    const staged = new Map<string, unknown>();
    const bodies = new Map<string, Body>();
    let everything: Map<string, Body> | undefined;

    const dirty = new Set<string>();
    /** A body already read in this transaction; reads always come before a staged write. */
    const current = (videoId: string): Body => {
      if (bodies.has(videoId)) {
        return bodies.get(videoId) ?? null;
      }
      if (everything !== undefined) {
        return everything.get(videoId) ?? null;
      }
      throw new Error('A notes body was written before it was read');
    };
    const body = async (videoId: string): Promise<Body> => {
      if (bodies.has(videoId) || everything !== undefined) {
        return current(videoId);
      }
      const key = notesKey(videoId);
      const loaded = parseBody((await chrome.storage.local.get(key))[key]);
      bodies.set(videoId, loaded);
      return loaded;
    };
    /** Every video's body, the staged ones included. */
    const allBodies = async (): Promise<Map<string, Body>> => {
      if (everything === undefined) {
        const keys = (await allLocalKeys()).filter((key) => key.startsWith(NOTES_KEY_PREFIX));
        const raw: Record<string, unknown> =
          keys.length === 0 ? {} : await chrome.storage.local.get(keys);
        everything = new Map(
          keys.map((key) => [key.slice(NOTES_KEY_PREFIX.length), parseBody(raw[key])]),
        );
      }
      const merged = new Map(everything);
      for (const [videoId, value] of bodies) {
        merged.set(videoId, value);
      }
      return merged;
    };
    const setBody = (videoId: string, value: VideoNotes | null): void => {
      bodies.set(videoId, value);
      dirty.add(videoId);
    };
    const video = async (videoId: string): Promise<VideoNotes | null> => {
      const found = await body(videoId);
      if (found === 'unreadable') {
        // Read again to throw the precise reason (a newer version, or a malformed body).
        const key = notesKey(videoId);
        parseVideoNotes((await chrome.storage.local.get(key))[key]);
        throw new MalformedRecordError('Notes body is malformed');
      }
      return found;
    };
    const read = async (entryId: string): Promise<LocalDoc<NoteLive>> => {
      let unreadable = false;
      for (const found of (await allBodies()).values()) {
        if (found === 'unreadable') {
          unreadable = true;
          continue;
        }
        const entry = found?.entries.find((candidate) => candidate.id === entryId);
        if (found !== null && entry !== undefined) {
          return { state: 'live', data: liveOf(found, entry), at: entry.updatedAt };
        }
      }
      // An entry not found may be in a body this build cannot read: never written over then.
      return unreadable ? { state: 'unreadable' } : { state: 'none' };
    };
    const imageValue = async (id: string): Promise<string | null | 'unreadable'> => {
      const key = noteImageKey(id);
      const value = staged.has(key) ? staged.get(key) : (await chrome.storage.local.get(key))[key];
      if (value === undefined || value === null) {
        return null;
      }
      return typeof value === 'string' && isImageDataUrl(value) ? value : 'unreadable';
    };

    const tx: NotesTx = {
      meta,
      video,
      read,
      async listLive() {
        const out: { data: NoteLive; at: number; imageAt?: number }[] = [];
        for (const found of (await allBodies()).values()) {
          if (found === null || found === 'unreadable') {
            continue;
          }
          for (const entry of found.entries) {
            const data = youtubeNoteCollection.parseLive(liveOf(found, entry));
            if (data !== null) {
              out.push({ data, at: entry.updatedAt, imageAt: entry.createdAt });
            }
          }
        }
        return out;
      },
      put(data, at) {
        const known = current(data.videoId);
        if (known === 'unreadable') {
          return;
        }
        const entry: NoteEntry = {
          id: data.id,
          at: cleanTime(data.at),
          text: data.text,
          createdAt: data.createdAt,
          updatedAt: at,
        };
        if (data.imageId !== undefined) {
          entry.imageId = data.imageId;
        }
        const base: VideoNotes = known ?? {
          schemaVersion: NOTES_SCHEMA_VERSION,
          videoId: data.videoId,
          url: canonicalVideoUrl(data.videoId),
          title: data.title,
          createdAt: data.createdAt,
          updatedAt: at,
          entries: [],
        };
        const others = base.entries.filter((other) => other.id !== data.id);
        const newest = others.every((other) => other.updatedAt <= at);
        setBody(data.videoId, {
          ...base,
          url: canonicalVideoUrl(data.videoId),
          title: data.title !== '' && newest ? data.title : base.title,
          createdAt: Math.min(base.createdAt, data.createdAt),
          updatedAt: known === null ? at : Math.max(base.updatedAt + 1, at),
          entries: [...base.entries.filter((other) => other.id !== data.id), entry].sort(
            (a, b) => a.createdAt - b.createdAt,
          ),
        });
      },
      remove(deleted, at) {
        const known = current(deleted.videoId);
        if (known === null || known === 'unreadable') {
          return;
        }
        const rest = known.entries.filter((entry) => entry.id !== deleted.id);
        if (rest.length === known.entries.length) {
          return;
        }
        setBody(
          deleted.videoId,
          rest.length === 0
            ? null
            : { ...known, updatedAt: Math.max(known.updatedAt + 1, at), entries: rest },
        );
      },
      readImage: imageValue,
      putImage(id, dataUrl) {
        staged.set(noteImageKey(id), dataUrl);
      },
      removeImage(id) {
        staged.set(noteImageKey(id), null);
      },
      async imageReferenced(id) {
        for (const found of (await allBodies()).values()) {
          if (
            found !== null &&
            found !== 'unreadable' &&
            found.entries.some((entry) => entry.imageId === id)
          ) {
            return true;
          }
        }
        return false;
      },
      stage(key, value) {
        staged.set(key, value);
      },
    };

    const result = await run(tx);
    const entries: Record<string, unknown> = Object.fromEntries(staged);
    const changed: [string, VideoNotes | null][] = [...dirty].map((videoId) => [
      videoId,
      (bodies.get(videoId) ?? null) as VideoNotes | null,
    ]);
    if (changed.length > 0) {
      for (const [videoId, value] of changed) {
        entries[notesKey(videoId)] = value;
      }
      if (!staged.has(NOTES_INDEX_KEY)) {
        const index = await readIndex();
        const touched = new Set(changed.map(([videoId]) => videoId));
        const summaries = index.notes.filter((summary) => !touched.has(summary.videoId));
        for (const [, value] of changed) {
          if (value !== null) {
            summaries.push(toNotesSummary(value));
          }
        }
        entries[NOTES_INDEX_KEY] = {
          schemaVersion: NOTES_SCHEMA_VERSION,
          notes: sortedSummaries(summaries),
        } satisfies NotesIndex;
      }
    }
    return { result, entries };
  });
}

/** Removes one entry, tracked, with its screenshot (its tombstone recorded by the tracking). */
function removeIn(tx: NotesTx, notes: VideoNotes, entry: NoteEntry, now: number): void {
  const at = trackLocalDocChange(tx, youtubeNoteCollection, {
    localId: entry.id,
    before: liveOf(notes, entry),
    after: { deleted: { id: entry.id, videoId: notes.videoId } },
    previousAt: entry.updatedAt,
    now,
  });
  tx.remove({ id: entry.id, videoId: notes.videoId }, at);
  if (entry.imageId !== undefined) {
    tx.removeImage(entry.imageId);
  }
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

/** The entry as it is stored after `put(data, at)`. */
function entryOf(data: NoteLive, at: number): NoteEntry {
  const entry: NoteEntry = {
    id: data.id,
    at: data.at,
    text: data.text,
    createdAt: data.createdAt,
    updatedAt: at,
  };
  if (data.imageId !== undefined) {
    entry.imageId = data.imageId;
  }
  return entry;
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
   * entry. The title is refreshed from `video` when it carries one (YouTube titles change); only
   * this entry's doc is marked to sync. A screenshot is stored in the same write as the note that
   * references it. Rejects an image that is not an image data URL.
   */
  addEntry(video: NoteVideo, note: NewNote, now: number = Date.now()): Promise<NoteEntry> {
    return transact(async (tx) => {
      if (note.image !== undefined && !isImageDataUrl(note.image)) {
        throw new MalformedRecordError('A note screenshot must be an image data URL');
      }
      const existing = await tx.video(video.videoId);
      const data: NoteLive = {
        id: crypto.randomUUID(),
        videoId: video.videoId,
        title: video.title === '' ? (existing?.title ?? '') : video.title,
        at: cleanTime(note.at),
        text: note.text,
        createdAt: now,
      };
      if (note.image !== undefined) {
        data.imageId = crypto.randomUUID();
        tx.putImage(data.imageId, note.image);
      }
      const at = trackLocalDocChange(tx, youtubeNoteCollection, {
        localId: data.id,
        before: null,
        after: { live: data },
        previousAt: 0,
        now,
      });
      tx.put(data, at);
      return entryOf(data, at);
    });
  },

  /**
   * Puts back a deleted note (the Undo of a deletion), with its screenshot, creating the video's
   * notes again if that was its last one, under a new stamp above its deletion. An entry with the
   * same id is replaced. Without the picture's data (or with data that is not an image) the
   * reference is kept only if an image is still stored under it.
   */
  restoreEntry(video: NoteVideo, removed: RemovedNote, now: number = Date.now()): Promise<void> {
    return transact(async (tx) => {
      const { entry, image } = removed;
      const existing = await tx.video(video.videoId);
      const data: NoteLive = {
        id: entry.id,
        videoId: video.videoId,
        title: existing?.title ?? video.title,
        at: cleanTime(entry.at),
        text: entry.text,
        createdAt: entry.createdAt,
      };
      if (entry.imageId !== undefined) {
        if (image !== undefined && isImageDataUrl(image)) {
          tx.putImage(entry.imageId, image);
          data.imageId = entry.imageId;
        } else {
          const stored = await tx.readImage(entry.imageId);
          if (stored !== null && stored !== 'unreadable') {
            data.imageId = entry.imageId;
          }
        }
      }
      const present = existing?.entries.find((other) => other.id === entry.id);
      const at = trackLocalDocChange(tx, youtubeNoteCollection, {
        localId: entry.id,
        before: present === undefined || existing === null ? null : liveOf(existing, present),
        after: { live: data },
        previousAt: Math.max(entry.updatedAt, present?.updatedAt ?? 0),
        now,
      });
      tx.put(data, at);
    });
  },

  /** Changes one note's text or time. Resolves `false` when the note is gone. */
  updateEntry(
    videoId: string,
    entryId: string,
    edit: NoteEdit,
    now: number = Date.now(),
  ): Promise<boolean> {
    return transact(async (tx) => {
      const notes = await tx.video(videoId);
      const target = notes?.entries.find((entry) => entry.id === entryId);
      if (notes === null || target === undefined) {
        return false;
      }
      const before = liveOf(notes, target);
      const data: NoteLive = {
        ...before,
        text: edit.text ?? target.text,
        at: edit.at === undefined ? target.at : cleanTime(edit.at),
      };
      const at = trackLocalDocChange(tx, youtubeNoteCollection, {
        localId: entryId,
        before,
        after: { live: data },
        previousAt: target.updatedAt,
        now,
      });
      tx.put(data, at);
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
    return transact(async (tx) => {
      const notes = await tx.video(videoId);
      const target = notes?.entries.find((entry) => entry.id === entryId);
      if (notes === null || target === undefined) {
        return undefined;
      }
      const removed: RemovedNote = { entry: target };
      if (target.imageId !== undefined) {
        const image = await tx.readImage(target.imageId);
        if (typeof image === 'string' && image !== 'unreadable') {
          removed.image = image;
        }
      }
      removeIn(tx, notes, target, now);
      return removed;
    });
  },

  /** Deletes every note on a video, with their images: one tombstone per entry when synced. */
  remove(videoId: string, now: number = Date.now()): Promise<void> {
    return transact(async (tx) => {
      const notes = await tx.video(videoId);
      if (notes !== null) {
        for (const entry of notes.entries) {
          const latest = await tx.video(videoId);
          if (latest !== null) {
            removeIn(tx, latest, entry, now);
          }
        }
        return;
      }
      const index = await readIndex();
      if (index.notes.some((summary) => summary.videoId === videoId)) {
        tx.stage(NOTES_INDEX_KEY, {
          schemaVersion: NOTES_SCHEMA_VERSION,
          notes: index.notes.filter((summary) => summary.videoId !== videoId),
        } satisfies NotesIndex);
      }
    });
  },

  /** A note's screenshot as an image data URL, or `undefined` when it is gone or not an image. */
  getImage(imageId: string): Promise<string | undefined> {
    return readImage(imageId);
  },

  /**
   * The repair pass: removes `null` bodies left by an interrupted cleanup, re-indexes bodies the
   * index lacks, drops index entries without a body (or whose summary no longer matches it), and
   * removes images no note references (except one cloud sync received and holds live, whose note
   * may still be on its way). An unreadable index is rebuilt from the bodies; a body from a newer
   * version is kept as it is and left out of the index, and the images it may reference are kept.
   */
  reconcile(): Promise<{ reindexed: number; dropped: number; images: number }> {
    return transact(async (tx) => {
      const keys = await allLocalKeys();
      const bodyKeys = keys.filter((key) => key.startsWith(NOTES_KEY_PREFIX));
      const imageKeys = keys.filter((key) => key.startsWith(IMAGE_KEY_PREFIX));
      const raw: Record<string, unknown> = await chrome.storage.local.get([
        NOTES_INDEX_KEY,
        ...bodyKeys,
        ...imageKeys,
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
        if (raw[key] === null) {
          tx.stage(key, null);
          continue;
        }
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
        tx.stage(NOTES_INDEX_KEY, {
          schemaVersion: NOTES_SCHEMA_VERSION,
          notes: sortedSummaries(summaries),
        } satisfies NotesIndex);
      }
      // An unreadable body may reference images we cannot see, so none are removed then. Nor is a
      // screenshot cloud sync received and still holds live: its note may be later in the feed.
      const images = tx.meta.images;
      const awaited = new Set(
        Object.keys(images.known)
          .filter((imageId) => images.deleted[imageId] === undefined)
          .map(noteImageKey),
      );
      const orphans = unreadable
        ? []
        : imageKeys.filter((key) => !referenced.has(key) && !awaited.has(key));
      for (const key of orphans) {
        tx.stage(key, null);
      }
      return {
        reindexed,
        dropped,
        images: orphans.filter((key) => raw[key] !== null).length,
      };
    });
  },
};

/** The YouTube notes collection's store, for the sync engine (`DOC_STORES`); it holds screenshots. */
export const youtubeNoteStore: DocStore<NoteLive, NoteDeleted> = {
  collection: youtubeNoteCollection,
  transact: (run) => transact(run),
};
