import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ModelHubRepository } from '@/server/model-hub/repository';
import { encryptSecret } from '@/server/model-hub/crypto';
import type { MockProcedure } from '../../helpers/mockProcedure';

const dispatchMock = vi.fn<MockProcedure>();

beforeEach(() => {
  vi.resetModules();
  dispatchMock.mockReset();
  dispatchMock.mockImplementation(async () => ({
    ok: true,
    text: 'ok',
    model: 'gpt-5.3-codex',
    provider: 'openai-codex',
  }));

  vi.doMock('@/server/model-hub/gateway', () => ({
    dispatchGatewayRequest: dispatchMock,
  }));
});

function createMockRepository(overrides: Partial<ModelHubRepository> = {}): ModelHubRepository {
  return {
    listPipelineModels: vi.fn<MockProcedure>().mockReturnValue([]),
    getAccountRecordById: vi.fn<MockProcedure>().mockReturnValue(null),
    updatePipelineModelStatus: vi.fn<MockProcedure>(),
    updatePipelineModelPriority: vi.fn<MockProcedure>(),
    listAccounts: vi.fn<MockProcedure>().mockReturnValue([]),
    createAccount: vi.fn<MockProcedure>(),
    deleteAccount: vi.fn<MockProcedure>(),
    updateAccountCredentials: vi.fn<MockProcedure>(),
    setHealthStatus: vi.fn<MockProcedure>(),
    addPipelineModel: vi.fn<MockProcedure>(),
    removePipelineModel: vi.fn<MockProcedure>(),
    replacePipeline: vi.fn<MockProcedure>(),
    ...overrides,
  };
}

describe('ModelHubService reasoning effort dispatch', () => {
  it('maps xhigh pipeline reasoning effort to high for provider request payload', async () => {
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
      listPipelineModels: vi.fn<MockProcedure>().mockReturnValue([
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
      getAccountRecordById: vi.fn<MockProcedure>().mockReturnValue(account),
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
