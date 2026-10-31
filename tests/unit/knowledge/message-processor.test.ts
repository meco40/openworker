import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  getWorldModelConfig: vi.fn<MockProcedure>(),
  isWorldModelRequired: vi.fn<MockProcedure>(),
  detectDominantEmotion: vi.fn<MockProcedure>(),
  detectCorrections: vi.fn<MockProcedure>(),
  processFacts: vi.fn<MockProcedure>(),
  processMeetingLedger: vi.fn<MockProcedure>(),
  storeFacts: vi.fn<MockProcedure>(),
  storeEvents: vi.fn<MockProcedure>(),
  storeEntities: vi.fn<MockProcedure>(),
  normalizeSelfReferences: vi.fn<MockProcedure>(),
  validateEventSpeakerRoles: vi.fn<MockProcedure>(),
  upsertEpisodeAndLedger: vi.fn<MockProcedure>(),
  storeTaskCompletions: vi.fn<MockProcedure>(),
  projectWindow: vi.fn<MockProcedure>(),
  enqueueProjectionPending: vi.fn<MockProcedure>(),
  detectTaskCompletion: vi.fn<MockProcedure>(),
  getObservationById: vi.fn<MockProcedure>(),
  matchStandingIntents: vi.fn<MockProcedure>(),
  processIncomingStandingIntents: vi.fn<MockProcedure>(),
}));

vi.mock('@/server/world-model/config', () => ({ getWorldModelConfig: mocks.getWorldModelConfig }));
vi.mock('@/server/world-model/mode', () => ({ isWorldModelRequired: mocks.isWorldModelRequired }));
vi.mock('@/server/knowledge/ingestion/emotionTracker', () => ({
  detectDominantEmotion: mocks.detectDominantEmotion,
}));
vi.mock('@/server/knowledge/ingestion/factExtractor', () => ({
  detectCorrections: mocks.detectCorrections,
  processFacts: mocks.processFacts,
  processMeetingLedger: mocks.processMeetingLedger,
  storeFacts: mocks.storeFacts,
}));
vi.mock('@/server/knowledge/ingestion/eventExtractor', () => ({ storeEvents: mocks.storeEvents }));
vi.mock('@/server/knowledge/ingestion/entityExtractor', () => ({
  storeEntities: mocks.storeEntities,
  normalizeSelfReferences: mocks.normalizeSelfReferences,
  validateEventSpeakerRoles: mocks.validateEventSpeakerRoles,
}));
vi.mock('@/server/knowledge/ingestion/episodeExtractor', () => ({
  upsertEpisodeAndLedger: mocks.upsertEpisodeAndLedger,
}));
vi.mock('@/server/knowledge/ingestion/taskCompletion', () => ({
  storeTaskCompletions: mocks.storeTaskCompletions,
}));
vi.mock('@/server/world-model/projector/projectWindow', () => ({
  projectWindow: mocks.projectWindow,
}));
vi.mock('@/server/world-model/repositories/projectionPendingRepository', () => ({
  enqueueProjectionPending: mocks.enqueueProjectionPending,
}));
vi.mock('@/server/knowledge/taskTracker', () => ({
  detectTaskCompletion: mocks.detectTaskCompletion,
}));
vi.mock('@/server/world-model/repositories/observationRepository', () => ({
  getObservationById: mocks.getObservationById,
}));
vi.mock('@/server/world-model/services/prospectiveEngine', () => ({
  matchStandingIntents: mocks.matchStandingIntents,
}));
vi.mock('@/server/world-model/services/standingIntentCompiler', () => ({
  processIncomingStandingIntents: mocks.processIncomingStandingIntents,
}));

import type { StoredMessage } from '@/server/channels/messages/repository';
import type { KnowledgeExtractionResult } from '@/server/knowledge/extractor';
import type { IngestionWindow } from '@/server/knowledge/ingestionCursor';
import {
  buildPersonaContext,
  normalizeExtractionSelfReferences,
  processWindow,
} from '@/server/knowledge/ingestion/messageProcessor';
import type { MockProcedure } from '../../helpers/mockProcedure';

function message(
  seq: number,
  role: 'user' | 'agent',
  content: string,
  id = `processor-${seq}`,
): StoredMessage {
  return {
    id,
    conversationId: 'conversation-processor',
    seq,
    role,
    content,
    platform: 'WebChat' as never,
    externalMsgId: null,
    senderName: null,
    metadata: null,
    createdAt: '2026-10-08T08:00:00.000Z',
  };
}

