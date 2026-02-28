/**
 * Master module – API client.
 *
 * Centralises all fetch calls to /api/master/* so components
 * never build URLs or parse responses directly.
 */

import type { MasterRun, MasterMetrics, MasterPersonaSummary, ApprovalDecision } from './types';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function buildScopeParams(personaId: string, workspaceId: string): URLSearchParams {
  const params = new URLSearchParams();
  if (personaId) params.set('personaId', personaId);
  if (workspaceId) params.set('workspaceId', workspaceId);
  return params;
}

async function parseOkJson<T>(response: Response): Promise<T> {
  const payload = (await response.json()) as { ok?: boolean; error?: string } & T;
  if (!response.ok || payload.ok === false) {
    throw new Error(payload.error ?? `HTTP ${response.status}`);
  }
  return payload;
}

// ─── Personas ─────────────────────────────────────────────────────────────────

export async function fetchPersonas(): Promise<MasterPersonaSummary[]> {
  const payload = await parseOkJson<{ personas?: MasterPersonaSummary[] }>(
    await fetch('/api/personas', { cache: 'no-store' }),
  );
  return payload.personas ?? [];
}

// ─── Runs ─────────────────────────────────────────────────────────────────────

export async function fetchRuns(personaId: string, workspaceId: string): Promise<MasterRun[]> {
  const params = buildScopeParams(personaId, workspaceId);
  const payload = await parseOkJson<{ runs?: MasterRun[] }>(
    await fetch(`/api/master/runs?${params.toString()}`, { cache: 'no-store' }),
  );
  return payload.runs ?? [];
}

export interface CreateRunInput {
  title: string;
  contract: string;
  personaId: string;
  workspaceId: string;
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
  personaId: string;
  workspaceId: string;
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
      }),
    }),
  );
  return payload;
}

// ─── Metrics ──────────────────────────────────────────────────────────────────

export async function fetchMetrics(
  personaId: string,
  workspaceId: string,
): Promise<MasterMetrics | null> {
  const params = buildScopeParams(personaId, workspaceId);
  const payload = await parseOkJson<{ metrics?: MasterMetrics }>(
    await fetch(`/api/master/metrics?${params.toString()}`, { cache: 'no-store' }),
  );
  return payload.metrics ?? null;
}
