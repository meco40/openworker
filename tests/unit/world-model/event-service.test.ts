import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { EventRecord, ObservationInput } from '@/server/world-model/types';

const mocks = vi.hoisted(() => ({
  client: { query: vi.fn<MockProcedure>() },
  withWorldModelTransaction: vi.fn<MockProcedure>(),
  getEventById: vi.fn<MockProcedure>(),
  insertEvent: vi.fn<MockProcedure>(),
  insertEventTransition: vi.fn<MockProcedure>(),
  listEventTimeline: vi.fn<MockProcedure>(),
  updateEventStatus: vi.fn<MockProcedure>(),
  insertObservationWithResult: vi.fn<MockProcedure>(),
  enqueueOutboxEvent: vi.fn<MockProcedure>(),
  getOpenLoopByKey: vi.fn<MockProcedure>(),
  insertOpenLoop: vi.fn<MockProcedure>(),
  updateOpenLoopStatus: vi.fn<MockProcedure>(),
}));

vi.mock('@/server/world-model/db', () => ({
  withWorldModelTransaction: mocks.withWorldModelTransaction,
}));
vi.mock('@/server/world-model/repositories/eventRepository', () => ({
  getEventById: mocks.getEventById,
  insertEvent: mocks.insertEvent,
  insertEventTransition: mocks.insertEventTransition,
  listEventTimeline: mocks.listEventTimeline,
  updateEventStatus: mocks.updateEventStatus,
}));
vi.mock('@/server/world-model/repositories/observationRepository', () => ({
  insertObservationWithResult: mocks.insertObservationWithResult,
}));
vi.mock('@/server/world-model/repositories/outboxRepository', () => ({
  enqueueOutboxEvent: mocks.enqueueOutboxEvent,
}));
vi.mock('@/server/world-model/repositories/prospectiveRepository', () => ({
  getOpenLoopByKey: mocks.getOpenLoopByKey,
  insertOpenLoop: mocks.insertOpenLoop,
  updateOpenLoopStatus: mocks.updateOpenLoopStatus,
}));

import {
  applyPlanChange,
  applyPlanChangeInTx,
  confirmEventOutcome,
  confirmEventOutcomeInTx,
  getEventHistory,
  planEvent,
  resolveEventOpenLoop,
} from '@/server/world-model/services/eventService';
import type { MockProcedure } from '../../helpers/mockProcedure';

const observation: ObservationInput = {
  userId: 'user-1',
  personaId: 'persona-1',
  workspaceId: 'workspace-1',
  sourceType: 'chat_message',
  sourceId: 'message-1',
  occurredAt: '2026-10-08T11:00:00.000Z',
  payload: { text: 'The event is planned.' },
};

function eventRecord(overrides: Partial<EventRecord> = {}): EventRecord {
  return {
    id: 'event-1',
    userId: 'user-1',
    personaId: 'persona-1',
    workspaceId: 'workspace-1',
    title: 'Dinner',
    eventType: 'meal',
    status: 'planned',
    createdAt: '2026-10-08T10:00:00.000Z',
    updatedAt: '2026-10-08T10:00:00.000Z',
    ...overrides,
  };
}

function planInput(
  overrides: Partial<Parameters<typeof planEvent>[0]> = {},
): Parameters<typeof planEvent>[0] {
  return {
    userId: 'user-1',
    personaId: 'persona-1',
    workspaceId: 'workspace-1',
    title: 'Dinner',
    eventType: 'meal',
    observation,
    ...overrides,
  };
}

