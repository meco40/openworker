/**
 * Master module – API client.
 *
 * Centralises all fetch calls to /api/master/* so components
 * never build URLs or parse responses directly.
 */

import type {
  MasterRun,
  MasterStep,
  MasterMetrics,
  ApprovalDecision,
  MasterApprovalRequest,
  MasterPersonaSummary,
  MasterSettingsSnapshot,
  MasterSubagentSession,
  MasterReminder,
  MasterEventMessage,
  SaveMasterSettingsInput,
  WorkspaceSummary,
} from './types';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function buildScopeParams(workspaceId: string, personaId?: string | null): URLSearchParams {
  const params = new URLSearchParams();
  if (workspaceId) params.set('workspaceId', workspaceId);
  if (personaId) params.set('personaId', personaId);
  return params;
}

async function parseOkJson<T>(response: Response): Promise<T> {
  const payload = (await response.json()) as { ok?: boolean; error?: string } & T;
  if (!response.ok || payload.ok === false) {
    throw new Error(payload.error ?? `HTTP ${response.status}`);
  }
  return payload;
}

// ─── Workspaces ───────────────────────────────────────────────────────────────

const FALLBACK_WORKSPACE: WorkspaceSummary = { id: 'main', name: 'Main', slug: 'main' };

export class MasterSystemPersonaDisabledError extends Error {
  constructor(message = 'Master system persona is disabled.') {
    super(message);
    this.name = 'MasterSystemPersonaDisabledError';
  }
}

export function isMasterSystemPersonaDisabledError(error: unknown): boolean {
  if (error instanceof MasterSystemPersonaDisabledError) {
    return true;
  }
  return error instanceof Error && /master system persona .*disabled/i.test(error.message);
}

export async function fetchWorkspaces(): Promise<WorkspaceSummary[]> {
  try {
    const response = await fetch('/api/workspaces', { cache: 'no-store' });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const data = (await response.json()) as Array<{ id: string; name: string; slug: string }>;
    if (!Array.isArray(data) || data.length === 0) return [FALLBACK_WORKSPACE];
    return data.map((w) => ({ id: w.id, name: w.name, slug: w.slug }));
  } catch {
    return [FALLBACK_WORKSPACE];
  }
}

// ─── Master settings ──────────────────────────────────────────────────────────

export async function fetchMasterSettings(): Promise<MasterSettingsSnapshot> {
  const response = await fetch('/api/master/settings', { cache: 'no-store' });
  if (response.status === 404) {
    const payload = (await response.json().catch(() => null)) as { error?: string } | null;
    throw new MasterSystemPersonaDisabledError(payload?.error ?? undefined);
  }
  return parseOkJson<MasterSettingsSnapshot>(response);
}

export async function saveMasterSettings(
  input: SaveMasterSettingsInput,
): Promise<MasterSettingsSnapshot> {
  return parseOkJson<MasterSettingsSnapshot>(
    await fetch('/api/master/settings', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(input),
    }),
  );
}

export async function fetchMasterPersonas(): Promise<MasterPersonaSummary[]> {
  const payload = await parseOkJson<{
    personas?: Array<MasterPersonaSummary & { systemPersonaKey?: string | null }>;
  }>(await fetch('/api/personas', { cache: 'no-store' }));
  return (payload.personas ?? []).filter((persona) => persona.systemPersonaKey !== 'master');
}

// ─── Runs ─────────────────────────────────────────────────────────────────────

export async function fetchRuns(
  workspaceId: string,
  personaId?: string | null,
  signal?: AbortSignal,
): Promise<MasterRun[]> {
  const params = buildScopeParams(workspaceId, personaId);
  const payload = await parseOkJson<{ runs?: MasterRun[] }>(
    await fetch(`/api/master/runs?${params.toString()}`, { cache: 'no-store', signal }),
  );
  return payload.runs ?? [];
}

export interface CreateRunInput {
  title: string;
  contract: string;
  workspaceId: string;
  personaId?: string | null;
}

export async function createRun(input: CreateRunInput): Promise<MasterRun> {
  const payload = await parseOkJson<{ run?: MasterRun }>(
    await fetch('/api/master/runs', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(input),
    }),
  );
  if (!payload.run) throw new Error('No run returned from server.');
  return payload.run;
}

// ─── Run actions ──────────────────────────────────────────────────────────────

export interface RunActionInput {
  actionType: string;
  stepId?: string;
  decision?: ApprovalDecision;
  approvalRequestId?: string;
  workspaceId: string;
  personaId?: string | null;
}

export interface RunActionResult {
  exportBundle?: unknown;
}

