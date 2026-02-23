import { afterEach, describe, expect, it, vi } from 'vitest';

import type {
  ModelHubRepository,
  PipelineModelEntry,
  ProviderAccountRecord,
  ProviderAccountView,
} from '@/server/model-hub/repository';

function buildAccountRecord(
  providerId: string,
  authMethod: 'none' | 'api_key' | 'oauth' = 'api_key',
): ProviderAccountRecord {
  const now = new Date().toISOString();
  return {
    id: `acc-${providerId}`,
    providerId,
    label: providerId,
    authMethod,
    secretMasked: '****',
    hasRefreshToken: authMethod === 'oauth',
    createdAt: now,
    updatedAt: now,
    lastCheckAt: null,
    lastCheckOk: null,
    encryptedSecret: {
      alg: 'aes-256-gcm',
      keyId: 'default',
      iv: 'iv',
      ciphertext: 'cipher',
      tag: 'tag',
    },
    encryptedRefreshToken:
      authMethod === 'oauth'
        ? {
            alg: 'aes-256-gcm',
            keyId: 'default',
            iv: 'iv-r',
            ciphertext: 'cipher-r',
            tag: 'tag-r',
          }
        : null,
  };
}

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

async function setupService(options?: {
  repository?: ModelHubRepository;
  decryptSecretImpl?: (...args: unknown[]) => string;
  isJwtExpiringSoon?: boolean;
  refreshResult?: { accessToken: string; refreshToken: string };
  refreshThrows?: boolean;
  dispatchResult?: { ok: boolean; text: string; model: string; provider: string; error?: string };
  fetchModelsResult?: Array<{ id: string; name: string; provider: string }>;
}) {
  vi.resetModules();

  const encryptSecret = vi.fn((value: string) => ({
    alg: 'aes-256-gcm',
    keyId: 'default',
    iv: `iv-${value}`,
    ciphertext: `cipher-${value}`,
    tag: `tag-${value}`,
  }));
  const maskSecret = vi.fn((value: string) => `****${value.slice(-2)}`);
  const decryptSecret = vi.fn(
    options?.decryptSecretImpl ??
      (() => {
        return 'token';
      }),
  );
  const dispatchGatewayRequest = vi.fn(async () => {
    return (
      options?.dispatchResult ?? {
        ok: true,
        text: 'ok',
        model: 'm',
        provider: 'p',
      }
    );
  });
  const fetchModelsForAccount = vi.fn(async () => options?.fetchModelsResult ?? []);
  const isJwtExpiringSoon = vi.fn(() => options?.isJwtExpiringSoon ?? false);
  const refreshOpenAICodexToken = options?.refreshThrows
    ? vi.fn(async () => {
        throw new Error('refresh failed');
      })
    : vi.fn(
        async () =>
          options?.refreshResult ?? { accessToken: 'new-access', refreshToken: 'new-refresh' },
      );

  vi.doMock('../../../src/server/model-hub/crypto', () => ({
    encryptSecret,
    decryptSecret,
    maskSecret,
  }));
  vi.doMock('../../../src/server/model-hub/gateway', () => ({
    dispatchGatewayRequest,
  }));
  vi.doMock('../../../src/server/model-hub/modelFetcher', () => ({
    fetchModelsForAccount,
  }));
  vi.doMock('../../../src/server/model-hub/codexAuth', () => ({
    isJwtExpiringSoon,
    refreshOpenAICodexToken,
  }));

  const { ModelHubService } = await import('@/server/model-hub/service');
  const repository = options?.repository ?? createMockRepository();
  return {
    service: new ModelHubService(repository),
    repository,
    encryptSecret,
    decryptSecret,
    maskSecret,
    dispatchGatewayRequest,
    fetchModelsForAccount,
    isJwtExpiringSoon,
    refreshOpenAICodexToken,
  };
}

