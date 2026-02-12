import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  reactStrictMode: true,
  output: 'standalone',
  outputFileTracingExcludes: {
    '/*': ['src/server/skills/handlers./**'],
  },
};

export default nextConfig;
