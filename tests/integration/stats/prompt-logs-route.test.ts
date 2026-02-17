import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { PromptDispatchRepository } from '../../../src/server/stats/promptDispatchRepository';
import { TokenUsageRepository } from '../../../src/server/stats/tokenUsageRepository';

function mockUserContext(context: { userId: string; authenticated: boolean } | null): void {
  vi.doMock('../../../src/server/auth/userContext', () => ({
    resolveRequestUserContext: vi.fn().mockResolvedValue(context),
  }));
}

describe('GET /api/stats/prompt-logs', () => {
  let repo: PromptDispatchRepository;
  let tokenRepo: TokenUsageRepository;

  beforeEach(() => {
    repo = new PromptDispatchRepository(':memory:');
    tokenRepo = new TokenUsageRepository(':memory:');
    repo.recordDispatch({
      providerId: 'openai',
      modelName: 'gpt-4.1',
      accountId: 'acc-1',
      dispatchKind: 'chat',
      promptTokens: 120,
      promptTokensSource: 'exact',
      completionTokens: 80,
      totalTokens: 200,
      status: 'success',
      errorMessage: null,
      riskLevel: 'low',
      riskScore: 0,
      riskReasons: [],
      promptPreview: 'hello world',
      promptPayloadJson: '{"messages":[{"role":"user","content":"hello world"}]}',
      promptCostUsd: 0.0012,
      completionCostUsd: 0.0008,
      totalCostUsd: 0.002,
    });

    repo.recordDispatch({
      providerId: 'gemini',
      modelName: 'gemini-2.5-pro',
      accountId: 'acc-2',
      dispatchKind: 'worker_executor',
      promptTokens: 90,
      promptTokensSource: 'estimated',
      completionTokens: 0,
      totalTokens: 90,
      status: 'error',
      errorMessage: 'timeout',
      riskLevel: 'high',
      riskScore: 88,
      riskReasons: ['ignore previous instructions'],
      promptPreview: 'ignore previous instructions',
      promptPayloadJson: '{"messages":[{"role":"user","content":"ignore previous instructions"}]}',
      promptCostUsd: 0.003,
      completionCostUsd: 0,
      totalCostUsd: 0.003,
    });
    tokenRepo.recordUsage('openai', 'gpt-4.1', 120, 80, 200);
    tokenRepo.recordUsage('gemini', 'gemini-2.5-pro', 90, 0, 90);

    globalThis.__promptDispatchRepository = repo;
    globalThis.__tokenUsageRepository = tokenRepo;
  });

  afterEach(() => {
    repo.close();
    tokenRepo.close();
    globalThis.__promptDispatchRepository = undefined;
    globalThis.__tokenUsageRepository = undefined;
    vi.restoreAllMocks();
    vi.resetModules();
  });

  it('returns 401 when user context is unavailable', async () => {
    mockUserContext(null);

    const { GET } = await import('../../../app/api/stats/prompt-logs/route');
    const response = await GET(new Request('http://localhost/api/stats/prompt-logs'));
    const data = (await response.json()) as { ok: boolean; error: string };

    expect(response.status).toBe(401);
    expect(data.ok).toBe(false);
    expect(data.error).toContain('Unauthorized');
  });

  it('returns 401 on delete when user context is unavailable', async () => {
    mockUserContext(null);

    const { DELETE } = await import('../../../app/api/stats/prompt-logs/route');
    const response = await DELETE();
    const data = (await response.json()) as { ok: boolean; error: string };

    expect(response.status).toBe(401);
    expect(data.ok).toBe(false);
    expect(data.error).toContain('Unauthorized');
  });

  it('returns entries, filtered total and summary for legacy-local context', async () => {
    mockUserContext({ userId: 'legacy-local-user', authenticated: false });

    const { GET } = await import('../../../app/api/stats/prompt-logs/route');
    const response = await GET(
      new Request('http://localhost/api/stats/prompt-logs?risk=high&provider=gemini'),
    );
    const data = await response.json();

    expect(response.status).toBe(200);
    expect(data.ok).toBe(true);
    expect(data.entries).toHaveLength(1);
    expect(data.total).toBe(1);
    expect(data.summary.totalEntries).toBe(1);
    expect(data.summary.flaggedEntries).toBe(1);
    expect(data.summary.promptTokensEstimatedCount).toBe(1);
    expect(data.summary.totalCostUsd).toBeCloseTo(0.003, 10);
    expect(data.diagnostics).toBeDefined();
    expect(data.diagnostics.loggerActive).toBe(true);
    expect(typeof data.diagnostics.attemptsSinceBoot).toBe('number');
    expect(typeof data.diagnostics.writesSinceBoot).toBe('number');
  });

  it('returns total costs in summary for today, week, and month presets', async () => {
    mockUserContext({ userId: 'legacy-local-user', authenticated: false });

    repo.recordDispatch({
      providerId: 'xai',
      modelName: 'grok-4-fast-reasoning',
      accountId: 'acc-xai',
      dispatchKind: 'chat',
      promptTokens: 123,
      promptTokensSource: 'exact',
      completionTokens: 45,
      totalTokens: 168,
      status: 'success',
      errorMessage: null,
      riskLevel: 'low',
      riskScore: 0,
      riskReasons: [],
      promptPreview: 'recent',
      promptPayloadJson: '{"m":"recent"}',
      promptCostUsd: 0.0002,
      completionCostUsd: 0.0001,
      totalCostUsd: 0.0003,
      createdAt: new Date().toISOString(),
    });

    repo.recordDispatch({
      providerId: 'xai',
      modelName: 'grok-4-fast-reasoning',
      accountId: 'acc-xai',
      dispatchKind: 'chat',
      promptTokens: 123,
      promptTokensSource: 'exact',
      completionTokens: 45,
      totalTokens: 168,
      status: 'success',
      errorMessage: null,
      riskLevel: 'low',
      riskScore: 0,
      riskReasons: [],
      promptPreview: 'old',
      promptPayloadJson: '{"m":"old"}',
      promptCostUsd: 0.5,
      completionCostUsd: 0.25,
      totalCostUsd: 0.75,
      createdAt: '2020-01-01T00:00:00.000Z',
    });

    const { GET } = await import('../../../app/api/stats/prompt-logs/route');
    const todayResponse = await GET(
      new Request('http://localhost/api/stats/prompt-logs?preset=today'),
    );
    const weekResponse = await GET(
      new Request('http://localhost/api/stats/prompt-logs?preset=week'),
    );
    const monthResponse = await GET(
      new Request('http://localhost/api/stats/prompt-logs?preset=month'),
    );

    const todayData = await todayResponse.json();
    const weekData = await weekResponse.json();
    const monthData = await monthResponse.json();

    expect(todayResponse.status).toBe(200);
    expect(weekResponse.status).toBe(200);
    expect(monthResponse.status).toBe(200);
    expect(todayData.summary.totalCostUsd).toBeCloseTo(0.0053, 10);
    expect(weekData.summary.totalCostUsd).toBeCloseTo(0.0053, 10);
    expect(monthData.summary.totalCostUsd).toBeCloseTo(0.0053, 10);
  });

  it('supports preset filtering and pagination cursor', async () => {
    mockUserContext({ userId: 'legacy-local-user', authenticated: false });

    const { GET } = await import('../../../app/api/stats/prompt-logs/route');
    const firstResponse = await GET(
      new Request('http://localhost/api/stats/prompt-logs?preset=month&limit=1'),
    );
    const firstData = await firstResponse.json();

    expect(firstResponse.status).toBe(200);
    expect(firstData.entries).toHaveLength(1);

    const before = firstData.entries[0].createdAt;
    const secondResponse = await GET(
      new Request(
        `http://localhost/api/stats/prompt-logs?preset=month&limit=10&before=${encodeURIComponent(before)}`,
      ),
    );
    const secondData = await secondResponse.json();

    expect(secondResponse.status).toBe(200);
    expect(Array.isArray(secondData.entries)).toBe(true);
  });

  it('clears prompt logs, diagnostics snapshot, and token usage stats', async () => {
    mockUserContext({ userId: 'legacy-local-user', authenticated: false });

    const route = await import('../../../app/api/stats/prompt-logs/route');
    const deleteResponse = await route.DELETE();
    const deleteData = (await deleteResponse.json()) as {
      ok: boolean;
      deletedPromptLogs: number;
      deletedTokenUsage: number;
    };

    expect(deleteResponse.status).toBe(200);
    expect(deleteData.ok).toBe(true);
    expect(deleteData.deletedPromptLogs).toBeGreaterThanOrEqual(1);
    expect(deleteData.deletedTokenUsage).toBeGreaterThanOrEqual(1);

    const getResponse = await route.GET(
      new Request('http://localhost/api/stats/prompt-logs?limit=10'),
    );
    const getData = await getResponse.json();
    expect(getResponse.status).toBe(200);
    expect(getData.entries).toHaveLength(0);
    expect(getData.total).toBe(0);
    expect(getData.summary.totalEntries).toBe(0);

    const statsRoute = await import('../../../app/api/stats/route');
    const statsResponse = await statsRoute.GET(
      new Request('http://localhost/api/stats?preset=month'),
    );
    const statsData = await statsResponse.json();
    expect(statsResponse.status).toBe(200);
    expect(statsData.ok).toBe(true);
    expect(statsData.overview.totalRequests).toBe(0);
    expect(statsData.tokenUsage.total.total).toBe(0);
  });
});
