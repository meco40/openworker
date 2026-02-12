import nextVitals from 'eslint-config-next/core-web-vitals';
import nextTypescript from 'eslint-config-next/typescript';
import eslintConfigPrettier from 'eslint-config-prettier/flat';
import reactHooks from 'eslint-plugin-react-hooks';
import security from 'eslint-plugin-security';
import sonarjs from 'eslint-plugin-sonarjs';

const config = [
  ...nextVitals,
  ...nextTypescript,
  {
    name: 'project/ignores',
    ignores: ['.next/**', '.worktrees/**', 'demo/**', 'out/**', 'build/**', 'dist/**', 'coverage/**', 'node_modules/**'],
  },
  {
    name: 'project/quality-rules',
    files: ['**/*.{ts,tsx,js,jsx}'],
    plugins: {
      'react-hooks': reactHooks,
      security,
      sonarjs,
    },
    rules: {
      ...reactHooks.configs.recommended.rules,
      ...security.configs.recommended.rules,
      'sonarjs/no-identical-functions': 'error',
      'sonarjs/no-ignored-return': 'error',
      'sonarjs/no-useless-catch': 'error',
      'react-hooks/set-state-in-effect': 'off',
      'security/detect-object-injection': 'off',
      // High false-positive rate for controlled path operations in this codebase.
      'security/detect-non-literal-fs-filename': 'off',
      'sonarjs/no-duplicate-string': 'off',
      '@typescript-eslint/no-unused-vars': [
        'warn',
        {
          argsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
          caughtErrorsIgnorePattern: '^_',
        },
      ],
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
