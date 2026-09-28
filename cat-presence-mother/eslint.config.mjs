import simpleImportSort from 'eslint-plugin-simple-import-sort';
import stylistic from '@stylistic/eslint-plugin';
import tseslint from 'typescript-eslint';

export default tseslint.config(...tseslint.configs.recommended, {
  files: ['**/*.ts'],

  plugins: {
    '@stylistic': stylistic,
    'simple-import-sort': simpleImportSort,
  },

  rules: {
    '@typescript-eslint/no-explicit-any': 'error',

    curly: ['error', 'all'],

    'simple-import-sort/imports': 'error',
    'simple-import-sort/exports': 'error',

    '@stylistic/padding-line-between-statements': [
      'error',

      {
        blankLine: 'always',
        prev: '*',
        next: ['if', 'switch', 'for', 'while', 'do', 'try', 'block-like'],
      },

      {
        blankLine: 'always',
        prev: '*',
        next: 'function',
      },

      {
        blankLine: 'always',
        prev: '*',
        next: 'return',
      },

      {
        blankLine: 'always',
        prev: ['if', 'switch', 'for', 'while', 'do', 'try', 'block-like'],
        next: '*',
      },
    ],

    '@stylistic/lines-between-class-members': [
      'error',
      'always',
      {
        exceptAfterSingleLine: true,
      },
    ],
  },
});
