import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

function mockUserContext(context: { userId: string; authenticated: boolean } | null): void {
  vi.doMock('../../../src/server/auth/userContext', () => ({
    resolveRequestUserContext: vi.fn().mockResolvedValue(context),
  }));
}

function makePutRequest(body: unknown): Request {
  return new Request('http://localhost/api/config', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

describe('config observability', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.resetModules();
  });

  it('emits load/save telemetry events without throwing', async () => {
    const infoSpy = vi.spyOn(console, 'info').mockImplementation(() => {});
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    mockUserContext({ userId: 'legacy-local-user', authenticated: false });
    const route = await import('../../../app/api/config/route');

    const firstGet = await route.GET();
    const firstPayload = (await firstGet.json()) as { revision: string };

    const putResponse = await route.PUT(
      makePutRequest({
        revision: firstPayload.revision,
        config: { gateway: { port: 8080, host: '127.0.0.1', logLevel: 'info' } },
      }),
    );

    expect(firstGet.status).toBe(200);
    expect(putResponse.status).toBe(200);
    expect(infoSpy).toHaveBeenCalled();
    expect(warnSpy).toHaveBeenCalledTimes(0);
    expect(errorSpy).toHaveBeenCalledTimes(0);

    const rendered = infoSpy.mock.calls.map((call) => JSON.stringify(call[0])).join('\n');
    expect(rendered).toContain('config.load.success');
    expect(rendered).toContain('config.save.attempt');
    expect(rendered).toContain('config.save.success');
  });
});
