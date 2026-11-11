import { describe, expect, it, vi } from 'vitest';

import {
  buildExportScope,
  canExportAll,
  collectProgressNotice,
  collectSessionBodies,
  copiedLinksNotice,
  copiedMarkdownNotice,
  exportAllNotice,
  exportFormatItems,
  exportScopeName,
  PROGRESS_NOTICE_THRESHOLD,
  PROGRESS_TICK_SIZE,
  shouldReportProgress,
  shouldTickProgress,
} from '@/lib/export-actions';
import { toJson } from '@/lib/session-export';
import { importSessions } from '@/lib/session-import';
import { sessionKey, sessionRepo } from '@/lib/session-repo';
import type { Session, SessionSummary } from '@/types';

function makeSession(overrides: Partial<Session> = {}): Session {
  return {
    schemaVersion: 1,
    id: 'a',
    kind: 'saved',
    name: 'Work',
    origin: 'manual',
    createdAt: 1_000,
    updatedAt: 2_000,
    windows: [
      {
        state: 'normal',
        focused: true,
        groups: [
          { title: 'Dev', color: 'blue', collapsed: false },
          { title: '', color: 'grey', collapsed: false },
        ],
        tabs: [
          { url: 'https://a.test/', title: 'A', pinned: false, active: true },
          { url: 'https://b.test/', title: 'B', pinned: false, active: false, groupIndex: 0 },
        ],
      },
      { state: 'normal', focused: false, groups: [], tabs: [] },
    ],
    ...overrides,
  };
}

function summary(id: string): SessionSummary {
  return {
    id,
    kind: 'saved',
    name: `Session ${id}`,
    origin: 'manual',
    createdAt: 1,
    updatedAt: 2,
    windowCount: 1,
    tabCount: 1,
    bytes: 10,
  };
}

describe('exportFormatItems', () => {
  it('lists every format once, in menu order', () => {
    expect(exportFormatItems().map((item) => item.format)).toEqual([
      'json',
      'markdown',
      'text',
      'html',
      'csv',
    ]);
  });
});

describe('buildExportScope', () => {
  const session = makeSession();

  it('is the whole session when no window is given', () => {
    expect(buildExportScope(session)).toEqual({ session });
    // A groupIndex without a windowIndex cannot be resolved and is ignored.
    expect(buildExportScope(session, undefined, 1)).toEqual({ session });
  });

  it('narrows to a window, then to a group', () => {
    expect(buildExportScope(session, 1)).toEqual({ session, windowIndex: 1 });
    expect(buildExportScope(session, 0, 1)).toEqual({ session, windowIndex: 0, groupIndex: 1 });
  });
});

describe('exportScopeName', () => {
  const session = makeSession();

  it('names the session, the window and the group', () => {
    expect(exportScopeName(session)).toBe('Work');
    expect(exportScopeName(session, 1)).toBe('Work (Window 2)');
    expect(exportScopeName(session, 0, 0)).toBe('Work (Dev)');
  });

  it('calls an untitled group by its placeholder', () => {
    expect(exportScopeName(session, 0, 1)).toBe('Work (Untitled group)');
  });

  it('falls back when an index is out of range', () => {
    expect(exportScopeName(session, 9)).toBe('Work');
    expect(exportScopeName(session, 0, 9)).toBe('Work (Window 1)');
  });
});

describe('notices', () => {
  it('pluralizes the copy confirmations', () => {
    expect(copiedLinksNotice(12)).toBe('Copied 12 links.');
    expect(copiedLinksNotice(1)).toBe('Copied 1 link.');
    expect(copiedMarkdownNotice(12)).toBe('Copied 12 links as Markdown.');
  });

  it('reports skipped bodies in the export-all confirmation', () => {
    expect(exportAllNotice(12, 0)).toBe('Exported 12 sessions as JSON.');
    expect(exportAllNotice(1, 2)).toBe('Exported 1 session as JSON. 2 sessions could not be read.');
  });

  it('announces progress only for large sets', () => {
    expect(shouldReportProgress(PROGRESS_NOTICE_THRESHOLD)).toBe(false);
    expect(shouldReportProgress(PROGRESS_NOTICE_THRESHOLD + 1)).toBe(true);
    expect(collectProgressNotice({ loaded: 12, total: 40 })).toBe('Collecting sessions… 12 of 40.');
  });

  it('ticks the progress notice in batches, and always on the last body', () => {
    expect(shouldTickProgress({ loaded: PROGRESS_TICK_SIZE, total: 40 })).toBe(true);
    expect(shouldTickProgress({ loaded: PROGRESS_TICK_SIZE + 1, total: 40 })).toBe(false);
    expect(shouldTickProgress({ loaded: 37, total: 37 })).toBe(true);
  });
});

describe('collectSessionBodies', () => {
  it('reads every body through sessionRepo, in the order given', async () => {
    const a = makeSession({ id: 'a', name: 'A' });
    const b = makeSession({ id: 'b', name: 'B' });
    await sessionRepo.put(a);
    await sessionRepo.put(b);

    const progress: number[] = [];
    const result = await collectSessionBodies([summary('a'), summary('b')], (step) => {
      progress.push(step.loaded);
    });

    expect(result.sessions.map((session) => session.name)).toEqual(['A', 'B']);
    expect(result.skipped).toEqual([]);
    expect(progress).toEqual([1, 2]);
  });

  it('skips a summary whose body is gone', async () => {
    await sessionRepo.put(makeSession({ id: 'a' }));
    const result = await collectSessionBodies([summary('a'), summary('missing')]);
    expect(result.sessions.map((session) => session.id)).toEqual(['a']);
    expect(result.skipped).toEqual(['missing']);
  });

  it('skips a body that cannot be migrated, keeping the rest', async () => {
    await sessionRepo.put(makeSession({ id: 'a' }));
    // A record from a newer schema version: sessionRepo.get() throws for it.
    await chrome.storage.local.set({
      [sessionKey('future')]: { ...makeSession({ id: 'future' }), schemaVersion: 99 },
    });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    const result = await collectSessionBodies([summary('future'), summary('a')]);

    expect(result.sessions.map((session) => session.id)).toEqual(['a']);
    expect(result.skipped).toEqual(['future']);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it('produces a bundle the importer reads back', async () => {
    await sessionRepo.put(makeSession({ id: 'a', name: 'Work' }));
    const { sessions } = await collectSessionBodies([summary('a')]);

    const parsed = importSessions(toJson(sessions, 1_700_000_000_000), 5_000);

    expect(parsed.format).toBe('json');
    expect(parsed.format === null ? [] : parsed.sessions.map((session) => session.name)).toEqual([
      'Work (imported)',
    ]);
  });

  it('reports no progress for an empty index', async () => {
    const onProgress = vi.fn();
    await expect(collectSessionBodies([], onProgress)).resolves.toEqual({
      sessions: [],
      skipped: [],
    });
    expect(onProgress).not.toHaveBeenCalled();
  });
});

describe('canExportAll', () => {
  it('is false for an empty store, so Settings disables the button', () => {
    expect(canExportAll([])).toBe(false);
  });

  it('is false when every row was saved by a newer version', () => {
    const newer: SessionSummary = {
      ...summary('a'),
      unreadable: { reason: 'unknown-schema', version: 99 },
    };
    expect(canExportAll([newer])).toBe(false);
  });

  it('is true with one readable session or snapshot', () => {
    expect(canExportAll([summary('a')])).toBe(true);
  });
});
