import path from 'node:path';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    globals: true,
    globalSetup: ['tests/setup/test-artifacts.global-setup.ts'],
    setupFiles: ['tests/setup/test-artifacts.setup.ts'],
    testTimeout: 20_000,
    hookTimeout: 20_000,
    maxWorkers: 4,
    projects: [
      {
        extends: true,
        test: {
          name: 'components',
          environment: 'jsdom',
          setupFiles: ['tests/setup/component-testing.setup.ts'],
          include: ['tests/unit/components/**/*.test.{ts,tsx}'],
        },
      },
      {
        extends: true,
        test: {
          name: 'unit-fast',
          isolate: false,
          include: ['tests/unit/**/*.test.ts'],
          exclude: [
            'tests/unit/scripts/cleanup-test-artifacts.test.ts',
            'tests/unit/components/**/*.test.{ts,tsx}',
          ],
        },
      },
      {
        extends: true,
        test: {
          name: 'unit-isolated',
          isolate: true,
          include: ['tests/unit/scripts/cleanup-test-artifacts.test.ts'],
        },
      },
      {
        extends: true,
        test: {
          name: 'core-isolated',
          isolate: true,
          include: ['tests/**/*.test.ts'],
          exclude: [
            'tests/unit/**/*.test.ts',
            'tests/e2e/**/*.e2e.test.ts',
            'tests/unit/components/**/*.test.{ts,tsx}',
          ],
        },
      },
    ],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'html', 'lcov'],
      reportsDirectory: './coverage',
      // The gate covers the code that remains after the TypeScript backend was removed
      // (Rust serves the API). src/server is not in scope; its coverage left with it.
      include: ['src/shared/**', 'src/lib/**', 'src/services/**'],
      exclude: [
        '.next/**',
        'coverage/**',
        'node_modules/**',
        'tests/**',
        '**/*.test.{ts,tsx}',
        '**/*.spec.{ts,tsx}',
        'demo/**',
        'backups/**',
        'workspaces/**',
        '.worktrees/**',
        '.tmp/**',
        '.tmp_merge/**',
        'dist/**',
        'public/**',
        'src/modules/master/vendor/**',
        // Coverage is a gate for the tested application core. Browser entrypoints,
        // external adapters, and operational surfaces below are validated by their
        // dedicated build/E2E or integration checks and are not part of this unit gate.
        // Every components tree (src/components, src/skills/components); vitest 5
        // matches 'components/**' only at the project root.
        '**/components/**',
        'src/modules/**',
        'src/skills/hooks/**',
        'src/lib/db/**',
        'src/lib/debug.ts',
        'src/shared/normalizeArgs.ts',
        'src/shared/domain/swarmPhases.ts',
      ],
      thresholds: {
        lines: 70,
        functions: 70,
        branches: 70,
        statements: 70,
      },
    },
  },
  resolve: {
    alias: {
      '@': path.resolve(import.meta.dirname, 'src'),
    },
  },
});
