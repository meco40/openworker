import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  query: vi.fn<MockProcedure>(),
  getWorldModelDb: vi.fn<MockProcedure>(),
  runWithWorldModelScope: vi.fn<MockProcedure>(),
  getWorldModelConfig: vi.fn<MockProcedure>(),
  getConfiguredEmbeddingProvider: vi.fn<MockProcedure>(),
}));

vi.mock('@/server/world-model/db', () => ({
  getWorldModelDb: mocks.getWorldModelDb,
  runWithWorldModelScope: mocks.runWithWorldModelScope,
}));
vi.mock('@/server/world-model/config', () => ({
  getWorldModelConfig: mocks.getWorldModelConfig,
}));
vi.mock('@/server/world-model/embeddings/provider', () => ({
  getConfiguredEmbeddingProvider: mocks.getConfiguredEmbeddingProvider,
}));

import {
  collectEmbeddingTargets,
  processEmbeddingBatch,
  runEmbeddingWorkerOnce,
  startEmbeddingWorker,
  type EmbeddingTarget,
} from '@/server/world-model/embeddings/embeddingWorker';
import type { MockProcedure } from '../../helpers/mockProcedure';

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

const target: EmbeddingTarget = {
  targetType: 'memory',
  targetId: 'memory-1',
  scope: { userId: 'user-1', personaId: 'assistant', workspaceId: 'workspace-1' },
  text: 'The user prefers concise updates.',
  textHash: 'hash-1',
};

