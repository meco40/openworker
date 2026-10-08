import { afterEach, describe, expect, it, vi } from 'vitest';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
});

describe('requestControlPlaneMetrics', () => {
  it('shares an in-flight dashboard request and allows a later refresh', async () => {
    let resolveFirstResponse!: (response: Response) => void;
    const firstResponse = new Promise<Response>((resolve) => {
      resolveFirstResponse = resolve;
    });
    const metrics = { uptimeMs: 42 };
    const fetchMock = vi
      .fn()
      .mockReturnValueOnce(firstResponse)
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ ok: true, metrics }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      );
    vi.stubGlobal('fetch', fetchMock);

    const { requestControlPlaneMetrics } =
      await import('@/modules/app-shell/controlPlaneMetricsClient');
    const first = requestControlPlaneMetrics();
    const concurrent = requestControlPlaneMetrics();

    expect(concurrent).toBe(first);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith('/api/control-plane/metrics?scope=shell', {
      cache: 'no-store',
    });

    resolveFirstResponse(
      new Response(JSON.stringify({ ok: true, metrics }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
    await expect(first).resolves.toEqual(metrics);
    await requestControlPlaneMetrics();

    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
