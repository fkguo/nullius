import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // The RPC-bridge tests spawn a Node child process per case (full
    // stdin/stdout round trips through the built CLI). On an idle machine a
    // case runs well under 2s, but on a cold or loaded CI runner the first
    // spawn alone can exceed the vitest 5s default (observed 5.7s on the
    // Node 20 matrix job) with no assertion ever failing. 20s keeps hangs
    // visible while removing the cold-runner flaps — same calibration as
    // packages/orchestrator.
    testTimeout: 20_000,
  },
});
