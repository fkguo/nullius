import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // One temporary root per run, removed when the run passes.
    globalSetup: ['../../scripts/lib/vitest-test-temp-root.mjs'],
  },
});
