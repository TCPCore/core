/**
 * Type-level guard: the two shipped stores really do implement `KernelStore`.
 *
 * This is the check that a missing method cannot hide. A `KernelStore` method left
 * unimplemented is a compile error here, and it is a compile error rather than a
 * runtime assertion because no runtime test can prove a signature is complete:
 * the method simply would not be there to call.
 *
 * `expectTypeOf(...).toMatchTypeOf<KernelStore>()` is used rather than
 * `toEqualTypeOf` deliberately. The store classes carry extra members (`tenantId`,
 * `end()`, the demo helpers), which are a superset of the interface and are fine.
 * What must hold is that the interface's members are all present with compatible
 * types.
 */

import { describe, expectTypeOf, it } from 'vitest';
import { MemoryStore, PostgresKernelStore } from '../index.js';
import type { KernelStore, KernelStoreFactory, TenantId } from '../index.js';

describe('KernelStore implementations', () => {
  it('MemoryStore satisfies KernelStore', () => {
    expectTypeOf<MemoryStore>().toMatchTypeOf<KernelStore>();
  });

  it('PostgresKernelStore satisfies KernelStore', () => {
    expectTypeOf<PostgresKernelStore>().toMatchTypeOf<KernelStore>();
  });
});

describe('KernelStoreFactory contract', () => {
  it('forTenant takes a TenantId, which no bare string satisfies', () => {
    expectTypeOf<KernelStoreFactory['forTenant']>().parameter(0).toEqualTypeOf<TenantId>();
  });

  it('forTenant returns a KernelStore', () => {
    expectTypeOf<KernelStoreFactory['forTenant']>().returns.toEqualTypeOf<KernelStore>();
  });
});
