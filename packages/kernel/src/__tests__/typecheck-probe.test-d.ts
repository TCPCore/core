/**
 * Probe: does the typecheck runner actually execute?
 *
 * Deliberately trivial. Its job is to prove the runner is wired up before a real
 * type-level guard is written, because a `*.test-d.ts` that never runs is
 * documentation, not a guard.
 *
 * Everything is imported explicitly rather than relying on Vitest globals. The
 * typecheck runner resolves types through its own tsconfig, and depending on
 * `vitest/globals` there made this probe fail on a missing `describe` instead of
 * checking the thing it exists to check.
 */

import { describe, expectTypeOf, it } from 'vitest';

describe('typecheck runner', () => {
  it('is actually executing', () => {
    expectTypeOf<string>().toEqualTypeOf<string>();
  });
});
