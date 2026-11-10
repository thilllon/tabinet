import { describe, expect, it } from 'vitest';

import { STORE_EXTENSION_ID } from '@/constants';
import { canSignInHere } from '@/lib/cloud-config';

describe('canSignInHere', () => {
  it('is true only under the store item id the OAuth client is bound to', () => {
    expect(canSignInHere(STORE_EXTENSION_ID)).toBe(true);
    expect(canSignInHere('abcdefghijklmnopabcdefghijklmnop')).toBe(false);
  });
});
