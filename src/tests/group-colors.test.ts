import { describe, expect, it } from 'vitest';

import {
  GROUP_CHIP_CLASS,
  GROUP_RAIL_CLASS,
  groupChipClass,
  groupRailClass,
} from '@/lib/group-colors';

describe('group colour classes', () => {
  it('keeps the chip and the rail in step', () => {
    expect(Object.keys(GROUP_CHIP_CLASS)).toEqual(Object.keys(GROUP_RAIL_CLASS));
  });

  it("maps Chrome's grey onto Tailwind's gray", () => {
    expect(groupChipClass('grey')).toContain('gray');
  });

  it('falls back to grey for a colour Chrome has not shipped yet', () => {
    expect(groupChipClass('magenta')).toBe(GROUP_CHIP_CLASS.grey);
    expect(groupRailClass('magenta')).toBe(GROUP_RAIL_CLASS.grey);
  });
});
