// Flat config: typescript-eslint recommended + a small set of quality rules.
// Prettier owns formatting (eslint-config-prettier disables conflicting rules).
import js from '@eslint/js';
import prettier from 'eslint-config-prettier';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: [
      '**/dist/**',
      '**/dist-*/**',
      '**/.output/**',
      '**/node_modules/**',
      '**/release/**',
      '**/.wxt/**',
      'docs/**',
      'scripts/*.sh',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  prettier,
  {
    files: ['**/*.ts', '**/*.tsx'],
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'error',
        { varsIgnorePattern: '^_', argsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_' },
      ],
      eqeqeq: ['error', 'always', { null: 'ignore' }],
      '@typescript-eslint/consistent-type-imports': 'warn',
      '@typescript-eslint/no-explicit-any': 'warn',
      // console is the server/CLI log surface by design.
      'no-console': 'off',
      // tsc already reports unknown identifiers; no-undef adds nothing for TS.
      'no-undef': 'off',
    },
  },
  {
    files: ['**/*.test.ts', '**/*.test.tsx', '**/__tests__/**', '**/test/**'],
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
    },
  },
  {
    // Node scripts in JS: globals come from the runtime, not imports.
    files: ['**/*.mjs', '**/*.cjs'],
    rules: { 'no-undef': 'off' },
  },
  {
    // electron-builder hooks are CommonJS by contract.
    files: ['**/*.cjs'],
    rules: { '@typescript-eslint/no-require-imports': 'off' },
  },
  {
    // wxt codegen relies on triple-slash type references; the control-char
    // regex in browser-controller is intentional sanitization.
    files: ['apps/browser-extension/**/*'],
    rules: {
      '@typescript-eslint/triple-slash-reference': 'off',
      'no-control-regex': 'off',
    },
  },
  {
    // Golden-path helper scripts are throwaway assertion glue, not product code.
    files: ['scripts/**/*.ts'],
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
      'no-console': 'off',
    },
  }
);
