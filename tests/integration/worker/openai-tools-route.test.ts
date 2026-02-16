import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type MockUserContext = { userId: string; authenticated: boolean } | null;

function mockUserContext(context: MockUserContext): void {
  vi.doMock('../../../src/server/auth/userContext', () => ({
    resolveRequestUserContext: vi.fn().mockResolvedValue(context),
  }));
}

describe('/api/worker/openai/tools', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.resetModules();
  });

  it('returns 401 when user context is missing', async () => {
    mockUserContext(null);

    const route = await import('../../../app/api/worker/openai/tools/route');
    const response = await route.GET();

    expect(response.status).toBe(401);
  });

  it('lists OpenAI worker tools', async () => {
    mockUserContext({ userId: 'legacy-local-user', authenticated: false });
    vi.doMock('../../../src/server/worker/openai/openaiToolRegistry', () => ({
      listOpenAiWorkerTools: vi.fn().mockResolvedValue([
        {
          id: 'computerUse',
          name: 'Computer Use',
          enabled: false,
          description: 'Control the remote browser session with guarded actions.',
          functionName: 'safe_computer_use',
        },
      ]),
    }));

    const route = await import('../../../app/api/worker/openai/tools/route');
    const response = await route.GET();
    const payload = (await response.json()) as {
      ok: boolean;
      tools: Array<{ id: string; enabled: boolean }>;
    };

    expect(response.status).toBe(200);
    expect(payload.ok).toBe(true);
    expect(payload.tools).toEqual([
      expect.objectContaining({ id: 'computerUse', enabled: false }),
    ]);
  });

  it('updates OpenAI worker tool activation via PATCH', async () => {
    mockUserContext({ userId: 'legacy-local-user', authenticated: false });
    const setToolEnabled = vi.fn().mockResolvedValue({
      id: 'browser',
      name: 'Browser',
      enabled: true,
      description: 'Capture browser snapshots.',
      functionName: 'safe_browser',
    });
    vi.doMock('../../../src/server/worker/openai/openaiToolRegistry', () => ({
      setOpenAiWorkerToolEnabled: setToolEnabled,
    }));

    const route = await import('../../../app/api/worker/openai/tools/route');
    const response = await route.PATCH(
      new Request('http://localhost/api/worker/openai/tools', {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ id: 'browser', enabled: true }),
      }),
    );
    const payload = (await response.json()) as {
      ok: boolean;
      tool: { id: string; enabled: boolean };
    };

    expect(response.status).toBe(200);
    expect(payload.ok).toBe(true);
    expect(payload.tool).toEqual(expect.objectContaining({ id: 'browser', enabled: true }));
    expect(setToolEnabled).toHaveBeenCalledWith('browser', true);
  });

  it('updates OpenAI worker tool deactivation via PATCH', async () => {
    mockUserContext({ userId: 'legacy-local-user', authenticated: false });
    const setToolEnabled = vi.fn().mockResolvedValue({
      id: 'github',
      name: 'GitHub',
      enabled: false,
      description: 'Query repositories and issue metadata.',
      functionName: 'safe_github',
    });
    vi.doMock('../../../src/server/worker/openai/openaiToolRegistry', () => ({
      setOpenAiWorkerToolEnabled: setToolEnabled,
    }));

    const route = await import('../../../app/api/worker/openai/tools/route');
    const response = await route.PATCH(
      new Request('http://localhost/api/worker/openai/tools', {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ id: 'github', enabled: false }),
      }),
    );
    const payload = (await response.json()) as {
      ok: boolean;
      tool: { id: string; enabled: boolean };
    };

    expect(response.status).toBe(200);
    expect(payload.ok).toBe(true);
    expect(payload.tool).toEqual(expect.objectContaining({ id: 'github', enabled: false }));
    expect(setToolEnabled).toHaveBeenCalledWith('github', false);
  });
});
