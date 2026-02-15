import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type MockUserContext = { userId: string; authenticated: boolean } | null;

function mockUserContext(context: MockUserContext): void {
  vi.doMock('../../../src/server/auth/userContext', () => ({
    resolveRequestUserContext: vi.fn().mockResolvedValue(context),
  }));
}

describe('privileged route auth enforcement', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.resetModules();
  });

  it('returns 401 for privileged routes when user context is unavailable', async () => {
    mockUserContext(null);

    const gatewayRoute = await import('../../../app/api/model-hub/gateway/route');
    const gatewayRes = await gatewayRoute.POST(
      new Request('http://localhost/api/model-hub/gateway', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          profileId: 'p1',
          messages: [{ role: 'user', content: 'hello' }],
        }),
      }),
    );
    expect(gatewayRes.status).toBe(401);

    const accountsRoute = await import('../../../app/api/model-hub/accounts/route');
    const accountsRes = await accountsRoute.GET();
    expect(accountsRes.status).toBe(401);

    const providersRoute = await import('../../../app/api/model-hub/providers/route');
    const providersRes = await providersRoute.GET();
    expect(providersRes.status).toBe(401);

    const accountByIdRoute = await import('../../../app/api/model-hub/accounts/[accountId]/route');
    const accountByIdRes = await accountByIdRoute.DELETE(
      new Request('http://localhost/api/model-hub/accounts/a1', { method: 'DELETE' }),
      { params: Promise.resolve({ accountId: 'a1' }) },
    );
    expect(accountByIdRes.status).toBe(401);

    const accountModelsRoute =
      await import('../../../app/api/model-hub/accounts/[accountId]/models/route');
    const accountModelsRes = await accountModelsRoute.GET(
      new Request('http://localhost/api/model-hub/accounts/a1/models'),
      { params: Promise.resolve({ accountId: 'a1' }) },
    );
    expect(accountModelsRes.status).toBe(401);

    const accountTestRoute =
      await import('../../../app/api/model-hub/accounts/[accountId]/test/route');
    const accountTestRes = await accountTestRoute.POST(
      new Request('http://localhost/api/model-hub/accounts/a1/test', { method: 'POST' }),
      { params: Promise.resolve({ accountId: 'a1' }) },
    );
    expect(accountTestRes.status).toBe(401);

    const testAllRoute = await import('../../../app/api/model-hub/accounts/test-all/route');
    const testAllRes = await testAllRoute.POST(
      new Request('http://localhost/api/model-hub/accounts/test-all', { method: 'POST' }),
    );
    expect(testAllRes.status).toBe(401);

    const pipelineRoute = await import('../../../app/api/model-hub/pipeline/route');
    const pipelineRes = await pipelineRoute.GET(
      new Request('http://localhost/api/model-hub/pipeline?profileId=p1'),
    );
    expect(pipelineRes.status).toBe(401);

    const oauthStartRoute = await import('../../../app/api/model-hub/oauth/start/route');
    const oauthStartRes = await oauthStartRoute.GET(
      new Request(
        'http://localhost/api/model-hub/oauth/start?providerId=openrouter&label=OpenRouter',
      ),
    );
    expect(oauthStartRes.status).toBe(401);

    const oauthCallbackRoute = await import('../../../app/api/model-hub/oauth/callback/route');
    const oauthCallbackRes = await oauthCallbackRoute.GET(
      new Request('http://localhost/api/model-hub/oauth/callback?code=abc&state=invalid'),
    );
    expect(oauthCallbackRes.status).toBe(401);

    const skillsRoute = await import('../../../app/api/skills/route');
    const skillsRes = await skillsRoute.GET();
    expect(skillsRes.status).toBe(401);

    const skillsExecRoute = await import('../../../app/api/skills/execute/route');
    const skillsExecRes = await skillsExecRoute.POST(
      new Request('http://localhost/api/skills/execute', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'list_files', args: {} }),
      }),
    );
    expect(skillsExecRes.status).toBe(401);

    const skillByIdRoute = await import('../../../app/api/skills/[id]/route');
    const skillByIdRes = await skillByIdRoute.PATCH(
      new Request('http://localhost/api/skills/s1', {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ installed: true }),
      }),
      { params: Promise.resolve({ id: 's1' }) },
    );
    expect(skillByIdRes.status).toBe(401);
  });

  it('keeps legacy-local behavior when context resolves successfully', async () => {
    mockUserContext({ userId: 'legacy-local-user', authenticated: false });

    const pipelineRoute = await import('../../../app/api/model-hub/pipeline/route');
    const pipelineRes = await pipelineRoute.GET(
      new Request('http://localhost/api/model-hub/pipeline?profileId=p1'),
    );

    expect(pipelineRes.status).toBe(200);
    const payload = (await pipelineRes.json()) as { ok: boolean };
    expect(payload.ok).toBe(true);
  });
});
