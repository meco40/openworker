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
      '.local/**',
      '.local/**/*.db',
      '.local/**/*.db-journal',
      '.local/**/*.db-shm',
      '.local/**/*.db-wal',
      '**/.codex/**',
      '**/.openclaw/**',
      '**/C:/Users/**/.codex/**',
      '**/C:/Users/**/.openclaw/**',
      'demo/**',
      'backups/**',
      'workspaces/**',
      'tests/**',
      'docs/**',
      'src/server/skills/handlers/**',
      // Keep compatibility exclude for historic dotted trace paths.
      'src/server/skills/handlers./**',
    ],
  },
};

export default withBundleAnalyzer(nextConfig);
