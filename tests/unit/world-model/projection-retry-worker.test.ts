import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  listDueProjectionPending: vi.fn<MockProcedure>(),
  markProjectionPendingFailed: vi.fn<MockProcedure>(),
  markProjectionPendingSucceeded: vi.fn<MockProcedure>(),
  getWorldModelDb: vi.fn<MockProcedure>(),
  runWithWorldModelScope: vi.fn<MockProcedure>(),
  listRuntimeWorldModelScopes: vi.fn<MockProcedure>(),
  dbQuery: vi.fn<MockProcedure>(),
  getMemoryProviderKind: vi.fn<MockProcedure>(),
  getMemoryService: vi.fn<MockProcedure>(),
  isMem0FactualWriteBlocked: vi.fn<MockProcedure>(),
  normalizeExtraction: vi.fn<MockProcedure>(),
  projectWindow: vi.fn<MockProcedure>(),
  getKnowledgeMessageRepository: vi.fn<MockProcedure>(),
  getKnowledgeRepository: vi.fn<MockProcedure>(),
  upsertEpisodeAndLedger: vi.fn<MockProcedure>(),
  storeEvents: vi.fn<MockProcedure>(),
  storeEntities: vi.fn<MockProcedure>(),
  processFacts: vi.fn<MockProcedure>(),
  processMeetingLedger: vi.fn<MockProcedure>(),
}));

vi.mock('@/server/world-model/db', () => ({
  getWorldModelDb: mocks.getWorldModelDb,
  runWithWorldModelScope: mocks.runWithWorldModelScope,
}));
vi.mock('@/server/world-model/runtime/scopeDiscovery', () => ({
  listRuntimeWorldModelScopes: mocks.listRuntimeWorldModelScopes,
}));
vi.mock('@/server/world-model/repositories/projectionPendingRepository', () => ({
  listDueProjectionPending: mocks.listDueProjectionPending,
  markProjectionPendingFailed: mocks.markProjectionPendingFailed,
  markProjectionPendingSucceeded: mocks.markProjectionPendingSucceeded,
}));
vi.mock('@/server/memory/runtime', () => ({
  getMemoryProviderKind: mocks.getMemoryProviderKind,
  getMemoryService: mocks.getMemoryService,
}));
vi.mock('@/server/world-model/mem0Policy', () => ({
  isMem0FactualWriteBlocked: mocks.isMem0FactualWriteBlocked,
}));
vi.mock('@/server/world-model/projector/normalizeExtraction', () => ({
  normalizeExtraction: mocks.normalizeExtraction,
}));
vi.mock('@/server/world-model/projector/projectWindow', () => ({
  projectWindow: mocks.projectWindow,
}));
vi.mock('@/server/knowledge/runtime', () => ({
  getKnowledgeMessageRepository: mocks.getKnowledgeMessageRepository,
  getKnowledgeRepository: mocks.getKnowledgeRepository,
}));
vi.mock('@/server/knowledge/ingestion/episodeExtractor', () => ({
  upsertEpisodeAndLedger: mocks.upsertEpisodeAndLedger,
}));
vi.mock('@/server/knowledge/ingestion/eventExtractor', () => ({
  storeEvents: mocks.storeEvents,
}));
vi.mock('@/server/knowledge/ingestion/entityExtractor', () => ({
  storeEntities: mocks.storeEntities,
}));
vi.mock('@/server/knowledge/ingestion/factExtractor', () => ({
  processFacts: mocks.processFacts,
  processMeetingLedger: mocks.processMeetingLedger,
}));

import type { ProjectionPendingRecord } from '@/server/world-model/repositories/projectionPendingRepository';
import {
  runProjectionRetryOnce,
  startProjectionRetryWorker,
} from '@/server/world-model/services/projectionRetryWorker';
import type { MockProcedure } from '../../helpers/mockProcedure';

const scope = { userId: 'user-1', personaId: 'assistant', workspaceId: 'workspace-1' };

