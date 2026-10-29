import js from '@eslint/js';
import { defineConfig, globalIgnores } from 'eslint/config';
import prettier from 'eslint-config-prettier/flat';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default defineConfig(
  globalIgnores([
    '**/node_modules/**',
    '**/lib/**',
    '**/build/**',
    '**/.cxx/**',
    '**/.gradle/**',
    'website/.docusaurus/**',
    'example/.expo/**',
    'example/.artifacts/**',
    'example/ios/**',
    'example/android/**',
    'nitrogen/generated/**',
    'cpp/vendor/**',
    '.vscode/**',
  ]),
  {
    files: ['**/*.{js,cjs,mjs}'],
    ignores: ['tests/hermes/range-suite.js', 'tests/hermes/extensions-suite.js'],
    extends: [js.configs.recommended],
    languageOptions: { globals: globals.node },
  },
  {
    files: ['tests/hermes/range-suite.js', 'tests/hermes/extensions-suite.js'],
    extends: [js.configs.recommended],
    languageOptions: {
      sourceType: 'script',
      globals: {
        NitroModulesProxy: 'readonly',
        assertBorrowedRange: 'readonly',
        fileFixturePath: 'readonly',
        print: 'readonly',
        api: 'readonly',
        normalize: 'readonly',
        VECTORS: 'readonly',
        ORIGINAL: 'readonly',
        BUFFER_VERSION: 'readonly',
        Buffer: 'readonly',
      },
    },
  },
  {
    files: ['tests/hermes/extensions-suite.js'],
    languageOptions: {
      globals: {
        methods: 'readonly',
        equal: 'readonly',
        throws: 'readonly',
        raw: 'readonly',
        checks: 'readonly',
      },
    },
  },
  {
    files: ['index.ts', 'src/**/*.ts', 'native/**/*.ts', 'tests/runtime*.ts'],
    extends: [js.configs.recommended, tseslint.configs.recommendedTypeChecked],
    languageOptions: {
      parserOptions: {
        project: './tsconfig.runtime.json',
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/no-misused-promises': 'error',
    },
  },
  {
    files: ['example/App.tsx', 'example/src/**/*.ts'],
    extends: [js.configs.recommended, tseslint.configs.recommendedTypeChecked],
    languageOptions: {
      parserOptions: {
        project: './example/tsconfig.json',
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/no-misused-promises': 'error',
    },
  },
  prettier,
);
