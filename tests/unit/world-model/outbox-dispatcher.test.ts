import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  config: {
    enabled: false,
    e2eEnabled: false,
    graphitiShadowEnabled: false,
    graphitiBackendEnabled: false,
    outboxBatchSize: 100,
    outboxPollIntervalMs: 60_000,
  },
  getWorldModelConfig: vi.fn<MockProcedure>(),
  closeWorldModelDb: vi.fn<MockProcedure>(),
  runWithWorldModelScope: vi.fn<MockProcedure>(),
  runWorldModelMigrations: vi.fn<MockProcedure>(),
  createGraphitiShadowHandler: vi.fn<MockProcedure>(),
  createGraphitiProjectorHandler: vi.fn<MockProcedure>(),
  createProactiveQuestionHandler: vi.fn<MockProcedure>(),
  createProactiveIntentFiredHandler: vi.fn<MockProcedure>(),
  projectMissionControlTaskCreated: vi.fn<MockProcedure>(),
  projectMissionControlTaskDeleted: vi.fn<MockProcedure>(),
  projectMissionControlTaskStatusChanged: vi.fn<MockProcedure>(),
  claimPendingOutboxEvents: vi.fn<MockProcedure>(),
  markOutboxDispatched: vi.fn<MockProcedure>(),
  markOutboxFailed: vi.fn<MockProcedure>(),
  listRuntimeWorldModelScopes: vi.fn<MockProcedure>(),
}));

vi.mock('@/server/world-model/config', () => ({
  getWorldModelConfig: mocks.getWorldModelConfig,
}));
vi.mock('@/server/world-model/db', () => ({
  closeWorldModelDb: mocks.closeWorldModelDb,
  runWithWorldModelScope: mocks.runWithWorldModelScope,
  runWorldModelMigrations: mocks.runWorldModelMigrations,
}));
vi.mock('@/server/world-model/graphiti/shadow', () => ({
  createGraphitiShadowHandler: mocks.createGraphitiShadowHandler,
}));
vi.mock('@/server/world-model/graphiti/projector', () => ({
  createGraphitiProjectorHandler: mocks.createGraphitiProjectorHandler,
}));
vi.mock('@/server/world-model/services/proactiveChannelDelivery', () => ({
  createProactiveQuestionHandler: mocks.createProactiveQuestionHandler,
  createProactiveIntentFiredHandler: mocks.createProactiveIntentFiredHandler,
}));
vi.mock('@/server/world-model/services/missionControlBridge', () => ({
  projectMissionControlTaskCreated: mocks.projectMissionControlTaskCreated,
  projectMissionControlTaskDeleted: mocks.projectMissionControlTaskDeleted,
  projectMissionControlTaskStatusChanged: mocks.projectMissionControlTaskStatusChanged,
}));
vi.mock('@/server/world-model/repositories/outboxRepository', () => ({
  claimPendingOutboxEvents: mocks.claimPendingOutboxEvents,
  markOutboxDispatched: mocks.markOutboxDispatched,
  markOutboxFailed: mocks.markOutboxFailed,
}));
vi.mock('@/server/world-model/runtime/scopeDiscovery', () => ({
  listRuntimeWorldModelScopes: mocks.listRuntimeWorldModelScopes,
}));

import {
  dispatchOutboxOnce,
  dispatchOutboxOnceInScope,
  registerOutboxHandler,
  startOutboxDispatcher,
  stopOutboxDispatcher,
} from '@/server/world-model/outboxDispatcher';
import type { OutboxEvent } from '@/server/world-model/types';
import type { MockProcedure } from '../../helpers/mockProcedure';

function event(partial: Partial<OutboxEvent> = {}): OutboxEvent {
  return {
    id: 'event-1',
    eventType: 'test.event',
    aggregateType: 'event',
    aggregateId: 'aggregate-1',
    payload: {},
    status: 'pending',
    attempts: 0,
    createdAt: '2026-10-08T09:00:00.000Z',
    ...partial,
  };
}

beforeEach(async () => {
  mocks.closeWorldModelDb.mockImplementation(async () => {});
  await stopOutboxDispatcher();
  vi.resetAllMocks();
  Object.assign(mocks.config, {
    enabled: false,
    e2eEnabled: false,
    graphitiShadowEnabled: false,
    graphitiBackendEnabled: false,
    outboxBatchSize: 100,
    outboxPollIntervalMs: 60_000,
  });
  mocks.getWorldModelConfig.mockImplementation(() => ({ ...mocks.config }));
  mocks.closeWorldModelDb.mockImplementation(async () => {});
  mocks.runWithWorldModelScope.mockImplementation(
    async (_scope: unknown, callback: () => unknown) => callback(),
  );
  mocks.runWorldModelMigrations.mockResolvedValue([]);
  mocks.createGraphitiShadowHandler.mockReturnValue(vi.fn(async () => {}));
  mocks.createGraphitiProjectorHandler.mockReturnValue(vi.fn(async () => {}));
  mocks.createProactiveQuestionHandler.mockReturnValue(vi.fn(async () => {}));
  mocks.createProactiveIntentFiredHandler.mockReturnValue(vi.fn(async () => {}));
  mocks.projectMissionControlTaskCreated.mockImplementation(async () => {});
  mocks.projectMissionControlTaskDeleted.mockImplementation(async () => {});
  mocks.projectMissionControlTaskStatusChanged.mockImplementation(async () => {});
  mocks.claimPendingOutboxEvents.mockResolvedValue([]);
  mocks.markOutboxDispatched.mockImplementation(async () => {});
  mocks.markOutboxFailed.mockImplementation(async () => {});
  mocks.listRuntimeWorldModelScopes.mockResolvedValue([]);
});