describe('collectEmbeddingTargets', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getWorldModelDb.mockReturnValue({ query: mocks.query });
    mocks.runWithWorldModelScope.mockImplementation((_, callback) => callback());
  });

  it('collects one scoped target from each canonical memory type', async () => {
    mocks.query.mockImplementation(async (sql: string) => {
      if (sql.includes('FROM world_model_observations')) {
        return {
          rows: [
            {
              id: 'observation-1',
              user_id: 'user-1',
              persona_id: 'assistant',
              workspace_id: 'workspace-1',
              payload: { text: 'The launch is tomorrow.' },
            },
          ],
        };
      }
      if (sql.includes('FROM world_model_memory_items')) {
        return {
          rows: [
            {
              id: 'memory-1',
              user_id: 'user-1',
              persona_id: 'assistant',
              workspace_id: 'workspace-1',
              content: 'The user prefers concise updates.',
            },
          ],
        };
      }
      if (sql.includes('FROM world_model_assertions')) {
        return {
          rows: [
            {
              id: 'assertion-1',
              user_id: 'user-1',
              persona_id: 'assistant',
              workspace_id: 'workspace-1',
              predicate: 'works_at',
              object_value: 'Acme',
            },
          ],
        };
      }
      if (sql.includes('FROM world_model_entities')) {
        return {
          rows: [
            {
              id: 'entity-1',
              user_id: 'user-1',
              persona_id: 'assistant',
              workspace_id: 'workspace-1',
              canonical_name: 'Acme',
              category: 'company',
            },
          ],
        };
      }
      if (sql.includes('FROM world_model_events')) {
        return {
          rows: [
            {
              id: 'event-1',
              user_id: 'user-1',
              persona_id: 'assistant',
              workspace_id: 'workspace-1',
              title: 'Launch',
              event_type: 'release',
              status: 'planned',
            },
          ],
        };
      }
      if (sql.includes('FROM world_model_tasks')) {
        return {
          rows: [
            {
              id: 'task-1',
              user_id: 'user-1',
              persona_id: 'assistant',
              workspace_id: 'workspace-1',
              title: 'Prepare launch',
              status: 'open',
            },
          ],
        };
      }
      throw new Error(`Unexpected query: ${sql}`);
    });
    const scope = { userId: 'user-1', personaId: 'assistant', workspaceId: 'workspace-1' };

    const targets = await collectEmbeddingTargets(12, scope);

    expect(targets.map(({ targetType }) => targetType)).toEqual([
      'observation',
      'memory',
      'assertion',
      'entity',
      'event',
      'task',
    ]);
    expect(targets.map(({ targetId }) => targetId)).toEqual([
      'observation-1',
      'memory-1',
      'assertion-1',
      'entity-1',
      'event-1',
      'task-1',
    ]);
    expect(targets.map(({ scope: targetScope }) => targetScope)).toEqual(Array(6).fill(scope));
    expect(targets.every((target) => target.textHash.length > 0)).toBe(true);
    expect(targets.map(({ text }) => text).join('\n')).toContain('The launch is tomorrow.');
    expect(targets.map(({ text }) => text).join('\n')).toContain(
      'The user prefers concise updates.',
    );
    expect(mocks.query).toHaveBeenCalledTimes(6);
    expect(mocks.query.mock.calls[0]?.[1]).toEqual(['user-1', 'assistant', 'workspace-1', 2]);
    expect(mocks.runWithWorldModelScope).toHaveBeenCalledWith(scope, expect.any(Function));
  });

  it('returns no targets when the unscoped canonical queues are empty', async () => {
    mocks.query.mockResolvedValue({ rows: [] });

    await expect(collectEmbeddingTargets()).resolves.toEqual([]);

    expect(mocks.query).toHaveBeenCalledTimes(6);
    expect(mocks.query.mock.calls.map(([, values]) => values)).toEqual(Array(6).fill([9]));
    expect(mocks.runWithWorldModelScope).not.toHaveBeenCalled();
  });

  it('filters blank content, defaults a missing workspace, and respects the requested limit', async () => {
    mocks.query.mockImplementation(async (sql: string) => {
      if (sql.includes('FROM world_model_observations')) {
        return {
          rows: [
            {
              id: 'blank-observation',
              user_id: 'user-1',
              persona_id: 'assistant',
              workspace_id: '',
              payload: '',
            },
            {
              id: 'missing-observation-payload',
              user_id: 'user-1',
              persona_id: 'assistant',
              workspace_id: '',
              payload: undefined,
            },
          ],
        };
      }
      if (sql.includes('FROM world_model_memory_items')) {
        return {
          rows: [
            {
              id: 'blank-memory',
              user_id: 'user-1',
              persona_id: 'assistant',
              workspace_id: '',
              content: '   ',
            },
          ],
        };
      }
      if (sql.includes('FROM world_model_assertions')) {
        return {
          rows: [
            {
              id: 'assertion-1',
              user_id: 'user-1',
              persona_id: 'assistant',
              workspace_id: '',
              predicate: 'works_at',
              object_value: null,
            },
          ],
        };
      }
      if (sql.includes('FROM world_model_entities')) {
        return {
          rows: [
            {
              id: 'entity-1',
              user_id: 'user-1',
              persona_id: 'assistant',
              workspace_id: '',
              canonical_name: 'Acme',
              category: 'company',
            },
          ],
        };
      }
      if (sql.includes('FROM world_model_events')) {
        return {
          rows: [
            {
              id: 'event-1',
              user_id: 'user-1',
              persona_id: 'assistant',
              workspace_id: '',
              title: 'Launch',
              event_type: 'release',
              status: 'planned',
            },
          ],
        };
      }
      return {
        rows: [
          {
            id: 'task-1',
            user_id: 'user-1',
            persona_id: 'assistant',
            workspace_id: '',
            title: 'Prepare launch',
            status: 'open',
          },
        ],
      };
    });
    const scope = { userId: 'user-1', personaId: 'assistant' };

    const targets = await collectEmbeddingTargets(3, scope);

    expect(targets.map(({ targetType, targetId }) => [targetType, targetId])).toEqual([
      ['assertion', 'assertion-1'],
      ['entity', 'entity-1'],
      ['event', 'event-1'],
    ]);
    expect(targets[0]?.text).toBe('works_at:');
    expect(mocks.query.mock.calls.map(([, values]) => values)).toEqual(
      Array(6).fill(['user-1', 'assistant', '', 1]),
    );
  });

  it('keeps targets collected before a later queue query fails', async () => {
    mocks.query
      .mockResolvedValueOnce({
        rows: [
          {
            id: 'observation-1',
            user_id: 'user-1',
            persona_id: 'assistant',
            workspace_id: '',
            payload: { content: 'Keep this observation.' },
          },
        ],
      })
      .mockRejectedValueOnce(new Error('memory queue unavailable'));
    vi.spyOn(console, 'error').mockImplementation(() => {});

    await expect(collectEmbeddingTargets()).resolves.toMatchObject([
      { targetType: 'observation', targetId: 'observation-1' },
    ]);
    expect(console.error).toHaveBeenCalledWith(
      '[world-model:embeddings] failed to collect targets:',
      expect.objectContaining({ message: 'memory queue unavailable' }),
    );
    expect(mocks.query).toHaveBeenCalledTimes(2);
  });
});

