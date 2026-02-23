import path from 'node:path';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    globals: true,
    include: ['tests/e2e/**/*.e2e.test.ts'],
    exclude: ['tests/e2e/**/*.live.e2e.test.ts'],
    testTimeout: 60_000,
    hookTimeout: 60_000,
    retry: 1,
    maxWorkers: 1,
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, 'src'),
    },
  },
});
