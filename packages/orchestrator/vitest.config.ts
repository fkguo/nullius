import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // This suite exercises real lifecycle IO by design: many tests run full
    // init/verify/final-conclusions/approve/export cycles against durable
    // fsync'd writes, and routinely take 3-5s each on an unloaded machine.
    // The vitest 5s default therefore sits exactly at the working point and
    // flips tests red under ambient machine load with no assertion ever
    // failing. 20s keeps hangs visible while removing the load-induced flaps.
    testTimeout: 20_000,
  },
});