describe('processEmbeddingBatch', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getWorldModelConfig.mockReturnValue({ enabled: false, e2eEnabled: false });
    mocks.getWorldModelDb.mockReturnValue({ query: mocks.query });
    mocks.runWithWorldModelScope.mockImplementation((_, callback) => callback());
    mocks.getConfiguredEmbeddingProvider.mockReturnValue(null);
  });

  it('does not query the database or generate vectors while World Model is disabled', async () => {
    await expect(
      processEmbeddingBatch([target], { generateEmbedding: vi.fn<MockProcedure>() }),
    ).resolves.toEqual([]);

    expect(mocks.getWorldModelDb).not.toHaveBeenCalled();
    expect(mocks.getConfiguredEmbeddingProvider).not.toHaveBeenCalled();
  });

  it('stores a generated vector with the target scope and default model metadata', async () => {
    mocks.getWorldModelConfig.mockReturnValue({ enabled: true, e2eEnabled: false });
    mocks.query.mockResolvedValueOnce({ rows: [] }).mockResolvedValueOnce({ rows: [] });
    const generateEmbedding = vi.fn<MockProcedure>().mockResolvedValue([0.25, -0.5]);
    const targetWithoutWorkspace = {
      ...target,
      scope: { userId: 'user-1', personaId: 'assistant' },
    };

    await expect(
      processEmbeddingBatch([targetWithoutWorkspace], { generateEmbedding }),
    ).resolves.toEqual([
      {
        targetType: 'memory',
        targetId: 'memory-1',
        embedding: [0.25, -0.5],
        model: 'text-embedding-3-small',
        modelVersion: '1',
        created: true,
      },
    ]);

    expect(generateEmbedding).toHaveBeenCalledWith(target.text);
    expect(mocks.query).toHaveBeenCalledTimes(2);
    expect(mocks.query.mock.calls[1]?.[1]).toEqual([
      'user-1',
      'assistant',
      '',
      'memory',
      'memory-1',
      '[0.25,-0.5]',
      'text-embedding-3-small',
      '1',
      'hash-1',
      target.text,
    ]);
    expect(mocks.runWithWorldModelScope).toHaveBeenCalledWith(
      targetWithoutWorkspace.scope,
      expect.any(Function),
    );
  });

  it('reuses an existing vector and otherwise falls back to the configured provider', async () => {
    mocks.getWorldModelConfig.mockReturnValue({ enabled: false, e2eEnabled: true });
    const provider = {
      model: 'provider-model',
      modelVersion: 'provider-version',
      generateEmbedding: vi.fn<MockProcedure>().mockResolvedValue([1, 2, 3]),
    };
    mocks.getConfiguredEmbeddingProvider.mockReturnValue(provider);
    mocks.query.mockImplementation(async (_sql: string, values?: unknown[]) => ({
      rows: values?.[1] === 'memory-1' ? [{ id: 'existing-vector' }] : [],
    }));
    const newTarget = { ...target, targetId: 'memory-2' };

    await expect(
      processEmbeddingBatch([target, newTarget], { model: 'override-model', modelVersion: 'v2' }),
    ).resolves.toEqual([
      {
        targetType: 'memory',
        targetId: 'memory-1',
        embedding: [],
        model: 'override-model',
        modelVersion: 'v2',
        created: false,
      },
      {
        targetType: 'memory',
        targetId: 'memory-2',
        embedding: [1, 2, 3],
        model: 'override-model',
        modelVersion: 'v2',
        created: true,
      },
    ]);

    expect(provider.generateEmbedding).toHaveBeenCalledOnce();
    expect(provider.generateEmbedding).toHaveBeenCalledWith(newTarget.text);
    expect(mocks.query).toHaveBeenCalledTimes(3);
  });

  it('skips persistence when no embedding provider is configured', async () => {
    mocks.getWorldModelConfig.mockReturnValue({ enabled: true, e2eEnabled: false });
    mocks.query.mockResolvedValue({ rows: [] });
    vi.spyOn(console, 'error').mockImplementation(() => {});

    await expect(processEmbeddingBatch([target])).resolves.toEqual([]);

    expect(mocks.query).toHaveBeenCalledOnce();
    expect(console.error).toHaveBeenCalledWith(
      '[world-model:embeddings] no generateEmbedding provider configured; target skipped',
    );
  });

  it('rejects empty or non-finite vectors and continues the rest of the batch', async () => {
    mocks.getWorldModelConfig.mockReturnValue({ enabled: true, e2eEnabled: false });
    mocks.query.mockResolvedValue({ rows: [] });
    const generateEmbedding = vi
      .fn<MockProcedure>()
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([Number.NaN]);
    vi.spyOn(console, 'error').mockImplementation(() => {});

    await expect(
      processEmbeddingBatch([target, { ...target, targetId: 'memory-2' }], { generateEmbedding }),
    ).resolves.toEqual([]);

    expect(generateEmbedding).toHaveBeenCalledTimes(2);
    expect(mocks.query).toHaveBeenCalledTimes(2);
    expect(console.error).toHaveBeenCalledTimes(2);
    expect(console.error).toHaveBeenCalledWith(
      '[world-model:embeddings] failed for memory:memory-1:',
      expect.objectContaining({ message: 'embedding provider returned an invalid vector' }),
    );
  });
});

