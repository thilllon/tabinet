import { describe, expect, it } from 'vitest';

import {
  countTabs,
  formatRate,
  formatRestoreDestination,
  formatRestoreSummary,
  formatWindowLine,
  lazyRestoreSummaryHint,
  needsRestoreConfirm,
  RESTORE_CONFIRM_THRESHOLD,
  restoreErrorLine,
  splitRestoreErrors,
} from '@/lib/restore-messages';
import type { Session } from '@/types';

function sessionWithTabs(...counts: number[]): Session {
  return {
    schemaVersion: 1,
    id: 'id',
    kind: 'saved',
    name: 'n',
    origin: 'manual',
    createdAt: 0,
    updatedAt: 0,
    windows: counts.map((count) => ({
      state: 'normal',
      focused: false,
      groups: [],
      tabs: Array.from({ length: count }, (_, i) => ({
        url: `https://example.com/${i}`,
        title: '',
        pinned: false,
        active: i === 0,
      })),
    })),
  };
}

describe('countTabs / needsRestoreConfirm', () => {
  it('sums tabs across windows', () => {
    expect(countTabs(sessionWithTabs(3, 4))).toBe(7);
  });

  it('requires confirmation only above the threshold', () => {
    expect(RESTORE_CONFIRM_THRESHOLD).toBe(100);
    expect(needsRestoreConfirm(sessionWithTabs(100))).toBe(false);
    expect(needsRestoreConfirm(sessionWithTabs(50, 51))).toBe(true);
  });
});

describe('formatRestoreDestination', () => {
  it('counts the windows a newWindows restore opens', () => {
    expect(formatRestoreDestination(sessionWithTabs(1, 2), { kind: 'newWindows' })).toBe(
      '“n” will open 2 windows.',
    );
    expect(formatRestoreDestination(sessionWithTabs(1), { kind: 'newWindows' })).toBe(
      '“n” will open 1 window.',
    );
  });

  it('says nothing about windows when restoring into an existing one', () => {
    expect(formatRestoreDestination(sessionWithTabs(1, 2), { kind: 'window', windowId: 7 })).toBe(
      '“n” will be added to this window.',
    );
  });
});

describe('splitRestoreErrors', () => {
  it('treats group/activate/window-state urls as structural, everything else as a tab error', () => {
    const result = {
      restored: 1,
      discarded: 0,
      skipped: [],
      errors: [
        { url: 'https://a', message: 'boom' },
        { url: 'group:Work', message: 'drag lock' },
        { url: 'activate:https://b', message: 'tab closed' },
        { url: 'window-state:minimized', message: 'nope' },
      ],
    };
    expect(splitRestoreErrors(result)).toEqual({
      tabErrors: [{ url: 'https://a', message: 'boom' }],
      structuralProblems: [
        { url: 'group:Work', message: 'drag lock' },
        { url: 'activate:https://b', message: 'tab closed' },
        { url: 'window-state:minimized', message: 'nope' },
      ],
    });
  });

  it('returns empty arrays when there are no errors', () => {
    expect(splitRestoreErrors({ restored: 1, discarded: 0, skipped: [], errors: [] })).toEqual({
      tabErrors: [],
      structuralProblems: [],
    });
  });
});

describe('formatRestoreSummary', () => {
  it('reports a clean restore', () => {
    expect(formatRestoreSummary({ restored: 5, discarded: 0, skipped: [], errors: [] }, 5)).toBe(
      'Restored 5 of 5 tabs',
    );
  });

  it('reports skipped and failed tabs', () => {
    const result = {
      restored: 410,
      discarded: 0,
      skipped: ['file:///a', 'javascript:void(0)'],
      errors: [{ url: 'https://x', message: 'boom' }],
    };
    expect(formatRestoreSummary(result, 413)).toBe(
      'Restored 410 of 413 tabs · 2 skipped · 1 could not be opened',
    );
  });

  it('reports structural (group/window) problems separately from tab errors', () => {
    const result = {
      restored: 10,
      discarded: 0,
      skipped: [],
      errors: [
        { url: 'https://a', message: 'boom' },
        { url: 'group:Work', message: 'drag lock' },
        { url: 'activate:https://b', message: 'tab closed' },
        { url: 'window-state:minimized', message: 'nope' },
      ],
    };
    expect(formatRestoreSummary(result, 11)).toBe(
      'Restored 10 of 11 tabs · 1 could not be opened · 3 group/window problems',
    );
  });

  it('calls out lazily restored tabs, before the skipped/failed counts', () => {
    expect(formatRestoreSummary({ restored: 80, discarded: 77, skipped: [], errors: [] }, 80)).toBe(
      'Restored 80 of 80 tabs · 77 tabs will load when clicked',
    );
    expect(
      formatRestoreSummary({ restored: 2, discarded: 1, skipped: ['file:///a'], errors: [] }, 3),
    ).toBe('Restored 2 of 3 tabs · 1 tab will load when clicked · 1 skipped');
  });

  it('keeps the lazy count on a cancelled restore', () => {
    expect(
      formatRestoreSummary({ restored: 25, discarded: 20, skipped: [], errors: [] }, 25, {
        cancelled: true,
      }),
    ).toBe(
      'Restore cancelled: 25 tabs opened · 20 tabs will load when clicked · the tabs already opened were kept',
    );
  });

  it('reports a cancelled restore as a plain count instead of a fraction', () => {
    expect(
      formatRestoreSummary({ restored: 25, discarded: 0, skipped: [], errors: [] }, 25, {
        cancelled: true,
      }),
    ).toBe('Restore cancelled: 25 tabs opened · the tabs already opened were kept');
  });
});

