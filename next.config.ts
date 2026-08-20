import type { NextConfig } from 'next';
import createBundleAnalyzer from '@next/bundle-analyzer';

const withBundleAnalyzer = createBundleAnalyzer({
  enabled: process.env.ANALYZE === 'true',
});

const nextConfig: NextConfig = {
  reactStrictMode: true,
  outputFileTracingExcludes: {
    '/*': [
      '.local/**',
      '.local/**/*.db',
      '.local/**/*.db-journal',
      '.local/**/*.db-shm',
      '.local/**/*.db-wal',
      '**/.codex/**',
      '**/.openclaw/**',
      'demo/**',
      'backups/**',
      'workspaces/**',
      'coverage/**',
      'playwright-report/**',
      'test-results/**',
      'dist/**',
      'tests/**',
      'docs/**',
      'src/server/skills/handlers/**',
      // Keep compatibility exclude for historic dotted trace paths.
      'src/server/skills/handlers./**',
    ],
  },
};

export default withBundleAnalyzer(nextConfig);
