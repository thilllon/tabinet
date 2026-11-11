import { describe, expect, it } from 'vitest';

import {
  hiddenTabCount,
  initialTabPage,
  nextTabPage,
  segmentTabs,
  showMoreLabel,
  TAB_PAGE_SIZE,
  TAB_PAGE_THRESHOLD,
} from '@/lib/tab-rows';
import type { TabSnapshot } from '@/types';

function tab(url: string, groupIndex?: number, pinned = false): TabSnapshot {
  return groupIndex === undefined
    ? { url, title: url, pinned, active: false }
    : { url, title: url, pinned, active: false, groupIndex };
}

describe('segmentTabs', () => {
  it('returns an empty list for no tabs', () => {
    expect(segmentTabs([])).toEqual([]);
  });

  it('keeps ungrouped tabs as single-tab segments in strip order', () => {
    const tabs = [tab('https://a/'), tab('https://b/')];
    expect(segmentTabs(tabs)).toEqual([
      { groupIndex: undefined, tabs: [tabs[0]], startIndex: 0 },
      { groupIndex: undefined, tabs: [tabs[1]], startIndex: 1 },
    ]);
  });

  it('merges consecutive tabs of the same group into one segment', () => {
    const tabs = [
      tab('https://pinned/', undefined, true),
      tab('https://a/', 0),
      tab('https://b/', 0),
      tab('https://c/'),
      tab('https://d/', 1),
    ];
    expect(segmentTabs(tabs)).toEqual([
      { groupIndex: undefined, tabs: [tabs[0]], startIndex: 0 },
      { groupIndex: 0, tabs: [tabs[1], tabs[2]], startIndex: 1 },
      { groupIndex: undefined, tabs: [tabs[3]], startIndex: 3 },
      { groupIndex: 1, tabs: [tabs[4]], startIndex: 4 },
    ]);
  });

  it('starts a new segment when the group index changes between neighbours', () => {
    const tabs = [tab('https://a/', 0), tab('https://b/', 1), tab('https://c/', 0)];
    expect(segmentTabs(tabs).map((segment) => segment.groupIndex)).toEqual([0, 1, 0]);
  });

  it('numbers each segment with the absolute index of its first tab', () => {
    const tabs = [tab('https://a/', 0), tab('https://b/', 0), tab('https://c/'), tab('https://d/')];
    expect(segmentTabs(tabs).map((segment) => segment.startIndex)).toEqual([0, 2, 3]);
  });
});

describe('initialTabPage', () => {
  it('shows every tab of a window at or below the threshold', () => {
    expect(initialTabPage(0)).toBe(0);
    expect(initialTabPage(6)).toBe(6);
    expect(initialTabPage(TAB_PAGE_THRESHOLD)).toBe(TAB_PAGE_THRESHOLD);
  });

  it('clips a window past the threshold to one page', () => {
    expect(initialTabPage(TAB_PAGE_THRESHOLD + 1)).toBe(TAB_PAGE_SIZE);
    expect(initialTabPage(10_000)).toBe(TAB_PAGE_SIZE);
  });

  it('survives a nonsense count', () => {
    expect(initialTabPage(-5)).toBe(0);
    expect(initialTabPage(Number.NaN)).toBe(0);
  });
});

describe('nextTabPage', () => {
  it('grows by one page per click', () => {
    expect(nextTabPage(200, 10_000)).toBe(400);
    expect(nextTabPage(400, 10_000)).toBe(600);
  });

  it('stops exactly at the end', () => {
    expect(nextTabPage(200, 301)).toBe(301);
    expect(nextTabPage(301, 301)).toBe(301);
  });

  it('reaches the end of a 10,000-tab window in 49 clicks', () => {
    let visible = initialTabPage(10_000);
    let clicks = 0;
    while (hiddenTabCount(visible, 10_000) > 0) {
      visible = nextTabPage(visible, 10_000);
      clicks += 1;
    }
    expect(clicks).toBe(49);
    expect(visible).toBe(10_000);
  });
});

describe('hiddenTabCount', () => {
  it('counts the rows not mounted yet', () => {
    expect(hiddenTabCount(200, 10_000)).toBe(9800);
    expect(hiddenTabCount(6, 6)).toBe(0);
    expect(hiddenTabCount(400, 301)).toBe(0);
  });
});

describe('showMoreLabel', () => {
  it('promises a full page while one is left', () => {
    expect(showMoreLabel(200, 10_000)).toBe('Show 200 more tabs');
  });

  it('promises only the remainder on the last page', () => {
    expect(showMoreLabel(200, 243)).toBe('Show 43 more tabs');
    expect(showMoreLabel(300, 301)).toBe('Show 1 more tab');
  });
});
