import { describe, expect, it } from 'vitest';

import { contentHash, fnv1a32 } from '@/lib/session-hash';
import type { WindowSnapshot } from '@/types';

function win(tabs: WindowSnapshot['tabs'], groups: WindowSnapshot['groups'] = []): WindowSnapshot {
  return { state: 'normal', focused: false, groups, tabs };
}

describe('fnv1a32', () => {
  it('matches known FNV-1a vectors', () => {
    expect(fnv1a32('')).toBe('811c9dc5');
    expect(fnv1a32('a')).toBe('e40c292c');
    expect(fnv1a32('foobar')).toBe('bf9cf968');
  });
});

describe('contentHash', () => {
  const base = [
    win(
      [
        { url: 'https://a.test', title: 'A', pinned: true, active: false },
        { url: 'https://b.test', title: 'B', pinned: false, active: true, groupIndex: 0 },
      ],
      [{ title: 'Work', color: 'blue', collapsed: false }],
    ),
  ];

  it('is 8 lowercase hex chars and stable across calls', () => {
    const hash = contentHash(base);
    expect(hash).toMatch(/^[0-9a-f]{8}$/);
    expect(contentHash(structuredClone(base))).toBe(hash);
  });

  it('ignores titles', () => {
    const renamed = structuredClone(base);
    const first = renamed[0]?.tabs[0];
    if (first) {
      first.title = 'Changed';
    }
    expect(contentHash(renamed)).toBe(contentHash(base));
  });

  it('changes when tab order, pinned state, group membership or group title change', () => {
    const reordered = structuredClone(base);
    reordered[0]?.tabs.reverse();
    expect(contentHash(reordered)).not.toBe(contentHash(base));

    const unpinned = structuredClone(base);
    const first = unpinned[0]?.tabs[0];
    if (first) {
      first.pinned = false;
    }
    expect(contentHash(unpinned)).not.toBe(contentHash(base));

    const ungrouped = structuredClone(base);
    const second = ungrouped[0]?.tabs[1];
    if (second) {
      second.groupIndex = undefined;
    }
    expect(contentHash(ungrouped)).not.toBe(contentHash(base));

    const retitled = structuredClone(base);
    const group = retitled[0]?.groups[0];
    if (group) {
      group.title = 'Play';
    }
    expect(contentHash(retitled)).not.toBe(contentHash(base));
  });

  it('separates windows: the same tabs split differently hash differently', () => {
    const a = { url: 'https://a.test', title: 'A', pinned: false, active: false };
    const b = { url: 'https://b.test', title: 'B', pinned: false, active: false };
    const c = { url: 'https://c.test', title: 'C', pinned: false, active: false };

    // Dragging a tab from the end of window 1 to the front of window 2.
    expect(contentHash([win([a, b]), win([c])])).not.toBe(contentHash([win([a]), win([b, c])]));
    // Splitting one window into two.
    expect(contentHash([win([a, b, c])])).not.toBe(contentHash([win([a, b]), win([c])]));
    // An empty window is not the same layout as no window at all.
    expect(contentHash([])).not.toBe(contentHash([win([])]));
  });

  it('separates the per-tab fields from each other', () => {
    const split = [
      win(
        [
          { url: 'https://x.test/a', title: '', pinned: false, active: false, groupIndex: 0 },
          { url: 'https://x.test/b', title: '', pinned: false, active: false, groupIndex: 0 },
        ],
        [{ title: '0', color: 'blue', collapsed: false }],
      ),
      win([]),
    ];
    // A URL that swallows the next field's text must not collide with the field boundary.
    const shifted = structuredClone(split);
    const first = shifted[0]?.tabs[0];
    if (first) {
      first.url = 'https://x.test/a0';
    }
    expect(contentHash(shifted)).not.toBe(contentHash(split));
  });
});
