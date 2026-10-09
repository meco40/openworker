import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { OutboxEvent } from '@/server/world-model/types';

const mocks = vi.hoisted(() => {
  const client = { query: vi.fn() };
  return {
    client,
    getWorldModelConfig: vi.fn(),
    runWithWorldModelScope: vi.fn(),
    withWorldModelTransaction: vi.fn(),
    enqueueOutboxEvent: vi.fn(),
    insertTask: vi.fn(),
    updateTaskStatusByExternalId: vi.fn(),
    getTaskById: vi.fn(),
    executeAction: vi.fn(),
  };
});

vi.mock('@/server/world-model/config', () => ({
  getWorldModelConfig: mocks.getWorldModelConfig,
}));
vi.mock('@/server/world-model/db', () => ({
  runWithWorldModelScope: mocks.runWithWorldModelScope,
  withWorldModelTransaction: mocks.withWorldModelTransaction,
}));
vi.mock('@/server/world-model/repositories/outboxRepository', () => ({
  enqueueOutboxEvent: mocks.enqueueOutboxEvent,
}));
vi.mock('@/server/world-model/repositories/taskRepository', () => ({
  insertTask: mocks.insertTask,
  updateTaskStatusByExternalId: mocks.updateTaskStatusByExternalId,
  getTaskById: mocks.getTaskById,
}));
vi.mock('@/server/world-model/services/actionService', () => ({
  executeAction: mocks.executeAction,
}));

import {
  executeMissionControlAction,
  mirrorTaskCreation,
  mirrorTaskDeletion,
  mirrorTaskStatusChange,
  projectMissionControlTaskCreated,
  projectMissionControlTaskDeleted,
  projectMissionControlTaskStatusChanged,
  toWorldModelTaskStatus,
  validateTaskTransition,
} from '@/server/world-model/services/missionControlBridge';

const context = {
  taskId: 'task-1',
  userId: 'user-1',
  personaId: 'assistant',
  workspaceId: 'workspace-a',
  title: 'Prepare dinner',
  status: 'planning' as const,
  assignedAgentId: 'agent-1',
  dueDate: '2026-10-09T12:00:00.000Z',
};

function outboxEvent(
  eventType: string,
  payload: Record<string, unknown>,
  overrides: Partial<OutboxEvent> = {},
): OutboxEvent {
  return {
    id: 'event-1',
    eventType,
    aggregateType: 'task',
    aggregateId: 'task-1',
    payload,
    status: 'pending',
    attempts: 0,
    createdAt: '2026-10-08T00:00:00.000Z',
    ...overrides,
  };
}

