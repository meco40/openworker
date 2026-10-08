import type { NextConfig } from 'next';
import createBundleAnalyzer from '@next/bundle-analyzer';

const withBundleAnalyzer = createBundleAnalyzer({
  enabled: process.env.ANALYZE === 'true',
});

const nextConfig: NextConfig = {
  reactStrictMode: true,
  allowedDevOrigins: ['127.0.0.1', 'localhost'],
  webpack(config, { dev }) {
    if (dev) {
      config.watchOptions = {
        ...config.watchOptions,
        ignored: [
          '**/.local/**',
          '**/.playwright-cli/**',
          '**/coverage/**',
          '**/output/**',
          '**/playwright-report/**',
          '**/test-results/**',
        ],
      };
    }
    return config;
  },
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
