import nextVitals from 'eslint-config-next/core-web-vitals';
import nextTypescript from 'eslint-config-next/typescript';
import eslintConfigPrettier from 'eslint-config-prettier/flat';
import { importX as importXPlugin } from 'eslint-plugin-import-x';
import promise from 'eslint-plugin-promise';
import reactHooks from 'eslint-plugin-react-hooks';
import security from 'eslint-plugin-security';
import sonarjs from 'eslint-plugin-sonarjs';
import unicorn from 'eslint-plugin-unicorn';
import unusedImports from 'eslint-plugin-unused-imports';
import vitest from 'eslint-plugin-vitest';

const config = [
  ...nextVitals,
  ...nextTypescript,
  importXPlugin.flatConfigs.recommended,
  importXPlugin.flatConfigs.typescript,
  {
    name: 'project/ignores',
    ignores: [
      '.next/**',
      '.worktrees/**',
      '.tmp/**',
      '.tmp_merge/**',
      'backups/**',
      'demo/**',
      'out/**',
      'build/**',
      'dist/**',
      'coverage/**',
      'node_modules/**',
    ],
  },
  {
    name: 'project/quality-rules',
    files: ['**/*.{ts,tsx,js,jsx}'],
    plugins: {
      'react-hooks': reactHooks,
      security,
      sonarjs,
      promise,
      unicorn,
      'unused-imports': unusedImports,
    },
    rules: {
      ...reactHooks.configs.recommended.rules,
      ...security.configs.recommended.rules,
      ...promise.configs['flat/recommended'].rules,
      'sonarjs/no-identical-functions': 'error',
      'sonarjs/no-ignored-return': 'error',
      'sonarjs/no-useless-catch': 'error',
      'import-x/no-cycle': 'warn',
      'import-x/no-duplicates': 'warn',
      'react-hooks/set-state-in-effect': 'off',
      'security/detect-object-injection': 'off',
      // High false-positive rate for controlled path operations in this codebase.
      'security/detect-non-literal-fs-filename': 'off',
      'sonarjs/no-duplicate-string': 'off',
      // This often produces noisy results in real-world async code.
      'promise/always-return': 'off',
      'promise/catch-or-return': 'warn',
      'promise/param-names': 'warn',
      'unicorn/prefer-node-protocol': 'warn',
      'unicorn/no-array-for-each': 'off',
      'unicorn/prefer-string-starts-ends-with': 'warn',
      'unicorn/no-useless-undefined': 'warn',
      'unicorn/consistent-function-scoping': 'warn',
      '@typescript-eslint/no-unused-vars': 'off',
      'unused-imports/no-unused-imports': 'warn',
      'unused-imports/no-unused-vars': [
        'warn',
        {
          argsIgnorePattern: '^_',
          args: 'after-used',
          varsIgnorePattern: '^_',
          vars: 'all',
          caughtErrorsIgnorePattern: '^_',
          caughtErrors: 'all',
        },
      ],
    },
  },
  {
    name: 'project/known-runtime-cycles',
    files: [
      'src/server/automation/runtime.ts',
      'src/server/channels/messages/runtime.ts',
      'src/server/channels/messages/service.ts',
      'src/server/channels/pairing/telegramInbound.ts',
      'src/server/channels/pairing/telegramPolling.ts',
      'src/server/worker/workerAgent.ts',
      'src/server/worker/workerCallback.ts',
    ],
    rules: {
      // These modules intentionally share singleton runtime state.
      'import-x/no-cycle': 'off',
    },
  },
  {
    name: 'project/react-default-member-exceptions',
    files: ['src/modules/personas/PersonaContext.tsx'],
    rules: {
      'import-x/no-named-as-default-member': 'off',
    },
  },
  {
    name: 'project/vitest-rules',
    files: ['**/*.{test,spec}.{ts,tsx,js,jsx}', 'tests/**/*.{ts,tsx,js,jsx}'],
    plugins: {
      vitest,
    },
    languageOptions: {
      globals: vitest.environments.env.globals,
    },
    rules: {
      ...vitest.configs.recommended.rules,
      'vitest/no-focused-tests': 'error',
      'vitest/no-disabled-tests': 'warn',
    },
  },
  {
    name: 'project/typescript-rules',
    files: ['**/*.{ts,tsx}'],
    rules: {
      '@typescript-eslint/no-explicit-any': 'error',
    },
  },
  eslintConfigPrettier,
];

export default config;
