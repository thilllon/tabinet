import { beforeEach } from 'vitest';

import { overrideOAuthConfig } from '@/lib/google-oauth';

import { type ChromeFake, createChromeFake } from './chrome-fake';

/**
 * A throw-away fake at module load (so modules touching `chrome` at import time can load), then
 * a fresh one before every test. A module that registers listeners at import (the worker) must be
 * imported inside the test, after `vi.resetModules()`, to reach that test's fake.
 */
let current: ChromeFake = createChromeFake();
Reflect.set(globalThis, 'chrome', current.chrome);

export function getChromeFake(): ChromeFake {
  return current;
}

beforeEach(() => {
  current = createChromeFake();
  Reflect.set(globalThis, 'chrome', current.chrome);
  overrideOAuthConfig();
});
