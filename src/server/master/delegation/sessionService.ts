import type { MasterRepository } from '@/server/master/repository';
import type {
  MasterDelegationEvent,
  MasterDelegationJob,
  MasterSubagentSession,
  WorkspaceScope,
} from '@/server/master/types';
import { publishMasterUpdated } from '@/server/master/liveEvents';
import type {
  ClaimSubagentSessionInput,
  SubagentSessionDetail,
} from '@/server/master/delegation/sessionTypes';

const DEFAULT_LEASE_MS = 30_000;

function nowIso(): string {
  return new Date().toISOString();
}

function expiresAt(now: string, leaseMs: number): string {
  return new Date(new Date(now).getTime() + leaseMs).toISOString();
}

function summarizePayload(payload: string): string {
  const trimmed = payload.trim();
  if (trimmed.length === 0) return 'Review delegated task context.';
  return trimmed.length > 180 ? `${trimmed.slice(0, 177)}...` : trimmed;
}

function buildSessionTitle(capability: string): string {
  return capability
    .split(/[_\-.]+/)
    .filter(Boolean)
    .map((part) => part.slice(0, 1).toUpperCase() + part.slice(1))
    .join(' ');
}

function sortSessionsForPairing(sessions: MasterSubagentSession[]): MasterSubagentSession[] {
  return [...sessions].sort((left, right) => {
    const createdDelta = new Date(left.createdAt).getTime() - new Date(right.createdAt).getTime();
    if (createdDelta !== 0) return createdDelta;
    return left.id.localeCompare(right.id);
  });
}

function pairJobForSession(
  repo: MasterRepository,
  scope: WorkspaceScope,
  session: MasterSubagentSession,
): MasterDelegationJob | null {
  const orderedSessions = sortSessionsForPairing(
    repo.listSubagentSessions(scope, session.runId, 500),
  );
  const orderedJobs = [...repo.listDelegationJobs(scope, session.runId)].sort((left, right) => {
    const createdDelta = new Date(left.createdAt).getTime() - new Date(right.createdAt).getTime();
    if (createdDelta !== 0) return createdDelta;
    return left.id.localeCompare(right.id);
  });
  const index = orderedSessions.findIndex((entry) => entry.id === session.id);
  return index >= 0 ? (orderedJobs[index] ?? null) : null;
}

function isLeaseExpired(session: MasterSubagentSession, now: string): boolean {
  if (!session.leaseExpiresAt) return true;
  return new Date(session.leaseExpiresAt).getTime() <= new Date(now).getTime();
}

export function createSubagentSessionForDispatch(
  repo: MasterRepository,
  scope: WorkspaceScope,
  input: {
    runId: string;
    capability: string;
    payload: string;
    assignedTools?: string[];
  },
): MasterSubagentSession {
  const created = repo.createSubagentSession(scope, {
    runId: input.runId,
    status: 'queued',
    title: buildSessionTitle(input.capability),
    prompt: summarizePayload(input.payload),
    assignedTools: input.assignedTools ?? [input.capability],
    ownerId: null,
    leaseExpiresAt: null,
    heartbeatAt: null,
    latestEventAt: null,
    resultSummary: null,
    lastError: null,
  });
  publishMasterUpdated({
    scope,
    resources: ['subagents', 'metrics'],
    runId: input.runId,
    sessionId: created.id,
  });
  return created;
}

export function claimSubagentSession(
  repo: MasterRepository,
  scope: WorkspaceScope,
  sessionId: string,
  input: Omit<ClaimSubagentSessionInput, 'runId'>,
): MasterSubagentSession | null {
  const session = repo.getSubagentSession(scope, sessionId);
  if (!session) return null;
  const now = input.now ?? nowIso();
  if (session.status === 'cancelled' || session.status === 'completed') {
    return null;
  }
  if (
    session.status === 'running' &&
    !isLeaseExpired(session, now) &&
    session.ownerId !== input.ownerId
  ) {
    return null;
  }
  const updated = repo.updateSubagentSession(scope, sessionId, {
    status: 'running',
    ownerId: input.ownerId,
    leaseExpiresAt: expiresAt(now, input.leaseMs ?? DEFAULT_LEASE_MS),
    heartbeatAt: now,
  });
  if (updated) {
    publishMasterUpdated({
      scope,
      resources: ['subagents', 'metrics'],
      runId: updated.runId,
      sessionId: updated.id,
    });
  }
  return updated;
}

export function claimNextSubagentSession(
  repo: MasterRepository,
  scope: WorkspaceScope,
  input: ClaimSubagentSessionInput,
): MasterSubagentSession | null {
  const now = input.now ?? nowIso();
  const sessions = repo.listSubagentSessions(scope, input.runId, 500);
  const queued = sortSessionsForPairing(sessions.filter((session) => session.status === 'queued'));
  const reclaimable = sortSessionsForPairing(
    sessions.filter((session) => session.status === 'running' && isLeaseExpired(session, now)),
  );
  const candidate = queued[0] ?? reclaimable[0] ?? null;
  if (!candidate) return null;
  return claimSubagentSession(repo, scope, candidate.id, {
    ownerId: input.ownerId,
    now,
    leaseMs: input.leaseMs,
  });
}

