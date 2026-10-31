import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  withWorldModelTransaction: vi.fn<MockProcedure>(),
  clientQuery: vi.fn<MockProcedure>(),
  getWorldModelConfig: vi.fn<MockProcedure>(),
  insertObservationWithResult: vi.fn<MockProcedure>(),
  enqueueOutboxEvent: vi.fn<MockProcedure>(),
  upsertEntity: vi.fn<MockProcedure>(),
  resolveEntity: vi.fn<MockProcedure>(),
  insertRelation: vi.fn<MockProcedure>(),
  insertAssertion: vi.fn<MockProcedure>(),
  insertEvent: vi.fn<MockProcedure>(),
  insertEventTransition: vi.fn<MockProcedure>(),
  insertOpenLoop: vi.fn<MockProcedure>(),
  insertTask: vi.fn<MockProcedure>(),
  completeTaskWithEvidence: vi.fn<MockProcedure>(),
  applyPlanChangeInTx: vi.fn<MockProcedure>(),
  confirmEventOutcomeInTx: vi.fn<MockProcedure>(),
  findStructuredEvents: vi.fn<MockProcedure>(),
  classifyEventUtterance: vi.fn<MockProcedure>(),
  pickEventCandidate: vi.fn<MockProcedure>(),
}));

vi.mock('@/server/world-model/db', () => ({
  withWorldModelTransaction: mocks.withWorldModelTransaction,
}));
vi.mock('@/server/world-model/config', () => ({ getWorldModelConfig: mocks.getWorldModelConfig }));
vi.mock('@/server/world-model/repositories/observationRepository', () => ({
  insertObservationWithResult: mocks.insertObservationWithResult,
}));
vi.mock('@/server/world-model/repositories/outboxRepository', () => ({
  enqueueOutboxEvent: mocks.enqueueOutboxEvent,
}));
vi.mock('@/server/world-model/repositories/entityRepository', () => ({
  upsertEntity: mocks.upsertEntity,
  insertRelation: mocks.insertRelation,
}));
vi.mock('@/server/world-model/repositories/assertionRepository', () => ({
  insertAssertion: mocks.insertAssertion,
}));
vi.mock('@/server/world-model/repositories/eventRepository', () => ({
  insertEvent: mocks.insertEvent,
  insertEventTransition: mocks.insertEventTransition,
}));
vi.mock('@/server/world-model/repositories/prospectiveRepository', () => ({
  insertOpenLoop: mocks.insertOpenLoop,
}));
vi.mock('@/server/world-model/repositories/taskRepository', () => ({
  completeTaskWithEvidence: mocks.completeTaskWithEvidence,
  insertTask: mocks.insertTask,
}));
vi.mock('@/server/world-model/services/eventService', () => ({
  applyPlanChangeInTx: mocks.applyPlanChangeInTx,
  confirmEventOutcomeInTx: mocks.confirmEventOutcomeInTx,
}));
vi.mock('@/server/world-model/services/entityService', () => ({
  resolveEntity: mocks.resolveEntity,
}));
vi.mock('@/server/world-model/retrieval/structured', () => ({
  findStructuredEvents: mocks.findStructuredEvents,
}));
vi.mock('@/server/world-model/services/eventLinker', () => ({
  classifyEventUtterance: mocks.classifyEventUtterance,
  pickEventCandidate: mocks.pickEventCandidate,
}));

import type { KnowledgeExtractionResult } from '@/server/knowledge/extractor';
import { projectWindow } from '@/server/world-model/projector/projectWindow';
import type { ProjectedEvent, WorldModelProjection } from '@/server/world-model/projector/types';
import type { ObservationInput } from '@/server/world-model/types';
import type { MockProcedure } from '../../helpers/mockProcedure';

const scope = { userId: 'user-a', personaId: 'assistant' };

function projection(overrides: Partial<WorldModelProjection> = {}): WorldModelProjection {
  return {
    assertions: [],
    events: [],
    entities: [],
    relations: [],
    openLoops: [],
    tasks: [],
    confidenceSummary: { total: 0, confident: 0 },
    ...overrides,
  };
}

function observation(payload: Record<string, unknown> = {}): ObservationInput {
  return {
    ...scope,
    sourceType: 'manual',
    sourceId: 'source-1',
    occurredAt: '2026-10-08T09:00:00.000Z',
    payload,
  };
}

function event(overrides: Partial<ProjectedEvent> = {}): ProjectedEvent {
  return {
    title: 'Kino',
    eventType: 'activity',
    status: 'planned',
    sourceMessageSeq: 1,
    ...overrides,
  };
}

function extractedEvent(overrides: Record<string, unknown> = {}) {
  return {
    sourceSeq: [1],
    subject: 'Kino',
    eventType: 'activity',
    isConfirmation: false,
    confirmationSignals: [],
    ...overrides,
  };
}