describe('formatRestoreSummary - cancelled with nothing opened', () => {
  it('does not claim tabs were kept when the cancel landed before the first tab', () => {
    expect(
      formatRestoreSummary({ restored: 0, discarded: 0, skipped: [], errors: [] }, 0, {
        cancelled: true,
      }),
    ).toBe('Restore cancelled: 0 tabs opened');
  });
});

describe('restoreErrorLine', () => {
  it('words each failure in the UI language and never shows an untranslated Chrome message', () => {
    expect(restoreErrorLine({ url: 'https://a.test/', message: 'No tab with id: 5.' })).toBe(
      'Failed: https://a.test/ (That tab or window is no longer open.)',
    );
    expect(
      restoreErrorLine({ url: 'https://a.test/', message: 'Cannot access a chrome:// URL' }),
    ).toBe('Failed: https://a.test/');
    expect(restoreErrorLine({ url: 'group:Work', message: 'boom' })).toBe(
      'Group “Work” could not be recreated.',
    );
    expect(restoreErrorLine({ url: 'group:', message: 'boom' })).toBe(
      'Group “Untitled group” could not be recreated.',
    );
    expect(
      restoreErrorLine({
        url: 'activate:https://b.test/',
        message: 'Tabs cannot be edited right now',
      }),
    ).toBe(
      'Could not switch to https://b.test/ (Chrome is busy with the tabs, perhaps because one is being dragged. Try again.)',
    );
    expect(
      restoreErrorLine({ url: 'window-state:maximized', message: 'Invalid value for state' }),
    ).toBe('Could not restore the window size.');
    expect(
      restoreErrorLine({ url: 'https://c.test/', message: 'windows.create returned no window' }),
    ).toBe('Failed: https://c.test/ (Chrome did not open a window to restore into.)');
  });
});

describe('formatWindowLine', () => {
  it('counts windows from one', () => {
    expect(formatWindowLine(0, 3)).toBe('Window 1 of 3');
    expect(formatWindowLine(1, 3)).toBe('Window 2 of 3');
    expect(formatWindowLine(2, 3)).toBe('Window 3 of 3');
  });

  it('says nothing for a single-window restore', () => {
    expect(formatWindowLine(0, 1)).toBeUndefined();
    expect(formatWindowLine(0, 0)).toBeUndefined();
  });

  it('never reports a window past the end', () => {
    expect(formatWindowLine(9, 3)).toBe('Window 3 of 3');
    expect(formatWindowLine(-2, 3)).toBe('Window 1 of 3');
  });

  it('survives nonsense input', () => {
    expect(formatWindowLine(Number.NaN, 3)).toBeUndefined();
    expect(formatWindowLine(0, Number.NaN)).toBeUndefined();
  });
});

describe('formatRate', () => {
  it('reports whole tabs per second once the restore is moving', () => {
    expect(formatRate(90, 2000)).toBe('~45 tabs/s');
    expect(formatRate(25, 1000)).toBe('~25 tabs/s');
  });

  it('keeps a decimal for slow restores', () => {
    expect(formatRate(2, 5000)).toBe('~0.4 tabs/s');
  });

  it('uses the singular for exactly one tab a second', () => {
    expect(formatRate(1, 1000)).toBe('~1 tab/s');
  });

  it('waits for a usable sample', () => {
    expect(formatRate(0, 5000)).toBeUndefined();
    expect(formatRate(4, 100)).toBeUndefined();
    expect(formatRate(4, Number.NaN)).toBeUndefined();
  });
});

describe('lazy restore hints', () => {
  it('explains that discarded tabs load when clicked', () => {
    expect(lazyRestoreSummaryHint(12)).toBe('12 tabs stayed unloaded and will load when clicked.');
    expect(lazyRestoreSummaryHint(1)).toBe('1 tab stayed unloaded and will load when clicked.');
  });

  it('says nothing when nothing was discarded', () => {
    expect(lazyRestoreSummaryHint(0)).toBeUndefined();
  });
});
