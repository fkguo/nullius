import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['src/**/*.test.ts', 'tests/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'html'],
    },
    testTimeout: 30000,
    // One temporary root per run, removed when the run passes.
    globalSetup: ['../../scripts/lib/vitest-test-temp-root.mjs'],
  },
});

