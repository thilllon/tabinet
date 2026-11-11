import { describe, expect, it } from 'vitest';

import { notesToMarkdown, readNoteImages, videoTitle } from '@/lib/notes-export';
import { notesRepo } from '@/lib/notes-repo';
import { NOTES_SCHEMA_VERSION, type VideoNotes } from '@/types';

import { getChromeFake } from './chrome-fake';

const ID = 'dQw4w9WgXcQ';
const URL = `https://www.youtube.com/watch?v=${ID}`;
const WEBP = 'data:image/webp;base64,UklGRhIAAABXRUJQ';

function notes(overrides: Partial<VideoNotes> = {}): VideoNotes {
  return {
    schemaVersion: NOTES_SCHEMA_VERSION,
    videoId: ID,
    url: URL,
    title: 'Rust ownership explained',
    createdAt: 1,
    updatedAt: 2,
    entries: [
      {
        id: 'b',
        at: 3725.4,
        text: 'Late point\n\n```rust\nlet x = 1;\n```\n',
        createdAt: 2,
        updatedAt: 2,
      },
      { id: 'a', at: 83.9, text: '  - indented list', createdAt: 1, updatedAt: 1 },
      { id: 'c', at: 200, text: '', imageId: 'img-1', createdAt: 3, updatedAt: 3 },
    ],
    ...overrides,
  };
}

describe('notesToMarkdown', () => {
  it('writes the title, the link, then each note in video order with its time link', () => {
    const markdown = notesToMarkdown(notes(), new Map([['img-1', WEBP]]));

    expect(markdown).toBe(
      [
        '# Rust ownership explained',
        URL,
        `### [1:23](${URL}&t=83s)`,
        '  - indented list',
        `### [3:20](${URL}&t=200s)`,
        `![Screenshot at 3:20](${WEBP})`,
        `### [1:02:05](${URL}&t=3725s)`,
        'Late point\n\n```rust\nlet x = 1;\n```',
      ].join('\n\n') + '\n',
    );
  });

  it('leaves out a screenshot that is missing or is not an image', () => {
    const without = notesToMarkdown(notes(), new Map());
    const broken = notesToMarkdown(notes(), new Map([['img-1', 'javascript:alert(1)) x']]));

    expect(without).not.toContain('![');
    expect(broken).toBe(without);
    // The note keeps its heading even with nothing under it.
    expect(without).toContain(`### [3:20](${URL}&t=200s)`);
  });

  it('keeps the heading on one line and names an untitled video', () => {
    expect(notesToMarkdown(notes({ title: 'Line one\nline two', entries: [] }), new Map())).toBe(
      `# Line one line two\n\n${URL}\n`,
    );
    expect(notesToMarkdown(notes({ title: '  ', entries: [] }), new Map())).toBe(
      `# Untitled video\n\n${URL}\n`,
    );
  });

  it('writes the link from the video id, never from the stored url', () => {
    const markdown = notesToMarkdown(notes({ url: 'javascript:void(0)', entries: [] }), new Map());
    expect(markdown).not.toContain('javascript');
  });

  it('writes its headings in the UI language', () => {
    getChromeFake().setUiLanguage('ja');
    const markdown = notesToMarkdown(notes({ title: '' }), new Map([['img-1', WEBP]]));
    expect(markdown).toContain('# タイトルのない動画');
    expect(markdown).toContain(`![3:20 のスクリーンショット](${WEBP})`);
  });
});

describe('videoTitle', () => {
  it('is the title, or a stand-in when there is none', () => {
    expect(videoTitle({ title: 'A' })).toBe('A');
    expect(videoTitle({ title: '' })).toBe('Untitled video');
  });
});

describe('readNoteImages', () => {
  it('reads the screenshots the notes reference and skips a missing one', async () => {
    const entry = await notesRepo.addEntry(
      { videoId: ID, title: 'T' },
      { at: 5, text: '', image: WEBP },
    );
    const stored = await notesRepo.get(ID);
    if (stored === undefined || entry.imageId === undefined) {
      throw new Error('expected stored notes');
    }
    const withMissing: VideoNotes = {
      ...stored,
      entries: [...stored.entries, { ...entry, id: 'x', imageId: 'gone' }],
    };

    expect(await readNoteImages(withMissing)).toEqual(new Map([[entry.imageId, WEBP]]));
  });
});
