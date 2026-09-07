import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // The RLS and immutability suites share one database and mutate global
    // session state (SET LOCAL role/GUCs). They must not interleave.
    fileParallelism: false,
    sequence: { concurrent: false },
    hookTimeout: 60_000,
    testTimeout: 30_000,
    globalSetup: ['./tests/global-setup.ts'],
  },
});
