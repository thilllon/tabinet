import { type MessageKey, t } from '@/lib/i18n';
import type { DuplicateTabHandling, GroupFrom, GroupingMode, SortBy, SortSettings } from '@/types';

/**
 * Pure rules behind the Settings dialog's sort settings (`chrome.storage.sync`). The component
 * stays thin: everything that decides what a stored or typed-in value means - and therefore what a
 * change writes - is decided here and unit-tested (AGENTS.md "Testing": vitest runs without a DOM,
 * so the React components themselves are not tested).
 */

/**
 * The sort defaults, in one place for both readers: the sort engine (`src/lib/sort-tabs.ts`)
 * passes this object to `chrome.storage.sync.get()`, so it is what a key that was never written
 * falls back to, and the Settings view shows the same values. `sort-settings.test.ts` pins them.
 */
export const DEFAULT_SORT_SETTINGS: SortSettings = {
  sortBy: 'url',
  groupFrom: 'leftToRight',
  preserveOrderWithinGroups: false,
  groupSuspendedTabs: false,
  sortPinnedTabs: false,
  duplicateTabHandling: 'closeAllButOne',
  groupingMode: 'subdomain',
};

/** Every key the page reads on mount and writes back on a change - the whole of `SortSettings`. */
export const SORT_SETTING_KEYS: readonly (keyof SortSettings)[] = [
  'sortBy',
  'groupFrom',
  'preserveOrderWithinGroups',
  'groupSuspendedTabs',
  'sortPinnedTabs',
  'duplicateTabHandling',
  'groupingMode',
];

export function isSortBy(value: unknown): value is SortBy {
  return value === 'url' || value === 'title' || value === 'custom';
}

export function isGroupFrom(value: unknown): value is GroupFrom {
  return value === 'leftToRight' || value === 'rightToLeft';
}

export function isDuplicateTabHandling(value: unknown): value is DuplicateTabHandling {
  return value === 'none' || value === 'closeAllButOne' || value === 'group';
}

export function isGroupingMode(value: unknown): value is GroupingMode {
  return value === 'subdomain' || value === 'domain';
}

/** One entry of a Settings dropdown: the stored value and the words shown for it. */
interface SortOption<T extends string> {
  value: T;
  label: string;
}

/**
 * What each dropdown in the Sorting section offers, in the order shown. The values are exactly the
 * ones the guards above accept (pinned by `sort-settings.test.ts`), so a choice can never write a
 * value the sort engine does not read. Functions, not constants: the labels are read in the UI
 * language at the moment they are drawn.
 */
/** The grey line under "Sort by": what the chosen mode does. */
export function sortByHintKey(sortBy: SortBy): MessageKey {
  switch (sortBy) {
    case 'url':
      return 'settingsSortByUrlHint';
    case 'title':
      return 'settingsSortByTitleHint';
    case 'custom':
      return 'settingsSortByCustomHint';
  }
}

export function sortByOptions(): SortOption<SortBy>[] {
  return [
    { value: 'url', label: t('settingsSortByUrl') },
    { value: 'title', label: t('settingsSortByTitleOption') },
    { value: 'custom', label: t('settingsSortByCustom') },
  ];
}

export function duplicateTabOptions(): SortOption<DuplicateTabHandling>[] {
  return [
    { value: 'closeAllButOne', label: t('settingsDuplicateKeepOne') },
    { value: 'none', label: t('settingsDuplicateKeepAll') },
    { value: 'group', label: t('settingsDuplicateGroup') },
  ];
}

export function groupingModeOptions(): SortOption<GroupingMode>[] {
  return [
    { value: 'subdomain', label: t('settingsGroupingSubdomain') },
    { value: 'domain', label: t('settingsGroupingDomain') },
  ];
}

export function groupFromOptions(): SortOption<GroupFrom>[] {
  return [
    { value: 'leftToRight', label: t('settingsGroupFromLeft') },
    { value: 'rightToLeft', label: t('settingsGroupFromRight') },
  ];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function parseBoolean(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback;
}

/**
 * Reads the whole of `SortSettings` out of what `chrome.storage.sync.get()` returned. Every value
 * is validated on its own and falls back to its default, so a missing key, a key left behind by an
 * older version, or a hand-edited value can never put the page (or what it writes back) into a
 * state the sort engine cannot read.
 */
export function parseSortSettings(raw: unknown): SortSettings {
  const stored = isRecord(raw) ? raw : {};
  return {
    sortBy: isSortBy(stored.sortBy) ? stored.sortBy : DEFAULT_SORT_SETTINGS.sortBy,
    groupFrom: isGroupFrom(stored.groupFrom) ? stored.groupFrom : DEFAULT_SORT_SETTINGS.groupFrom,
    preserveOrderWithinGroups: parseBoolean(
      stored.preserveOrderWithinGroups,
      DEFAULT_SORT_SETTINGS.preserveOrderWithinGroups,
    ),
    groupSuspendedTabs: parseBoolean(
      stored.groupSuspendedTabs,
      DEFAULT_SORT_SETTINGS.groupSuspendedTabs,
    ),
    sortPinnedTabs: parseBoolean(stored.sortPinnedTabs, DEFAULT_SORT_SETTINGS.sortPinnedTabs),
    duplicateTabHandling: isDuplicateTabHandling(stored.duplicateTabHandling)
      ? stored.duplicateTabHandling
      : DEFAULT_SORT_SETTINGS.duplicateTabHandling,
    groupingMode: isGroupingMode(stored.groupingMode)
      ? stored.groupingMode
      : DEFAULT_SORT_SETTINGS.groupingMode,
  };
}

/**
 * Whether the Settings view shows the Custom-only settings (indented under "Sort by"):
 * `groupingMode`, `groupFrom` and `preserveOrderWithinGroups`. Only `sortByCustom()` reads them -
 * `sortByTitleOrUrl()` is not even passed them, so under "By URL" / "By title" they change
 * nothing. They are hidden rather than disabled under the other modes; their stored values are
 * kept either way.
 */
export function showsCustomSortOptions(sortBy: SortBy): boolean {
  return sortBy === 'custom';
}