function pendingRecord(
  projectionType: string,
  payload: Record<string, unknown> = {},
  overrides: Partial<ProjectionPendingRecord> = {},
): ProjectionPendingRecord {
  return {
    id: `pending-${projectionType}`,
    scope,
    projectionType,
    sourceObservationId: 'observation-1',
    sourceWindowId: 'window-1',
    payload,
    attempts: 0,
    status: 'pending',
    errorMessage: null,
    nextAttemptAt: '2026-10-08T10:00:00.000Z',
    createdAt: '2026-10-08T09:00:00.000Z',
    updatedAt: '2026-10-08T09:00:00.000Z',
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.listDueProjectionPending.mockResolvedValue([]);
  mocks.markProjectionPendingFailed.mockImplementation(async () => {});
  mocks.markProjectionPendingSucceeded.mockImplementation(async () => {});
  mocks.dbQuery.mockResolvedValue({ rows: [{ count: '1' }] });
  mocks.getWorldModelDb.mockReturnValue({ query: mocks.dbQuery });
  mocks.listRuntimeWorldModelScopes.mockResolvedValue([
    { userId: 'user-1', personaId: 'persona-1', workspaceId: 'workspace-1' },
  ]);
  mocks.runWithWorldModelScope.mockImplementation(async (_scope: unknown, fn: () => unknown) =>
    fn(),
  );
  mocks.getMemoryProviderKind.mockReturnValue('sqlite');
  mocks.getMemoryService.mockReturnValue({
    storeMemory: vi.fn<MockProcedure>().mockResolvedValue({}),
    store: vi.fn<MockProcedure>().mockResolvedValue({}),
  });
  mocks.isMem0FactualWriteBlocked.mockReturnValue(false);
  mocks.normalizeExtraction.mockReturnValue({});
  mocks.projectWindow.mockImplementation(async () => {});
  mocks.getKnowledgeMessageRepository.mockReturnValue({
    markMessagesMemoryPending: vi.fn<MockProcedure>(),
  });
  mocks.getKnowledgeRepository.mockReturnValue({});
  mocks.processFacts.mockReturnValue([]);
  mocks.processMeetingLedger.mockReturnValue({
    decisions: [],
    negotiatedTerms: [],
    openPoints: [],
    actionItems: [],
  });
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('runProjectionRetryOnce', () => {
  const extraction = {
    facts: ['Alice works at Acme.'],
    teaser: 'Alice works at Acme',
    episode: 'Alice started at Acme.',
    meetingLedger: {
      topicKey: 'employment',
      counterpart: null,
      participants: [],
      decisions: [],
      negotiatedTerms: [],
      openPoints: [],
      actionItems: [],
      sourceRefs: [],
      confidence: 0.9,
    },
    events: [],
    entities: [],
  };

  it('marks handled records succeeded and records unsupported types as failed', async () => {
    const handled = pendingRecord('custom_projection');
    const unsupported = pendingRecord('unknown_projection');
    const handler = vi.fn<() => Promise<void>>(async () => {});
    mocks.listDueProjectionPending.mockResolvedValue([handled, unsupported]);

    await expect(runProjectionRetryOnce(12, { custom_projection: handler })).resolves.toEqual({
      selected: 2,
      succeeded: 1,
      failed: 1,
    });

    expect(mocks.listDueProjectionPending).toHaveBeenCalledWith(12);
    expect(handler).toHaveBeenCalledWith(handled);
    expect(mocks.markProjectionPendingSucceeded).toHaveBeenCalledWith(handled.id);
    expect(mocks.markProjectionPendingFailed).toHaveBeenCalledWith(
      unsupported.id,
      'no retry handler for unknown_projection',
    );
  });

  it('clears memory-pending flags after the final projection settles', async () => {
    const record = pendingRecord('custom_projection', { messageIds: ['message-1', null, 42, ''] });
    const messageRepository = { markMessagesMemoryPending: vi.fn<MockProcedure>() };
    mocks.listDueProjectionPending.mockResolvedValue([record]);
    mocks.dbQuery.mockResolvedValue({ rows: [{ count: '0' }] });
    mocks.getKnowledgeMessageRepository.mockReturnValue(messageRepository);

    await expect(
      runProjectionRetryOnce(25, { custom_projection: vi.fn<() => Promise<void>>(async () => {}) }),
    ).resolves.toEqual({ selected: 1, succeeded: 1, failed: 0 });

    expect(messageRepository.markMessagesMemoryPending).toHaveBeenCalledWith(
      ['message-1', '42'],
      false,
    );
  });

  it('uses the stored message snapshot when message IDs are unavailable', async () => {
    const record = pendingRecord('custom_projection', {
      messages: [{ id: 'message-1' }, {}, { id: 17 }],
    });
    const messageRepository = { markMessagesMemoryPending: vi.fn<MockProcedure>() };
    mocks.listDueProjectionPending.mockResolvedValue([record]);
    mocks.dbQuery.mockResolvedValue({ rows: [{ count: 0 }] });
    mocks.getKnowledgeMessageRepository.mockReturnValue(messageRepository);

    await runProjectionRetryOnce(25, {
      custom_projection: vi.fn<() => Promise<void>>(async () => {}),
    });

    expect(messageRepository.markMessagesMemoryPending).toHaveBeenCalledWith(
      ['message-1', '17'],
      false,
    );
  });

  it('keeps messages marked pending while another projection remains unsettled', async () => {
    const record = pendingRecord('custom_projection', { messageIds: ['message-1'] });
    const messageRepository = { markMessagesMemoryPending: vi.fn<MockProcedure>() };
    mocks.listDueProjectionPending.mockResolvedValue([record]);
    mocks.getKnowledgeMessageRepository.mockReturnValue(messageRepository);

    await runProjectionRetryOnce(25, {
      custom_projection: vi.fn<() => Promise<void>>(async () => {}),
    });

    expect(messageRepository.markMessagesMemoryPending).not.toHaveBeenCalled();
  });

  it('normalizes a non-Error retry failure before persisting it', async () => {
    const record = pendingRecord('custom_projection');
    mocks.listDueProjectionPending.mockResolvedValue([record]);

    await expect(
      runProjectionRetryOnce(25, {
        custom_projection: vi.fn<MockProcedure>().mockRejectedValue('offline'),
      }),
    ).resolves.toEqual({ selected: 1, succeeded: 0, failed: 1 });

    expect(mocks.markProjectionPendingFailed).toHaveBeenCalledWith(record.id, 'offline');
  });

  it('reprojects a world-model window from its raw extraction and sequence range', async () => {
    const record = pendingRecord('world_model_window', {
      conversationId: 'conversation-1',
      fromSeqExclusive: '2',
      toSeqInclusive: '4',
      rawExtraction: extraction,
    });
    const projection = { assertions: [{ subject: 'Alice' }] };
    mocks.listDueProjectionPending.mockResolvedValue([record]);
    mocks.normalizeExtraction.mockReturnValue(projection);

    await expect(runProjectionRetryOnce()).resolves.toEqual({
      selected: 1,
      succeeded: 1,
      failed: 0,
    });

    expect(mocks.normalizeExtraction).toHaveBeenCalledWith({
      result: extraction,
      workspaceId: 'workspace-1',
      userId: 'user-1',
      personaId: 'assistant',
    });
    expect(mocks.projectWindow).toHaveBeenCalledWith(
      expect.objectContaining({
        scope,
        projection,
        extraction,
        observation: expect.objectContaining({
          sourceType: 'automation',
          sourceId: 'window-1',
          sourceAuthority: 'persona',
          payload: expect.objectContaining({
            conversationId: 'conversation-1',
            fromSeq: 3,
            toSeq: 4,
            windowId: 'window-1',
            rawExtraction: extraction,
          }),
        }),
      }),
    );
  });

  it('defaults omitted projection sequence and workspace values', async () => {
    const record = pendingRecord(
      'world_model_window',
      { rawExtraction: extraction },
      { scope: { ...scope, workspaceId: undefined } },
    );
    mocks.listDueProjectionPending.mockResolvedValue([record]);

    await expect(runProjectionRetryOnce()).resolves.toEqual({
      selected: 1,
      succeeded: 1,
      failed: 0,
    });

    expect(mocks.normalizeExtraction).toHaveBeenCalledWith({
      result: extraction,
      workspaceId: '',
      userId: 'user-1',
      personaId: 'assistant',
    });
    expect(mocks.projectWindow).toHaveBeenCalledWith(
      expect.objectContaining({
        observation: expect.objectContaining({
          workspaceId: '',
          payload: expect.objectContaining({ conversationId: '', fromSeq: 1, toSeq: 0 }),
        }),
      }),
    );
  });

  it('records a missing raw extraction as a retry failure', async () => {
    const record = pendingRecord('world_model_window');
    mocks.listDueProjectionPending.mockResolvedValue([record]);

    await expect(runProjectionRetryOnce()).resolves.toEqual({
      selected: 1,
      succeeded: 0,
      failed: 1,
    });

    expect(mocks.projectWindow).not.toHaveBeenCalled();
    expect(mocks.markProjectionPendingFailed).toHaveBeenCalledWith(
      record.id,
      'projection retry payload has no raw extraction',
    );
  });

  it('retries non-empty Mem0 facts using the scoped storeMemory contract', async () => {
    const record = pendingRecord('mem0_fact', {
      facts: [' Keep this fact. ', '  ', null, 'Second fact'],
    });
    const storeMemory = vi.fn<MockProcedure>().mockResolvedValue({ id: 'memory-1' });
    mocks.listDueProjectionPending.mockResolvedValue([record]);
    mocks.getMemoryProviderKind.mockReturnValue('mem0');
    mocks.getMemoryService.mockReturnValue({ storeMemory });

    await expect(runProjectionRetryOnce()).resolves.toEqual({
      selected: 1,
      succeeded: 1,
      failed: 0,
    });

    expect(storeMemory).toHaveBeenCalledTimes(2);
    expect(storeMemory).toHaveBeenNthCalledWith(1, {
      personaId: 'assistant',
      type: 'fact',
      content: 'Keep this fact.',
      importance: 3,
      userId: 'user-1',
      metadata: {
        sourceType: 'world_model_projection_retry',
        sourceObservationId: 'observation-1',
        projectionPendingId: record.id,
        idempotencyKey: `world-model-retry:${record.id}:0`,
      },
    });
    expect(storeMemory.mock.calls[1]?.[0]).toMatchObject({
      content: 'Second fact',
      metadata: { idempotencyKey: `world-model-retry:${record.id}:3` },
    });
  });

  it('fails factual Mem0 retries when canonical policy blocks writes', async () => {
    const record = pendingRecord('mem0_fact', { facts: ['blocked fact'] });
    mocks.listDueProjectionPending.mockResolvedValue([record]);
    mocks.getMemoryProviderKind.mockReturnValue('mem0');
    mocks.isMem0FactualWriteBlocked.mockReturnValue(true);

    await expect(runProjectionRetryOnce()).resolves.toEqual({
      selected: 1,
      succeeded: 0,
      failed: 1,
    });

    expect(mocks.getMemoryService).not.toHaveBeenCalled();
    expect(mocks.markProjectionPendingFailed).toHaveBeenCalledWith(
      record.id,
      'Mem0 factual projection is disabled in canonical mode',
    );
  });

  it('settles an empty or non-array Mem0 fact payload without writing memories', async () => {
    const record = pendingRecord('mem0_fact', { facts: 'not-an-array' });
    mocks.listDueProjectionPending.mockResolvedValue([record]);
    mocks.getMemoryProviderKind.mockReturnValue('mem0');

    await expect(runProjectionRetryOnce()).resolves.toEqual({
      selected: 1,
      succeeded: 1,
      failed: 0,
    });

    expect(mocks.getMemoryService).toHaveBeenCalledOnce();
    expect(mocks.getMemoryService.mock.results[0]?.value.storeMemory).not.toHaveBeenCalled();
    expect(mocks.getMemoryService.mock.results[0]?.value.store).not.toHaveBeenCalled();
  });

  it('uses the legacy memory store method when storeMemory is unavailable', async () => {
    const record = pendingRecord('mem0_fact', { facts: ['  Stored through legacy API  '] });
    const store = vi.fn<MockProcedure>().mockResolvedValue({});
    mocks.listDueProjectionPending.mockResolvedValue([record]);
    mocks.getMemoryService.mockReturnValue({ store });

    await expect(runProjectionRetryOnce()).resolves.toMatchObject({ succeeded: 1, failed: 0 });

    expect(store).toHaveBeenCalledWith(
      'assistant',
      'fact',
      'Stored through legacy API',
      3,
      'user-1',
      {
        sourceType: 'world_model_projection_retry',
        sourceObservationId: 'observation-1',
        projectionPendingId: record.id,
        idempotencyKey: `world-model-retry:${record.id}:0`,
      },
    );
  });

  it('replays SQLite knowledge from message snapshots and preserves ingestion metadata', async () => {
    const record = pendingRecord('sqlite_knowledge', {
      conversationId: 'conversation-1',
      fromSeqExclusive: '3',
      toSeqInclusive: '5',
      personaName: 'Assistant',
      facts: [' saved fact ', ' ', null],
      memoryIds: ['memory-1', null, 17],
      rawExtraction: extraction,
      messages: [
        {
          id: 'message-1',
          conversationId: 'message-conversation',
          seq: '4',
          role: 'assistant',
          content: 'A saved response.',
          platform: 'telegram',
          externalMsgId: 'external-1',
          senderName: 'Alice',
          metadata: '{"source":"test"}',
          createdAt: '2026-10-08T09:00:00.000Z',
        },
        {
          seq: 5,
          content: 'A user reply.',
          externalMsgId: '',
          senderName: '',
          metadata: null,
          createdAt: '2026-10-08T09:01:00.000Z',
        },
      ],
    });
    const repository = {};
    mocks.listDueProjectionPending.mockResolvedValue([record]);
    mocks.getKnowledgeRepository.mockReturnValue(repository);
    mocks.processMeetingLedger.mockReturnValue({
      decisions: ['decision'],
      negotiatedTerms: ['term'],
      openPoints: ['open'],
      actionItems: ['action'],
    });

    await expect(runProjectionRetryOnce()).resolves.toMatchObject({ succeeded: 1, failed: 0 });

    expect(mocks.upsertEpisodeAndLedger).toHaveBeenCalledWith(repository, {
      window: {
        conversationId: 'conversation-1',
        userId: 'user-1',
        personaId: 'assistant',
        workspaceId: 'workspace-1',
        fromSeqExclusive: 3,
        toSeqInclusive: 5,
        messages: [
          {
            id: 'message-1',
            conversationId: 'message-conversation',
            seq: 4,
            role: 'assistant',
            content: 'A saved response.',
            platform: 'telegram',
            externalMsgId: 'external-1',
            senderName: 'Alice',
            metadata: '{"source":"test"}',
            createdAt: '2026-10-08T09:00:00.000Z',
          },
          {
            id: 'window-1:5',
            conversationId: 'conversation-1',
            seq: 5,
            role: 'user',
            content: 'A user reply.',
            platform: 'webchat',
            externalMsgId: null,
            senderName: null,
            metadata: null,
            createdAt: '2026-10-08T09:01:00.000Z',
          },
        ],
      },
      extraction,
      facts: [' saved fact ', ' '],
      memoryIds: ['memory-1', '17'],
      filteredDecisions: ['decision'],
      filteredNegotiatedTerms: ['term'],
      filteredOpenPoints: ['open'],
      filteredActionItems: ['action'],
    });
    expect(mocks.storeEvents).toHaveBeenCalledWith(repository, {
      window: expect.objectContaining({ conversationId: 'conversation-1' }),
      extraction,
      personaName: 'Assistant',
    });
    expect(mocks.storeEntities).toHaveBeenCalledWith(repository, {
      window: expect.objectContaining({ conversationId: 'conversation-1' }),
      entities: [],
    });
    expect(mocks.processFacts).not.toHaveBeenCalled();
  });

  it('reconstructs a minimal SQLite snapshot from defaults and derived facts', async () => {
    const record = pendingRecord(
      'sqlite_knowledge',
      {
        rawExtraction: extraction,
        messages: [{ seq: 7 }],
      },
      { scope: { ...scope, workspaceId: undefined } },
    );
    const repository = {};
    mocks.listDueProjectionPending.mockResolvedValue([record]);
    mocks.dbQuery.mockResolvedValue({ rows: [] });
    mocks.getKnowledgeRepository.mockReturnValue(repository);
    mocks.getKnowledgeMessageRepository.mockReturnValue({});
    mocks.processFacts.mockReturnValue(['derived fact']);

    await expect(runProjectionRetryOnce()).resolves.toEqual({
      selected: 1,
      succeeded: 1,
      failed: 0,
    });

    expect(mocks.upsertEpisodeAndLedger).toHaveBeenCalledWith(
      repository,
      expect.objectContaining({
        window: expect.objectContaining({
          conversationId: '',
          workspaceId: '',
          fromSeqExclusive: 0,
          toSeqInclusive: 7,
          messages: [
            expect.objectContaining({
              id: 'window-1:7',
              conversationId: '',
              seq: 7,
              role: 'user',
              content: '',
              platform: 'webchat',
              externalMsgId: null,
              senderName: null,
              metadata: null,
              createdAt: expect.any(String),
            }),
          ],
        }),
        facts: ['derived fact'],
        memoryIds: [],
      }),
    );
    expect(mocks.processFacts).toHaveBeenCalledWith(
      extraction,
      expect.objectContaining({ conversationId: '' }),
    );
    expect(mocks.storeEvents).toHaveBeenCalledWith(repository, {
      window: expect.objectContaining({ conversationId: '' }),
      extraction,
      personaName: 'assistant',
    });
  });

  it('rejects SQLite retries without a message snapshot', async () => {
    const record = pendingRecord('sqlite_knowledge', {
      rawExtraction: extraction,
      messages: 'not-an-array',
    });
    mocks.listDueProjectionPending.mockResolvedValue([record]);

    await expect(runProjectionRetryOnce()).resolves.toEqual({
      selected: 1,
      succeeded: 0,
      failed: 1,
    });
    expect(mocks.markProjectionPendingFailed).toHaveBeenCalledWith(
      record.id,
      'sqlite knowledge retry payload has no source messages',
    );
  });
});

describe('startProjectionRetryWorker', () => {
  it('schedules and stops the default interval', () => {
    vi.useFakeTimers();
    const worker = startProjectionRetryWorker();

    expect(vi.getTimerCount()).toBe(1);
    worker.stop();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('logs tick failures and keeps the interval alive until stopped', async () => {
    const error = new Error('pending query failed');
    mocks.listDueProjectionPending.mockRejectedValue(error);
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.useFakeTimers();
    const worker = startProjectionRetryWorker(100);

    await vi.advanceTimersByTimeAsync(200);

    expect(mocks.listDueProjectionPending).toHaveBeenCalledTimes(2);
    expect(console.error).toHaveBeenCalledWith(
      '[world-model:projection-retry] worker tick failed:',
      error,
    );
    worker.stop();
    expect(vi.getTimerCount()).toBe(0);
  });
});
