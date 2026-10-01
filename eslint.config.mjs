// eslint.config.mjs — lint with type-aware rules (typescript-eslint, strict preset).
// Separate TypeScript projects (main CommonJS, isolated renderer ES modules, renderer
// tests): the parser gets all of them, so every file is analyzed with its own tsconfig.
//
// The few rules tuned below are only those with known false positives; none is turned
// off to hide a real problem.

import eslint from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: ['dist/**', 'release/**', 'node_modules/**', 'scripts/**', 'eslint.config.mjs'],
  },
  eslint.configs.recommended,
  ...tseslint.configs.strictTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        project: ['./tsconfig.json', './tsconfig.renderer.json', './tsconfig.renderer.test.json'],
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      // Numbers and booleans in template strings are intended (messages, UI labels).
      '@typescript-eslint/restrict-template-expressions': ['error', { allowNumber: true, allowBoolean: true }],
      // Convention `_name` = intentionally unused (already accepted by tsc).
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      // `test()`/`describe()` from node:test return a promise handled by the runner.
      '@typescript-eslint/no-floating-promises': ['error', {
        allowForKnownSafeCalls: [{ from: 'package', package: 'node:test', name: ['test', 'describe', 'it'] }],
      }],
    },
  },
  {
    files: ['**/*.test.ts', 'tests/**/*.ts'],
    rules: {
      // In fetch/SDK mocks an async function without await is the natural form.
      '@typescript-eslint/require-await': 'off',
      // `!` after an assert already done in the test: acceptable in tests only.
      '@typescript-eslint/no-non-null-assertion': 'off',
    },
  },
);
