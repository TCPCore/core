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
    include: ['packages/*/src/**/*.test.ts', 'packages/*/src/**/*.test-d.ts'],
    exclude: ['**/node_modules/**', '**/dist/**'],
    environment: 'node',
    globals: false,
    reporters: ['default'],
    testTimeout: 20_000,
    /**
     * Hooks need their own budget, and it has to be generous.
     *
     * Vitest's default is 10s regardless of `testTimeout`, so a `beforeAll` that
     * warms a module graph and generates a key pair legitimately exceeds it when
     * the rest of the workspace is loading the machine in parallel. The failure it
     * produces is a timeout on a test that does no I/O and answers in milliseconds,
     * which reads as a mysterious flake rather than as "setup was slow". A suite
     * people stop trusting is a suite people skip.
     */
    hookTimeout: 30_000,
    /**
     * Type-level tests run, and are scoped.
     *
     * Vitest's typecheck mode is a separate runner, disabled by default, so a
     * `*.test-d.ts` file in the tree does nothing at all: documentation wearing a
     * test's filename. That matters because a type-level guard is the strongest
     * form available here. It asserts that code omitting a required argument fails
     * to compile, which no runtime assertion can, and it cannot be skipped or made
     * flaky.
     *
     * Two things had to be fixed before this could be enabled, both found by
     * enabling it:
     *
     *   1. Test fakes that did not match their interfaces. The runner reported
     *      `'query' does not exist in type 'AuditSink'`, plus a partial `AuditLog`
     *      in `risk-gate.test.ts`. A type-level guard is worthless while the code
     *      it guards does not typecheck.
     *   2. Scope. Enabled unscoped, the runner walked outside the project and
     *      resolved stale ambient declarations from an unrelated codebase, taking
     *      the suite from about 60s to about 530s. `tsconfig` bounds it.
     */
    typecheck: {
      enabled: true,
      tsconfig: './tsconfig.typecheck.json',
      include: ['**/*.test-d.ts'],
    },
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
