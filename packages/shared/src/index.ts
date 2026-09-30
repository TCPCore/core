/**
 * @tcpcore1/shared — the contract every other TCPcore package builds on.
 *
 * Zod schemas are the source of truth; TypeScript types are inferred from them
 * so validation and static types cannot disagree.
 */

export * from './constants.js';

export * from './schemas/adapter.js';
export * from './schemas/approval.js';
export * from './schemas/audit.js';
export * from './schemas/domain.js';
export * from './schemas/integration.js';
export * from './schemas/user.js';
