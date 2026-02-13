// ─── Worker State Machine ────────────────────────────────────
// Defines allowed status transitions for manual (Kanban drag)
// and system (agent loop) operations.

import type { WorkerTaskStatus } from './workerTypes';

export type { WorkerTaskStatus };

export type TransitionSource = 'manual' | 'system';

/**
 * Statuses where the agent is actively processing.
 * Manual transitions are blocked for these, except → cancelled.
 */
const ACTIVE_STATUSES: ReadonlySet<WorkerTaskStatus> = new Set([
  'planning',
  'executing',
  'clarifying',
  'waiting_approval',
]);

/** Check if a status is actively being processed by the agent. */
export function isActiveStatus(status: WorkerTaskStatus): boolean {
  return ACTIVE_STATUSES.has(status);
}

/**
 * Manual transitions table.
 * Key = current status, Value = set of allowed target statuses.
 */
const MANUAL_TRANSITIONS: Record<string, ReadonlySet<string>> = {
  inbox: new Set(['queued', 'assigned', 'cancelled']),
  assigned: new Set(['queued', 'inbox', 'cancelled']),
  queued: new Set(['inbox', 'cancelled']),
  // Active statuses: only cancelled allowed
  planning: new Set(['cancelled']),
  executing: new Set(['cancelled']),
  clarifying: new Set(['cancelled']),
  waiting_approval: new Set(['cancelled']),
  testing: new Set(['review', 'assigned', 'cancelled']),
  review: new Set(['completed', 'assigned', 'cancelled']),
  completed: new Set(['review']),
  failed: new Set(['queued', 'cancelled']),
  interrupted: new Set(['queued', 'cancelled']),
  cancelled: new Set([]),
};

/**
 * System transitions table.
 * The agent can move between these statuses programmatically.
 */
const SYSTEM_TRANSITIONS: Record<string, ReadonlySet<string>> = {
  queued: new Set(['planning']),
  planning: new Set(['executing', 'clarifying']),
  clarifying: new Set(['planning', 'executing']),
  executing: new Set(['testing', 'review', 'waiting_approval', 'completed']),
  waiting_approval: new Set(['executing']),
  testing: new Set(['review', 'executing']),
  review: new Set(['completed']),
};

/** Universal system targets — always reachable from any status. */
const UNIVERSAL_SYSTEM_TARGETS: ReadonlySet<string> = new Set([
  'failed',
  'cancelled',
  'interrupted',
]);

/**
 * Check if a status transition is allowed.
 * @param from Current status
 * @param to Target status
 * @param source 'manual' (Kanban drag) or 'system' (agent/API)
 */
export function canTransition(
  from: WorkerTaskStatus,
  to: WorkerTaskStatus,
  source: TransitionSource,
): boolean {
  if (from === to) return false;

  if (source === 'manual') {
    const allowed = MANUAL_TRANSITIONS[from];
    return allowed ? allowed.has(to) : false;
  }

  // System transitions
  if (UNIVERSAL_SYSTEM_TARGETS.has(to)) return true;
  const allowed = SYSTEM_TRANSITIONS[from];
  return allowed ? allowed.has(to) : false;
}

/** Kanban column definitions for UI rendering. */
export interface KanbanColumn {
  id: string;
  label: string;
  statuses: WorkerTaskStatus[];
}

export const KANBAN_COLUMNS: readonly KanbanColumn[] = [
  {
    id: 'planning',
    label: 'Planung',
    statuses: ['planning', 'clarifying'],
  },
  { id: 'inbox', label: 'Eingang', statuses: ['inbox'] },
  {
    id: 'assigned',
    label: 'Zugewiesen',
    statuses: ['queued', 'assigned'],
  },
  {
    id: 'in-progress',
    label: 'In Arbeit',
    statuses: ['executing', 'waiting_approval'],
  },
  { id: 'testing', label: 'Testing', statuses: ['testing'] },
  { id: 'review', label: 'Review', statuses: ['review'] },
  {
    id: 'done',
    label: 'Erledigt',
    statuses: ['completed', 'failed', 'cancelled', 'interrupted'],
  },
] as const;