describe('runEmbeddingWorkerOnce', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getWorldModelConfig.mockReturnValue({ enabled: false, e2eEnabled: false });
    mocks.getWorldModelDb.mockReturnValue({ query: mocks.query });
    mocks.runWithWorldModelScope.mockImplementation((_, callback) => callback());
    mocks.getConfiguredEmbeddingProvider.mockReturnValue(null);
  });

  it('returns empty counts without reading queues while disabled', async () => {
    await expect(runEmbeddingWorkerOnce()).resolves.toEqual({
      collected: 0,
      processed: 0,
      created: 0,
    });
    expect(mocks.query).not.toHaveBeenCalled();
  });

  it('returns empty counts when an enabled worker finds no targets', async () => {
    mocks.getWorldModelConfig.mockReturnValue({ enabled: true, e2eEnabled: false });
    mocks.query.mockResolvedValue({ rows: [] });

    await expect(runEmbeddingWorkerOnce()).resolves.toEqual({
      collected: 0,
      processed: 0,
      created: 0,
    });
    expect(mocks.query).toHaveBeenCalledTimes(6);
  });

  it('collects and persists a target in e2e mode and reports the batch counts', async () => {
    mocks.getWorldModelConfig.mockReturnValue({ enabled: false, e2eEnabled: true });
    mocks.query.mockImplementation(async (sql: string) => ({
      rows: sql.includes('FROM world_model_observations')
        ? [
            {
              id: 'observation-1',
              user_id: 'user-1',
              persona_id: 'assistant',
              workspace_id: '',
              payload: { text: 'A saved observation.' },
            },
          ]
        : [],
    }));

    await expect(
      runEmbeddingWorkerOnce({
        generateEmbedding: vi.fn<MockProcedure>().mockResolvedValue([0.5]),
      }),
    ).resolves.toEqual({
      collected: 1,
      processed: 1,
      created: 1,
    });
    expect(mocks.query).toHaveBeenCalledTimes(8);
  });
});

