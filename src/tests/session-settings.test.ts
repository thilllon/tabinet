import { describe, expect, it } from 'vitest';

import {
  CUSTOM_INTERVAL,
  HISTORY_INTERVAL_MAX_MINUTES,
  HISTORY_INTERVAL_MIN_MINUTES,
  HISTORY_INTERVALS,
  HISTORY_MAX_MAX,
  HISTORY_MAX_MIN,
  intervalLabel,
  intervalSelectValue,
  isRestoreLazy,
  parseHistoryInterval,
  parseIntervalMinutes,
  parseSnapshotLimit,
  RESTORE_LAZY_MODES,
} from '@/lib/session-settings';
import { DEFAULT_SESSION_SETTINGS } from '@/types';

describe('option lists', () => {
  it('include the defaults, so the selects always have a matching option', () => {
    expect(HISTORY_INTERVALS).toContain(DEFAULT_SESSION_SETTINGS.historyIntervalMinutes);
    expect(RESTORE_LAZY_MODES).toContain(DEFAULT_SESSION_SETTINGS.restoreLazy);
  });

  it('bracket the default snapshot limit', () => {
    expect(DEFAULT_SESSION_SETTINGS.historyMaxSnapshots).toBeGreaterThanOrEqual(HISTORY_MAX_MIN);
    expect(DEFAULT_SESSION_SETTINGS.historyMaxSnapshots).toBeLessThanOrEqual(HISTORY_MAX_MAX);
  });
});

describe('parseHistoryInterval', () => {
  it('reads the three supported values back as numbers', () => {
    expect(parseHistoryInterval('5')).toBe(5);
    expect(parseHistoryInterval('10')).toBe(10);
    expect(parseHistoryInterval('30')).toBe(30);
  });

  it('returns undefined for anything else, including the Custom option', () => {
    expect(parseHistoryInterval('7')).toBeUndefined();
    expect(parseHistoryInterval('')).toBeUndefined();
    expect(parseHistoryInterval('5 minutes')).toBeUndefined();
    expect(parseHistoryInterval(CUSTOM_INTERVAL)).toBeUndefined();
  });
});

describe('intervalSelectValue', () => {
  it('shows the matching preset', () => {
    expect(intervalSelectValue(5, false)).toBe('5');
    expect(intervalSelectValue(30, false)).toBe('30');
  });

  it('shows Custom for a value that is not a preset', () => {
    expect(intervalSelectValue(7, false)).toBe(CUSTOM_INTERVAL);
    expect(intervalSelectValue(120, false)).toBe(CUSTOM_INTERVAL);
  });

  it('shows Custom while the user is typing one, even over a preset value', () => {
    expect(intervalSelectValue(5, true)).toBe(CUSTOM_INTERVAL);
  });
});

describe('parseIntervalMinutes', () => {
  it('reads a whole number of minutes', () => {
    expect(parseIntervalMinutes('45')).toBe(45);
    expect(parseIntervalMinutes(' 7 ')).toBe(7);
  });

  it('clamps to the supported range', () => {
    expect(HISTORY_INTERVAL_MIN_MINUTES).toBe(1);
    expect(HISTORY_INTERVAL_MAX_MINUTES).toBe(1440);
    expect(parseIntervalMinutes('0')).toBe(HISTORY_INTERVAL_MIN_MINUTES);
    expect(parseIntervalMinutes('-5')).toBe(HISTORY_INTERVAL_MIN_MINUTES);
    expect(parseIntervalMinutes('99999')).toBe(HISTORY_INTERVAL_MAX_MINUTES);
  });

  it('rounds a fractional entry to whole minutes, as stored values are', () => {
    expect(parseIntervalMinutes('12.9')).toBe(13);
    expect(parseIntervalMinutes('12.4')).toBe(12);
  });

  it('reads exponent notation the way the number input does', () => {
    expect(parseIntervalMinutes('1e3')).toBe(1000);
  });

  it('returns undefined for an empty or non-numeric entry', () => {
    expect(parseIntervalMinutes('')).toBeUndefined();
    expect(parseIntervalMinutes('  ')).toBeUndefined();
    expect(parseIntervalMinutes('soon')).toBeUndefined();
  });
});

describe('isRestoreLazy', () => {
  it('accepts the three modes', () => {
    expect(isRestoreLazy('auto')).toBe(true);
    expect(isRestoreLazy('always')).toBe(true);
    expect(isRestoreLazy('never')).toBe(true);
  });

  it('rejects anything else', () => {
    expect(isRestoreLazy('sometimes')).toBe(false);
    expect(isRestoreLazy('')).toBe(false);
  });
});

describe('parseSnapshotLimit', () => {
  it('reads a plain integer', () => {
    expect(parseSnapshotLimit('20')).toBe(20);
    expect(parseSnapshotLimit(' 7 ')).toBe(7);
  });

  it('clamps to the supported range', () => {
    expect(parseSnapshotLimit('0')).toBe(HISTORY_MAX_MIN);
    expect(parseSnapshotLimit('-4')).toBe(HISTORY_MAX_MIN);
    expect(parseSnapshotLimit('9999')).toBe(HISTORY_MAX_MAX);
  });

  it('truncates a fractional entry to whole snapshots', () => {
    expect(parseSnapshotLimit('20.7')).toBe(20);
  });

  it('returns undefined for an empty or non-numeric entry', () => {
    expect(parseSnapshotLimit('')).toBeUndefined();
    expect(parseSnapshotLimit('   ')).toBeUndefined();
    expect(parseSnapshotLimit('many')).toBeUndefined();
  });
});

describe('labels', () => {
  it('names each interval', () => {
    expect(intervalLabel(5)).toBe('Every 5 minutes');
    expect(intervalLabel(30)).toBe('Every 30 minutes');
    expect(intervalLabel(1)).toBe('Every minute');
  });
});