function extraction(
  events: Array<Record<string, unknown>>,
  episode = 'Kino',
): KnowledgeExtractionResult {
  return { events, episode } as unknown as KnowledgeExtractionResult;
}

beforeEach(() => {
  vi.resetAllMocks();
  const client = { query: mocks.clientQuery };
  mocks.withWorldModelTransaction.mockImplementation(
    async (callback: (db: typeof client) => unknown) => callback(client),
  );
  mocks.clientQuery.mockResolvedValue({ rows: [] });
  mocks.getWorldModelConfig.mockReturnValue({
    graphitiShadowEnabled: false,
    graphitiBackendEnabled: false,
  });
  mocks.insertObservationWithResult.mockImplementation(async (input: ObservationInput) => ({
    created: true,
    observation: { ...input, id: 'observation-1', receivedAt: '2026-10-08T09:00:00.000Z' },
  }));
  mocks.enqueueOutboxEvent.mockImplementation(async () => {});
  mocks.upsertEntity.mockResolvedValue({ id: 'entity-created' });
  mocks.resolveEntity.mockResolvedValue({ entityId: 'entity-existing', ambiguous: false });
  mocks.insertRelation.mockImplementation(async () => {});
  mocks.insertAssertion.mockImplementation(async () => {});
  mocks.insertEvent.mockResolvedValue({ id: 'event-created' });
  mocks.insertEventTransition.mockImplementation(async () => {});
  mocks.insertOpenLoop.mockImplementation(async () => {});
  mocks.insertTask.mockResolvedValue({ id: 'task-created' });
  mocks.completeTaskWithEvidence.mockImplementation(async () => {});
  mocks.applyPlanChangeInTx.mockImplementation(async () => {});
  mocks.confirmEventOutcomeInTx.mockImplementation(async () => {});
  mocks.findStructuredEvents.mockResolvedValue([]);
  mocks.classifyEventUtterance.mockReturnValue('plan');
  mocks.pickEventCandidate.mockReturnValue(null);
});

afterEach(() => vi.restoreAllMocks());

