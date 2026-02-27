import type { MasterRunStatus } from '@/server/master/types';

const TRANSITIONS: Record<MasterRunStatus, MasterRunStatus[]> = {
  IDLE: ['ANALYZING'],
  ANALYZING: ['PLANNING', 'FAILED'],
  PLANNING: ['DELEGATING', 'EXECUTING', 'FAILED'],
  DELEGATING: ['EXECUTING', 'VERIFYING', 'FAILED'],
  EXECUTING: ['VERIFYING', 'REFINING', 'AWAITING_APPROVAL', 'FAILED'],
  VERIFYING: ['COMPLETED', 'REFINING', 'FAILED'],
  REFINING: ['PLANNING', 'EXECUTING', 'FAILED'],
  AWAITING_APPROVAL: ['EXECUTING', 'REFINING', 'FAILED'],
  COMPLETED: [],
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
  options?: { verificationPassed?: boolean; needsApproval?: boolean; failed?: boolean },
): MasterRunStatus {
  if (options?.failed) return 'FAILED';
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
