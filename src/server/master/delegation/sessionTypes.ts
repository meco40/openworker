import type {
  MasterDelegationEvent,
  MasterDelegationJob,
  MasterSubagentSession,
} from '@/server/master/types';

export interface SubagentSessionDetail {
  session: MasterSubagentSession;
  job: MasterDelegationJob | null;
  events: MasterDelegationEvent[];
}

export interface ClaimSubagentSessionInput {
  ownerId: string;
  now?: string;
  leaseMs?: number;
  runId?: string;
}