function setConfig(overrides: { enabled?: boolean; e2eEnabled?: boolean; mode?: string } = {}) {
  mocks.getWorldModelConfig.mockReturnValue({
    enabled: true,
    e2eEnabled: false,
    mode: 'shadow',
    ...overrides,
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  setConfig();
  mocks.runWithWorldModelScope.mockImplementation((_scope, callback) => callback());
  mocks.withWorldModelTransaction.mockImplementation((callback) => callback(mocks.client));
  mocks.updateTaskStatusByExternalId.mockResolvedValue(true);
  mocks.getTaskById.mockResolvedValue({ id: 'task-1' });
  mocks.executeAction.mockResolvedValue({
    attemptId: 'attempt-1',
    created: true,
    succeeded: true,
  });
});

afterEach(() => vi.restoreAllMocks());

describe('Mission Control task status bridge', () => {
  it('maps external lifecycle states to canonical World Model states', () => {
    expect(toWorldModelTaskStatus('inbox')).toBe('proposed');
    expect(toWorldModelTaskStatus('pending_dispatch')).toBe('planned');
    expect(toWorldModelTaskStatus('planning')).toBe('planned');
    expect(toWorldModelTaskStatus('assigned')).toBe('in_progress');
    expect(toWorldModelTaskStatus('in_progress')).toBe('in_progress');
    expect(toWorldModelTaskStatus('testing')).toBe('waiting');
    expect(toWorldModelTaskStatus('review')).toBe('waiting');
    expect(toWorldModelTaskStatus('done')).toBe('completed');
  });

  it('validates transitions after mapping instead of casting unrelated enums', () => {
    expect(validateTaskTransition('review', 'done').allowed).toBe(true);
    expect(validateTaskTransition('done', 'review').allowed).toBe(false);
    expect(validateTaskTransition(undefined, 'inbox')).toMatchObject({
      allowed: true,
      reason: 'ok',
    });
  });

  it('does nothing while disabled and directly executes actions without canonical persistence', async () => {
    setConfig({ enabled: false, e2eEnabled: false, mode: 'off' });
    const run = vi.fn(async () => ({ ok: false, error: 'provider unavailable' }));
    const input = {
      scope: { userId: 'user-1', personaId: 'assistant', workspaceId: 'workspace-a' },
      taskId: 'external-task-1',
      actionType: 'email.send',
      idempotencyKey: 'action-1',
      run,
    };

    await mirrorTaskCreation(context);
    await mirrorTaskStatusChange(context, 'inbox');
    await mirrorTaskDeletion(
      context.taskId,
      context.userId,
      context.personaId,
      context.workspaceId,
    );
    await expect(executeMissionControlAction(input)).resolves.toEqual({
      attemptId: 'direct-action-1',
      created: true,
      succeeded: false,
      error: 'provider unavailable',
      result: undefined,
    });

    expect(run).toHaveBeenCalledOnce();
    expect(mocks.withWorldModelTransaction).not.toHaveBeenCalled();
    expect(mocks.enqueueOutboxEvent).not.toHaveBeenCalled();
    expect(mocks.executeAction).not.toHaveBeenCalled();
  });

  it('mirrors task lifecycle events with canonical status and scope metadata', async () => {
    await mirrorTaskCreation(context);
    await mirrorTaskStatusChange(context, 'inbox');
    await mirrorTaskDeletion(
      context.taskId,
      context.userId,
      context.personaId,
      context.workspaceId,
    );

    expect(mocks.withWorldModelTransaction).toHaveBeenCalledTimes(3);
    expect(mocks.enqueueOutboxEvent).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        eventType: 'world.task.created',
        aggregateId: context.taskId,
        idempotencyKey: `task-created:${context.taskId}`,
        payload: expect.objectContaining({
          title: context.title,
          status: context.status,
          assignedAgentId: context.assignedAgentId,
          dueDate: context.dueDate,
        }),
      }),
      mocks.client,
    );
    expect(mocks.enqueueOutboxEvent).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        eventType: 'world.task.status_changed',
        idempotencyKey: `task-status:${context.taskId}:${context.status}`,
        payload: expect.objectContaining({
          previousStatus: 'proposed',
          newStatus: 'planned',
          sourcePreviousStatus: 'inbox',
          sourceNewStatus: 'planning',
        }),
      }),
      mocks.client,
    );
    expect(mocks.enqueueOutboxEvent).toHaveBeenNthCalledWith(
      3,
      expect.objectContaining({
        eventType: 'world.task.deleted',
        idempotencyKey: `task-deleted:${context.taskId}`,
        payload: expect.objectContaining({ workspaceId: context.workspaceId }),
      }),
      mocks.client,
    );
  });

  it('warns on invalid shadow transitions and blocks them in required mode', async () => {
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await mirrorTaskStatusChange({ ...context, status: 'review' }, 'done');
    expect(warning).toHaveBeenCalledWith(
      '[world-model:mission-control] invalid task transition: done -> review',
    );
    expect(mocks.withWorldModelTransaction).not.toHaveBeenCalled();

    setConfig({ mode: 'required' });
    await expect(mirrorTaskStatusChange({ ...context, status: 'review' }, 'done')).rejects.toThrow(
      'invalid task transition: done -> review',
    );
  });

  it.each([
    ['creation', () => mirrorTaskCreation(context), 'task creation mirror failed'],
    [
      'deletion',
      () =>
        mirrorTaskDeletion(context.taskId, context.userId, context.personaId, context.workspaceId),
      'task deletion mirror failed',
    ],
  ])(
    'fails softly for %s persistence errors in shadow mode and rethrows when required',
    async (_, run, label) => {
      const error = new Error('database unavailable');
      const log = vi.spyOn(console, 'error').mockImplementation(() => {});
      mocks.withWorldModelTransaction.mockRejectedValueOnce(error);
      await expect(run()).resolves.toBeUndefined();
      expect(log).toHaveBeenCalledWith(
        `[world-model:mission-control] ${label} (fail-soft):`,
        error,
      );

      setConfig({ mode: 'required' });
      mocks.withWorldModelTransaction.mockRejectedValueOnce(error);
      await expect(run()).rejects.toBe(error);
    },
  );

  it('executes actions with canonical task linkage when available and keeps unknown IDs unlinked', async () => {
    const scope = { userId: 'user-1', personaId: 'assistant', workspaceId: 'workspace-a' };
    const run = vi.fn(async () => ({ ok: true, result: { providerId: 'mail-1' } }));
    const baseInput = {
      scope,
      taskId: 'task-1',
      actionType: 'email.send',
      idempotencyKey: 'action-1',
      correlationId: 'master-run-1',
      run,
    };

    await expect(executeMissionControlAction(baseInput)).resolves.toMatchObject({
      attemptId: 'attempt-1',
      created: true,
      succeeded: true,
    });
    expect(mocks.runWithWorldModelScope).toHaveBeenCalledWith(scope, expect.any(Function));
    expect(mocks.executeAction).toHaveBeenCalledWith(
      expect.objectContaining({
        scope,
        taskId: 'task-1',
        actionType: 'email.send',
        idempotencyKey: 'action-1',
        correlationId: 'master-run-1',
        run,
      }),
    );

    mocks.executeAction.mockClear();
    mocks.getTaskById.mockResolvedValueOnce(null);
    await executeMissionControlAction({ ...baseInput, taskId: 'master-run-unknown' });
    expect(mocks.executeAction).toHaveBeenCalledWith(
      expect.objectContaining({ taskId: undefined }),
    );

    mocks.executeAction.mockClear();
    await executeMissionControlAction({ ...baseInput, taskId: '' });
    expect(mocks.getTaskById).toHaveBeenCalledTimes(2);
    expect(mocks.executeAction).toHaveBeenCalledWith(expect.objectContaining({ taskId: '' }));
  });

  it('falls back to unlinked action execution when canonical task lookup fails', async () => {
    mocks.getTaskById.mockRejectedValueOnce(new Error('database unavailable'));
    await executeMissionControlAction({
      scope: { userId: 'user-1', personaId: 'assistant', workspaceId: 'workspace-a' },
      taskId: 'external-task-1',
      actionType: 'calendar.create',
      idempotencyKey: 'action-2',
      run: async () => ({ ok: true }),
    });
    expect(mocks.executeAction).toHaveBeenCalledWith(
      expect.objectContaining({ taskId: undefined }),
    );
  });

  it('projects task creation defaults, rejects invalid sources, and updates the canonical status', async () => {
    await projectMissionControlTaskCreated(
      outboxEvent(
        'world.task.created',
        {
          userId: 'user-1',
          personaId: 'assistant',
          title: 'Projected task',
          status: 'assigned',
          assignedAgentId: 'agent-2',
          dueDate: '2026-10-10T10:00:00.000Z',
        },
        { workspaceId: 'workspace-a' },
      ),
    );
    expect(mocks.insertTask).toHaveBeenCalledWith({
      userId: 'user-1',
      personaId: 'assistant',
      workspaceId: 'workspace-a',
      title: 'Projected task',
      status: 'in_progress',
      dueAt: '2026-10-10T10:00:00.000Z',
      requester: 'user-1',
      assignee: 'agent-2',
      externalTaskId: 'task-1',
      origin: 'mission_control',
      idempotencyKey: 'task-created:task-1',
    });

    await projectMissionControlTaskCreated(
      outboxEvent('world.task.created', {
        taskId: 'payload-task',
        userId: 'user-1',
        personaId: 'assistant',
        workspaceId: 'payload-workspace',
        title: 'No assignee',
        status: 'inbox',
        dueDate: 9,
      }),
    );
    expect(mocks.insertTask).toHaveBeenLastCalledWith(
      expect.objectContaining({
        workspaceId: 'payload-workspace',
        status: 'proposed',
        dueAt: undefined,
        assignee: 'user-1',
        externalTaskId: 'payload-task',
      }),
    );
    await expect(
      projectMissionControlTaskCreated(
        outboxEvent('world.task.created', {
          userId: 'user-1',
          personaId: 'assistant',
          status: 'inbox',
        }),
      ),
    ).rejects.toThrow('missing title');
    await expect(
      projectMissionControlTaskCreated(
        outboxEvent('world.task.created', {
          userId: 'user-1',
          personaId: 'assistant',
          title: 'Invalid',
          status: 'cancelled',
        }),
      ),
    ).rejects.toThrow('invalid status');
  });

  it('rejects invalid projected status events and accepts deletion for missing rows', async () => {
    await projectMissionControlTaskStatusChanged(
      outboxEvent(
        'world.task.status_changed',
        {
          userId: 'user-1',
          personaId: 'assistant',
          newStatus: 'waiting',
        },
        { workspaceId: 'workspace-a' },
      ),
    );
    expect(mocks.updateTaskStatusByExternalId).toHaveBeenCalledWith(
      'task-1',
      'user-1',
      'assistant',
      'workspace-a',
      'waiting',
    );

    await expect(
      projectMissionControlTaskStatusChanged(
        outboxEvent('world.task.status_changed', {
          taskId: 'task-1',
          userId: 'user-1',
          personaId: 'assistant',
          newStatus: 'not-a-status',
        }),
      ),
    ).rejects.toThrow('invalid newStatus');
    mocks.updateTaskStatusByExternalId.mockResolvedValueOnce(false);
    await expect(
      projectMissionControlTaskStatusChanged(
        outboxEvent('world.task.status_changed', {
          taskId: 'task-1',
          userId: 'user-1',
          personaId: 'assistant',
          newStatus: 'completed',
        }),
      ),
    ).rejects.toThrow('task task-1 is not projected yet');

    mocks.updateTaskStatusByExternalId.mockResolvedValueOnce(false);
    await expect(
      projectMissionControlTaskDeleted(
        outboxEvent('world.task.deleted', {
          userId: 'user-1',
          personaId: 'assistant',
        }),
      ),
    ).resolves.toBeUndefined();
    expect(mocks.updateTaskStatusByExternalId).toHaveBeenLastCalledWith(
      'task-1',
      'user-1',
      'assistant',
      '',
      'cancelled',
    );
  });
});
