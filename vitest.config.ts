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
            'tests/unit/channels/message-service-*.test.ts',
            'tests/unit/channels/telegram-*.test.ts',
            'tests/unit/components/**/*.test.{ts,tsx}',
          ],
        },
      },
      {
        extends: true,
        test: {
          name: 'unit-isolated',
          isolate: true,
          include: [
            'tests/unit/channels/message-service-*.test.ts',
            'tests/unit/channels/telegram-*.test.ts',
          ],
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
      exclude: [
        'components/**',
        'src/modules/**',
        'app/api/model-hub/**',
        'src/server/skills/**',
        'app/api/skills/**',
        'src/server/personas/**',
        'src/server/channels/messages/service.ts',
        'src/server/channels/outbound/router.ts',
        'src/server/channels/pairing/telegramPolling.ts',
        'tests/**',
        '**/*.test.{ts,tsx}',
        '**/*.spec.{ts,tsx}',
      ],
      thresholds: {
        lines: 60,
        functions: 60,
        branches: 60,
        statements: 60,
      },
    },
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, 'src'),
    },
  },
});
