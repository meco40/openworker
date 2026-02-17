import type { NextConfig } from 'next';
import createBundleAnalyzer from '@next/bundle-analyzer';

const withBundleAnalyzer = createBundleAnalyzer({
  enabled: process.env.ANALYZE === 'true',
});

const nextConfig: NextConfig = {
  reactStrictMode: true,
  output: 'standalone',
  outputFileTracingExcludes: {
    '/*': [
      '.local/**/*.db-journal',
      '.local/**/*.db-shm',
      '.local/**/*.db-wal',
      'demo/**',
      'backups/**',
      'workspaces/**',
      'src/server/skills/handlers./**',
    ],
  },
};

export default withBundleAnalyzer(nextConfig);