afterEach(async () => {
  await stopOutboxDispatcher();
  vi.unstubAllEnvs();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('outbox dispatcher', () => {
  it('fails events with no handler and acknowledges all handlers on success', async () => {
    const ok = vi.fn<() => Promise<void>>(async () => {});
    registerOutboxHandler('test.success', ok);
    mocks.claimPendingOutboxEvents.mockResolvedValue([
      event({ id: 'no-handler', eventType: 'test.missing' }),
      event({ id: 'handled', eventType: 'test.success' }),
    ]);

    await expect(dispatchOutboxOnce(7)).resolves.toBe(1);
    expect(mocks.claimPendingOutboxEvents).toHaveBeenCalledWith(7, expect.any(String));
    expect(mocks.markOutboxFailed).toHaveBeenCalledWith(
      'no-handler',
      '[world-model:outbox] no handler registered for test.missing',
      expect.any(String),
    );
    expect(ok).toHaveBeenCalledWith(expect.objectContaining({ id: 'handled' }));
    expect(mocks.markOutboxDispatched).toHaveBeenCalledWith('handled', expect.any(String));
  });

  it('runs multiple handlers together and normalizes non-Error failures', async () => {
    const first = vi.fn<() => Promise<void>>(async () => {});
    const second = vi.fn<MockProcedure>().mockRejectedValue('transport down');
    registerOutboxHandler('test.multiple', first);
    registerOutboxHandler('test.multiple', second);
    mocks.claimPendingOutboxEvents.mockResolvedValue([event({ eventType: 'test.multiple' })]);

    await expect(dispatchOutboxOnce()).resolves.toBe(0);
    expect(first).toHaveBeenCalledOnce();
    expect(second).toHaveBeenCalledOnce();
    expect(mocks.markOutboxFailed).toHaveBeenCalledWith(
      'event-1',
      'transport down',
      expect.any(String),
    );
    expect(mocks.markOutboxDispatched).not.toHaveBeenCalled();
  });

  it('deduplicates a keyed registration, keeps distinct keys, and counts empty batches', async () => {
    const handler = vi.fn<() => Promise<void>>(async () => {});
    const duplicate = vi.fn<() => Promise<void>>(async () => {});
    registerOutboxHandler('test.keyed', handler, 'stable');
    registerOutboxHandler('test.keyed', duplicate, 'stable');
    registerOutboxHandler('test.keyed', duplicate, 'second');
    mocks.claimPendingOutboxEvents.mockResolvedValue([event({ eventType: 'test.keyed' })]);

    await expect(dispatchOutboxOnce()).resolves.toBe(1);
    expect(handler).toHaveBeenCalledOnce();
    expect(duplicate).toHaveBeenCalledOnce();

    mocks.claimPendingOutboxEvents.mockResolvedValue([]);
    await expect(dispatchOutboxOnce()).resolves.toBe(0);
  });

  it('releases its in-flight guard after an error and ignores overlapping ticks', async () => {
    mocks.claimPendingOutboxEvents.mockRejectedValueOnce(new Error('database unavailable'));
    await expect(dispatchOutboxOnce()).rejects.toThrow('database unavailable');
    mocks.claimPendingOutboxEvents.mockResolvedValueOnce([]);
    await expect(dispatchOutboxOnce()).resolves.toBe(0);

    let release!: (rows: OutboxEvent[]) => void;
    mocks.claimPendingOutboxEvents.mockImplementationOnce(
      () => new Promise<OutboxEvent[]>((resolve) => (release = resolve)),
    );
    const first = dispatchOutboxOnce();
    await Promise.resolve();
    await expect(dispatchOutboxOnce()).resolves.toBe(0);
    release([]);
    await expect(first).resolves.toBe(0);
  });

  it('dispatches under the requested RLS scope', async () => {
    const scope = { userId: 'user-a', personaId: 'assistant', workspaceId: 'space-a' };
    await expect(dispatchOutboxOnceInScope(scope, 5)).resolves.toBe(0);
    expect(mocks.runWithWorldModelScope).toHaveBeenCalledWith(scope, expect.any(Function));
  });

  it('does not start when disabled or when the E2E bypass is used in production', async () => {
    await startOutboxDispatcher();
    expect(mocks.runWorldModelMigrations).not.toHaveBeenCalled();

    mocks.config.e2eEnabled = true;
    vi.stubEnv('NODE_ENV', 'production');
    await startOutboxDispatcher();
    expect(mocks.runWorldModelMigrations).not.toHaveBeenCalled();
  });

  it('starts in development E2E mode, registers core handlers once, and stops cleanly', async () => {
    mocks.config.e2eEnabled = true;
    mocks.listRuntimeWorldModelScopes.mockResolvedValue([
      { userId: 'user-a', personaId: 'assistant', workspaceId: 'space-a' },
      { userId: 'user-b', personaId: 'assistant', workspaceId: 'space-b' },
    ]);
    mocks.claimPendingOutboxEvents
      .mockResolvedValueOnce([
        event({ eventType: 'proactive.question.requested' }),
        event({ id: 'intent', eventType: 'proactive.intent.fired' }),
        event({ id: 'task-created', eventType: 'world.task.created' }),
        event({ id: 'task-status', eventType: 'world.task.status_changed' }),
        event({ id: 'task-deleted', eventType: 'world.task.deleted' }),
      ])
      .mockResolvedValueOnce([]);
    const interval = vi.spyOn(globalThis, 'setInterval');

    await startOutboxDispatcher();
    await startOutboxDispatcher();

    expect(mocks.runWorldModelMigrations).toHaveBeenCalledOnce();
    expect(mocks.createProactiveQuestionHandler).toHaveBeenCalledOnce();
    expect(mocks.createProactiveIntentFiredHandler).toHaveBeenCalledOnce();
    expect(mocks.projectMissionControlTaskCreated).toHaveBeenCalledOnce();
    expect(mocks.projectMissionControlTaskStatusChanged).toHaveBeenCalledOnce();
    expect(mocks.projectMissionControlTaskDeleted).toHaveBeenCalledOnce();
    expect(mocks.listRuntimeWorldModelScopes).toHaveBeenCalledOnce();
    expect(mocks.runWithWorldModelScope).toHaveBeenCalledTimes(2);
    expect(mocks.claimPendingOutboxEvents).toHaveBeenCalledTimes(2);
    expect(interval).toHaveBeenCalledOnce();

    mocks.closeWorldModelDb.mockRejectedValueOnce(new Error('already closed'));
    await expect(stopOutboxDispatcher()).resolves.toBeUndefined();
    await expect(stopOutboxDispatcher()).resolves.toBeUndefined();
  });

  it('registers Graphiti handlers for each enabled event family', async () => {
    mocks.config.enabled = true;
    mocks.config.graphitiShadowEnabled = true;
    mocks.config.graphitiBackendEnabled = true;
    const graphitiShadow = vi.fn<() => Promise<void>>(async () => {});
    const graphitiProjector = vi.fn<() => Promise<void>>(async () => {});
    mocks.createGraphitiShadowHandler.mockReturnValue(graphitiShadow);
    mocks.createGraphitiProjectorHandler.mockReturnValue(graphitiProjector);
    mocks.listRuntimeWorldModelScopes.mockResolvedValue([
      { userId: 'user-a', personaId: 'assistant', workspaceId: 'space-a' },
    ]);
    mocks.claimPendingOutboxEvents.mockResolvedValue([
      event({ id: 'observation', eventType: 'world.observation.created' }),
      event({ id: 'assertion', eventType: 'world.assertion.created' }),
      event({ id: 'task', eventType: 'world.task.created' }),
      event({ id: 'status', eventType: 'world.task.status_changed' }),
      event({ id: 'relation', eventType: 'world.relation.created' }),
      event({ id: 'world-event', eventType: 'world.event.created' }),
    ]);

    await startOutboxDispatcher();

    expect(graphitiShadow).toHaveBeenCalledWith(expect.objectContaining({ id: 'observation' }));
    expect(graphitiProjector).toHaveBeenCalledTimes(6);
    expect(mocks.markOutboxDispatched).toHaveBeenCalledTimes(6);
  });

  it('continues after initial dispatch errors and logs the failed tick', async () => {
    vi.useFakeTimers();
    mocks.config.enabled = true;
    mocks.listRuntimeWorldModelScopes.mockRejectedValueOnce(new Error('initial scan failed'));
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});

    await expect(startOutboxDispatcher()).resolves.toBeUndefined();
    expect(error).toHaveBeenCalledWith(
      '[world-model:outbox] initial dispatch failed:',
      expect.any(Error),
    );

    mocks.listRuntimeWorldModelScopes.mockRejectedValue(new Error('tick failed'));
    await vi.advanceTimersByTimeAsync(60_000);
    expect(error).toHaveBeenCalledWith(
      '[world-model:outbox] dispatch tick failed:',
      expect.any(Error),
    );
  });
});
