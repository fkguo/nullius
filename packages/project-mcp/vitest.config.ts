import { defineConfig } from 'vitest/config';
export default defineConfig({
  test: {
    testTimeout: 30_000,
    hookTimeout: 30_000,
    // One temporary root per run, removed when the run passes.
    globalSetup: ['../../scripts/lib/vitest-test-temp-root.mjs'],
  },
});
