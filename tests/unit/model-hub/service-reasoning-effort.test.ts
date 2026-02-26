import { describe, expect, it, vi } from 'vitest';
import type { ModelHubRepository } from '@/server/model-hub/repository';
import { encryptSecret } from '@/server/model-hub/crypto';

vi.mock('@/server/model-hub/gateway', () => ({
  dispatchGatewayRequest: vi.fn(async () => ({
    ok: true,
    text: 'ok',
    model: 'gpt-5.3-codex',
    provider: 'openai-codex',
  })),
}));

function createMockRepository(overrides: Partial<ModelHubRepository> = {}): ModelHubRepository {
  return {
    listPipelineModels: vi.fn().mockReturnValue([]),
    getAccountRecordById: vi.fn().mockReturnValue(null),
    updatePipelineModelStatus: vi.fn(),
    updatePipelineModelPriority: vi.fn(),
    listAccounts: vi.fn().mockReturnValue([]),
    createAccount: vi.fn(),
    deleteAccount: vi.fn(),
    updateAccountCredentials: vi.fn(),
    setHealthStatus: vi.fn(),
    addPipelineModel: vi.fn(),
    removePipelineModel: vi.fn(),
    replacePipeline: vi.fn(),
    ...overrides,
  };
}

describe('ModelHubService reasoning effort dispatch', () => {
  it('maps xhigh pipeline reasoning effort to high for provider request payload', async () => {
    const { dispatchGatewayRequest } = await import('@/server/model-hub/gateway');
    const dispatchMock = vi.mocked(dispatchGatewayRequest);
    const encryptionKey = '0123456789abcdef0123456789abcdef';

    const now = new Date().toISOString();
    const account = {
      id: 'a1',
      providerId: 'openai-codex',
      label: 'codex',
      authMethod: 'oauth' as const,
      secretMasked: '********',
      hasRefreshToken: false,
      createdAt: now,
      updatedAt: now,
      lastCheckAt: null,
      lastCheckOk: null,
      encryptedSecret: encryptSecret('access-token', encryptionKey),
      encryptedRefreshToken: null,
    };

    const repo = createMockRepository({
      listPipelineModels: vi.fn().mockReturnValue([
        {
          id: 'm1',
          profileId: 'p1',
          accountId: 'a1',
          providerId: 'openai-codex',
          modelName: 'gpt-5.3-codex',
          priority: 1,
          status: 'active',
          createdAt: now,
          updatedAt: now,
          reasoningEffort: 'xhigh',
        },
      ]),
      getAccountRecordById: vi.fn().mockReturnValue(account),
    });

    const { ModelHubService } = await import('@/server/model-hub/service');
    const service = new ModelHubService(repo);

    const result = await service.dispatchWithFallback('p1', encryptionKey, {
      messages: [{ role: 'user', content: 'hello' }],
    });

    expect(result.ok).toBe(true);
    expect(dispatchMock).toHaveBeenCalledTimes(1);
    const requestArg = dispatchMock.mock.calls[0]?.[2] as { reasoning_effort?: string };
    expect(requestArg.reasoning_effort).toBe('high');
  });
});
