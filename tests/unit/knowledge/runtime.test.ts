import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type RuntimeGlobals = typeof globalThis & {
  __messageRepository?: unknown;
  __knowledgeMessageRepository?: unknown;
  __knowledgeRepository?: unknown;
  __knowledgeExtractor?: unknown;
  __knowledgeCursor?: unknown;
  __knowledgeIngestionService?: unknown;
  __knowledgeRetrievalService?: unknown;
  __knowledgeRuntimeLoop?: unknown;
};

const globals = globalThis as RuntimeGlobals;

const BASE_CONFIG = {
  layerEnabled: true,
  ledgerEnabled: true,
  episodeEnabled: true,
  retrievalEnabled: true,
  maxContextTokens: 4000,
  ingestIntervalMs: 60_000,
  minMessagesPerBatch: 2,
  contradictionDetectionEnabled: false,
  correctionDetectionEnabled: false,
  dynamicRecallBudgetEnabled: false,
  conversationSummaryEnabled: false,
  memoryConsolidationEnabled: false,
  personaTypeAwarenessEnabled: false,
  emotionTrackingEnabled: false,
  projectTrackingEnabled: false,
  taskTrackingEnabled: false,
};

function resetRuntimeGlobals(): void {
  globals.__messageRepository = undefined;
  globals.__knowledgeMessageRepository = undefined;
  globals.__knowledgeRepository = undefined;
  globals.__knowledgeExtractor = undefined;
  globals.__knowledgeCursor = undefined;
  globals.__knowledgeIngestionService = undefined;
  globals.__knowledgeRetrievalService = undefined;
  globals.__knowledgeRuntimeLoop = undefined;
}

function mockKnowledgeConfig(overrides: Record<string, unknown> = {}): void {
  vi.doMock('../../../src/server/knowledge/config', () => ({
    getKnowledgeConfig: () => ({ ...BASE_CONFIG, ...overrides }),
  }));
}

