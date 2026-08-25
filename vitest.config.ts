import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    // Each test file gets its own SQLite file, so files may run in parallel,
    // but tests inside a file share a database and must run sequentially.
    sequence: { concurrent: false },
    testTimeout: 20_000,
    reporters: ['default'],
  },
});
