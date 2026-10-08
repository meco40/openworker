import { describe, expect, it } from 'vitest';
import nextConfig from '../../next.config';

describe('next config security headers', () => {
  it('sets baseline security headers for all routes', async () => {
    const entries = (await nextConfig.headers?.()) ?? [];
    const allRoutes = entries.find((entry) => entry.source === '/:path*');

    expect(allRoutes).toBeDefined();
    expect(Object.fromEntries(allRoutes!.headers.map((h) => [h.key, h.value]))).toEqual({
      'X-Content-Type-Options': 'nosniff',
      'X-Frame-Options': 'DENY',
      'Referrer-Policy': 'strict-origin-when-cross-origin',
      'Content-Security-Policy': "frame-ancestors 'none'; base-uri 'self'; object-src 'none'",
    });
  });
});
