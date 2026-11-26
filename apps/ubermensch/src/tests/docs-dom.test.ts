import { describe, expect, it } from 'vitest';

import { emailFromLabel, findAccountEmail, findMountAnchor, MOUNT_ANCHORS } from '@/lib/docs-dom';

/** A stand-in for `document` that knows which selectors match (vitest runs without a DOM). */
function fakeRoot(matches: Record<string, { label?: string }[]>): ParentNode {
  const element = (entry: { label?: string }): Element =>
    ({
      getAttribute: (name: string) => (name === 'aria-label' ? (entry.label ?? null) : null),
    }) as unknown as Element;
  return {
    querySelector: (selector: string) => {
      const first = matches[selector]?.[0];
      return first === undefined ? null : element(first);
    },
    querySelectorAll: (selector: string) => (matches[selector] ?? []).map(element),
  } as unknown as ParentNode;
}

describe('findMountAnchor', () => {
  it('takes the most specific anchor the page has', () => {
    const all = Object.fromEntries(MOUNT_ANCHORS.map((selector) => [selector, [{}]]));
    expect(findMountAnchor(fakeRoot(all))).toBeDefined();
    expect(findMountAnchor(fakeRoot({ '#docs-titlebar': [{}] }))).toBeDefined();
  });

  it('gives up quietly when Google changed the page', () => {
    expect(findMountAnchor(fakeRoot({}))).toBeUndefined();
  });
});

describe('the account address', () => {
  it('reads it from a label', () => {
    expect(emailFromLabel('Google Account: Kim Example (kim.example+docs@example.co.uk)')).toBe(
      'kim.example+docs@example.co.uk',
    );
    expect(emailFromLabel('Sign in')).toBeUndefined();
    expect(emailFromLabel(null)).toBeUndefined();
  });

  it('finds the first labelled account control', () => {
    expect(
      findAccountEmail(
        fakeRoot({ 'header [aria-label*="@"]': [{ label: 'Account (kim@example.com)' }] }),
      ),
    ).toBe('kim@example.com');
    expect(findAccountEmail(fakeRoot({}))).toBeUndefined();
  });
});
