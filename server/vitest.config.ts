import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/tests/**/*.test.ts'],
    // PGlite starts a real Postgres in WASM per test file; give it room on a slow machine.
    testTimeout: 20_000,
    hookTimeout: 30_000,
  },
});
