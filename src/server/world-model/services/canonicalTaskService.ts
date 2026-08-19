import type { TaskStatus } from '@/server/world-model/types';

const ALLOWED_TASK_TRANSITIONS: Record<TaskStatus, readonly TaskStatus[]> = {
  proposed: ['planned', 'cancelled', 'in_progress', 'completed'],
  planned: ['in_progress', 'waiting', 'cancelled', 'failed'],
  in_progress: ['completed', 'failed', 'waiting', 'cancelled'],
  waiting: ['in_progress', 'cancelled', 'failed', 'completed'],
  completed: [],
  cancelled: [],
  failed: ['in_progress', 'planned'],
};

export interface TaskTransitionResult {
  allowed: boolean;
  from: TaskStatus;
  to: TaskStatus;
  reason?: 'not_found' | 'invalid_transition' | 'ok';
}

/**
 * Phase 6: Statusautomat fuer Canonical Tasks. Reine Entscheidungsfunktion.
 * `completed` erfordert eine bestaetigende Evidenz; der Aufrufer speichert
 * diese (completion_evidence_id / result) vor dem Transition.
 */
export function canTransitionTask(from: TaskStatus, to: TaskStatus): boolean {
  return (ALLOWED_TASK_TRANSITIONS[from] ?? []).includes(to);
}

export function resolveTaskTransition(
  from: TaskStatus | undefined,
  to: TaskStatus,
): TaskTransitionResult {
  if (!from) return { allowed: true, from: 'proposed', to, reason: 'ok' };
  if (canTransitionTask(from, to)) {
    return { allowed: true, from, to, reason: 'ok' };
  }
  return { allowed: false, from, to, reason: 'invalid_transition' };
}

/**
 * Idempotenz: completed darf nur einmal gesetzt werden.
 */
export function isTaskCompletionAllowed(current: TaskStatus | undefined): boolean {
  return current !== 'completed';
}
