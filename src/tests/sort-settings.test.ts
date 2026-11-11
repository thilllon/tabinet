import { describe, expect, it } from 'vitest';

import {
  DEFAULT_SORT_SETTINGS,
  duplicateTabOptions,
  groupFromOptions,
  groupingModeOptions,
  isDuplicateTabHandling,
  isGroupFrom,
  isGroupingMode,
  isSortBy,
  parseSortSettings,
  sortByOptions,
  SORT_SETTING_KEYS,
  showsCustomSortOptions,
} from '@/lib/sort-settings';
import type { SortSettings } from '@/types';

/** Every setting on a non-default value, so a fallback shows up as a changed field. */
const ALL_CHANGED: SortSettings = {
  sortBy: 'custom',
  groupFrom: 'rightToLeft',
  preserveOrderWithinGroups: true,
  groupSuspendedTabs: true,
  sortPinnedTabs: true,
  duplicateTabHandling: 'group',
  groupingMode: 'domain',
};

describe('DEFAULT_SORT_SETTINGS', () => {
  it('pins the default values', () => {
    expect(DEFAULT_SORT_SETTINGS).toEqual({
      sortBy: 'url',
      groupFrom: 'leftToRight',
      preserveOrderWithinGroups: false,
      groupSuspendedTabs: false,
      sortPinnedTabs: false,
      duplicateTabHandling: 'closeAllButOne',
      groupingMode: 'subdomain',
    });
  });

  it('is covered key for key by SORT_SETTING_KEYS', () => {
    expect([...SORT_SETTING_KEYS].sort()).toEqual(Object.keys(DEFAULT_SORT_SETTINGS).sort());
  });
});

describe('type guards', () => {
  it('accept exactly the values the SortSettings unions allow', () => {
    expect(['url', 'title', 'custom'].every(isSortBy)).toBe(true);
    expect(['leftToRight', 'rightToLeft'].every(isGroupFrom)).toBe(true);
    expect(['none', 'closeAllButOne', 'group'].every(isDuplicateTabHandling)).toBe(true);
    expect(['subdomain', 'domain'].every(isGroupingMode)).toBe(true);
  });

  it('reject near-misses, other unions members and non-strings', () => {
    expect(isSortBy('URL')).toBe(false);
    expect(isSortBy('domain')).toBe(false);
    expect(isGroupFrom('lefttoright')).toBe(false);
    expect(isGroupFrom(0)).toBe(false);
    expect(isDuplicateTabHandling('closeAll')).toBe(false);
    expect(isDuplicateTabHandling(null)).toBe(false);
    expect(isGroupingMode('hostname')).toBe(false);
    expect(isGroupingMode(undefined)).toBe(false);
  });
});

describe('parseSortSettings', () => {
  it('returns the defaults for empty storage', () => {
    expect(parseSortSettings({})).toEqual(DEFAULT_SORT_SETTINGS);
  });

  it('returns the defaults for a non-object', () => {
    expect(parseSortSettings(undefined)).toEqual(DEFAULT_SORT_SETTINGS);
    expect(parseSortSettings(null)).toEqual(DEFAULT_SORT_SETTINGS);
    expect(parseSortSettings('nonsense')).toEqual(DEFAULT_SORT_SETTINGS);
  });

  it('reads back every key it is given', () => {
    expect(parseSortSettings(ALL_CHANGED)).toEqual(ALL_CHANGED);
  });

  it('keeps the stored keys it understands and defaults the rest', () => {
    expect(parseSortSettings({ sortBy: 'title', sortPinnedTabs: true })).toEqual({
      ...DEFAULT_SORT_SETTINGS,
      sortBy: 'title',
      sortPinnedTabs: true,
    });
  });

  it('falls back per key for values of the wrong type or an unknown member', () => {
    const parsed = parseSortSettings({
      sortBy: 'sideways',
      groupFrom: 42,
      preserveOrderWithinGroups: 'true',
      groupSuspendedTabs: null,
      sortPinnedTabs: 1,
      duplicateTabHandling: 'closeAll',
      groupingMode: 'hostname',
    });
    expect(parsed).toEqual(DEFAULT_SORT_SETTINGS);
  });

  it('ignores a suspender extension id left in storage by an older version', () => {
    // Suspended tabs are recognised by the shape of their page now; the old key is not read.
    expect(parseSortSettings({ ...ALL_CHANGED, tabSuspenderExtensionId: 'abc' })).toEqual(
      ALL_CHANGED,
    );
    expect(SORT_SETTING_KEYS).not.toContain('tabSuspenderExtensionId');
  });
});

describe('showsCustomSortOptions', () => {
  it('shows the Custom-only settings only for custom sorting', () => {
    expect(showsCustomSortOptions('custom')).toBe(true);
    expect(showsCustomSortOptions('url')).toBe(false);
    expect(showsCustomSortOptions('title')).toBe(false);
  });

  it('keeps a hidden setting stored as it is', () => {
    expect(parseSortSettings({ ...ALL_CHANGED, sortBy: 'url' })).toMatchObject({
      groupingMode: 'domain',
      groupFrom: 'rightToLeft',
      preserveOrderWithinGroups: true,
    });
  });
});

describe('dropdown options', () => {
  const cases = [
    { name: 'sortByOptions', options: sortByOptions(), guard: isSortBy, count: 3 },
    {
      name: 'duplicateTabOptions',
      options: duplicateTabOptions(),
      guard: isDuplicateTabHandling,
      count: 3,
    },
    {
      name: 'groupingModeOptions',
      options: groupingModeOptions(),
      guard: isGroupingMode,
      count: 2,
    },
    { name: 'groupFromOptions', options: groupFromOptions(), guard: isGroupFrom, count: 2 },
  ];

  for (const { name, options, guard, count } of cases) {
    it(`${name} offers every stored value once, each accepted by its guard`, () => {
      const values = options.map((option) => option.value);
      expect(new Set(values).size).toBe(count);
      expect(values.every((value) => guard(value))).toBe(true);
      expect(options.every((option) => option.label.trim() !== '')).toBe(true);
    });
  }
});