describe('projectWindow', () => {
  it('writes graph outbox events and projects entities, relations, assertions, loops, and tasks', async () => {
    mocks.getWorldModelConfig.mockReturnValue({
      graphitiShadowEnabled: true,
      graphitiBackendEnabled: false,
    });
    mocks.resolveEntity
      .mockResolvedValueOnce({ entityId: 'source-id', ambiguous: false })
      .mockResolvedValueOnce({ entityId: 'target-id', ambiguous: false })
      .mockResolvedValueOnce({ entityId: undefined, ambiguous: false })
      .mockResolvedValueOnce({ entityId: 'target-id', ambiguous: false })
      .mockResolvedValueOnce({ entityId: 'source-id', ambiguous: false })
      .mockResolvedValueOnce({ entityId: 'target-id', ambiguous: true })
      .mockResolvedValueOnce({ entityId: 'known-subject', ambiguous: false })
      .mockResolvedValueOnce({ entityId: undefined, ambiguous: true })
      .mockResolvedValueOnce({ entityId: undefined, ambiguous: false });

    const result = await projectWindow({
      scope,
      observation: observation({ texts: [{}, { content: 'A source message.' }] }),
      projection: projection({
        entities: [
          { canonicalName: 'Alice', category: 'person', owner: 'shared', sourceMessageSeq: 1 },
        ],
        relations: [
          {
            sourceEntity: 'Alice',
            targetEntity: 'Acme',
            relationType: 'works_at',
            confidence: 0.9,
            sourceMessageSeq: 1,
          },
          {
            sourceEntity: 'Unknown',
            targetEntity: 'Acme',
            relationType: 'knows',
            confidence: 0.8,
            sourceMessageSeq: 1,
          },
          {
            sourceEntity: 'Alice',
            targetEntity: 'Ambiguous',
            relationType: 'visits',
            confidence: 0.8,
            sourceMessageSeq: 1,
          },
        ],
        assertions: [
          {
            subject: 'Alice',
            predicate: 'role',
            objectValue: 'engineer',
            modality: 'reported',
            confidence: 0.9,
            sourceMessageSeq: 1,
          },
          {
            subject: 'Ambiguous',
            predicate: 'role',
            objectValue: 'unknown',
            modality: 'reported',
            confidence: 0.6,
            sourceMessageSeq: 1,
          },
          {
            subject: 'Assistant',
            predicate: 'preference',
            objectValue: 'coffee',
            modality: 'confirmed',
            confidence: 0.9,
            sourceMessageSeq: 1,
          },
        ],
        openLoops: [
          {
            type: 'clarification',
            question: 'Which project?',
            deduplicationKey: 'project',
            sourceMessageSeq: 1,
          },
        ],
        tasks: [
          { title: 'Ship report', requester: 'user', assignee: 'assistant', sourceMessageSeq: 1 },
          { title: 'Review plan', requester: 'user', assignee: 'assistant', sourceMessageSeq: 1 },
        ],
      }),
      completedTaskEvidence: [
        {
          title: ' ship REPORT ',
          messageSeq: 2,
          evidenceText: 'The report is sent.',
          confidence: 0.95,
        },
      ],
    });

    expect(result).toMatchObject({
      observationId: 'observation-1',
      entitiesUpserted: 1,
      relationsCreated: 1,
      assertionsCreated: 2,
      openLoopsUpserted: 1,
    });
    expect(mocks.enqueueOutboxEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: 'world.observation.created',
        payload: expect.objectContaining({
          userId: scope.userId,
          workspaceId: '',
          text: 'A source message.',
        }),
      }),
      expect.any(Object),
    );
    expect(mocks.insertRelation).toHaveBeenCalledOnce();
    expect(mocks.insertAssertion).toHaveBeenCalledTimes(2);
    expect(mocks.completeTaskWithEvidence).toHaveBeenCalledOnce();
  });

  it('does not enqueue a duplicate observation or when Graphiti output is disabled', async () => {
    mocks.getWorldModelConfig.mockReturnValue({
      graphitiShadowEnabled: true,
      graphitiBackendEnabled: true,
    });
    mocks.insertObservationWithResult.mockResolvedValue({
      created: false,
      observation: { id: 'observation-1' },
    });

    await projectWindow({ scope, observation: observation(), projection: projection() });
    expect(mocks.enqueueOutboxEvent).not.toHaveBeenCalled();

    mocks.insertObservationWithResult.mockResolvedValue({
      created: true,
      observation: { id: 'observation-2' },
    });
    mocks.getWorldModelConfig.mockReturnValue({
      graphitiShadowEnabled: false,
      graphitiBackendEnabled: false,
    });
    await projectWindow({ scope, observation: observation(), projection: projection() });
    expect(mocks.enqueueOutboxEvent).not.toHaveBeenCalled();
  });

  it('creates a new event and its initial transition when no current candidate matches', async () => {
    const result = await projectWindow({
      scope,
      observation: observation(),
      projection: projection({
        events: [event()],
        confidenceSummary: { total: 4, confident: 3 },
      }),
    });

    expect(result.eventsCreated).toBe(1);
    expect(mocks.insertEvent).toHaveBeenCalledWith(
      expect.objectContaining({ title: 'Kino', replacesEventId: undefined }),
      expect.any(Object),
    );
    expect(mocks.insertEventTransition).toHaveBeenCalledWith(
      expect.objectContaining({ eventId: 'event-created', confidence: 0.75 }),
      expect.any(Object),
    );
  });

  it('uses extracted confirmations to complete a matching active event', async () => {
    mocks.classifyEventUtterance.mockReturnValue('unknown');
    mocks.findStructuredEvents.mockResolvedValue([
      { id: 'existing-event', title: 'Kino plan', status: 'planned', timeline: [] },
    ]);
    mocks.pickEventCandidate.mockImplementation(
      (_kind: unknown, candidates: unknown[]) => candidates[0],
    );
    const result = await projectWindow({
      scope,
      observation: observation({ texts: [{ seq: 1, content: 'Went there yesterday.' }] }),
      projection: projection({ events: [event()] }),
      extraction: extraction([
        extractedEvent({ confirmationSignals: ['done'], isConfirmation: true }),
      ]),
    });

    expect(result.eventsCreated).toBe(1);
    expect(mocks.confirmEventOutcomeInTx).toHaveBeenCalledWith(
      expect.objectContaining({ eventId: 'existing-event', outcome: 'completed' }),
      expect.any(Object),
    );
    expect(mocks.insertEvent).not.toHaveBeenCalled();
  });

  it('reuses a matching planned event as an idempotent replay', async () => {
    mocks.findStructuredEvents.mockResolvedValue([
      { id: 'existing-event', title: 'Kino', status: 'in_progress', timeline: [] },
    ]);
    mocks.pickEventCandidate.mockImplementation(
      (_kind: unknown, candidates: unknown[]) => candidates[0],
    );

    await expect(
      projectWindow({
        scope,
        observation: observation(),
        projection: projection({ events: [event()] }),
      }),
    ).resolves.toMatchObject({ eventsCreated: 1 });
    expect(mocks.insertEvent).not.toHaveBeenCalled();
  });

  it('cancels a matching event and asks for clarification when no candidate is available', async () => {
    mocks.classifyEventUtterance.mockReturnValue('cancellation');
    mocks.findStructuredEvents.mockResolvedValue([
      { id: 'existing-event', title: 'Kino', status: 'planned', timeline: [] },
    ]);
    mocks.pickEventCandidate.mockImplementation(
      (_kind: unknown, candidates: unknown[]) => candidates[0],
    );
    await expect(
      projectWindow({
        scope,
        observation: observation(),
        projection: projection({ events: [event()] }),
      }),
    ).resolves.toMatchObject({ eventsCreated: 1, openLoopsUpserted: 0 });
    expect(mocks.applyPlanChangeInTx).toHaveBeenCalledWith(
      expect.objectContaining({
        eventId: 'existing-event',
        toStatus: 'cancelled',
        reason: 'user changed plan',
      }),
      expect.any(Object),
    );

    mocks.classifyEventUtterance.mockReturnValue('outcome_confirmation');
    mocks.pickEventCandidate.mockReturnValue(null);
    await expect(
      projectWindow({
        scope,
        observation: observation(),
        projection: projection({ events: [event()] }),
      }),
    ).resolves.toMatchObject({ eventsCreated: 0, openLoopsUpserted: 1 });
    expect(mocks.insertOpenLoop).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'clarification' }),
      expect.any(Object),
    );
  });

  it('cancels a matching old event and inserts a replacement with a transition replay check', async () => {
    mocks.classifyEventUtterance.mockReturnValue('change');
    mocks.findStructuredEvents.mockResolvedValue([
      { id: 'old-event', title: 'Kino', status: 'proposed', timeline: [] },
    ]);
    mocks.pickEventCandidate.mockImplementation(
      (_kind: unknown, candidates: unknown[]) => candidates[0],
    );
    mocks.clientQuery.mockResolvedValue({ rows: [{ id: 'transition-exists' }] });
    const replacement = event({ title: 'Kino', replacesEventId: 'stale-event' });

    await expect(
      projectWindow({
        scope,
        observation: observation(),
        projection: projection({ events: [replacement] }),
      }),
    ).resolves.toMatchObject({ eventsCreated: 1 });
    expect(mocks.applyPlanChangeInTx).toHaveBeenCalledWith(
      expect.objectContaining({
        eventId: 'old-event',
        reason: 'user changed plan; replacement follows',
      }),
      expect.any(Object),
    );
    expect(mocks.insertEvent).toHaveBeenCalledWith(
      expect.objectContaining({ title: 'Kino', replacesEventId: 'old-event' }),
      expect.any(Object),
    );
    expect(mocks.insertEventTransition).not.toHaveBeenCalled();
  });

  it('turns a cancelled change with a distinct sibling into a clarification', async () => {
    mocks.classifyEventUtterance.mockReturnValue('change');
    const result = await projectWindow({
      scope,
      observation: observation({
        texts: [{ seq: 1, content: 'Kino wird abgesagt. Abendessen stattdessen.' }],
      }),
      projection: projection({
        events: [event(), event({ title: 'Abendessen', sourceMessageSeq: 1 })],
      }),
    });
    expect(mocks.classifyEventUtterance).toHaveBeenNthCalledWith(
      1,
      'Kino wird abgesagt. Abendessen stattdessen.',
    );
    expect(result).toMatchObject({ eventsCreated: 1, openLoopsUpserted: 1 });
    expect(mocks.insertOpenLoop).toHaveBeenCalledWith(
      expect.objectContaining({ question: 'Welches Event meinst du mit "Kino"?' }),
      expect.any(Object),
    );
    expect(mocks.insertEvent).toHaveBeenCalledOnce();
  });

  it('falls back to extraction text and inserts when a candidate is inactive or unrelated', async () => {
    mocks.classifyEventUtterance.mockReturnValue('unknown');
    mocks.findStructuredEvents.mockResolvedValue([
      { id: 'finished-event', title: 'Kino', status: 'completed', timeline: [] },
    ]);
    mocks.pickEventCandidate.mockImplementation(
      (_kind: unknown, candidates: unknown[]) => candidates[0],
    );
    mocks.clientQuery.mockResolvedValue({ rows: [] });

    await expect(
      projectWindow({
        scope,
        observation: observation({ texts: [{ seq: 2, content: 'No matching source sequence.' }] }),
        projection: projection({ events: [event()] }),
        extraction: extraction([
          extractedEvent({ sourceSeq: [1], subject: 'Elsewhere', eventType: 'different' }),
        ]),
      }),
    ).resolves.toMatchObject({ eventsCreated: 1 });
    expect(mocks.insertEventTransition).toHaveBeenCalledWith(
      expect.objectContaining({ confidence: 0.5 }),
      expect.any(Object),
    );
  });
});
