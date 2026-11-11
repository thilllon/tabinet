import { describe, expect, it, vi } from 'vitest';

import {
  buildImportPreview,
  checkImportSize,
  fileReadError,
  formatImportTotals,
  MAX_IMPORT_BYTES,
  PREVIEW_SESSION_LIMIT,
  PREVIEW_TITLE_LIMIT,
  PREVIEW_WINDOW_LIMIT,
  utf8ByteLength,
} from '@/lib/import-preview';
import type { Session, WindowSnapshot } from '@/types';

function makeWindow(titles: string[]): WindowSnapshot {
  return {
    state: 'normal',
    focused: false,
    groups: [],
    tabs: titles.map((title, index) => ({
      url: `https://example.test/${index}`,
      title,
      pinned: false,
      active: index === 0,
    })),
  };
}

function makeSession(name: string, windows: WindowSnapshot[]): Session {
  return {
    schemaVersion: 1,
    id: name,
    kind: 'saved',
    name,
    origin: 'import',
    createdAt: 1,
    updatedAt: 1,
    windows,
  };
}

describe('checkImportSize', () => {
  it('accepts anything up to the limit', () => {
    expect(checkImportSize(0)).toEqual({ ok: true });
    expect(checkImportSize(MAX_IMPORT_BYTES)).toEqual({ ok: true });
  });

  it('refuses a larger input, naming both sizes', () => {
    expect(checkImportSize(MAX_IMPORT_BYTES + 1)).toEqual({
      ok: false,
      error: 'That is too large to import (20.0 MB). The limit is 20.0 MB.',
    });
    expect(checkImportSize(3 * 1024 * 1024, 1024 * 1024)).toEqual({
      ok: false,
      error: 'That is too large to import (3.0 MB). The limit is 1.0 MB.',
    });
  });

  it('measures pasted text in UTF-8 bytes', () => {
    expect(utf8ByteLength('abc')).toBe(3);
    expect(utf8ByteLength('é🙂')).toBe(6);
  });
});

describe('labels', () => {
  it('explains an unreadable file', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    expect(fileReadError(new Error('NotReadableError'))).toBe('Could not read this file.');
    expect(fileReadError(undefined)).toBe('Could not read this file.');
    expect(fileReadError(new DOMException('denied', 'NotAllowedError'))).toBe(
      'Could not read this file: The browser did not allow this.',
    );
  });
});

describe('buildImportPreview', () => {
  it('lists sessions, windows, tab counts and the first few titles', () => {
    const preview = buildImportPreview([
      makeSession('Work (imported)', [makeWindow(['A', 'B']), makeWindow(['C'])]),
    ]);

    expect(preview.sessionCount).toBe(1);
    expect(preview.windowCount).toBe(2);
    expect(preview.tabCount).toBe(3);
    expect(preview.moreSessions).toBe(0);
    expect(preview.sessions[0]).toEqual({
      name: 'Work (imported)',
      windowCount: 2,
      tabCount: 3,
      moreWindows: 0,
      windows: [
        { number: 1, tabCount: 2, titles: ['A', 'B'], moreTabs: 0 },
        { number: 2, tabCount: 1, titles: ['C'], moreTabs: 0 },
      ],
    });
  });

  it('falls back to the url for a title-less tab', () => {
    const preview = buildImportPreview([makeSession('Links', [makeWindow(['', '  '])])]);
    expect(preview.sessions[0]?.windows[0]?.titles).toEqual([
      'https://example.test/0',
      'https://example.test/1',
    ]);
  });

  it('counts what it does not draw', () => {
    const tabs = Array.from({ length: PREVIEW_TITLE_LIMIT + 4 }, (_, i) => `Tab ${i}`);
    const windows = Array.from({ length: PREVIEW_WINDOW_LIMIT + 2 }, () => makeWindow(tabs));
    const sessions = Array.from({ length: PREVIEW_SESSION_LIMIT + 3 }, (_, i) =>
      makeSession(`S${i}`, windows),
    );

    const preview = buildImportPreview(sessions);

    expect(preview.sessions).toHaveLength(PREVIEW_SESSION_LIMIT);
    expect(preview.moreSessions).toBe(3);
    expect(preview.sessions[0]?.windows).toHaveLength(PREVIEW_WINDOW_LIMIT);
    expect(preview.sessions[0]?.moreWindows).toBe(2);
    expect(preview.sessions[0]?.windows[0]?.titles).toHaveLength(PREVIEW_TITLE_LIMIT);
    expect(preview.sessions[0]?.windows[0]?.moreTabs).toBe(4);
    // Totals describe the whole parse, not the drawn part.
    expect(preview.sessionCount).toBe(PREVIEW_SESSION_LIMIT + 3);
    expect(preview.windowCount).toBe((PREVIEW_SESSION_LIMIT + 3) * (PREVIEW_WINDOW_LIMIT + 2));
    expect(preview.tabCount).toBe(preview.windowCount * tabs.length);
  });

  it('handles an empty parse and a window with no tabs', () => {
    expect(buildImportPreview([])).toEqual({
      sessions: [],
      moreSessions: 0,
      sessionCount: 0,
      windowCount: 0,
      tabCount: 0,
    });
    const preview = buildImportPreview([makeSession('Empty', [makeWindow([])])]);
    expect(preview.sessions[0]?.windows[0]).toEqual({
      number: 1,
      tabCount: 0,
      titles: [],
      moreTabs: 0,
    });
  });
});

describe('formatImportTotals', () => {
  it('reads like a session card meta line', () => {
    const preview = buildImportPreview([
      makeSession('A', [makeWindow(['a'])]),
      makeSession('B', [makeWindow(['b']), makeWindow(['c', 'd'])]),
    ]);
    expect(formatImportTotals(preview)).toBe('2 sessions · 3 windows · 4 tabs');
  });
});
