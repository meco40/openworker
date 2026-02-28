import type { MasterRunStatus } from '@/server/master/types';

const TRANSITIONS: Record<MasterRunStatus, MasterRunStatus[]> = {
  IDLE: ['ANALYZING', 'CANCELLED'],
  ANALYZING: ['PLANNING', 'FAILED', 'CANCELLED'],
  PLANNING: ['DELEGATING', 'EXECUTING', 'FAILED', 'CANCELLED'],
  DELEGATING: ['EXECUTING', 'VERIFYING', 'FAILED', 'CANCELLED'],
  EXECUTING: ['VERIFYING', 'REFINING', 'AWAITING_APPROVAL', 'FAILED', 'CANCELLED'],
  VERIFYING: ['COMPLETED', 'REFINING', 'FAILED', 'CANCELLED'],
  REFINING: ['PLANNING', 'EXECUTING', 'FAILED', 'CANCELLED'],
  AWAITING_APPROVAL: ['EXECUTING', 'REFINING', 'FAILED', 'CANCELLED'],
  COMPLETED: [],
  CANCELLED: [],
  FAILED: [],
};

export function canTransition(from: MasterRunStatus, to: MasterRunStatus): boolean {
  return TRANSITIONS[from].includes(to);
}

export function assertTransition(from: MasterRunStatus, to: MasterRunStatus): void {
  if (!canTransition(from, to)) {
    throw new Error(`Invalid master run transition: ${from} -> ${to}`);
  }
}

export function nextLifecycleStatus(
  status: MasterRunStatus,
  options?: {
    verificationPassed?: boolean;
    needsApproval?: boolean;
    failed?: boolean;
    cancelled?: boolean;
  },
): MasterRunStatus {
  if (options?.failed) return 'FAILED';
  if (options?.cancelled) return 'CANCELLED';
  if (options?.needsApproval) return 'AWAITING_APPROVAL';
  if (status === 'ANALYZING') return 'PLANNING';
  if (status === 'PLANNING') return 'DELEGATING';
  if (status === 'DELEGATING') return 'EXECUTING';
  if (status === 'EXECUTING') return 'VERIFYING';
  if (status === 'VERIFYING') return options?.verificationPassed ? 'COMPLETED' : 'REFINING';
  if (status === 'REFINING') return 'PLANNING';
  if (status === 'AWAITING_APPROVAL') return 'EXECUTING';
  return status;
}