function changeInput(toStatus: 'planned' | 'in_progress' | 'completed' | 'cancelled' | 'no_show') {
  return { eventId: 'event-1', toStatus, observation, reason: 'user confirmed' };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.client.query.mockResolvedValue({ rows: [] });
  mocks.withWorldModelTransaction.mockImplementation((callback) => callback(mocks.client));
  mocks.getEventById.mockResolvedValue(eventRecord());
  mocks.insertEvent.mockResolvedValue(eventRecord());
  mocks.insertEventTransition.mockResolvedValue({
    id: 'transition-1',
    eventId: 'event-1',
    fromStatus: 'proposed',
    toStatus: 'planned',
    transitionedAt: '2026-10-08T10:00:00.000Z',
  });
  mocks.listEventTimeline.mockResolvedValue([]);
  mocks.insertObservationWithResult.mockResolvedValue({
    observation: { ...observation, id: 'observation-1' },
    created: false,
  });
  mocks.getOpenLoopByKey.mockResolvedValue(null);
  mocks.insertOpenLoop.mockResolvedValue({
    id: 'loop-1',
    deduplicationKey: 'event-outcome:event-1',
  });
});

afterEach(() => vi.restoreAllMocks());

describe('planEvent', () => {
  it('rejects mismatched user, persona, or workspace scopes before opening a transaction', async () => {
    await expect(planEvent(planInput({ userId: 'other-user' }))).rejects.toThrow(
      'plan observation scope must match event scope',
    );
    await expect(planEvent(planInput({ personaId: 'other-persona' }))).rejects.toThrow(
      'plan observation scope must match event scope',
    );
    await expect(planEvent(planInput({ workspaceId: 'other-workspace' }))).rejects.toThrow(
      'plan observation workspace must match event scope',
    );
    expect(mocks.withWorldModelTransaction).not.toHaveBeenCalled();
  });

  it('creates an event, observation transition, follow-up, and outbox records atomically', async () => {
    const event = eventRecord({ title: 'Dinner with Alice' });
    mocks.insertEvent.mockResolvedValue(event);
    mocks.insertObservationWithResult.mockResolvedValue({
      observation: { ...observation, id: 'observation-1' },
      created: true,
    });

    await expect(
      planEvent(
        planInput({
          scheduledFor: '2026-10-08T12:00:00.000Z',
          endsAt: '2026-10-08T13:00:00.000Z',
          subjectEntityId: 'alice',
          counterpartEntityId: 'restaurant',
        }),
      ),
    ).resolves.toEqual({ event, openLoop: expect.any(Object) });

    expect(mocks.insertEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: 'user-1',
        personaId: 'persona-1',
        workspaceId: 'workspace-1',
        title: 'Dinner',
        eventType: 'meal',
        status: 'planned',
        subjectEntityId: 'alice',
        counterpartEntityId: 'restaurant',
      }),
      mocks.client,
    );
    expect(mocks.insertOpenLoop).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'event_outcome',
        subjectId: 'alice',
        question: 'How did "Dinner with Alice" go?',
        deduplicationKey: 'event-outcome:event-1',
        importance: 2,
        triggerAt: '2026-10-08T14:00:00.000Z',
      }),
      mocks.client,
    );
    expect(mocks.enqueueOutboxEvent).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        eventType: 'world.observation.created',
        aggregateId: 'observation-1',
        payload: expect.objectContaining({ userId: 'user-1', personaId: 'persona-1' }),
      }),
      mocks.client,
    );
    expect(mocks.enqueueOutboxEvent).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ eventType: 'world.event.created', aggregateId: 'event-1' }),
      mocks.client,
    );
  });

  it.each([
    ['scheduled time', { scheduledFor: '2026-10-08T12:00:00.000Z' }, '2026-10-08T13:00:00.000Z'],
    ['no time', {}, undefined],
  ])('uses the %s when the event has no end time', async (_label, time, triggerAt) => {
    await planEvent(
      planInput({
        ...time,
        workspaceId: undefined,
        observation: { ...observation, workspaceId: undefined },
      }),
    );

    expect(mocks.insertEvent).toHaveBeenCalledWith(
      expect.objectContaining({ workspaceId: '' }),
      mocks.client,
    );
    expect(mocks.insertOpenLoop).toHaveBeenCalledWith(
      expect.objectContaining({ triggerAt }),
      mocks.client,
    );
    expect(mocks.enqueueOutboxEvent).toHaveBeenCalledTimes(1);
  });
});

