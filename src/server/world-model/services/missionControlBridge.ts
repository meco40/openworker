import { getWorldModelConfig } from '@/server/world-model/config';
import type { TaskStatus as MissionControlTaskStatus } from '@/lib/types';
import { isWorldModelRequired } from '@/server/world-model/mode';
import { executeAction, type ToolActionResult } from '@/server/world-model/services/actionService';
import { resolveTaskTransition } from '@/server/world-model/services/canonicalTaskService';
import { runWithWorldModelScope, withWorldModelTransaction } from '@/server/world-model/db';
import { enqueueOutboxEvent } from '@/server/world-model/repositories/outboxRepository';
import {
  insertTask,
  updateTaskStatusByExternalId,
  getTaskById,
} from '@/server/world-model/repositories/taskRepository';
import type { WorldModelScope } from '@/server/world-model/scope';
import type { OutboxEvent, TaskStatus as WorldModelTaskStatus } from '@/server/world-model/types';

/**
 * Phase 6/4: Bruecke zwischen Mission-Control-Tasks und kanonischen
 * World-Model-Services.
 *
 * Jede Task-Operation (create, update, dispatch, complete) wird zusaetzlich
 * im World Model gespiegelt. Im shadow-Modus ist das fail-soft, im
 * required/canonical-Modus blockierend.
 *
 * Tool-/E-Mail-/Kalender-Aktionen werden ueber `executeAction` idempotent
 * ausgefuert und ihr Ergebnis im World Model persistiert.
 */

export interface MissionControlTaskContext {
  taskId: string;
  userId: string;
  personaId: string;
  workspaceId: string;
  title: string;
  status: MissionControlTaskStatus;
  assignedAgentId?: string;
  dueDate?: string;
}

/** Maps the UI/task-store lifecycle to the smaller canonical task state machine. */
export function toWorldModelTaskStatus(status: MissionControlTaskStatus): WorldModelTaskStatus {
  switch (status) {
    case 'inbox':
      return 'proposed';
    case 'pending_dispatch':
    case 'planning':
      return 'planned';
    case 'assigned':
    case 'in_progress':
      return 'in_progress';
    case 'testing':
    case 'review':
      return 'waiting';
    case 'done':
      return 'completed';
  }
}

export interface MissionControlActionResult {
  attemptId: string;
  created: boolean;
  succeeded: boolean;
  error?: string;
  result?: ToolActionResult;
}

/**
 * Spiegelt eine Task-Statusaenderung ins World Model.
 */
export async function mirrorTaskStatusChange(
  context: MissionControlTaskContext,
  previousStatus: MissionControlTaskStatus | undefined,
): Promise<void> {
  const config = getWorldModelConfig();
  if (!config.enabled && !config.e2eEnabled) return;

  const canonicalPreviousStatus = previousStatus
    ? toWorldModelTaskStatus(previousStatus)
    : undefined;
  const canonicalStatus = toWorldModelTaskStatus(context.status);
  const transition = resolveTaskTransition(canonicalPreviousStatus, canonicalStatus);
  if (!transition.allowed) {
    if (isWorldModelRequired(config.mode)) {
      throw new Error(
        `[world-model:mission-control] invalid task transition: ${previousStatus} -> ${context.status}`,
      );
    }
    console.warn(
      `[world-model:mission-control] invalid task transition: ${previousStatus} -> ${context.status}`,
    );
    return;
  }

  try {
    await withWorldModelTransaction(async (client) => {
      await enqueueOutboxEvent(
        {
          eventType: 'world.task.status_changed',
          aggregateType: 'task',
          aggregateId: context.taskId,
          idempotencyKey: `task-status:${context.taskId}:${context.status}`,
          userId: context.userId,
          personaId: context.personaId,
          workspaceId: context.workspaceId,
          payload: {
            taskId: context.taskId,
            userId: context.userId,
            personaId: context.personaId,
            workspaceId: context.workspaceId,
            title: context.title,
            previousStatus: canonicalPreviousStatus,
            newStatus: canonicalStatus,
            sourcePreviousStatus: previousStatus,
            sourceNewStatus: context.status,
            assignedAgentId: context.assignedAgentId,
            dueDate: context.dueDate,
            changedAt: new Date().toISOString(),
          },
        },
        client,
      );
    });
  } catch (error) {
    if (isWorldModelRequired(config.mode)) throw error;
    console.error('[world-model:mission-control] task mirror failed (fail-soft):', error);
  }
}

