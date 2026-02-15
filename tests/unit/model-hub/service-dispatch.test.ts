import { describe, expect, it, vi } from 'vitest';
import type { ModelHubRepository } from '../../../src/server/model-hub/repository';

/**
 * Tests for the ModelHub service dispatchWithFallback method.
 *
 * We create a minimal mock of the ModelHubRepository and validate
 * the pipeline fallback logic.
 */

function createMockRepository(overrides: Partial<ModelHubRepository> = {}): ModelHubRepository {
  return {
    listPipelineModels: vi.fn().mockReturnValue([]),
    getAccountRecordById: vi.fn().mockReturnValue(null),
    updatePipelineModelStatus: vi.fn(),
    updatePipelineModelPriority: vi.fn(),
    listAccounts: vi.fn().mockReturnValue([]),
    createAccount: vi.fn(),
    deleteAccount: vi.fn(),
    setHealthStatus: vi.fn(),
    addPipelineModel: vi.fn(),
    removePipelineModel: vi.fn(),
    replacePipeline: vi.fn(),
    ...overrides,
  };
}

describe('ModelHubService.dispatchWithFallback', () => {
  it('returns error when no active models in pipeline', async () => {
    const { ModelHubService } = await import('../../../src/server/model-hub/service');

    const repo = createMockRepository({
      listPipelineModels: vi.fn().mockReturnValue([]),
    });

    const service = new ModelHubService(repo);
    const result = await service.dispatchWithFallback('p1', 'key', {
      messages: [{ role: 'user', content: 'test' }],
    });

    expect(result.ok).toBe(false);
    expect(result.error).toContain('No active models');
  });

  it('returns error when no active models remain (all offline)', async () => {
    const { ModelHubService } = await import('../../../src/server/model-hub/service');

    const repo = createMockRepository({
      listPipelineModels: vi.fn().mockReturnValue([
        {
          id: 'm1',
          modelName: 'gpt-4',
          providerId: 'openai',
          accountId: 'a1',
          status: 'offline',
        },
      ]),
    });

    const service = new ModelHubService(repo);
    const result = await service.dispatchWithFallback('p1', 'key', {
      messages: [{ role: 'user', content: 'test' }],
    });

    expect(result.ok).toBe(false);
    expect(result.error).toContain('No active models');
  });

  it('skips models where account is not found', async () => {
    const { ModelHubService } = await import('../../../src/server/model-hub/service');

    const repo = createMockRepository({
      listPipelineModels: vi.fn().mockReturnValue([
        {
          id: 'm1',
          modelName: 'gemini-2.5-flash',
          providerId: 'gemini',
          accountId: 'missing',
          status: 'active',
        },
      ]),
      getAccountRecordById: vi.fn().mockReturnValue(null),
    });

    const service = new ModelHubService(repo);
    const result = await service.dispatchWithFallback('p1', 'key', {
      messages: [{ role: 'user', content: 'test' }],
    });

    expect(result.ok).toBe(false);
    expect(result.error).toContain('All models failed');
  });
});

describe('GatewayRequest type extensions', () => {
  it('supports systemInstruction, tools, and responseMimeType fields', async () => {
    const request = {
      model: 'test',
      messages: [{ role: 'user' as const, content: 'test' }],
      systemInstruction: 'You are helpful',
      tools: [{ functionDeclarations: [{ name: 'test' }] }],
      responseMimeType: 'application/json',
    };

    // Type check — these fields should exist without TS errors
    expect(request.systemInstruction).toBe('You are helpful');
    expect(request.tools).toHaveLength(1);
    expect(request.responseMimeType).toBe('application/json');
  });
});

describe('GatewayResponse type extensions', () => {
  it('supports functionCalls field', () => {
    const response = {
      ok: true,
      text: '',
      model: 'test',
      provider: 'gemini',
      functionCalls: [{ name: 'core_memory_store', args: { type: 'fact', content: 'test' } }],
    };

    expect(response.functionCalls).toHaveLength(1);
    expect(response.functionCalls[0].name).toBe('core_memory_store');
  });
});

describe('ModelHubService.movePipelineModel', () => {
  it('moves a model up and swaps priorities with the previous model', async () => {
    const { ModelHubService } = await import('../../../src/server/model-hub/service');

    const updatePriority = vi.fn();
    const repo = createMockRepository({
      listPipelineModels: vi.fn().mockReturnValue([
        { id: 'm1', priority: 1, modelName: 'alpha', status: 'active' },
        { id: 'm2', priority: 2, modelName: 'beta', status: 'active' },
        { id: 'm3', priority: 3, modelName: 'gamma', status: 'active' },
      ]),
      updatePipelineModelPriority: updatePriority,
    });

    const service = new ModelHubService(repo);
    const moved = service.movePipelineModel('p1', 'm2', 'up');

    expect(moved).toBe(true);
    expect(updatePriority).toHaveBeenCalledTimes(2);
    expect(updatePriority).toHaveBeenNthCalledWith(1, 'm2', 1);
    expect(updatePriority).toHaveBeenNthCalledWith(2, 'm1', 2);
  });

  it('returns false when moving the first model up', async () => {
    const { ModelHubService } = await import('../../../src/server/model-hub/service');

    const updatePriority = vi.fn();
    const repo = createMockRepository({
      listPipelineModels: vi.fn().mockReturnValue([
        { id: 'm1', priority: 1, modelName: 'alpha', status: 'active' },
        { id: 'm2', priority: 2, modelName: 'beta', status: 'active' },
      ]),
      updatePipelineModelPriority: updatePriority,
    });

    const service = new ModelHubService(repo);
    const moved = service.movePipelineModel('p1', 'm1', 'up');

    expect(moved).toBe(false);
    expect(updatePriority).not.toHaveBeenCalled();
  });
});
