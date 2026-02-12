import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  PromptDispatchRepository,
  type PromptDispatchRiskLevel,
} from '../../../src/server/stats/promptDispatchRepository';

describe('PromptDispatchRepository', () => {
  let repo: PromptDispatchRepository;

  beforeEach(() => {
    repo = new PromptDispatchRepository(':memory:');
  });

  afterEach(() => {
    repo.close();
    delete process.env.PROMPT_LOG_RETENTION_DAYS;
    delete process.env.PROMPT_LOG_MAX_ENTRIES;
  });

  it('records and lists prompt dispatch entries with filters', () => {
    repo.recordDispatch({
      providerId: 'openai',
      modelName: 'gpt-4.1',
      accountId: 'acc-openai',
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
      promptCostUsd: 0.00012,
      completionCostUsd: 0.00008,
      totalCostUsd: 0.0002,
    });

    repo.recordDispatch({
      providerId: 'gemini',
      modelName: 'gemini-2.5-pro',
      accountId: 'acc-gemini',
      dispatchKind: 'worker_executor',
      promptTokens: 90,
      promptTokensSource: 'estimated',
      completionTokens: 0,
      totalTokens: 90,
      status: 'error',
      errorMessage: 'rate limit',
      riskLevel: 'high',
      riskScore: 85,
      riskReasons: ['ignore previous instructions'],
      promptPreview: 'ignore previous instructions',
      promptPayloadJson: '{"messages":[{"role":"user","content":"ignore previous instructions"}]}'
    });

    const all = repo.listDispatches({});
    expect(all).toHaveLength(2);

    const byProvider = repo.listDispatches({ provider: 'openai' });
    expect(byProvider).toHaveLength(1);
    expect(byProvider[0].modelName).toBe('gpt-4.1');
    expect(byProvider[0].promptCostUsd).toBe(0.00012);
    expect(byProvider[0].totalCostUsd).toBe(0.0002);

    const byRisk = repo.listDispatches({ risk: 'high' });
    expect(byRisk).toHaveLength(1);
    expect(byRisk[0].status).toBe('error');
  });

  it('supports cursor pagination via before timestamp', () => {
    const first = repo.recordDispatch({
      providerId: 'openai',
      modelName: 'gpt-4.1',
      accountId: 'acc-1',
      dispatchKind: 'chat',
      promptTokens: 10,
      promptTokensSource: 'exact',
      completionTokens: 5,
      totalTokens: 15,
      status: 'success',
      errorMessage: null,
      riskLevel: 'low',
      riskScore: 0,
      riskReasons: [],
      promptPreview: 'first',
      promptPayloadJson: '{"m":"first"}',
    });

    repo.recordDispatch({
      providerId: 'openai',
      modelName: 'gpt-4.1',
      accountId: 'acc-1',
      dispatchKind: 'chat',
      promptTokens: 11,
      promptTokensSource: 'exact',
      completionTokens: 5,
      totalTokens: 16,
      status: 'success',
      errorMessage: null,
      riskLevel: 'low',
      riskScore: 0,
      riskReasons: [],
      promptPreview: 'second',
      promptPayloadJson: '{"m":"second"}',
    });

    const page = repo.listDispatches({ before: first.createdAt });
    expect(page).toHaveLength(0);
  });

  it('returns aggregate summary', () => {
    repo.recordDispatch({
      providerId: 'openai',
      modelName: 'gpt-4.1',
      accountId: 'acc-openai',
      dispatchKind: 'chat',
      promptTokens: 100,
      promptTokensSource: 'exact',
      completionTokens: 50,
      totalTokens: 150,
      status: 'success',
      errorMessage: null,
      riskLevel: 'medium',
      riskScore: 40,
      riskReasons: ['reveal system prompt'],
      promptPreview: 'reveal system prompt',
      promptPayloadJson: '{"m":"x"}',
    });

    repo.recordDispatch({
      providerId: 'gemini',
      modelName: 'gemini-2.5-pro',
      accountId: 'acc-gemini',
      dispatchKind: 'summary',
      promptTokens: 90,
      promptTokensSource: 'estimated',
      completionTokens: 0,
      totalTokens: 90,
      status: 'error',
      errorMessage: 'timeout',
      riskLevel: 'low',
      riskScore: 0,
      riskReasons: [],
      promptPreview: 'summary',
      promptPayloadJson: '{"m":"y"}',
    });

    const summary = repo.getSummary({});
    expect(summary.totalEntries).toBe(2);
    expect(summary.flaggedEntries).toBe(1);
    expect(summary.promptTokensTotal).toBe(190);
    expect(summary.promptTokensExactCount).toBe(1);
    expect(summary.promptTokensEstimatedCount).toBe(1);
  });

  it('prunes entries by retention age and max entry cap', () => {
    process.env.PROMPT_LOG_RETENTION_DAYS = '30';
    process.env.PROMPT_LOG_MAX_ENTRIES = '2';

    repo.recordDispatch({
      providerId: 'openai',
      modelName: 'gpt-4.1',
      accountId: 'acc-1',
      dispatchKind: 'chat',
      promptTokens: 10,
      promptTokensSource: 'exact',
      completionTokens: 0,
      totalTokens: 10,
      status: 'success',
      errorMessage: null,
      riskLevel: 'low',
      riskScore: 0,
      riskReasons: [],
      promptPreview: 'old',
      promptPayloadJson: '{"m":"old"}',
      createdAt: '2020-01-01T00:00:00.000Z',
    });

    repo.recordDispatch({
      providerId: 'openai',
      modelName: 'gpt-4.1',
      accountId: 'acc-1',
      dispatchKind: 'chat',
      promptTokens: 11,
      promptTokensSource: 'exact',
      completionTokens: 0,
      totalTokens: 11,
      status: 'success',
      errorMessage: null,
      riskLevel: 'low',
      riskScore: 0,
      riskReasons: [],
      promptPreview: 'new-1',
      promptPayloadJson: '{"m":"new-1"}',
    });

    repo.recordDispatch({
      providerId: 'openai',
      modelName: 'gpt-4.1',
      accountId: 'acc-1',
      dispatchKind: 'chat',
      promptTokens: 12,
      promptTokensSource: 'exact',
      completionTokens: 0,
      totalTokens: 12,
      status: 'success',
      errorMessage: null,
      riskLevel: 'low',
      riskScore: 0,
      riskReasons: [],
      promptPreview: 'new-2',
      promptPayloadJson: '{"m":"new-2"}',
    });

    repo.recordDispatch({
      providerId: 'openai',
      modelName: 'gpt-4.1',
      accountId: 'acc-1',
      dispatchKind: 'chat',
      promptTokens: 13,
      promptTokensSource: 'exact',
      completionTokens: 0,
      totalTokens: 13,
      status: 'success',
      errorMessage: null,
      riskLevel: 'low',
      riskScore: 0,
      riskReasons: [],
      promptPreview: 'new-3',
      promptPayloadJson: '{"m":"new-3"}',
    });

    repo.pruneOldEntries();

    const entries = repo.listDispatches({});
    expect(entries).toHaveLength(2);
    expect(entries.some((entry) => entry.promptPreview === 'old')).toBe(false);
  });

  it('counts by filter', () => {
    const risks: PromptDispatchRiskLevel[] = ['low', 'medium', 'high'];
    for (const risk of risks) {
      repo.recordDispatch({
        providerId: 'openai',
        modelName: `gpt-${risk}`,
        accountId: 'acc-1',
        dispatchKind: 'chat',
        promptTokens: 1,
        promptTokensSource: 'exact',
        completionTokens: 0,
        totalTokens: 1,
        status: 'success',
        errorMessage: null,
        riskLevel: risk,
        riskScore: risk === 'low' ? 0 : 50,
        riskReasons: [],
        promptPreview: risk,
        promptPayloadJson: '{}',
      });
    }

    expect(repo.countDispatches({})).toBe(3);
    expect(repo.countDispatches({ risk: 'high' })).toBe(1);
  });
});
