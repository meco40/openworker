import path from 'node:path';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    globals: true,
    include: ['tests/**/*.test.ts'],
    testTimeout: 20_000,
    hookTimeout: 20_000,
    maxWorkers: 4,
    coverage: {
      provider: 'v8',
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
