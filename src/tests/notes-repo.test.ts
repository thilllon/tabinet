import { describe, expect, it } from 'vitest';

import {
  NOTES_INDEX_KEY,
  noteImageKey,
  notesKey,
  notesRepo,
  toNotesSummary,
} from '@/lib/notes-repo';
import { UnknownSchemaVersionError } from '@/lib/session-migrate';
import { NOTES_SCHEMA_VERSION, type NoteEntry, type NotesIndex, type VideoNotes } from '@/types';

import { getChromeFake } from './chrome-fake';

const A = 'aaaaaaaaaaa';
const B = 'bbbbbbbbbbb';
const PNG = 'data:image/webp;base64,AAAA';

function imageIdOf(entry: NoteEntry): string {
  if (entry.imageId === undefined) {
    throw new Error('the note has no image');
  }
  return entry.imageId;
}

function stored<T>(key: string): T | undefined {
  // CAST: the test reads back what the repository itself wrote.
  return getChromeFake().state.local.get(key) as T | undefined;
}

function index(): NotesIndex | undefined {
  return stored<NotesIndex>(NOTES_INDEX_KEY);
}

describe('notesRepo', () => {
  it('creates a video on its first note, with the canonical url', async () => {
    const entry = await notesRepo.addEntry(
      { videoId: A, title: 'Talk' },
      { at: 83.5, text: 'hi' },
      1000,
    );

    const body = stored<VideoNotes>(notesKey(A));
    expect(body).toEqual({
      schemaVersion: NOTES_SCHEMA_VERSION,
      videoId: A,
      url: `https://www.youtube.com/watch?v=${A}`,
      title: 'Talk',
      createdAt: 1000,
      updatedAt: 1000,
      entries: [{ id: entry.id, at: 83.5, text: 'hi', createdAt: 1000, updatedAt: 1000 }],
    });
    expect(index()?.notes).toEqual([
      {
        videoId: A,
        url: `https://www.youtube.com/watch?v=${A}`,
        title: 'Talk',
        entryCount: 1,
        createdAt: 1000,
        updatedAt: 1000,
      },
    ]);
  });

  it('adds to the same video, refreshes its title, and keeps the index newest first', async () => {
    await notesRepo.addEntry({ videoId: A, title: 'Old' }, { at: 1, text: 'a1' }, 1000);
    await notesRepo.addEntry({ videoId: B, title: 'B' }, { at: 1, text: 'b1' }, 2000);
    await notesRepo.addEntry({ videoId: A, title: 'New' }, { at: 2, text: 'a2' }, 3000);
    await notesRepo.addEntry({ videoId: A, title: '' }, { at: 3, text: 'a3' }, 4000);

    const notes = await notesRepo.get(A);
    expect(notes?.title).toBe('New');
    expect(notes?.entries.map((e) => e.text)).toEqual(['a1', 'a2', 'a3']);
    expect((await notesRepo.listSummaries()).map((s) => [s.videoId, s.entryCount])).toEqual([
      [A, 3],
      [B, 1],
    ]);
  });

  it('stores a time that is not a time as 0', async () => {
    const entry = await notesRepo.addEntry(
      { videoId: A, title: '' },
      { at: Number.NaN, text: 'x' },
    );
    expect(entry.at).toBe(0);
    expect((await notesRepo.addEntry({ videoId: A, title: '' }, { at: -5, text: 'y' })).at).toBe(0);
  });

  it('writes the body before the index', async () => {
    const order: string[] = [];
    const set = chrome.storage.local.set.bind(chrome.storage.local);
    chrome.storage.local.set = async (items: Record<string, unknown>) => {
      order.push(...Object.keys(items));
      return set(items);
    };

    await notesRepo.addEntry({ videoId: A, title: 'T' }, { at: 1, text: 'x' });

    expect(order).toEqual([notesKey(A), NOTES_INDEX_KEY]);
  });

  it('edits a note and moves updatedAt forward, even with a clock that went back', async () => {
    const entry = await notesRepo.addEntry({ videoId: A, title: 'T' }, { at: 1, text: 'x' }, 5000);

    expect(await notesRepo.updateEntry(A, entry.id, { text: 'y', at: 9 }, 4000)).toBe(true);

    const notes = await notesRepo.get(A);
    expect(notes?.entries[0]).toMatchObject({ text: 'y', at: 9, createdAt: 5000, updatedAt: 5001 });
    expect(notes?.updatedAt).toBe(5001);
    expect(index()?.notes[0]?.updatedAt).toBe(5001);
  });

  it('reports an edit of a note or video that is gone', async () => {
    expect(await notesRepo.updateEntry(A, 'nope', { text: 'y' })).toBe(false);
    await notesRepo.addEntry({ videoId: A, title: 'T' }, { at: 1, text: 'x' });
    expect(await notesRepo.updateEntry(A, 'nope', { text: 'y' })).toBe(false);
  });

  it('deletes one note with its image, and the video with its last note', async () => {
    const first = await notesRepo.addEntry(
      { videoId: A, title: 'T' },
      { at: 1, text: '', image: PNG },
    );
    const second = await notesRepo.addEntry({ videoId: A, title: 'T' }, { at: 2, text: 'y' });
    const imageId = imageIdOf(first);

    expect(await notesRepo.removeEntry(A, first.id)).toEqual({ entry: first, image: PNG });
    expect(stored(noteImageKey(imageId))).toBeUndefined();
    expect((await notesRepo.get(A))?.entries).toEqual([second]);
    expect(index()?.notes[0]?.entryCount).toBe(1);

    expect(await notesRepo.removeEntry(A, second.id)).toEqual({ entry: second });
    expect(stored(notesKey(A))).toBeUndefined();
    expect(index()?.notes).toEqual([]);
    expect(await notesRepo.removeEntry(A, second.id)).toBeUndefined();
  });

  it('puts a deleted note back as it was, also when it was the last one', async () => {
    const entry = await notesRepo.addEntry({ videoId: A, title: 'T' }, { at: 7, text: 'x' }, 1000);
    const removed = await notesRepo.removeEntry(A, entry.id);
    if (removed === undefined) {
      throw new Error('nothing removed');
    }

    await notesRepo.restoreEntry({ videoId: A, title: 'T' }, removed, 2000);

    const notes = await notesRepo.get(A);
    expect(notes?.entries).toEqual([entry]);
    expect(notes?.title).toBe('T');
    expect(index()?.notes).toHaveLength(1);
  });

  it('refuses a screenshot that is not an image and stores nothing', async () => {
    await expect(
      notesRepo.addEntry({ videoId: A, title: 'T' }, { at: 1, text: '', image: 'javascript:1' }),
    ).rejects.toThrow();
    expect(stored(notesKey(A))).toBeUndefined();
    expect([...getChromeFake().state.local.keys()]).toEqual([]);
  });

  describe('screenshots', () => {
    it('stores the image before the note that references it, under one id', async () => {
      const writes: string[][] = [];
      const local = chrome.storage.local;
      const set = local.set.bind(local);
      local.set = async (items: Record<string, unknown>) => {
        writes.push(Object.keys(items));
        return set(items);
      };

      const entry = await notesRepo.addEntry(
        { videoId: A, title: 'T' },
        { at: 12, text: '', image: PNG },
      );

      const imageId = imageIdOf(entry);
      expect(writes).toEqual([[noteImageKey(imageId)], [notesKey(A)], [NOTES_INDEX_KEY]]);
      expect(await notesRepo.getImage(imageId)).toBe(PNG);
      expect(entry).toMatchObject({ at: 12, text: '' });
    });

    it('reads back only image data URLs', async () => {
      getChromeFake().state.local.set(noteImageKey('bad'), 'javascript:alert(1)');
      getChromeFake().state.local.set(noteImageKey('num'), 42);

      expect(await notesRepo.getImage('bad')).toBeUndefined();
      expect(await notesRepo.getImage('num')).toBeUndefined();
      expect(await notesRepo.getImage('missing')).toBeUndefined();
    });

    it('brings the picture back with an undone deletion, also of the last note', async () => {
      const entry = await notesRepo.addEntry(
        { videoId: A, title: 'T' },
        { at: 1, text: 'x', image: PNG },
      );
      const removed = await notesRepo.removeEntry(A, entry.id);
      if (removed === undefined) {
        throw new Error('nothing removed');
      }
      expect(stored(noteImageKey(imageIdOf(entry)))).toBeUndefined();

      await notesRepo.restoreEntry({ videoId: A, title: 'T' }, removed);

      expect((await notesRepo.get(A))?.entries).toEqual([entry]);
      expect(await notesRepo.getImage(imageIdOf(entry))).toBe(PNG);
      expect((await notesRepo.reconcile()).images).toBe(0);
    });

    it('drops the reference of a restored note whose picture is lost', async () => {
      const entry = await notesRepo.addEntry(
        { videoId: A, title: 'T' },
        { at: 1, text: 'x', image: PNG },
      );
      const removed = await notesRepo.removeEntry(A, entry.id);
      if (removed === undefined) {
        throw new Error('nothing removed');
      }

      await notesRepo.restoreEntry({ videoId: A, title: 'T' }, { entry: removed.entry });

      expect((await notesRepo.get(A))?.entries[0]?.imageId).toBeUndefined();
    });

    it('keeps the image when only the text of its note changes', async () => {
      const entry = await notesRepo.addEntry(
        { videoId: A, title: 'T' },
        { at: 1, text: '', image: PNG },
      );

      await notesRepo.updateEntry(A, entry.id, { text: 'caption' });

      expect((await notesRepo.get(A))?.entries[0]?.imageId).toBe(entry.imageId);
      expect(await notesRepo.getImage(imageIdOf(entry))).toBe(PNG);
    });

    it("deletes a whole video with its images, and leaves other videos' images", async () => {
      const a = await notesRepo.addEntry(
        { videoId: A, title: 'T' },
        { at: 1, text: '', image: PNG },
      );
      const b = await notesRepo.addEntry(
        { videoId: B, title: 'B' },
        { at: 1, text: '', image: PNG },
      );

      await notesRepo.remove(A);

      expect(stored(notesKey(A))).toBeUndefined();
      expect(stored(noteImageKey(imageIdOf(a)))).toBeUndefined();
      expect(stored(noteImageKey(imageIdOf(b)))).toBe(PNG);
      expect(index()?.notes.map((s) => s.videoId)).toEqual([B]);
    });

    it('keeps the images of live notes through a repair pass', async () => {
      const entry = await notesRepo.addEntry(
        { videoId: A, title: 'T' },
        { at: 1, text: '', image: PNG },
      );

      expect((await notesRepo.reconcile()).images).toBe(0);
      expect(await notesRepo.getImage(imageIdOf(entry))).toBe(PNG);
    });
  });

  it('refuses to write over notes saved by a newer version', async () => {
    getChromeFake().state.local.set(notesKey(A), { schemaVersion: 2, videoId: A });

    await expect(
      notesRepo.addEntry({ videoId: A, title: 'T' }, { at: 1, text: 'x' }),
    ).rejects.toBeInstanceOf(UnknownSchemaVersionError);
    expect(stored<{ schemaVersion: number }>(notesKey(A))?.schemaVersion).toBe(2);
  });

  it('refuses a damaged body rather than replacing it', async () => {
    getChromeFake().state.local.set(notesKey(A), { schemaVersion: 1, videoId: A, entries: 'no' });

    await expect(notesRepo.get(A)).rejects.toThrow(/malformed/);
  });

  it('never touches session data or chrome.storage.sync', async () => {
    await notesRepo.addEntry({ videoId: A, title: 'T' }, { at: 1, text: 'x' });
    const keys = [...getChromeFake().state.local.keys()];
    expect(keys.every((key) => key.startsWith('notes'))).toBe(true);
    expect(getChromeFake().state.sync.size).toBe(0);
  });

  it('serializes concurrent writes: none is lost', async () => {
    await Promise.all(
      Array.from({ length: 10 }, (_, n) =>
        notesRepo.addEntry({ videoId: A, title: 'T' }, { at: n, text: String(n) }),
      ),
    );
    expect((await notesRepo.get(A))?.entries).toHaveLength(10);
    expect(index()?.notes[0]?.entryCount).toBe(10);
  });
});

