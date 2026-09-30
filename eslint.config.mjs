// eslint.config.mjs — lint con regole basate sui tipi (typescript-eslint, preset strict).
// Due progetti TypeScript separati (main CommonJS, renderer ES module isolato):
// il parser li riceve entrambi, così ogni file è analizzato col proprio tsconfig.
//
// Le poche regole regolate qui sotto sono solo quelle con falsi positivi noti;
// nessuna è spenta per nascondere un problema reale.

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
        project: ['./tsconfig.json', './tsconfig.renderer.json'],
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      // Numeri e booleani nei template string sono voluti (messaggi, etichette UI).
      '@typescript-eslint/restrict-template-expressions': ['error', { allowNumber: true, allowBoolean: true }],
      // `test()`/`describe()` di node:test restituiscono una promise gestita dal runner.
      '@typescript-eslint/no-floating-promises': ['error', {
        allowForKnownSafeCalls: [{ from: 'package', package: 'node:test', name: ['test', 'describe', 'it'] }],
      }],
    },
  },
  {
    files: ['**/*.test.ts', 'tests/**/*.ts'],
    rules: {
      // Nei mock di fetch/SDK una funzione async senza await è la forma naturale.
      '@typescript-eslint/require-await': 'off',
      // `!` dopo un assert già fatto nel test: accettabile nei soli test.
      '@typescript-eslint/no-non-null-assertion': 'off',
    },
  },
);