export function syncSubagentSessionHeartbeat(
  repo: MasterRepository,
  scope: WorkspaceScope,
  sessionId: string,
  input: { ownerId: string; now?: string; leaseMs?: number },
): MasterSubagentSession | null {
  const session = repo.getSubagentSession(scope, sessionId);
  if (!session || session.ownerId !== input.ownerId) return null;
  const now = input.now ?? nowIso();
  return repo.updateSubagentSession(scope, sessionId, {
    heartbeatAt: now,
    leaseExpiresAt: expiresAt(now, input.leaseMs ?? DEFAULT_LEASE_MS),
  });
}

export function completeSubagentSession(
  repo: MasterRepository,
  scope: WorkspaceScope,
  sessionId: string,
  resultSummary: string,
  latestEventAt = nowIso(),
): MasterSubagentSession | null {
  const updated = repo.updateSubagentSession(scope, sessionId, {
    status: 'completed',
    ownerId: null,
    leaseExpiresAt: null,
    heartbeatAt: null,
    latestEventAt,
    resultSummary,
    lastError: null,
  });
  if (updated) {
    publishMasterUpdated({
      scope,
      resources: ['subagents', 'metrics'],
      runId: updated.runId,
      sessionId: updated.id,
    });
  }
  return updated;
}

export function failSubagentSession(
  repo: MasterRepository,
  scope: WorkspaceScope,
  sessionId: string,
  message: string,
  latestEventAt = nowIso(),
): MasterSubagentSession | null {
  const updated = repo.updateSubagentSession(scope, sessionId, {
    status: 'failed',
    ownerId: null,
    leaseExpiresAt: null,
    heartbeatAt: null,
    latestEventAt,
    lastError: message,
  });
  if (updated) {
    publishMasterUpdated({
      scope,
      resources: ['subagents', 'metrics'],
      runId: updated.runId,
      sessionId: updated.id,
    });
  }
  return updated;
}

export function cancelSubagentSession(
  repo: MasterRepository,
  scope: WorkspaceScope,
  sessionId: string,
  reason = 'cancelled',
): MasterSubagentSession | null {
  const session = repo.getSubagentSession(scope, sessionId);
  if (!session) return null;
  const job = pairJobForSession(repo, scope, session);
  const cancelled = repo.updateSubagentSession(scope, sessionId, {
    status: 'cancelled',
    ownerId: null,
    leaseExpiresAt: null,
    heartbeatAt: null,
    lastError: reason,
  });
  if (job && job.status !== 'completed' && job.status !== 'failed' && job.status !== 'cancelled') {
    repo.updateDelegationJob(scope, job.id, {
      status: 'cancelled',
      lastError: reason,
    });
    publishDelegationEvent(repo, scope, {
      runId: session.runId,
      jobId: job.id,
      type: 'cancelled',
      payload: JSON.stringify({ reason }),
    });
  }
  if (cancelled) {
    publishMasterUpdated({
      scope,
      resources: ['subagents', 'metrics'],
      runId: cancelled.runId,
      sessionId: cancelled.id,
    });
  }
  return cancelled;
}

export function publishDelegationEvent(
  repo: MasterRepository,
  scope: WorkspaceScope,
  event: Omit<MasterDelegationEvent, 'id' | 'userId' | 'workspaceId' | 'createdAt'>,
): MasterDelegationEvent {
  const created = repo.appendDelegationEvent(scope, event);
  const session = findSessionForJob(repo, scope, event.runId, event.jobId);
  if (session) {
    repo.updateSubagentSession(scope, session.id, { latestEventAt: created.createdAt });
  }
  return created;
}

function findSessionForJob(
  repo: MasterRepository,
  scope: WorkspaceScope,
  runId: string,
  jobId: string,
): MasterSubagentSession | null {
  const orderedSessions = sortSessionsForPairing(repo.listSubagentSessions(scope, runId, 500));
  const orderedJobs = [...repo.listDelegationJobs(scope, runId)].sort((left, right) => {
    const createdDelta = new Date(left.createdAt).getTime() - new Date(right.createdAt).getTime();
    if (createdDelta !== 0) return createdDelta;
    return left.id.localeCompare(right.id);
  });
  const jobIndex = orderedJobs.findIndex((entry) => entry.id === jobId);
  return jobIndex >= 0 ? (orderedSessions[jobIndex] ?? null) : null;
}

export function getSubagentSessionDetail(
  repo: MasterRepository,
  scope: WorkspaceScope,
  sessionId: string,
): SubagentSessionDetail | null {
  const session = repo.getSubagentSession(scope, sessionId);
  if (!session) return null;
  const job = pairJobForSession(repo, scope, session);
  const events = job
    ? repo.listDelegationEvents(scope, session.runId).filter((event) => event.jobId === job.id)
    : [];
  return { session, job, events };
}