describe('event status transitions', () => {
  it('enforces explicit outcome confirmation and handles missing, unchanged, and invalid events', async () => {
    await expect(applyPlanChange(changeInput('completed'))).rejects.toThrow(
      'completed/no_show requires confirmEventOutcome()',
    );

    mocks.getEventById.mockResolvedValueOnce(null);
    await expect(applyPlanChange(changeInput('in_progress'))).resolves.toEqual({
      kind: 'not_found',
    });

    mocks.getEventById.mockResolvedValueOnce(eventRecord({ status: 'planned' }));
    await expect(applyPlanChange(changeInput('planned'))).resolves.toMatchObject({
      kind: 'unchanged',
      event: { status: 'planned' },
    });

    mocks.getEventById.mockResolvedValueOnce(eventRecord({ status: 'proposed' }));
    await expect(applyPlanChange(changeInput('in_progress'))).rejects.toThrow(
      'invalid event transition proposed -> in_progress',
    );
    expect(mocks.insertObservationWithResult).not.toHaveBeenCalled();
  });

  it('reuses a matching transition and updates a non-terminal plan in the transaction', async () => {
    const updated = eventRecord({ status: 'in_progress', workspaceId: undefined });
    mocks.getEventById.mockResolvedValueOnce(eventRecord()).mockResolvedValueOnce(updated);
    mocks.client.query.mockResolvedValueOnce({
      rows: [
        {
          id: 'transition-existing',
          event_id: 'event-1',
          from_status: null,
          to_status: 'in_progress',
          reason: null,
          source_observation_id: null,
          confidence: 0.7,
          transitioned_at: '2026-10-08T11:00:00.000Z',
        },
      ],
    });

    await expect(applyPlanChangeInTx(changeInput('in_progress'), mocks.client)).resolves.toEqual({
      kind: 'in_progress',
      event: updated,
      transition: {
        id: 'transition-existing',
        eventId: 'event-1',
        fromStatus: undefined,
        toStatus: 'in_progress',
        reason: undefined,
        sourceObservationId: undefined,
        confidence: 0.7,
        transitionedAt: '2026-10-08T11:00:00.000Z',
      },
    });
    expect(mocks.insertEventTransition).not.toHaveBeenCalled();
    expect(mocks.updateEventStatus).toHaveBeenCalledWith(
      'event-1',
      'in_progress',
      observation.occurredAt,
      mocks.client,
    );
    expect(mocks.getOpenLoopByKey).not.toHaveBeenCalled();
    expect(mocks.enqueueOutboxEvent).toHaveBeenCalledWith(
      expect.objectContaining({ payload: expect.objectContaining({ workspaceId: '' }) }),
      mocks.client,
    );
  });

  it.each([
    ['cancelled', 'open', 'cancelled'],
    ['completed', 'scheduled', 'resolved'],
    ['no_show', 'asked', 'resolved'],
  ] as const)(
    'creates a transition and %s resolves its %s follow-up loop',
    async (toStatus, loopStatus, loopTarget) => {
      const updated = eventRecord({ status: toStatus });
      mocks.getEventById.mockResolvedValueOnce(eventRecord()).mockResolvedValueOnce(updated);
      mocks.insertObservationWithResult.mockResolvedValue({
        observation: { ...observation, id: 'observation-1' },
        created: true,
      });
      mocks.getOpenLoopByKey.mockResolvedValue({
        id: 'loop-1',
        status: loopStatus,
      });

      const result =
        toStatus === 'cancelled'
          ? await applyPlanChange(changeInput(toStatus))
          : toStatus === 'completed'
            ? await confirmEventOutcome({ eventId: 'event-1', observation, outcome: toStatus })
            : await confirmEventOutcomeInTx(
                { eventId: 'event-1', observation, outcome: toStatus },
                mocks.client,
              );

      expect(result.kind).toBe(toStatus);
      expect(mocks.insertEventTransition).toHaveBeenCalledWith(
        expect.objectContaining({
          eventId: 'event-1',
          toStatus,
          sourceObservationId: 'observation-1',
        }),
        mocks.client,
      );
      expect(mocks.getOpenLoopByKey).toHaveBeenCalledWith(
        'user-1',
        'persona-1',
        'event-outcome:event-1',
        'workspace-1',
        mocks.client,
      );
      expect(mocks.updateOpenLoopStatus).toHaveBeenCalledWith(
        'loop-1',
        loopTarget,
        { note: `event became ${toStatus}` },
        mocks.client,
      );
    },
  );

  it('returns not found when a transitioned event disappears before its final read', async () => {
    mocks.getEventById.mockResolvedValueOnce(eventRecord()).mockResolvedValueOnce(null);

    await expect(applyPlanChangeInTx(changeInput('in_progress'), mocks.client)).resolves.toEqual({
      kind: 'not_found',
    });
    expect(mocks.enqueueOutboxEvent).not.toHaveBeenCalled();
  });

  it('leaves missing and already closed outcome loops untouched', async () => {
    mocks.getEventById
      .mockResolvedValueOnce(eventRecord())
      .mockResolvedValueOnce(eventRecord({ status: 'cancelled', workspaceId: undefined }))
      .mockResolvedValueOnce(eventRecord())
      .mockResolvedValueOnce(eventRecord({ status: 'completed', workspaceId: undefined }));
    mocks.getOpenLoopByKey.mockResolvedValueOnce(null).mockResolvedValueOnce({
      id: 'closed-loop',
      status: 'answered',
    });

    await applyPlanChange(changeInput('cancelled'));
    await confirmEventOutcome({ eventId: 'event-1', observation, outcome: 'completed' });

    expect(mocks.getOpenLoopByKey).toHaveBeenNthCalledWith(
      1,
      'user-1',
      'persona-1',
      'event-outcome:event-1',
      '',
      mocks.client,
    );
    expect(mocks.updateOpenLoopStatus).not.toHaveBeenCalled();
  });
});

