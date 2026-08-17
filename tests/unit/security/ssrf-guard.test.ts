import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  assertSafeHttpUrl,
  fetchWithSsrfGuard,
  isPrivateOrReservedIp,
  readResponseTextLimited,
} from '@/server/http/ssrfGuard';

describe('SSRF guard', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('blocks private, loopback, link-local, and mapped addresses', () => {
    expect(isPrivateOrReservedIp('127.0.0.1')).toBe(true);
    expect(isPrivateOrReservedIp('10.0.0.5')).toBe(true);
    expect(isPrivateOrReservedIp('169.254.169.254')).toBe(true);
    expect(isPrivateOrReservedIp('::1')).toBe(true);
    expect(isPrivateOrReservedIp('::ffff:192.168.1.10')).toBe(true);
    expect(isPrivateOrReservedIp('93.184.216.34')).toBe(false);
  });

  it('rejects unsupported protocols and embedded credentials', async () => {
    await expect(assertSafeHttpUrl('file:///etc/passwd')).rejects.toThrow('Unsupported protocol');
    await expect(assertSafeHttpUrl('https://user:pass@example.com')).rejects.toThrow(
      'embedded credentials',
    );
  });

  it('blocks redirects before following them', async () => {
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(
        new Response(null, { status: 302, headers: { location: 'http://127.0.0.1:8010/' } }),
      );

    try {
      await expect(
        fetchWithSsrfGuard('https://example.com/ssrf-private-redirect', undefined, {
          maxRedirects: 1,
        }),
      ).rejects.toThrow('blocked private/loopback');
      const matchingCalls = fetchMock.mock.calls.filter(
        ([input]) => String(input) === 'https://example.com/ssrf-private-redirect',
      );
      expect(matchingCalls).toHaveLength(1);
    } finally {
      fetchMock.mockRestore();
    }
  });

  it('does not forward sensitive headers across origins', async () => {
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(
        new Response(null, { status: 302, headers: { location: 'https://example.org/next' } }),
      )
      .mockResolvedValueOnce(new Response('ok', { status: 200 }));

    try {
      await fetchWithSsrfGuard(
        'https://example.com/ssrf-header-redirect',
        {
          headers: {
            Authorization: 'Bearer secret',
            Cookie: 'session=secret',
            'X-Custom': 'preserved',
          },
        },
        { maxRedirects: 1 },
      );

      const redirectedCall = fetchMock.mock.calls.find(
        ([input]) => String(input) === 'https://example.org/next',
      );
      const redirectedHeaders = new Headers(redirectedCall?.[1]?.headers);
      expect(redirectedHeaders.get('authorization')).toBeNull();
      expect(redirectedHeaders.get('cookie')).toBeNull();
      expect(redirectedHeaders.get('x-custom')).toBe('preserved');
    } finally {
      fetchMock.mockRestore();
    }
  });

  it('limits streamed response bodies', async () => {
    await expect(readResponseTextLimited(new Response('0123456789'), 4)).rejects.toThrow(
      'Response body exceeds',
    );
  });
});
