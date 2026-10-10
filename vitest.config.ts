import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts', 'test/**/*.test.ts'],
    // Property tests shrink a failing case before reporting it, which can take minutes.
    testTimeout: 600_000,
  },
});