/**
 * Fuehrt eine Tool-Aktion (E-Mail, Kalender, etc.) idempotent aus und
 * persistiert das Ergebnis im World Model.
 */
export function executeMissionControlAction(input: {
  scope: WorldModelScope;
  taskId: string;
  actionType: string;
  idempotencyKey: string;
  correlationId?: string;
  run: () => Promise<{ ok: boolean; error?: string; result?: ToolActionResult }>;
}): Promise<MissionControlActionResult> {
  return runWithWorldModelScope(input.scope, () => executeMissionControlActionInScope(input));
}

async function executeMissionControlActionInScope(input: {
  scope: WorldModelScope;
  taskId: string;
  actionType: string;
  idempotencyKey: string;
  correlationId?: string;
  run: () => Promise<{ ok: boolean; error?: string; result?: ToolActionResult }>;
}): Promise<MissionControlActionResult> {
  const config = getWorldModelConfig();
  if (!config.enabled && !config.e2eEnabled) {
    // Fallback: direkte Ausfuehrung ohne World-Model-Persistenz
    const result = await input.run();
    return {
      attemptId: `direct-${input.idempotencyKey}`,
      created: true,
      succeeded: result.ok,
      error: result.error,
      result: result.result,
    };
  }

  // Master run IDs are not necessarily canonical task IDs. Passing an
  // unknown value into the FK-backed action_attempts.task_id column would
  // turn a perfectly valid tool action into a persistence error. Keep the
  // correlation on the attempt while only linking an existing canonical task.
  let canonicalTaskId: string | undefined = input.taskId;
  if (canonicalTaskId) {
    try {
      if (!(await getTaskById(canonicalTaskId))) canonicalTaskId = undefined;
    } catch {
      canonicalTaskId = undefined;
    }
  }

  return executeAction({
    scope: input.scope,
    taskId: canonicalTaskId,
    actionType: input.actionType,
    idempotencyKey: input.idempotencyKey,
    correlationId: input.correlationId,
    run: input.run,
  });
}

/**
 * Spiegelt eine Task-Erstellung ins World Model.
 */
export async function mirrorTaskCreation(context: MissionControlTaskContext): Promise<void> {
  const config = getWorldModelConfig();
  if (!config.enabled && !config.e2eEnabled) return;

  try {
    await withWorldModelTransaction(async (client) => {
      await enqueueOutboxEvent(
        {
          eventType: 'world.task.created',
          aggregateType: 'task',
          aggregateId: context.taskId,
          idempotencyKey: `task-created:${context.taskId}`,
          userId: context.userId,
          personaId: context.personaId,
          workspaceId: context.workspaceId,
          payload: {
            taskId: context.taskId,
            userId: context.userId,
            personaId: context.personaId,
            workspaceId: context.workspaceId,
            title: context.title,
            status: context.status,
            assignedAgentId: context.assignedAgentId,
            dueDate: context.dueDate,
            createdAt: new Date().toISOString(),
          },
        },
        client,
      );
    });
  } catch (error) {
    if (isWorldModelRequired(config.mode)) throw error;
    console.error('[world-model:mission-control] task creation mirror failed (fail-soft):', error);
  }
}

/**
 * Spiegelt eine Task-Loeschung ins World Model.
 */
export async function mirrorTaskDeletion(
  taskId: string,
  userId: string,
  personaId: string,
  workspaceId: string,
): Promise<void> {
  const config = getWorldModelConfig();
  if (!config.enabled && !config.e2eEnabled) return;

  try {
    await withWorldModelTransaction(async (client) => {
      await enqueueOutboxEvent(
        {
          eventType: 'world.task.deleted',
          aggregateType: 'task',
          aggregateId: taskId,
          idempotencyKey: `task-deleted:${taskId}`,
          userId,
          personaId,
          workspaceId,
          payload: {
            taskId,
            userId,
            personaId,
            workspaceId,
            deletedAt: new Date().toISOString(),
          },
        },
        client,
      );
    });
  } catch (error) {
    if (isWorldModelRequired(config.mode)) throw error;
    console.error('[world-model:mission-control] task deletion mirror failed (fail-soft):', error);
  }
}

