import { defineConfig } from 'vitest/config';

/**
 * Root Vitest config.
 *
 * Test files live next to the code they cover (`src/**\/__tests__/*.test.ts`) so a
 * package can be understood without a separate test tree, and so `tsc` can
 * exclude compiled test output from a package's published `dist/`.
 *
 * The `include` pattern is anchored to `src/` deliberately: an unanchored
 * `**\/*.test.ts` would also match the compiled copies under `dist/`, running
 * every test twice (and against stale code).
 */
export default defineConfig({
  test: {
    include: ['packages/*/src/**/*.test.ts'],
    exclude: ['**/node_modules/**', '**/dist/**'],
    environment: 'node',
    globals: false,
    reporters: ['default'],
    testTimeout: 20_000,
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov'],
      include: ['packages/*/src/**/*.ts'],
      exclude: [
        '**/__tests__/**',
        '**/*.test.ts',
        '**/index.ts',
        '**/types.ts',
        '**/sample-specs.ts',
      ],
    },
  },
});
