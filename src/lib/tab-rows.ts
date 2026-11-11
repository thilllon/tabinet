/**
 * How a window's tab rows are laid out: split into runs of ungrouped tabs and groups, and paged
 * so a very large window never mounts every row at once.
 */

import { tp } from '@/lib/i18n';
import type { TabSnapshot } from '@/types';

interface TabSegment {
  groupIndex?: number;
  tabs: TabSnapshot[];
  /**
   * Index of this segment's first tab in the window's `tabs` array. Row actions ("Remove from
   * session", "Close tab") address a tab by that absolute index, which segmenting would otherwise
   * lose.
   */
  startIndex: number;
}

/**
 * Splits a window's tabs (strip order) into runs: each ungrouped tab is its own segment,
 * consecutive tabs sharing a groupIndex form one segment. Rendering the segments in order
 * reproduces the tab strip exactly.
 */
export function segmentTabs(tabs: TabSnapshot[]): TabSegment[] {
  const segments: TabSegment[] = [];
  tabs.forEach((tab, index) => {
    const last = segments[segments.length - 1];
    if (
      tab.groupIndex !== undefined &&
      last !== undefined &&
      last.groupIndex !== undefined &&
      last.groupIndex === tab.groupIndex
    ) {
      last.tabs.push(tab);
    } else {
      segments.push({ groupIndex: tab.groupIndex, tabs: [tab], startIndex: index });
    }
  });
  return segments;
}

/**
 * Paging for very large windows: a 10,000-tab session never mounts 10,000 rows at once.
 * `content-visibility: auto` keeps off-screen rows cheap to *render*, but React
 * still has to create and diff every row it mounts - so a window over the threshold starts
 * clipped and grows a page at a time behind a "Show 200 more tabs" button.
 *
 * The threshold is deliberately well above a realistic window (a 300-tab window renders in full,
 * as it always did) and the page size below it, so the first click on a huge window is visibly
 * cheap. Pure; the component only holds the count.
 */

/** Windows with more tabs than this start paged. */
export const TAB_PAGE_THRESHOLD = 300;

/** How many more rows each "Show more" click mounts. */
export const TAB_PAGE_SIZE = 200;

function clampTotal(total: number): number {
  return Number.isFinite(total) ? Math.max(0, Math.floor(total)) : 0;
}

/** How many rows a window shows before the first "Show more" click. */
export function initialTabPage(total: number): number {
  const size = clampTotal(total);
  return size > TAB_PAGE_THRESHOLD ? TAB_PAGE_SIZE : size;
}

/** How many rows are shown after one more click; never past the end. */
export function nextTabPage(visible: number, total: number): number {
  const size = clampTotal(total);
  return Math.min(size, Math.max(0, Math.floor(visible)) + TAB_PAGE_SIZE);
}

/** Rows not mounted yet. Zero means the whole window is on screen and no button is needed. */
export function hiddenTabCount(visible: number, total: number): number {
  return Math.max(0, clampTotal(total) - Math.max(0, Math.floor(visible)));
}

/**
 * "Show 200 more tabs" - or the exact remainder on the last page ("Show 43 more tabs"), so the
 * button never promises rows that do not exist.
 */
export function showMoreLabel(visible: number, total: number): string {
  const hidden = hiddenTabCount(visible, total);
  return tp('treeShowMoreTabs', Math.min(TAB_PAGE_SIZE, hidden));
}
