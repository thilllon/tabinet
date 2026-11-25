import { cn as registryCn } from 'cn';
import { describe, expect, it } from 'vitest';

import { cn } from '@/lib/utils';

describe("the registry's cn", () => {
  it('is our own, so the stock components add no second class-merge library', () => {
    expect(registryCn).toBe(cn);
  });
});