describe('ModelHubService core flows', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.resetModules();
  });

  it('connects account by encrypting secret and optional refresh token', async () => {
    const now = new Date().toISOString();
    const accountView: ProviderAccountView = {
      id: 'acc-openrouter',
      providerId: 'openrouter',
      label: 'OpenRouter',
      authMethod: 'oauth',
      secretMasked: '****',
      hasRefreshToken: true,
      createdAt: now,
      updatedAt: now,
      lastCheckAt: null,
      lastCheckOk: null,
    };
    const repository = createMockRepository({
      createAccount: vi.fn(() => accountView),
    });
    const { service, encryptSecret, maskSecret } = await setupService({ repository });

    const result = service.connectAccount({
      providerId: 'openrouter',
      label: 'OpenRouter',
      authMethod: 'oauth',
      secret: 'secret-value',
      refreshToken: 'refresh-value',
      encryptionKey: 'enc-key',
    });

    expect(result).toBe(accountView);
    expect(encryptSecret).toHaveBeenCalledWith('secret-value', 'enc-key');
    expect(encryptSecret).toHaveBeenCalledWith('refresh-value', 'enc-key');
    expect(maskSecret).toHaveBeenCalledWith('secret-value');
    expect(repository.createAccount).toHaveBeenCalledTimes(1);
  });

  it('forwards list/get/update/delete account wrappers to repository', async () => {
    const account = buildAccountRecord('openai');
    const repository = createMockRepository({
      listAccounts: vi.fn(() => [account]),
      getAccountRecordById: vi.fn(() => account),
      deleteAccount: vi.fn(() => true),
    });
    const { service } = await setupService({ repository });

    expect(service.listAccounts()).toEqual([account]);
    expect(service.getAccountById(account.id)).toBe(account);
    service.updateHealth(account.id, true, 'ok');
    expect(repository.setHealthStatus).toHaveBeenCalledWith(account.id, true, 'ok');
    expect(service.deleteAccount(account.id)).toBe(true);
  });

  it('refreshes openai-codex oauth tokens when jwt is expiring soon', async () => {
    const initial = buildAccountRecord('openai-codex', 'oauth');
    const refreshed = { ...initial, secretMasked: '****99' };
    const getAccountRecordById = vi
      .fn()
      .mockReturnValueOnce(initial)
      .mockReturnValueOnce(refreshed);
    const repository = createMockRepository({
      getAccountRecordById,
    });
    const decryptValues = ['access-token', 'refresh-token'];
    const { service, decryptSecret, refreshOpenAICodexToken } = await setupService({
      repository,
      decryptSecretImpl: () => decryptValues.shift() || '',
      isJwtExpiringSoon: true,
      refreshResult: {
        accessToken: 'new-access-token',
        refreshToken: 'new-refresh-token',
      },
    });

    const result = await service.getUsableAccountById(initial.id, 'enc-key');

    expect(result).toBe(refreshed);
    expect(decryptSecret).toHaveBeenCalledTimes(2);
    expect(refreshOpenAICodexToken).toHaveBeenCalledWith('refresh-token');
    expect(repository.updateAccountCredentials).toHaveBeenCalledTimes(1);
  });

  it('keeps original account when codex token refresh fails', async () => {
    const initial = buildAccountRecord('openai-codex', 'oauth');
    const repository = createMockRepository({
      getAccountRecordById: vi.fn(() => initial),
    });
    const { service } = await setupService({
      repository,
      decryptSecretImpl: () => 'token',
      isJwtExpiringSoon: true,
      refreshThrows: true,
    });

    const result = await service.getUsableAccountById(initial.id, 'enc-key');

    expect(result).toBe(initial);
    expect(repository.updateAccountCredentials).not.toHaveBeenCalled();
  });

  it('dispatchChat returns account-not-found error when account is unavailable', async () => {
    const repository = createMockRepository({
      getAccountRecordById: vi.fn(() => null),
    });
    const { service } = await setupService({ repository });

    const result = await service.dispatchChat('missing', 'enc-key', {
      model: 'gpt-4.1',
      messages: [{ role: 'user', content: 'hello' }],
    });

    expect(result.ok).toBe(false);
    expect(result.error).toContain('Account missing not found.');
  });

  it('dispatchChat delegates to gateway dispatch for usable accounts', async () => {
    const account = buildAccountRecord('openai');
    const repository = createMockRepository({
      getAccountRecordById: vi.fn(() => account),
    });
    const { service, dispatchGatewayRequest } = await setupService({
      repository,
      dispatchResult: {
        ok: true,
        text: 'answer',
        model: 'gpt-4.1',
        provider: 'openai',
      },
    });

    const request = {
      model: 'gpt-4.1',
      messages: [{ role: 'user' as const, content: 'hello' }],
    };
    const result = await service.dispatchChat(account.id, 'enc-key', request);

    expect(dispatchGatewayRequest).toHaveBeenCalledWith(account, 'enc-key', request);
    expect(result).toEqual({
      ok: true,
      text: 'answer',
      model: 'gpt-4.1',
      provider: 'openai',
    });
  });

  it('fetchModelsForAccount delegates to modelFetcher for usable accounts', async () => {
    const account = buildAccountRecord('openai');
    const repository = createMockRepository({
      getAccountRecordById: vi.fn(() => account),
    });
    const { service, fetchModelsForAccount } = await setupService({
      repository,
      fetchModelsResult: [{ id: 'gpt-4.1', name: 'gpt-4.1', provider: 'openai' }],
    });

    const result = await service.fetchModelsForAccount(account.id, 'enc-key');

    expect(fetchModelsForAccount).toHaveBeenCalledWith(account, 'enc-key', {
      purpose: 'general',
    });
    expect(result).toEqual([{ id: 'gpt-4.1', name: 'gpt-4.1', provider: 'openai' }]);
  });

  it('dispatchWithFallback returns override-not-found error when preferred model is absent', async () => {
    const now = new Date().toISOString();
    const pipeline: PipelineModelEntry[] = [
      {
        id: 'p1',
        profileId: 'profile-1',
        accountId: 'acc-openai',
        providerId: 'openai',
        modelName: 'gpt-4.1',
        priority: 1,
        status: 'active',
        createdAt: now,
        updatedAt: now,
      },
    ];
    const repository = createMockRepository({
      listPipelineModels: vi.fn(() => pipeline),
    });
    const { service } = await setupService({ repository });

    const result = await service.dispatchWithFallback(
      'profile-1',
      'enc-key',
      { messages: [{ role: 'user', content: 'hello' }] },
      { modelOverride: 'missing-model' },
    );

    expect(result.ok).toBe(false);
    expect(result.error).toContain('not found in active pipeline');
  });

  it('returns Aborted before dispatching fallback models when signal is already aborted', async () => {
    const now = new Date().toISOString();
    const pipeline: PipelineModelEntry[] = [
      {
        id: 'p1',
        profileId: 'profile-1',
        accountId: 'acc-openai',
        providerId: 'openai',
        modelName: 'gpt-4.1',
        priority: 1,
        status: 'active',
        createdAt: now,
        updatedAt: now,
      },
    ];
    const repository = createMockRepository({
      listPipelineModels: vi.fn(() => pipeline),
    });
    const { service, dispatchGatewayRequest } = await setupService({ repository });
    const controller = new AbortController();
    controller.abort();

    const result = await service.dispatchWithFallback(
      'profile-1',
      'enc-key',
      { messages: [{ role: 'user', content: 'hello' }] },
      { signal: controller.signal },
    );

    expect(result).toEqual({ ok: false, text: '', model: '', provider: '', error: 'Aborted' });
    expect(dispatchGatewayRequest).not.toHaveBeenCalled();
  });

  it('marks models as rate-limited when preferred or fallback dispatch returns rate errors', async () => {
    const now = new Date().toISOString();
    const preferred = {
      id: 'p1',
      profileId: 'profile-1',
      accountId: 'acc-openai',
      providerId: 'openai',
      modelName: 'gpt-4.1',
      priority: 1,
      status: 'active' as const,
      createdAt: now,
      updatedAt: now,
    };
    const fallback = {
      id: 'p2',
      profileId: 'profile-1',
      accountId: 'acc-openai',
      providerId: 'openai',
      modelName: 'gpt-4.1-mini',
      priority: 2,
      status: 'active' as const,
      createdAt: now,
      updatedAt: now,
    };
    const account = buildAccountRecord('openai');
    const repository = createMockRepository({
      listPipelineModels: vi.fn(() => [preferred, fallback]),
      getAccountRecordById: vi.fn(() => account),
    });
    const dispatchGatewayRequest = vi
      .fn()
      .mockResolvedValueOnce({
        ok: false,
        text: '',
        model: preferred.modelName,
        provider: preferred.providerId,
        error: '429 Too Many Requests',
      })
      .mockResolvedValueOnce({
        ok: false,
        text: '',
        model: fallback.modelName,
        provider: fallback.providerId,
        error: 'rate limit exceeded',
      });

    vi.resetModules();
    vi.doMock('../../../src/server/model-hub/crypto', () => ({
      encryptSecret: vi.fn((value: string) => ({
        alg: 'aes-256-gcm',
        keyId: 'default',
        iv: `iv-${value}`,
        ciphertext: `cipher-${value}`,
        tag: `tag-${value}`,
      })),
      decryptSecret: vi.fn(() => 'token'),
      maskSecret: vi.fn(() => '****'),
    }));
    vi.doMock('../../../src/server/model-hub/gateway', () => ({
      dispatchGatewayRequest,
    }));
    vi.doMock('../../../src/server/model-hub/modelFetcher', () => ({
      fetchModelsForAccount: vi.fn(async () => []),
    }));
    vi.doMock('../../../src/server/model-hub/codexAuth', () => ({
      isJwtExpiringSoon: vi.fn(() => false),
      refreshOpenAICodexToken: vi.fn(),
    }));
    const { ModelHubService } = await import('@/server/model-hub/service');
    const service = new ModelHubService(repository);

    const result = await service.dispatchWithFallback(
      'profile-1',
      'enc-key',
      { messages: [{ role: 'user', content: 'hello' }] },
      { modelOverride: preferred.modelName },
    );

    expect(result.ok).toBe(false);
    expect(repository.updatePipelineModelStatus).toHaveBeenCalledWith(preferred.id, 'rate-limited');
    expect(repository.updatePipelineModelStatus).toHaveBeenCalledWith(fallback.id, 'rate-limited');
    expect(result.error).toContain('All models failed');
  });
});
