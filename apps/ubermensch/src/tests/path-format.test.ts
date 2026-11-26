import { describe, expect, it } from 'vitest';

import { POLICY } from '@/constants';
import {
  ELLIPSIS,
  fullPathText,
  middleCut,
  pathView,
  segmentLabel,
  shortenLabel,
} from '@/lib/path-format';
import type { DocRef, PathSegment } from '@/types';

import { getChromeFake } from './setup';

const DOC: DocRef = { kind: 'document', fileId: 'doc', accountIndex: 1 };

function folder(id: string, name: string): PathSegment {
  return { id, name, kind: 'folder' };
}

describe('middleCut', () => {
  it('leaves a path that fits alone', () => {
    expect(middleCut([8, 8, 4], 64)).toBeUndefined();
    expect(middleCut([100, 100], 10)).toBeUndefined();
  });

  it('keeps the first name and as many trailing names as fit', () => {
    // 10 + 3 + 1 + 3 + 10 = 27 for first, gap and last; each more name costs its length + 3.
    expect(middleCut([10, 10, 10, 10, 10], 39)).toEqual({ head: 1, tail: 1 });
    expect(middleCut([10, 10, 10, 10, 10], 40)).toEqual({ head: 1, tail: 2 });
    expect(middleCut([10, 10, 10, 10, 10, 10], 54)).toEqual({ head: 1, tail: 3 });
  });

  it('always keeps the last name, even when it alone is too long', () => {
    expect(middleCut([5, 5, 200], 20)).toEqual({ head: 1, tail: 1 });
  });
});

describe('labels', () => {
  it('names My Drive and an unnamed shared drive in the UI language', () => {
    expect(segmentLabel({ id: 'r', name: 'My Drive', kind: 'my-drive' })).toBe('My Drive');
    expect(segmentLabel({ id: 'd', name: '', kind: 'shared-drive' })).toBe('Shared drive');
    expect(segmentLabel(folder('f', ' '))).toBe('Untitled folder');
    getChromeFake().state.language = 'ko';
    expect(segmentLabel({ id: 'r', name: 'My Drive', kind: 'my-drive' })).toBe('내 드라이브');
  });

  it('cuts one long name at the end by characters, not code units', () => {
    expect(shortenLabel('short', 10)).toBe('short');
    expect(shortenLabel('abcdefghijkl', 5)).toBe(`abcd${ELLIPSIS}`);
    expect(shortenLabel('😀😀😀😀😀😀', 4)).toBe(`😀😀😀${ELLIPSIS}`);
  });

  it('writes the full path for the tooltip', () => {
    expect(fullPathText(['My Drive', 'A'], false)).toBe('My Drive › A');
    expect(fullPathText(['A'], true)).toBe(`${ELLIPSIS} › A`);
  });
});

describe('pathView', () => {
  it('links every folder in the page account', () => {
    const view = pathView(
      {
        state: 'ready',
        path: {
          kind: 'path',
          partial: false,
          segments: [
            { id: 'root', name: 'My Drive', kind: 'my-drive' },
            folder('f1', 'Projects'),
            folder('f2', '2026'),
          ],
        },
      },
      DOC,
    );
    expect(view).toEqual({
      kind: 'path',
      title: 'Drive folder: My Drive › Projects › 2026',
      items: [
        {
          label: 'My Drive',
          href: 'https://drive.google.com/drive/u/1/my-drive',
          title: 'Open My Drive in Google Drive',
        },
        {
          label: 'Projects',
          href: 'https://drive.google.com/drive/u/1/folders/f1',
          title: 'Open Projects in Google Drive',
        },
        {
          label: '2026',
          href: 'https://drive.google.com/drive/u/1/folders/f2',
          title: 'Open 2026 in Google Drive',
        },
      ],
    });
  });

  it('cuts a long path in the middle and keeps the whole path in the tooltip', () => {
    const segments = Array.from({ length: 8 }, (_, i) => folder(`f${i}`, `Folder number ${i}`));
    const view = pathView(
      { state: 'ready', path: { kind: 'path', partial: false, segments } },
      DOC,
    );
    if (view.kind !== 'path') {
      throw new Error(view.kind);
    }
    const labels = view.items.map((item) => item.label);
    expect(labels[0]).toBe('Folder number 0');
    expect(labels).toContain(ELLIPSIS);
    expect(labels.at(-1)).toBe('Folder number 7');
    expect(labels.join(' › ').length).toBeLessThanOrEqual(POLICY.path.maxChars);
    expect(view.title).toContain('Folder number 3');
    expect(view.items.find((item) => item.label === ELLIPSIS)?.href).toBeUndefined();
  });

  it('marks a partial path with a leading ellipsis', () => {
    const view = pathView(
      { state: 'ready', path: { kind: 'path', partial: true, segments: [folder('f1', 'Shared')] } },
      { kind: 'document', fileId: 'x' },
    );
    expect(view.kind === 'path' && view.items.map((item) => item.label)).toEqual([
      ELLIPSIS,
      'Shared',
    ]);
    expect(view.kind === 'path' && view.items[1]?.href).toBe(
      'https://drive.google.com/drive/folders/f1',
    );
    expect(view.title).toContain('not visible');
  });

  it('shows the owner when the location is hidden', () => {
    expect(pathView({ state: 'ready', path: { kind: 'hidden', owner: 'Kim' } }, DOC)).toMatchObject(
      {
        kind: 'text',
        text: 'Location not visible · owner: Kim',
      },
    );
    expect(pathView({ state: 'ready', path: { kind: 'hidden' } }, DOC)).toMatchObject({
      kind: 'text',
      text: 'Location not visible',
    });
  });

  it('offers sign-in, says when it is not configured, and offers a retry on failure', () => {
    expect(pathView({ state: 'needs-sign-in' }, DOC)).toMatchObject({
      kind: 'button',
      action: 'sign-in',
      text: 'Show folder',
    });
    expect(pathView({ state: 'not-configured' }, DOC)).toMatchObject({
      kind: 'text',
      text: 'Folder path: sign-in not configured',
    });
    expect(pathView({ state: 'error', reason: 'network' }, DOC)).toMatchObject({
      kind: 'button',
      action: 'retry',
      title: 'The folder could not be read: Google Drive could not be reached. Click to try again.',
    });
    expect(pathView({ state: 'error', reason: 'wrong-account' }, DOC)).toMatchObject({
      kind: 'button',
      action: 'sign-in',
    });
    expect(pathView({ state: 'error', reason: 'cancelled' }, DOC)).toMatchObject({
      kind: 'button',
      action: 'sign-in',
    });
  });
});
