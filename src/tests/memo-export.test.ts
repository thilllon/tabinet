import { describe, expect, it } from 'vitest';

import { memoDisplayTitle, memoExport } from '@/lib/memo-export';

describe('memoExport', () => {
  it('exports the text exactly as written, named after the first line', () => {
    expect(memoExport({ text: '  Plan\n\n- one  \n' })).toEqual({
      base: 'Plan',
      text: '  Plan\n\n- one  \n',
    });
  });

  it('names a blank memo "Untitled memo"', () => {
    expect(memoExport({ text: '\n \n' }).base).toBe('Untitled memo');
    expect(memoDisplayTitle('')).toBe('Untitled memo');
    expect(memoDisplayTitle('x')).toBe('x');
  });
});
