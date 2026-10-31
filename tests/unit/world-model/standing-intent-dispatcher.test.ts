import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Observation, StandingIntentRecord } from '@/server/world-model/types';
import type { MockProcedure } from '../../helpers/mockProcedure';

type Mocks = {
  enqueueOutboxEvent: ReturnType<typeof vi.fn>;
  insertOpenLoop: ReturnType<typeof vi.fn>;
  executeAction: ReturnType<typeof vi.fn>;
};

let mocks: Mocks;

beforeEach(() => {
  vi.resetModules();
  mocks = {
    enqueueOutboxEvent: vi.fn<MockProcedure>().mockResolvedValue({ id: 'outbox-1', created: true }),
    insertOpenLoop: vi.fn<MockProcedure>().mockResolvedValue({ id: 'loop-1' }),
    executeAction: vi.fn<MockProcedure>().mockResolvedValue({ succeeded: true }),
  };
  vi.doMock('@/server/world-model/repositories/outboxRepository', () => ({
    enqueueOutboxEvent: mocks.enqueueOutboxEvent,
  }));
  vi.doMock('@/server/world-model/repositories/prospectiveRepository', () => ({
    insertOpenLoop: mocks.insertOpenLoop,
  }));
  vi.doMock('@/server/world-model/services/actionService', () => ({
    executeAction: mocks.executeAction,
  }));
});

afterEach(() => {
  vi.doUnmock('@/server/world-model/repositories/outboxRepository');
  vi.doUnmock('@/server/world-model/repositories/prospectiveRepository');
  vi.doUnmock('@/server/world-model/services/actionService');
  vi.resetModules();
});

const intent: StandingIntentRecord = {
  id: 'intent-1',
  userId: 'user-1',
  personaId: 'persona-1',
  workspaceId: 'workspace-1',
  description: 'Ask about the appointment',
  triggerTerms: ['appointment', 'doctor'],
  deduplicationKey: 'intent-key',
  status: 'armed',
  fireCount: 1,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
};

const observation: Observation = {
  id: 'observation-1',
  userId: 'user-1',
  personaId: 'persona-1',
  workspaceId: 'workspace-1',
  sourceType: 'chat_message',
  sourceId: 'message-1',
  occurredAt: '2026-01-02T00:00:00.000Z',
  receivedAt: '2026-01-02T00:00:01.000Z',
  payload: {},
};