function extraction(overrides: Partial<KnowledgeExtractionResult> = {}): KnowledgeExtractionResult {
  return {
    facts: ['A retained fact'],
    teaser: 'A short summary.',
    episode: 'The conversation captured a useful fact.',
    entities: [],
    events: [],
    meetingLedger: {
      topicKey: 'general',
      counterpart: null,
      participants: [],
      decisions: [],
      negotiatedTerms: [],
      openPoints: [],
      actionItems: [],
      sourceRefs: [],
      confidence: 0.8,
    },
    ...overrides,
  };
}

function context(
  options: {
    extraction?: KnowledgeExtractionResult;
    messages?: StoredMessage[];
    workspaceId?: string;
    markMessagesMemoryPending?: (ids: string[], pending: boolean, reason?: string) => void;
  } = {},
) {
  const window: IngestionWindow = {
    conversationId: 'conversation-processor',
    userId: 'user-processor',
    personaId: 'persona-processor',
    workspaceId: options.workspaceId,
    fromSeqExclusive: 0,
    toSeqInclusive: 2,
    messages: options.messages ?? [
      message(1, 'user', 'A question from the user.', 'message-1'),
      message(2, 'agent', 'A response from the assistant.', 'message-2'),
    ],
  };
  const repo = {
    upsertEpisode: vi.fn<MockProcedure>(),
    upsertMeetingLedger: vi.fn<MockProcedure>(),
  };
  const markMessagesMemoryPending = options.markMessagesMemoryPending;
  return {
    window,
    repo,
    markMessagesMemoryPending,
    extractor: {
      extract: vi.fn<() => Promise<KnowledgeExtractionResult>>(
        async () => options.extraction ?? extraction(),
      ),
    },
  };
}