/**
 * Validiert, ob eine Task-Transition im World Model erlaubt ist.
 * Wrapper um `canTransitionTask` mit zusaetzlichem Logging.
 */
export function validateTaskTransition(
  from: MissionControlTaskStatus | undefined,
  to: MissionControlTaskStatus,
): { allowed: boolean; reason: string } {
  const result = resolveTaskTransition(
    from ? toWorldModelTaskStatus(from) : undefined,
    toWorldModelTaskStatus(to),
  );
  return {
    allowed: result.allowed,
    reason: result.reason ?? 'ok',
  };
}

function requiredPayloadString(event: OutboxEvent, key: string): string {
  const value = event.payload[key] ?? (key === 'taskId' ? event.aggregateId : undefined);
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`[world-model:mission-control] missing ${key} in ${event.eventType}`);
  }
  return value;
}

function payloadWorldModelStatus(event: OutboxEvent, key: string): WorldModelTaskStatus {
  const value = event.payload[key];
  const statuses: WorldModelTaskStatus[] = [
    'proposed',
    'planned',
    'in_progress',
    'waiting',
    'completed',
    'cancelled',
    'failed',
  ];
  if (typeof value !== 'string' || !statuses.includes(value as WorldModelTaskStatus)) {
    throw new Error(`[world-model:mission-control] invalid ${key} in ${event.eventType}`);
  }
  return value as WorldModelTaskStatus;
}

/** Projects Mission Control's outbox events into the canonical task table. */
export async function projectMissionControlTaskCreated(event: OutboxEvent): Promise<void> {
  const taskId = requiredPayloadString(event, 'taskId');
  const userId = requiredPayloadString(event, 'userId');
  const personaId = requiredPayloadString(event, 'personaId');
  const workspaceId = String(event.payload.workspaceId ?? event.workspaceId ?? '');
  const title = requiredPayloadString(event, 'title');
  const sourceStatus = event.payload.status;
  const sourceStatuses: MissionControlTaskStatus[] = [
    'inbox',
    'pending_dispatch',
    'planning',
    'assigned',
    'in_progress',
    'testing',
    'review',
    'done',
  ];
  if (
    typeof sourceStatus !== 'string' ||
    !sourceStatuses.includes(sourceStatus as MissionControlTaskStatus)
  ) {
    throw new Error(`[world-model:mission-control] invalid status in ${event.eventType}`);
  }

  await insertTask({
    userId,
    personaId,
    workspaceId,
    title,
    status: toWorldModelTaskStatus(sourceStatus as MissionControlTaskStatus),
    dueAt: typeof event.payload.dueDate === 'string' ? event.payload.dueDate : undefined,
    requester: userId,
    assignee:
      typeof event.payload.assignedAgentId === 'string' ? event.payload.assignedAgentId : userId,
    externalTaskId: taskId,
    origin: 'mission_control',
    idempotencyKey: `task-created:${taskId}`,
  });
}

export async function projectMissionControlTaskStatusChanged(event: OutboxEvent): Promise<void> {
  const taskId = requiredPayloadString(event, 'taskId');
  const userId = requiredPayloadString(event, 'userId');
  const personaId = requiredPayloadString(event, 'personaId');
  const workspaceId = String(event.payload.workspaceId ?? event.workspaceId ?? '');
  const status = payloadWorldModelStatus(event, 'newStatus');
  const updated = await updateTaskStatusByExternalId(
    taskId,
    userId,
    personaId,
    workspaceId,
    status,
  );
  if (!updated) {
    throw new Error(`[world-model:mission-control] task ${taskId} is not projected yet`);
  }
}

export async function projectMissionControlTaskDeleted(event: OutboxEvent): Promise<void> {
  const taskId = requiredPayloadString(event, 'taskId');
  const userId = requiredPayloadString(event, 'userId');
  const personaId = requiredPayloadString(event, 'personaId');
  const workspaceId = String(event.payload.workspaceId ?? event.workspaceId ?? '');
  // Keep the canonical row for auditability; a missing row is already in the
  // desired terminal state and must not make a deletion event retry forever.
  await updateTaskStatusByExternalId(taskId, userId, personaId, workspaceId, 'cancelled');
}
