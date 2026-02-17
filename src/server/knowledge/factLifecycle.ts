/**
 * Fact Lifecycle — state machine for knowledge facts.
 *
 * Each fact/event/entity traverses:
 *   new → confirmed → stale → rejected
 *          ↑              ↓
 *          └── reactivated ┘
 */

export type LifecycleStatus = 'new' | 'confirmed' | 'stale' | 'superseded' | 'rejected';

export type LifecycleSignal =
  | 'user_confirmed'
  | 'repeated_in_session'
  | 'contradicted'
  | 'corrected_by_user'
  | 'time_expired'
  | 'reactivated'
  | 'garbage_collected';

const ACTIVE_STATUSES: ReadonlySet<LifecycleStatus> = new Set(['new', 'confirmed']);

/**
 * Pure state transition function for the fact lifecycle.
 * Returns the new lifecycle status given a current status and an incoming signal.
 */
export function transitionLifecycle(
  currentStatus: LifecycleStatus,
  signal: LifecycleSignal,
): LifecycleStatus {
  switch (signal) {
    case 'user_confirmed':
      return 'confirmed';

    case 'repeated_in_session':
      return currentStatus === 'new' ? 'confirmed' : currentStatus;

    case 'contradicted':
      return 'superseded';

    case 'corrected_by_user':
      return 'superseded';

    case 'time_expired':
      return 'stale';

    case 'reactivated':
      return 'confirmed';

    case 'garbage_collected':
      return 'rejected';

    default:
      return currentStatus;
  }
}

/**
 * Checks whether a lifecycle status counts as "active" for retrieval.
 * Only 'new' and 'confirmed' facts are included in recall results.
 */
export function isActiveStatus(status: LifecycleStatus): boolean {
  return ACTIVE_STATUSES.has(status);
}