describe('event follow-ups and history', () => {
  it('resolves only active event follow-up loops and ignores missing events or closed loops', async () => {
    mocks.getEventById.mockResolvedValueOnce(null);
    await expect(resolveEventOpenLoop('missing-event')).resolves.toBeUndefined();
    expect(mocks.getOpenLoopByKey).not.toHaveBeenCalled();

    mocks.getEventById.mockResolvedValue(
      eventRecord({ workspaceId: undefined, status: 'completed' }),
    );
    for (const status of ['open', 'scheduled', 'asked'] as const) {
      mocks.getOpenLoopByKey.mockResolvedValueOnce({ id: `loop-${status}`, status });
      await resolveEventOpenLoop('event-1');
      expect(mocks.updateOpenLoopStatus).toHaveBeenLastCalledWith(`loop-${status}`, 'resolved', {
        note: 'event became completed',
      });
    }
    mocks.getOpenLoopByKey.mockResolvedValueOnce({ id: 'loop-closed', status: 'answered' });
    await resolveEventOpenLoop('event-1');
    expect(mocks.updateOpenLoopStatus).toHaveBeenCalledTimes(3);
    expect(mocks.getOpenLoopByKey).toHaveBeenLastCalledWith(
      'user-1',
      'persona-1',
      'event-outcome:event-1',
      '',
    );
  });

  it('returns the repository event timeline', async () => {
    const timeline = [{ id: 'transition-1', toStatus: 'planned' }];
    mocks.listEventTimeline.mockResolvedValue(timeline);

    await expect(getEventHistory('event-1')).resolves.toBe(timeline);
    expect(mocks.listEventTimeline).toHaveBeenCalledWith('event-1');
  });
});