describe('notesRepo.reconcile', () => {
  function body(videoId: string, updatedAt: number, imageId?: string): VideoNotes {
    return {
      schemaVersion: NOTES_SCHEMA_VERSION,
      videoId,
      url: `https://www.youtube.com/watch?v=${videoId}`,
      title: videoId,
      createdAt: 1,
      updatedAt,
      entries: [
        {
          id: `${videoId}-1`,
          at: 1,
          text: 'x',
          createdAt: 1,
          updatedAt: 1,
          ...(imageId ? { imageId } : {}),
        },
      ],
    };
  }

  it('re-indexes an orphan body and drops an entry without one', async () => {
    const local = getChromeFake().state.local;
    local.set(notesKey(A), body(A, 10));
    local.set(NOTES_INDEX_KEY, {
      schemaVersion: NOTES_SCHEMA_VERSION,
      notes: [toNotesSummary(body(B, 20))],
    });

    expect(await notesRepo.reconcile()).toEqual({ reindexed: 1, dropped: 1, images: 0 });
    expect(index()?.notes).toEqual([toNotesSummary(body(A, 10))]);
  });

  it('rebuilds an unreadable index from the bodies', async () => {
    const local = getChromeFake().state.local;
    local.set(notesKey(A), body(A, 10));
    local.set(notesKey(B), body(B, 20));
    local.set(NOTES_INDEX_KEY, 'garbage');

    await notesRepo.reconcile();

    expect(index()?.notes.map((s) => s.videoId)).toEqual([B, A]);
  });

  it('removes images no note references, and keeps the rest', async () => {
    const local = getChromeFake().state.local;
    local.set(noteImageKey('kept'), 'data:kept');
    local.set(noteImageKey('orphan'), 'data:orphan');
    local.set(notesKey(A), body(A, 10, 'kept'));

    expect((await notesRepo.reconcile()).images).toBe(1);
    expect(local.has(noteImageKey('kept'))).toBe(true);
    expect(local.has(noteImageKey('orphan'))).toBe(false);
  });

  it('keeps every image while a body it cannot read might reference one', async () => {
    const local = getChromeFake().state.local;
    local.set(noteImageKey('maybe'), 'data:maybe');
    local.set(notesKey(A), { schemaVersion: 2, videoId: A });

    await notesRepo.reconcile();

    expect(local.has(noteImageKey('maybe'))).toBe(true);
    expect(local.has(notesKey(A))).toBe(true);
  });

  it('writes nothing when everything is in order', async () => {
    await notesRepo.addEntry({ videoId: A, title: 'T' }, { at: 1, text: 'x' });
    const before = JSON.stringify(index());

    expect(await notesRepo.reconcile()).toEqual({ reindexed: 0, dropped: 0, images: 0 });
    expect(JSON.stringify(index())).toBe(before);
  });

  it('writes no index into an empty store', async () => {
    await notesRepo.reconcile();
    expect(index()).toBeUndefined();
  });
});
