import { getServerEventBus } from '@/server/events/runtime';

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

export function isActiveStatus(status: LifecycleStatus): boolean {
  return ACTIVE_STATUSES.has(status);
}

export function resolveLifecycleStatus(
  metadata: Record<string, unknown> | undefined,
  now = Date.now(),
): { status: LifecycleStatus; derivedSignal: LifecycleSignal | null } {
  const rawStatus = String(metadata?.lifecycleStatus || '')
    .trim()
    .toLowerCase();
  const knownStatus: LifecycleStatus[] = ['new', 'confirmed', 'stale', 'superseded', 'rejected'];
  const status = knownStatus.includes(rawStatus as LifecycleStatus)
    ? (rawStatus as LifecycleStatus)
    : 'new';
  const expiresAt = Date.parse(String(metadata?.expiresAt || ''));
  if (Number.isFinite(expiresAt) && expiresAt <= now && isActiveStatus(status)) {
    return { status: transitionLifecycle(status, 'time_expired'), derivedSignal: 'time_expired' };
  }
  return { status, derivedSignal: null };
}

export function isActiveMemoryMetadata(metadata: Record<string, unknown> | undefined): boolean {
  return isActiveStatus(resolveLifecycleStatus(metadata).status);
}

export function withLifecycleSignal(
  metadata: Record<string, unknown> | undefined,
  signal: LifecycleSignal,
  now = new Date().toISOString(),
): Record<string, unknown> {
  const current = resolveLifecycleStatus(metadata).status;
  return {
    ...metadata,
    lifecycleStatus: transitionLifecycle(current, signal),
    lifecycleSignal: signal,
    lifecycleUpdatedAt: now,
  };
}

export function publishMemoryLifecycleChange(input: {
  memoryId: string;
  userId: string;
  personaId: string;
  status: LifecycleStatus;
  signal: LifecycleSignal;
  provider?: 'postgres' | 'mem0' | 'sqlite';
}): void {
  getServerEventBus().publish('memory.lifecycle.changed', {
    ...input,
    provider: input.provider || 'mem0',
    at: new Date().toISOString(),
  });
}
