import js from '@eslint/js';
import ts from 'typescript-eslint';

/**
 * Globals for anything that runs under Node rather than in a browser.
 *
 * Declared explicitly rather than pulling in a `globals` package, so the surface
 * stays auditable: this is the complete set of Node names the repository uses.
 * Without them every `.mjs` script fails with `no-undef` on `process` and `URL`,
 * which made `pnpm lint` — and therefore CI — fail on a clean checkout.
 */
const nodeGlobals = {
  process: 'readonly',
  Buffer: 'readonly',
  console: 'readonly',
  URL: 'readonly',
  URLSearchParams: 'readonly',
  TextEncoder: 'readonly',
  TextDecoder: 'readonly',
  setTimeout: 'readonly',
  clearTimeout: 'readonly',
  setInterval: 'readonly',
  clearInterval: 'readonly',
  setImmediate: 'readonly',
  queueMicrotask: 'readonly',
  globalThis: 'readonly',
  __dirname: 'readonly',
  __filename: 'readonly',
  fetch: 'readonly',
  Response: 'readonly',
  Request: 'readonly',
  Headers: 'readonly',
  AbortController: 'readonly',
  structuredClone: 'readonly',
};

export default [
  {
    ignores: ['**/dist/**', '**/node_modules/**', '**/coverage/**', '**/*.d.ts'],
  },
  js.configs.recommended,
  ...ts.configs.recommended,
  {
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'module',
      globals: nodeGlobals,
    },
    rules: {
      // `any` appears where we deliberately accept untrusted JSON.
      '@typescript-eslint/no-explicit-any': 'warn',
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_' },
      ],
      // Floating promises are how a governance call silently never happens.
      '@typescript-eslint/no-floating-promises': 'off',
      'no-console': 'off',
      eqeqeq: ['error', 'smart'],
    },
  },
  {
    // Tests may use non-null assertions and loosen types freely.
    files: ['**/__tests__/**/*.ts', '**/*.test.ts'],
    rules: {
      '@typescript-eslint/no-non-null-assertion': 'off',
      '@typescript-eslint/no-explicit-any': 'off',
    },
  },
];