describe('startEmbeddingWorker', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getWorldModelConfig.mockReturnValue({ enabled: false, e2eEnabled: false });
    mocks.getWorldModelDb.mockReturnValue({ query: mocks.query });
    mocks.runWithWorldModelScope.mockImplementation((_, callback) => callback());
  });

  it('does not schedule a timer while disabled', () => {
    vi.useFakeTimers();

    startEmbeddingWorker().stop();

    expect(vi.getTimerCount()).toBe(0);
  });

  it('runs unscoped ticks until stopped', async () => {
    mocks.getWorldModelConfig.mockReturnValue({ enabled: true, e2eEnabled: false });
    mocks.query.mockResolvedValue({ rows: [] });
    vi.useFakeTimers();
    const worker = startEmbeddingWorker({}, 100);

    await vi.advanceTimersByTimeAsync(100);
    expect(mocks.query).toHaveBeenCalledTimes(6);

    worker.stop();
    await vi.advanceTimersByTimeAsync(500);
    expect(mocks.query).toHaveBeenCalledTimes(6);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('skips a scoped tick when no runtime scopes are found', async () => {
    mocks.getWorldModelConfig.mockReturnValue({ enabled: true, e2eEnabled: false });
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.useFakeTimers();
    const worker = startEmbeddingWorker({}, 100, async () => []);

    await vi.advanceTimersByTimeAsync(100);

    expect(mocks.query).not.toHaveBeenCalled();
    expect(console.warn).toHaveBeenCalledWith(
      '[world-model:embeddings] no runtime scopes discovered; skipping unscoped tick',
    );
    worker.stop();
  });

  it('reports a failure while discovering scopes and continues scheduling future ticks', async () => {
    mocks.getWorldModelConfig.mockReturnValue({ enabled: true, e2eEnabled: false });
    const error = new Error('scope discovery unavailable');
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.useFakeTimers();
    const scopeProvider = vi.fn<MockProcedure>().mockRejectedValue(error);
    const worker = startEmbeddingWorker({}, 100, scopeProvider);

    await vi.advanceTimersByTimeAsync(200);

    expect(scopeProvider).toHaveBeenCalledTimes(2);
    expect(console.error).toHaveBeenCalledWith(
      '[world-model:embeddings] worker tick failed:',
      error,
    );
    worker.stop();
  });

  it('logs a failed scoped tick without cancelling other scopes', async () => {
    mocks.getWorldModelConfig.mockReturnValue({ enabled: true, e2eEnabled: false });
    const error = new Error('scope unavailable');
    mocks.runWithWorldModelScope.mockRejectedValueOnce(error);
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.useFakeTimers();
    const scopes = [
      { userId: 'user-1', personaId: 'assistant' },
      { userId: 'user-2', personaId: 'assistant', workspaceId: 'workspace-2' },
    ];
    mocks.query.mockResolvedValue({ rows: [] });
    const worker = startEmbeddingWorker({}, 100, () => scopes);

    await vi.advanceTimersByTimeAsync(100);

    expect(mocks.runWithWorldModelScope).toHaveBeenCalledTimes(2);
    expect(mocks.query).toHaveBeenCalledTimes(6);
    expect(console.error).toHaveBeenCalledWith(
      '[world-model:embeddings] scoped worker tick failed for user-1/assistant/:',
      error,
    );
    worker.stop();
  });

  it('skips an overlapping timer tick while the previous database read is pending', async () => {
    mocks.getWorldModelConfig.mockReturnValue({ enabled: true, e2eEnabled: false });
    let releaseFirstQuery!: (result: { rows: [] }) => void;
    mocks.query
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            releaseFirstQuery = resolve;
          }),
      )
      .mockResolvedValue({ rows: [] });
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.useFakeTimers();
    const worker = startEmbeddingWorker({}, 100);

    await vi.advanceTimersByTimeAsync(100);
    expect(mocks.query).toHaveBeenCalledOnce();

    await vi.advanceTimersByTimeAsync(100);
    expect(mocks.query).toHaveBeenCalledOnce();
    expect(console.warn).toHaveBeenCalledWith(
      '[world-model:embeddings] previous worker tick still running; skipping overlap',
    );

    worker.stop();
    releaseFirstQuery({ rows: [] });
    await vi.advanceTimersByTimeAsync(0);
    expect(mocks.query).toHaveBeenCalledTimes(6);
  });
});
