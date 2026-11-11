import { isRecord } from '@/lib/import-guards';
import { MalformedRecordError, UnknownSchemaVersionError } from '@/lib/session-migrate';
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
      await writeBodyAndIndex({
        ...notes,
        title: video.title === '' ? notes.title : video.title,
        updatedAt: after(existing?.updatedAt ?? now - 1, now),
        entries: [...notes.entries, entry],
      });
      return entry;
    });
  },

  /**
   * Puts back a deleted note exactly as it was (the Undo of a deletion), with its screenshot,
   * creating the video's notes again if that was its last one. An entry with the same id is
   * replaced. Without the picture's data (or with data that is not an image) the reference is kept
   * only if the image is still stored.
   */
  restoreEntry(video: NoteVideo, removed: RemovedNote, now: number = Date.now()): Promise<void> {
    return withNotesLock(async () => {
      const { entry, image } = removed;
      const existing = await readBody(video.videoId);
      const restored: NoteEntry = { ...entry };
      if (restored.imageId !== undefined) {
        const key = noteImageKey(restored.imageId);
        if (image !== undefined && isImageDataUrl(image)) {
          await chrome.storage.local.set({ [key]: image });
        } else {
          const raw: Record<string, unknown> = await chrome.storage.local.get(key);
          if (typeof raw[key] !== 'string') {
            delete restored.imageId;
          }
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
      await writeBodyAndIndex({
        ...notes,
        updatedAt: after(existing?.updatedAt ?? now - 1, now),
        entries: [...notes.entries.filter((other) => other.id !== entry.id), restored],
      });
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
      await writeBodyAndIndex({
        ...notes,
        updatedAt: after(notes.updatedAt, now),
        entries: notes.entries.map((entry) => (entry.id === entryId ? changed : entry)),
      });
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
        return removed;
      }
      await writeBodyAndIndex({ ...notes, updatedAt: after(notes.updatedAt, now), entries: rest });
      if (target.imageId !== undefined) {
        await chrome.storage.local.remove(noteImageKey(target.imageId));
      }
      return removed;
    });
  },

  /** Deletes every note on a video, with their images. */
  remove(videoId: string): Promise<void> {
    return withNotesLock(async () => {
      const notes = await readBody(videoId);
      if (notes !== undefined) {
        await removeBodyAndIndex(notes);
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
