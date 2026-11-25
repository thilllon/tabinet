import { describe, expect, it } from 'vitest';

import { DOC_STORES } from '@/lib/doc-collections';

describe('DOC_STORES', () => {
  it('lists memos, then YouTube notes, with valid types and one screenshot store', () => {
    expect(DOC_STORES.map((store) => store.collection.type)).toEqual(['memo', 'youtubeNote']);
    for (const { collection } of DOC_STORES) {
      expect(collection.type).toMatch(/^[a-z][A-Za-z0-9]{0,31}$/);
      expect(Number.isInteger(collection.version) && collection.version > 0).toBe(true);
      if (collection.conflict === 'keepBoth') {
        expect(collection.keepBoth).toBeDefined();
      }
    }
    expect(DOC_STORES.filter((store) => store.collection.imageOf !== undefined)).toHaveLength(1);
  });

  it('declares the doc shapes of spec 11.3 and 11.4', () => {
    const [memo, note] = DOC_STORES.map((store) => store.collection);
    expect(memo?.conflict).toBe('keepBoth');
    expect(note?.conflict).toBe('lastWriter');
    const live = {
      id: 'n1',
      videoId: 'dQw4w9WgXcQ',
      title: 'T',
      at: 3,
      text: 'x',
      imageId: 'i1',
      createdAt: 1,
    };
    expect(note?.parseLive(live)).toEqual(live);
    expect(note?.parseLive({ ...live, videoId: 'short' })).toBeNull();
    expect(note?.parseLive({ ...live, at: -1 })).toBeNull();
    expect(note?.parseDeleted({ id: 'n1', videoId: 'dQw4w9WgXcQ' })).toEqual({
      id: 'n1',
      videoId: 'dQw4w9WgXcQ',
    });
    expect(note?.fingerprint(live)).toEqual(['dQw4w9WgXcQ', 'T', 3, 'x', 'i1']);
    expect(note?.parentOf?.(live)).toBe('dQw4w9WgXcQ');
    expect(note?.imageOf?.(live)).toBe('i1');
  });
});