describe('standing intent dispatcher', () => {
  it('enqueues a scoped, idempotent outbox event for a fired intent', async () => {
    const { dispatchStandingIntentAction } =
      await import('@/server/world-model/services/standingIntentDispatcher');
    const db = { query: vi.fn<MockProcedure>() };

    await expect(dispatchStandingIntentAction({ intent, observation }, db)).resolves.toEqual({
      dispatched: true,
      outboxEventId: 'outbox-1',
      created: true,
    });
    expect(mocks.enqueueOutboxEvent).toHaveBeenCalledWith(
      {
        eventType: 'proactive.intent.fired',
        aggregateType: 'standing_intent',
        aggregateId: 'intent-1',
        idempotencyKey: 'standing-intent-fire:intent-1:observation-1',
        userId: 'user-1',
        personaId: 'persona-1',
        workspaceId: 'workspace-1',
        payload: {
          userId: 'user-1',
          personaId: 'persona-1',
          workspaceId: 'workspace-1',
          intentId: 'intent-1',
          description: 'Ask about the appointment',
          triggerTerms: ['appointment', 'doctor'],
          firingObservationId: 'observation-1',
          sourceType: 'chat_message',
          firedAt: observation.occurredAt,
        },
      },
      db,
    );
  });

  it('defaults workspace scope and marks an existing idempotent event as not created', async () => {
    const { dispatchStandingIntentAction } =
      await import('@/server/world-model/services/standingIntentDispatcher');
    mocks.enqueueOutboxEvent.mockResolvedValue({ id: 'outbox-existing', created: false });
    const { workspaceId: _workspaceId, ...unscopedIntent } = intent;
    const { workspaceId: _observationWorkspace, ...unscopedObservation } = observation;

    await expect(
      dispatchStandingIntentAction({ intent: unscopedIntent, observation: unscopedObservation }),
    ).resolves.toEqual({ dispatched: true, outboxEventId: 'outbox-existing', created: false });
    expect(mocks.enqueueOutboxEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: '',
        payload: expect.objectContaining({ workspaceId: '' }),
      }),
      undefined,
    );

    mocks.enqueueOutboxEvent.mockResolvedValue({ id: 'outbox-default-created' });
    await expect(
      dispatchStandingIntentAction({ intent: unscopedIntent, observation: unscopedObservation }),
    ).resolves.toMatchObject({ created: true });
  });

  it('executes the follow-up action by creating a deduplicated open loop', async () => {
    const { executeStandingIntentFollowUp } =
      await import('@/server/world-model/services/standingIntentDispatcher');
    mocks.executeAction.mockImplementation(async (...args: unknown[]) => {
      const action = args[0] as { run: () => Promise<unknown> };
      await action.run();
      return { succeeded: true };
    });

    await executeStandingIntentFollowUp({
      intentId: 'intent-1',
      userId: 'user-1',
      personaId: 'persona-1',
      description: 'Ask about the appointment',
      firingObservationId: 'observation-1',
    });

    expect(mocks.executeAction).toHaveBeenCalledWith(
      expect.objectContaining({
        scope: { userId: 'user-1', personaId: 'persona-1', workspaceId: '' },
        actionType: 'standing_intent.follow_up',
        idempotencyKey: 'standing-intent-action:intent-1:observation-1',
        correlationId: 'observation-1',
      }),
    );
    expect(mocks.insertOpenLoop).toHaveBeenCalledWith({
      userId: 'user-1',
      personaId: 'persona-1',
      workspaceId: '',
      type: 'promised_follow_up',
      question: 'Erinnerung: Ask about the appointment',
      deduplicationKey: 'standing-intent-follow-up:intent-1:observation-1',
    });
  });

  it('propagates action errors and supplies a fallback when no error is returned', async () => {
    const { executeStandingIntentFollowUp } =
      await import('@/server/world-model/services/standingIntentDispatcher');

    mocks.executeAction.mockResolvedValueOnce({ succeeded: false, error: 'database unavailable' });
    await expect(
      executeStandingIntentFollowUp({
        intentId: 'intent-1',
        userId: 'user-1',
        personaId: 'persona-1',
        workspaceId: 'workspace-1',
        description: 'Follow up',
        firingObservationId: 'observation-1',
      }),
    ).rejects.toThrow('database unavailable');

    mocks.executeAction.mockResolvedValueOnce({ succeeded: false });
    await expect(
      executeStandingIntentFollowUp({
        intentId: 'intent-1',
        userId: 'user-1',
        personaId: 'persona-1',
        workspaceId: 'workspace-1',
        description: 'Follow up',
        firingObservationId: 'observation-1',
      }),
    ).rejects.toThrow('standing intent follow-up action failed');
  });

  it('routes fired payloads to the handler and requires a registered action handler', async () => {
    const { buildIntentFiredHandler } =
      await import('@/server/world-model/services/standingIntentDispatcher');
    const onAction = vi.fn<MockProcedure>();
    const event = {
      id: 'outbox-1',
      eventType: 'proactive.intent.fired',
      aggregateType: 'standing_intent',
      aggregateId: 'intent-from-aggregate',
      payload: {
        userId: 'user-1',
        personaId: 'persona-1',
        workspaceId: 'workspace-1',
        intentId: 'intent-1',
        description: 'Follow up',
        firingObservationId: 'observation-1',
      },
    };

    await buildIntentFiredHandler(onAction)(event);
    expect(onAction).toHaveBeenCalledWith({
      intentId: 'intent-1',
      userId: 'user-1',
      personaId: 'persona-1',
      workspaceId: 'workspace-1',
      description: 'Follow up',
      firingObservationId: 'observation-1',
    });
    await expect(buildIntentFiredHandler()(event)).rejects.toThrow(
      'no action handler for proactive.intent.fired',
    );
  });

  it('falls back to the aggregate id and omits empty or missing payload fields', async () => {
    const { buildIntentFiredHandler } =
      await import('@/server/world-model/services/standingIntentDispatcher');
    const onAction = vi.fn<MockProcedure>();
    await buildIntentFiredHandler(onAction)({
      id: 'outbox-2',
      eventType: 'proactive.intent.fired',
      aggregateType: 'standing_intent',
      aggregateId: 'intent-fallback',
      payload: { workspaceId: '', userId: null, personaId: 7 },
    });

    expect(onAction).toHaveBeenCalledWith({
      intentId: 'intent-fallback',
      userId: '',
      personaId: '7',
      workspaceId: undefined,
      description: '',
      firingObservationId: '',
    });

    await buildIntentFiredHandler(onAction)({
      id: 'outbox-3',
      eventType: 'proactive.intent.fired',
      aggregateType: 'standing_intent',
      aggregateId: 'intent-empty-payload',
      payload: null as unknown as Record<string, unknown>,
    });
    expect(onAction).toHaveBeenLastCalledWith({
      intentId: 'intent-empty-payload',
      userId: '',
      personaId: '',
      workspaceId: undefined,
      description: '',
      firingObservationId: '',
    });
  });
});
