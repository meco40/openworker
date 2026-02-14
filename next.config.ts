import type { NextConfig } from 'next';

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

export default nextConfig;