describe('knowledge runtime', () => {
  beforeEach(() => {
    resetRuntimeGlobals();
    vi.resetModules();
  });

  afterEach(() => {
    resetRuntimeGlobals();
    vi.restoreAllMocks();
    vi.resetModules();
  });

  it('creates and caches repository singletons', async () => {
    const repositoryConstructor = vi.fn();
    class SqliteKnowledgeRepository {
      listEpisodes = vi.fn(() => []);
      constructor() {
        repositoryConstructor();
      }
    }
    vi.doMock('../../../src/server/knowledge/sqliteKnowledgeRepository', () => ({
      SqliteKnowledgeRepository,
    }));

    const runtime = await import('@/server/knowledge/runtime');

    const first = runtime.getKnowledgeRepository();
    const second = runtime.getKnowledgeRepository();
    expect(second).toBe(first);
    expect(repositoryConstructor).toHaveBeenCalledTimes(1);
  });

  it('reuses shared message repository when creating ingestion cursor', async () => {
    const sharedMessageRepository = { shared: true };
    globals.__messageRepository =
      sharedMessageRepository as unknown as RuntimeGlobals['__messageRepository'];
    const cursorConstructor = vi.fn();
    const messageRepositoryConstructor = vi.fn();
    const knowledgeRepositoryConstructor = vi.fn();

    class KnowledgeIngestionCursor {
      constructor(_messageRepository: unknown, _knowledgeRepository: unknown, _options: unknown) {
        cursorConstructor(_messageRepository, _knowledgeRepository, _options);
      }
    }
    class SqliteMessageRepository {
      constructor() {
        messageRepositoryConstructor();
      }
    }
    class SqliteKnowledgeRepository {
      constructor() {
        knowledgeRepositoryConstructor();
      }
    }

    mockKnowledgeConfig({ minMessagesPerBatch: 7 });
    vi.doMock('../../../src/server/knowledge/ingestionCursor', () => ({
      KnowledgeIngestionCursor,
    }));
    vi.doMock('../../../src/server/channels/messages/sqliteMessageRepository', () => ({
      SqliteMessageRepository,
    }));
    vi.doMock('../../../src/server/knowledge/sqliteKnowledgeRepository', () => ({
      SqliteKnowledgeRepository,
    }));

    const runtime = await import('@/server/knowledge/runtime');
    runtime.getKnowledgeIngestionCursor();
    expect(cursorConstructor).toHaveBeenCalledWith(sharedMessageRepository, expect.any(Object), {
      minMessagesPerBatch: 7,
    });
    expect(messageRepositoryConstructor).not.toHaveBeenCalled();
    expect(knowledgeRepositoryConstructor).toHaveBeenCalledTimes(1);
  });

  it('creates dedicated sqlite message repository when no shared repository exists', async () => {
    const cursorConstructor = vi.fn();
    const messageRepositoryConstructor = vi.fn();

    class KnowledgeIngestionCursor {
      constructor() {
        cursorConstructor();
      }
    }
    class SqliteMessageRepository {
      constructor() {
        messageRepositoryConstructor();
      }
    }
    class SqliteKnowledgeRepository {
      constructor() {}
    }

    mockKnowledgeConfig({ minMessagesPerBatch: 3 });
    vi.doMock('../../../src/server/knowledge/ingestionCursor', () => ({
      KnowledgeIngestionCursor,
    }));
    vi.doMock('../../../src/server/channels/messages/sqliteMessageRepository', () => ({
      SqliteMessageRepository,
    }));
    vi.doMock('../../../src/server/knowledge/sqliteKnowledgeRepository', () => ({
      SqliteKnowledgeRepository,
    }));

    const runtime = await import('@/server/knowledge/runtime');
    runtime.getKnowledgeIngestionCursor();

    expect(messageRepositoryConstructor).toHaveBeenCalledTimes(1);
    expect(cursorConstructor).toHaveBeenCalledTimes(1);
  });

  it('handles unavailable memory runtime and persona repository lookup errors in ingestion service', async () => {
    const consoleWarn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    mockKnowledgeConfig({ minMessagesPerBatch: 5 });

    class SqliteKnowledgeRepository {
      constructor() {}
    }
    class SqliteMessageRepository {
      constructor() {}
    }
    class KnowledgeIngestionCursor {
      constructor() {}
    }
    class KnowledgeExtractor {
      constructor() {}
    }
    class KnowledgeIngestionService {
      deps: unknown;
      options: unknown;
      constructor(deps: unknown, options: unknown) {
        this.deps = deps;
        this.options = options;
      }
    }

    vi.doMock('../../../src/server/knowledge/sqliteKnowledgeRepository', () => ({
      SqliteKnowledgeRepository,
    }));
    vi.doMock('../../../src/server/channels/messages/sqliteMessageRepository', () => ({
      SqliteMessageRepository,
    }));
    vi.doMock('../../../src/server/knowledge/ingestionCursor', () => ({
      KnowledgeIngestionCursor,
    }));
    vi.doMock('../../../src/server/knowledge/extractor', () => ({
      KnowledgeExtractor,
    }));
    vi.doMock('../../../src/server/knowledge/ingestionService', () => ({
      KnowledgeIngestionService,
    }));
    vi.doMock('../../../src/server/memory/runtime', () => ({
      getMemoryService: () => {
        throw new Error('mem0 unavailable');
      },
    }));
    vi.doMock('../../../src/server/personas/personaRepository', () => ({
      getPersonaRepository: () => ({
        getPersona: () => {
          throw new Error('repo unavailable');
        },
      }),
    }));

    const runtime = await import('@/server/knowledge/runtime');
    const ingestionService = runtime.getKnowledgeIngestionService() as unknown as {
      deps: {
        memoryService: unknown;
        resolvePersonaName: (personaId: string) => string | null;
      };
    };

    expect(consoleWarn).toHaveBeenCalledWith(
      '[knowledge] Mem0 unavailable — Mem0 storage will be skipped during ingestion.',
      'mem0 unavailable',
    );
    expect(ingestionService.deps.memoryService).toBeNull();
    expect(ingestionService.deps.resolvePersonaName('persona-1')).toBeNull();
  });

  it('wires extraction model calls through model hub and surfaces provider errors', async () => {
    mockKnowledgeConfig({ minMessagesPerBatch: 1 });

    const dispatchWithFallback = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, text: 'model output' })
      .mockResolvedValueOnce({ ok: false, error: 'rate limited' });
    let capturedRunExtractionModel: ((prompt: string) => Promise<string>) | null = null;

    vi.doMock('../../../src/server/model-hub/runtime', () => ({
      getModelHubService: () => ({ dispatchWithFallback }),
      getModelHubEncryptionKey: () => 'enc-key',
    }));
    class SqliteKnowledgeRepository {
      constructor() {}
    }
    class SqliteMessageRepository {
      constructor() {}
    }
    class KnowledgeIngestionCursor {
      constructor() {}
    }
    vi.doMock('../../../src/server/knowledge/sqliteKnowledgeRepository', () => ({
      SqliteKnowledgeRepository,
    }));
    vi.doMock('../../../src/server/channels/messages/sqliteMessageRepository', () => ({
      SqliteMessageRepository,
    }));
    vi.doMock('../../../src/server/knowledge/ingestionCursor', () => ({
      KnowledgeIngestionCursor,
    }));
    vi.doMock('../../../src/server/knowledge/extractor', () => ({
      KnowledgeExtractor: class {
        constructor(options: { runExtractionModel: (prompt: string) => Promise<string> }) {
          capturedRunExtractionModel = options.runExtractionModel;
        }
      },
    }));
    vi.doMock('../../../src/server/knowledge/ingestionService', () => ({
      KnowledgeIngestionService: class {
        constructor(_deps: unknown, _options: unknown) {}
      },
    }));
    vi.doMock('../../../src/server/memory/runtime', () => ({
      getMemoryService: () => null,
    }));
    vi.doMock('../../../src/server/personas/personaRepository', () => ({
      getPersonaRepository: () => ({ getPersona: () => null }),
    }));

    const runtime = await import('@/server/knowledge/runtime');
    runtime.getKnowledgeIngestionService();
    expect(capturedRunExtractionModel).toBeTypeOf('function');

    await expect(capturedRunExtractionModel!('Extract this')).resolves.toBe('model output');
    expect(dispatchWithFallback).toHaveBeenCalledWith('p1', 'enc-key', {
      messages: [{ role: 'user', content: 'Extract this' }],
      auditContext: { kind: 'knowledge-extraction' },
    });

    await expect(capturedRunExtractionModel!('Extract fails')).rejects.toThrow(
      'Knowledge extraction model call failed: rate limited',
    );
  });

  it('builds retrieval service with persona memory type resolver', async () => {
    mockKnowledgeConfig({ maxContextTokens: 1234 });
    class SqliteKnowledgeRepository {
      constructor() {}
    }
    class SqliteMessageRepository {
      constructor() {}
    }
    class KnowledgeRetrievalService {
      deps: unknown;
      constructor(deps: unknown) {
        this.deps = deps;
      }
    }

    vi.doMock('../../../src/server/knowledge/sqliteKnowledgeRepository', () => ({
      SqliteKnowledgeRepository,
    }));
    vi.doMock('../../../src/server/channels/messages/sqliteMessageRepository', () => ({
      SqliteMessageRepository,
    }));
    vi.doMock('../../../src/server/knowledge/retrieval', () => ({
      KnowledgeRetrievalService,
    }));
    vi.doMock('../../../src/server/memory/runtime', () => ({
      getMemoryService: () => ({ kind: 'mem0-service' }),
    }));
    vi.doMock('../../../src/server/personas/personaRepository', () => ({
      getPersonaRepository: () => ({
        getPersona: (id: string) => (id === 'persona-a' ? { memoryPersonaType: 'roleplay' } : null),
      }),
    }));

    const runtime = await import('@/server/knowledge/runtime');
    const retrievalService = runtime.getKnowledgeRetrievalService() as unknown as {
      deps: {
        maxContextTokens: number;
        getPersonaMemoryType: (personaId: string) => string | null;
      };
    };

    expect(retrievalService.deps.maxContextTokens).toBe(1234);
    expect(retrievalService.deps.getPersonaMemoryType('persona-a')).toBe('roleplay');
    expect(retrievalService.deps.getPersonaMemoryType('persona-missing')).toBeNull();
  });

  it('starts/stops loop and executes cleanup/reconciliation callbacks', async () => {
    const consoleLog = vi.spyOn(console, 'log').mockImplementation(() => {});
    const consoleWarn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    type MaintenanceCallbacks = {
      runCleanup: () => Promise<void>;
      runReconciliation: () => Promise<void>;
    };
    let capturedOptions: MaintenanceCallbacks | null = null;

    class MockKnowledgeRuntimeLoop {
      start = vi.fn();
      stop = vi.fn();
      constructor(options: unknown) {
        capturedOptions = options as MaintenanceCallbacks;
      }
    }

    mockKnowledgeConfig({
      layerEnabled: true,
      episodeEnabled: true,
      ledgerEnabled: false,
      ingestIntervalMs: 2000,
    });
    vi.doMock('../../../src/server/knowledge/runtimeLoop', () => ({
      KnowledgeRuntimeLoop: MockKnowledgeRuntimeLoop,
    }));
    vi.doMock('../../../src/server/knowledge/cleanupDetector', () => ({
      detectPlaceholder: (fact: string) => fact.includes('placeholder'),
      detectStaleRelativeTime: () => true,
      detectLowRelevance: (fact: string) => fact.includes('smalltalk'),
    }));
    vi.doMock('../../../src/server/knowledge/reconciliation', () => ({
      detectOrphans: () => ({ mem0OrphansFound: 2, knowledgeOrphansFound: 1 }),
    }));
    vi.doMock('../../../src/server/knowledge/sqliteKnowledgeRepository', () => ({
      SqliteKnowledgeRepository: vi.fn(() => ({
        listEpisodes: vi.fn(() => []),
      })),
    }));

    globals.__knowledgeRepository = {
      listEpisodes: vi.fn(() => [
        {
          id: 'ep-1',
          userId: 'user-a',
          personaId: 'persona-a',
          conversationId: 'conv-a',
          topicKey: 'topic-a',
          counterpart: null,
          teaser: 'teaser',
          episode: 'episode',
          facts: ['placeholder marker', 'smalltalk text'],
          sourceSeqStart: 1,
          sourceSeqEnd: 2,
          sourceRefs: [],
          eventAt: null,
          updatedAt: '2026-01-01T00:00:00.000Z',
        },
      ]),
    } as unknown as RuntimeGlobals['__knowledgeRepository'];

    const runtime = await import('@/server/knowledge/runtime');
    const loop = runtime.startKnowledgeRuntimeLoop() as unknown as {
      start: ReturnType<typeof vi.fn>;
      stop: ReturnType<typeof vi.fn>;
    };
    expect(loop.start).toHaveBeenCalledTimes(1);

    expect(capturedOptions).not.toBeNull();
    await capturedOptions!.runCleanup();
    await capturedOptions!.runReconciliation();

    expect(consoleLog).toHaveBeenCalledWith(
      '[knowledge] cleanup detected 4 stale/placeholder facts',
    );
    expect(consoleLog).toHaveBeenCalledWith(
      '[knowledge] reconciliation: 2 Mem0 orphans, 1 knowledge orphans',
    );
    expect(consoleWarn).not.toHaveBeenCalledWith(
      '[knowledge] reconciliation skipped:',
      expect.anything(),
    );

    runtime.stopKnowledgeRuntimeLoop();
    expect(loop.stop).toHaveBeenCalledTimes(1);
    runtime.resetKnowledgeRuntimeForTests();
    expect(globals.__knowledgeRepository).toBeUndefined();
  });
});