export async function postRunAction(
  runId: string,
  input: RunActionInput,
): Promise<RunActionResult> {
  const payload = await parseOkJson<RunActionResult>(
    await fetch(`/api/master/runs/${runId}/actions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        personaId: input.personaId,
        workspaceId: input.workspaceId,
        stepId: input.stepId ?? `step-${Date.now()}`,
        actionType: input.actionType,
        decision: input.decision,
        approvalRequestId: input.approvalRequestId,
      }),
    }),
  );
  return payload;
}

// ─── Approvals ────────────────────────────────────────────────────────────────

export async function fetchApprovalRequests(
  workspaceId: string,
  personaId?: string | null,
  runId?: string | null,
): Promise<MasterApprovalRequest[]> {
  const params = buildScopeParams(workspaceId, personaId);
  if (runId) params.set('runId', runId);
  const response = await fetch(`/api/master/approvals?${params.toString()}`, { cache: 'no-store' });
  if (response.status === 404) {
    return [];
  }
  const payload = await parseOkJson<{ approvals?: MasterApprovalRequest[] }>(response);
  return payload.approvals ?? [];
}

export async function decideApprovalRequest(input: {
  approvalRequestId: string;
  decision: ApprovalDecision;
  workspaceId: string;
  personaId?: string | null;
}): Promise<MasterApprovalRequest> {
  const payload = await parseOkJson<{ approval?: MasterApprovalRequest }>(
    await fetch(`/api/master/approvals/${input.approvalRequestId}/decision`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        personaId: input.personaId,
        workspaceId: input.workspaceId,
        decision: input.decision,
      }),
    }),
  );
  if (!payload.approval) {
    throw new Error('No approval returned from server.');
  }
  return payload.approval;
}

// ─── Metrics ──────────────────────────────────────────────────────────────────

export async function fetchMetrics(
  workspaceId: string,
  personaId?: string | null,
  signal?: AbortSignal,
): Promise<MasterMetrics | null> {
  const params = buildScopeParams(workspaceId, personaId);
  const payload = await parseOkJson<{ metrics?: MasterMetrics }>(
    await fetch(`/api/master/metrics?${params.toString()}`, { cache: 'no-store', signal }),
  );
  return payload.metrics ?? null;
}

// ─── Run detail ───────────────────────────────────────────────────────────────

export interface RunDetail {
  run: MasterRun;
  steps: MasterStep[];
}

export async function fetchRunDetail(
  runId: string,
  workspaceId: string,
  personaId?: string | null,
  signal?: AbortSignal,
): Promise<RunDetail | null> {
  const params = buildScopeParams(workspaceId, personaId);
  const payload = await parseOkJson<{ run?: MasterRun; steps?: MasterStep[] }>(
    await fetch(`/api/master/runs/${runId}?${params.toString()}`, { cache: 'no-store', signal }),
  );
  if (!payload.run) return null;
  return { run: payload.run, steps: payload.steps ?? [] };
}

// ─── Subagent sessions ───────────────────────────────────────────────────────

export async function fetchSubagentSessions(
  workspaceId: string,
  personaId?: string | null,
  runId?: string | null,
): Promise<MasterSubagentSession[]> {
  const params = buildScopeParams(workspaceId, personaId);
  if (runId) params.set('runId', runId);
  const response = await fetch(`/api/master/subagents?${params.toString()}`, { cache: 'no-store' });
  if (response.status === 404) {
    return [];
  }
  const payload = await parseOkJson<{ sessions?: MasterSubagentSession[] }>(response);
  return payload.sessions ?? [];
}

export async function fetchSubagentSession(
  sessionId: string,
  workspaceId: string,
  personaId?: string | null,
): Promise<MasterSubagentSession | null> {
  const params = buildScopeParams(workspaceId, personaId);
  const payload = await parseOkJson<{ session?: MasterSubagentSession }>(
    await fetch(`/api/master/subagents/${sessionId}?${params.toString()}`, { cache: 'no-store' }),
  );
  return payload.session ?? null;
}

// ─── Reminders ────────────────────────────────────────────────────────────────

export async function fetchReminders(
  workspaceId: string,
  personaId?: string | null,
): Promise<MasterReminder[]> {
  const params = buildScopeParams(workspaceId, personaId);
  const payload = await parseOkJson<{ reminders?: MasterReminder[] }>(
    await fetch(`/api/master/reminders?${params.toString()}`, { cache: 'no-store' }),
  );
  return payload.reminders ?? [];
}

export async function fetchReminder(
  reminderId: string,
  workspaceId: string,
  personaId?: string | null,
): Promise<MasterReminder | null> {
  const params = buildScopeParams(workspaceId, personaId);
  const payload = await parseOkJson<{ reminder?: MasterReminder }>(
    await fetch(`/api/master/reminders/${reminderId}?${params.toString()}`, { cache: 'no-store' }),
  );
  return payload.reminder ?? null;
}

// ─── Events ───────────────────────────────────────────────────────────────────

export function createMasterEventsUrl(workspaceId: string, personaId?: string | null): string {
  const params = buildScopeParams(workspaceId, personaId);
  return `/api/master/events?${params.toString()}`;
}

export function parseMasterEventMessage(data: string): MasterEventMessage | null {
  try {
    return JSON.parse(data) as MasterEventMessage;
  } catch {
    return null;
  }
}

// ─── Cancel run ───────────────────────────────────────────────────────────────

export async function cancelRun(
  runId: string,
  workspaceId: string,
  personaId?: string | null,
): Promise<void> {
  await postRunAction(runId, {
    actionType: 'run.cancel',
    stepId: `run-cancel-${Date.now()}`,
    workspaceId,
    personaId,
  });
}

// ─── Feedback ─────────────────────────────────────────────────────────────────

export interface SubmitFeedbackInput {
  runId: string;
  rating: number;
  policy: 'safe' | 'balanced' | 'fast';
  comment?: string;
}

export async function submitFeedback(
  input: SubmitFeedbackInput,
  workspaceId: string,
  personaId?: string | null,
): Promise<void> {
  const params = buildScopeParams(workspaceId, personaId);
  await parseOkJson<Record<string, unknown>>(
    await fetch(`/api/master/runs/${input.runId}/feedback?${params.toString()}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        rating: input.rating,
        policy: input.policy,
        comment: input.comment,
      }),
    }),
  );
}