describe('knowledge message processor', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.getWorldModelConfig.mockReturnValue({
      enabled: false,
      e2eEnabled: false,
      mode: 'shadow',
    });
    mocks.isWorldModelRequired.mockReturnValue(false);
    mocks.detectDominantEmotion.mockReturnValue(null);
    mocks.detectCorrections.mockReturnValue([]);
    mocks.processFacts.mockImplementation((result: KnowledgeExtractionResult) => result.facts);
    mocks.processMeetingLedger.mockReturnValue({
      decisions: [],
      negotiatedTerms: [],
      openPoints: [],
      actionItems: [],
    });
    mocks.storeFacts.mockResolvedValue({ memoryIds: [], pendingCount: 0, failCount: 0 });
    mocks.storeEvents.mockResolvedValue({ stored: 0, confirmed: 0 });
    mocks.storeEntities.mockReturnValue({ created: 0, merged: 0, relationsAdded: 0 });
    mocks.storeTaskCompletions.mockResolvedValue([]);
    mocks.projectWindow.mockResolvedValue({ observationId: 'observation-1' });
    mocks.enqueueProjectionPending.mockImplementation(async () => {});
    mocks.detectTaskCompletion.mockReturnValue(null);
    mocks.getObservationById.mockResolvedValue(null);
    mocks.processIncomingStandingIntents.mockImplementation(async () => {});
  });

  afterEach(() => vi.restoreAllMocks());

  it('resolves persona names and normalizes only recognized self-references', () => {
    expect(
      buildPersonaContext({
        conversationId: 'c',
        userId: 'u',
        personaId: 'p',
        fromSeqExclusive: 0,
        toSeqInclusive: 0,
        messages: [],
      }),
    ).toMatchObject({ personaName: 'p', personaContext: { name: 'p' } });
    expect(
      buildPersonaContext(
        {
          conversationId: 'c',
          userId: 'u',
          personaId: 'p',
          fromSeqExclusive: 0,
          toSeqInclusive: 0,
          messages: [],
        },
        () => 'Lea',
      ).personaName,
    ).toBe('Lea');

    const noEntities = extraction({ entities: undefined });
    normalizeExtractionSelfReferences(noEntities, 'Lea', 'persona-processor');
    expect(mocks.normalizeSelfReferences).not.toHaveBeenCalled();

    const sameName = extraction();
    normalizeExtractionSelfReferences(sameName, 'persona-processor', 'persona-processor');
    expect(mocks.normalizeSelfReferences).not.toHaveBeenCalled();

    const withSelfReferences = extraction({
      events: [
        {
          eventType: 'meeting',
          speakerRole: 'user',
          subject: 'Ich',
          counterpart: 'myself',
          relationLabel: null,
          timeExpression: 'today',
          startDate: '2026-10-08',
          endDate: '2026-10-08',
          dayCount: 1,
          isConfirmation: false,
          confirmationSignals: [],
          sourceSeq: [1],
        },
      ],
    });
    normalizeExtractionSelfReferences(withSelfReferences, 'Lea', 'persona-processor');
    expect(withSelfReferences.events?.[0]).toMatchObject({ subject: 'Lea', counterpart: 'Lea' });
    expect(mocks.normalizeSelfReferences).toHaveBeenCalledWith([], 'Lea', 'persona-processor');
  });

  it('keeps the legacy store path when canonical World Model projection is disabled', async () => {
    const input = context();
    const result = await processWindow(input);

    expect(result).toMatchObject({
      factsStored: 0,
      eventsStored: 0,
      entitiesCreated: 0,
      entitiesMerged: 0,
      mem0PendingCount: 0,
      worldModelProjected: false,
    });
    expect(mocks.projectWindow).not.toHaveBeenCalled();
    expect(mocks.storeFacts).toHaveBeenCalledOnce();
    expect(mocks.storeEvents).toHaveBeenCalledOnce();
    expect(input.markMessagesMemoryPending).toBeUndefined();
  });

  it('projects canonical knowledge, captures completed-task evidence and matches intents', async () => {
    mocks.getWorldModelConfig.mockReturnValue({ enabled: false, e2eEnabled: true, mode: 'shadow' });
    mocks.getObservationById.mockResolvedValue({ id: 'observation-1' });
    mocks.detectTaskCompletion.mockReturnValue({ matchConfidence: 0.93 });
    const input = context({
      extraction: extraction({
        meetingLedger: {
          topicKey: 'launch',
          counterpart: null,
          participants: [],
          decisions: [],
          negotiatedTerms: [],
          openPoints: [],
          actionItems: ['Send the launch email'],
          sourceRefs: [],
          confidence: 0.9,
        },
      }),
      messages: [
        message(1, 'user', 'I sent the launch email.', 'user-message'),
        message(2, 'agent', 'Thanks.', 'agent-message'),
      ],
    });

    const result = await processWindow(input);
    expect(result).toMatchObject({
      worldModelProjected: true,
      worldModelObservationId: 'observation-1',
    });
    expect(mocks.projectWindow).toHaveBeenCalledWith(
      expect.objectContaining({
        scope: { userId: input.window.userId, personaId: input.window.personaId, workspaceId: '' },
        completedTaskEvidence: [
          expect.objectContaining({
            title: 'Send the launch email',
            messageSeq: 1,
            evidenceText: 'I sent the launch email.',
            confidence: 0.93,
          }),
        ],
      }),
    );
    expect(mocks.processIncomingStandingIntents).toHaveBeenCalledOnce();
    expect(mocks.matchStandingIntents).toHaveBeenCalledWith({ id: 'observation-1' });
    expect(mocks.getObservationById).toHaveBeenCalledWith('observation-1', {
      userId: input.window.userId,
      personaId: input.window.personaId,
      workspaceId: '',
    });
  });

  it('queues fail-soft canonical projection errors and continues legacy projections', async () => {
    mocks.getWorldModelConfig.mockReturnValue({ enabled: true, e2eEnabled: false, mode: 'shadow' });
    mocks.projectWindow.mockRejectedValue(new Error('canonical database unavailable'));
    const markPending = vi.fn<MockProcedure>();
    const input = context({ markMessagesMemoryPending: markPending });
    vi.spyOn(console, 'error').mockImplementation(() => {});

    const result = await processWindow(input);
    expect(result.worldModelProjected).toBe(false);
    expect(markPending).toHaveBeenCalledWith(
      ['message-1', 'message-2'],
      true,
      'canonical database unavailable',
    );
    expect(mocks.enqueueProjectionPending).toHaveBeenCalledWith(
      expect.objectContaining({
        projectionType: 'world_model_window',
        sourceWindowId: 'conversation-processor:1-2',
        errorMessage: 'canonical database unavailable',
      }),
    );
    expect(mocks.storeFacts).toHaveBeenCalledOnce();
  });

  it('does not swallow required-mode projection failures or depend on retry persistence', async () => {
    mocks.getWorldModelConfig.mockReturnValue({
      enabled: true,
      e2eEnabled: false,
      mode: 'required',
    });
    mocks.isWorldModelRequired.mockReturnValue(true);
    mocks.projectWindow.mockRejectedValue('required projection failed');
    const markPending = vi.fn<MockProcedure>();
    const input = context({ markMessagesMemoryPending: markPending });

    await expect(processWindow(input)).rejects.toBe('required projection failed');
    expect(markPending).toHaveBeenCalledWith(
      ['message-1', 'message-2'],
      true,
      'required projection failed',
    );
    expect(mocks.enqueueProjectionPending).not.toHaveBeenCalled();
    expect(mocks.storeFacts).not.toHaveBeenCalled();
  });

  it('returns early on legacy memory retry and enqueues canonical memory retries after commit', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    mocks.storeFacts.mockResolvedValue({ memoryIds: ['memory-1'], pendingCount: 1, failCount: 2 });
    const legacy = await processWindow(context());
    expect(legacy).toMatchObject({
      factsStored: 1,
      mem0FailCount: 2,
      mem0PendingCount: 1,
      eventsStored: 0,
      worldModelProjected: false,
    });
    expect(mocks.storeEvents).not.toHaveBeenCalled();

    vi.clearAllMocks();
    mocks.getWorldModelConfig.mockReturnValue({ enabled: true, e2eEnabled: false, mode: 'shadow' });
    mocks.projectWindow.mockResolvedValue({ observationId: 'observation-2' });
    mocks.storeFacts.mockResolvedValue({ memoryIds: ['memory-2'], pendingCount: 1, failCount: 1 });
    const markPending = vi.fn<MockProcedure>();
    const canonical = await processWindow(context({ markMessagesMemoryPending: markPending }));
    expect(canonical.worldModelProjected).toBe(true);
    expect(mocks.enqueueProjectionPending).toHaveBeenCalledWith(
      expect.objectContaining({
        projectionType: 'mem0_fact',
        sourceObservationId: 'observation-2',
        payload: expect.objectContaining({
          facts: ['A retained fact'],
          messageIds: ['message-1', 'message-2'],
        }),
      }),
    );
    expect(markPending).toHaveBeenCalledWith(
      ['message-1', 'message-2'],
      true,
      '1 factual Mem0 projection(s) pending',
    );
    expect(markPending).not.toHaveBeenCalledWith(['message-1', 'message-2'], false);
    expect(console.warn).toHaveBeenCalledWith(
      '[knowledge-ingestion] Mem0 projection incomplete after canonical commit:',
      1,
    );
  });

  it('keeps SQLite projection failures retryable in canonical mode and throws in legacy mode', async () => {
    mocks.getWorldModelConfig.mockReturnValue({ enabled: true, e2eEnabled: false, mode: 'shadow' });
    mocks.upsertEpisodeAndLedger.mockImplementation(() => {
      throw new Error('SQLite knowledge store unavailable');
    });
    const markPending = vi.fn<MockProcedure>();
    const input = context({ markMessagesMemoryPending: markPending });
    vi.spyOn(console, 'error').mockImplementation(() => {});

    const result = await processWindow(input);
    expect(result.worldModelProjected).toBe(true);
    expect(mocks.enqueueProjectionPending).toHaveBeenCalledWith(
      expect.objectContaining({
        projectionType: 'sqlite_knowledge',
        sourceObservationId: 'observation-1',
        errorMessage: 'SQLite knowledge store unavailable',
      }),
    );
    expect(markPending).toHaveBeenCalledWith(
      ['message-1', 'message-2'],
      true,
      'SQLite knowledge store unavailable',
    );
    expect(markPending).not.toHaveBeenCalledWith(['message-1', 'message-2'], false);

    mocks.getWorldModelConfig.mockReturnValue({
      enabled: false,
      e2eEnabled: false,
      mode: 'shadow',
    });
    await expect(processWindow(context())).rejects.toThrow('SQLite knowledge store unavailable');
  });
});
