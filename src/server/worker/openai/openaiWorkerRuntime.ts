import type { WorkerTaskRecord } from '../workerTypes';
import { getWorkerRepository } from '../workerRepository';
import { broadcastStatus } from '../utils/broadcast';
import { loadGatewayConfig } from '../../config/gatewayConfig';
import { getPersonaRepository } from '../../personas/personaRepository';
import { listEnabledOpenAiWorkerToolNames } from './openaiToolRegistry';
import {
  getOpenAiWorkerClient,
  type OpenAiWorkerStartRunResult,
  type OpenAiWorkerClient,
} from './openaiWorkerClient';

const userDailyCostState = new Map<string, number>();
const userRateWindowState = new Map<string, { startedAtMs: number; count: number }>();

function readNumberEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : fallback;
}

export interface OpenAiRuntimeLimits {
  maxTokensPerRun: number;
  maxCostUsdPerRun: number;
  maxCostUsdPerUserPerDay: number;
  maxRequestsPerMinutePerUser: number;
}

export function getOpenAiRuntimeLimits(): OpenAiRuntimeLimits {
  return {
    maxTokensPerRun: readNumberEnv('OPENAI_WORKER_MAX_TOKENS_PER_RUN', 120000),
    maxCostUsdPerRun: readNumberEnv('OPENAI_WORKER_MAX_COST_USD_PER_RUN', 10),
    maxCostUsdPerUserPerDay: readNumberEnv('OPENAI_WORKER_MAX_COST_USD_PER_USER_PER_DAY', 25),
    maxRequestsPerMinutePerUser: readNumberEnv('OPENAI_WORKER_MAX_REQ_PER_MIN_PER_USER', 60),
  };
}

export interface BudgetCheckInput {
  userId?: string | null;
  projectedTokens: number;
  projectedCostUsd: number;
}

export interface BudgetCheckResult {
  ok: boolean;
  reason?: 'run_token_limit' | 'run_cost_limit' | 'daily_cost_limit';
}

export function checkBudget(input: BudgetCheckInput): BudgetCheckResult {
  const limits = getOpenAiRuntimeLimits();

  if (input.projectedTokens > limits.maxTokensPerRun) {
    return { ok: false, reason: 'run_token_limit' };
  }
  if (input.projectedCostUsd > limits.maxCostUsdPerRun) {
    return { ok: false, reason: 'run_cost_limit' };
  }

  const userId = input.userId || 'anonymous';
  const spentToday = userDailyCostState.get(userId) || 0;
  if (spentToday + input.projectedCostUsd > limits.maxCostUsdPerUserPerDay) {
    return { ok: false, reason: 'daily_cost_limit' };
  }
  return { ok: true };
}

export function recordRunCost(userId: string | null | undefined, costUsd: number): void {
  const key = userId || 'anonymous';
  const current = userDailyCostState.get(key) || 0;
  userDailyCostState.set(key, current + Math.max(0, costUsd));
}

export interface RateLimitCheckResult {
  ok: boolean;
  retryAfterSec?: number;
}

export function checkRateLimit(userId: string | null | undefined, nowMs = Date.now()): RateLimitCheckResult {
  const limits = getOpenAiRuntimeLimits();
  const key = userId || 'anonymous';
  const minuteMs = 60_000;
  const existing = userRateWindowState.get(key);

  if (!existing || nowMs - existing.startedAtMs >= minuteMs) {
    userRateWindowState.set(key, { startedAtMs: nowMs, count: 1 });
    return { ok: true };
  }

  if (existing.count >= limits.maxRequestsPerMinutePerUser) {
    const retryAfter = Math.max(1, Math.ceil((minuteMs - (nowMs - existing.startedAtMs)) / 1000));
    return { ok: false, retryAfterSec: retryAfter };
  }

  existing.count += 1;
  return { ok: true };
}

function getNestedObject(root: unknown, key: string): Record<string, unknown> {
  if (!root || typeof root !== 'object' || Array.isArray(root)) return {};
  const value = (root as Record<string, unknown>)[key];
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return value as Record<string, unknown>;
}

function normalizeModelHubProfileId(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

async function resolveDefaultModelHubProfileId(): Promise<string> {
  const fromEnv = normalizeModelHubProfileId(process.env.OPENAI_WORKER_MODEL_HUB_PROFILE);
  if (fromEnv) return fromEnv;

  const state = await loadGatewayConfig();
  const worker = getNestedObject(state.config, 'worker');
  const openai = getNestedObject(worker, 'openai');
  const fromConfig = normalizeModelHubProfileId(openai.modelHubProfile);
  return fromConfig || 'p1';
}

export interface OpenAiTaskModelRouting {
  personaId: string | null;
  preferredModelId: string | null;
  modelHubProfileId: string;
}

export async function resolveTaskModelRouting(task: WorkerTaskRecord): Promise<OpenAiTaskModelRouting> {
  let personaId: string | null = null;
  let preferredModelId: string | null = null;
  let modelHubProfileId: string | null = null;

  if (task.assignedPersonaId) {
    try {
      const persona = getPersonaRepository().getPersona(task.assignedPersonaId);
      if (persona && (!task.userId || persona.userId === task.userId)) {
        personaId = persona.id;
        preferredModelId = persona.preferredModelId || null;
        modelHubProfileId = normalizeModelHubProfileId(
          (persona as { modelHubProfileId?: string | null }).modelHubProfileId ?? null,
        );
      }
    } catch {
      // Missing persona storage should not block execution.
    }
  }

  return {
    personaId,
    preferredModelId,
    modelHubProfileId: modelHubProfileId || (await resolveDefaultModelHubProfileId()),
  };
}

export async function isOpenAiRuntimeEnabled(): Promise<boolean> {
  if (process.env.WORKER_RUNTIME) {
    return process.env.WORKER_RUNTIME === 'openai';
  }
  const state = await loadGatewayConfig();
  const worker = getNestedObject(state.config, 'worker');
  return worker.runtime === 'openai';
}

function buildCompletedSummary(task: WorkerTaskRecord, output?: string): string {
  const body = output && output.trim().length > 0 ? output.trim() : 'OpenAI Worker run completed.';
  return `✅ Task "${task.title}" abgeschlossen.\n\n${body}`;
}

function saveApprovalCheckpoint(taskId: string, approvalToken: string): void {
  const repo = getWorkerRepository();
  repo.saveCheckpoint(taskId, {
    phase: 'waiting_approval',
    openaiApprovalToken: approvalToken,
    approvalResponse: null,
  });
}

function updateForStart(task: WorkerTaskRecord): void {
  const repo = getWorkerRepository();
  repo.updateStatus(task.id, 'planning');
  repo.addActivity({
    taskId: task.id,
    type: 'status_change',
    message: 'OpenAI runtime gestartet (Planung)',
    metadata: { from: task.status, to: 'planning', runtime: 'openai' },
  });
  broadcastStatus(task.id, 'planning', 'OpenAI Planung gestartet');
}

async function finalizeResult(
  task: WorkerTaskRecord,
  result: OpenAiWorkerStartRunResult,
): Promise<void> {
  const repo = getWorkerRepository();
  const { notifyTaskCompleted, notifyTaskFailed, notifyApprovalRequest } = await import(
    '../workerCallback'
  );

  if (result.status === 'approval_required') {
    repo.updateStatus(task.id, 'waiting_approval');
    if (result.approvalToken) saveApprovalCheckpoint(task.id, result.approvalToken);
    broadcastStatus(task.id, 'waiting_approval', 'Genehmigung erforderlich');
    await notifyApprovalRequest(task, 'openai_sidecar_action');
    return;
  }

  if (result.status === 'failed') {
    const errorMessage = result.output || 'OpenAI runtime failed.';
    repo.updateStatus(task.id, 'failed', { error: errorMessage });
    broadcastStatus(task.id, 'failed', errorMessage);
    await notifyTaskFailed(task, errorMessage);
    return;
  }

  const summary = buildCompletedSummary(task, result.output);
  repo.updateStatus(task.id, 'completed', { summary });
  broadcastStatus(task.id, 'completed', 'Task abgeschlossen');
  await notifyTaskCompleted(task, summary);
}

export async function executeOpenAiRuntimeTask(
  task: WorkerTaskRecord,
  client: OpenAiWorkerClient = getOpenAiWorkerClient(),
): Promise<void> {
  updateForStart(task);

  const rate = checkRateLimit(task.userId || null);
  if (!rate.ok) {
    const repo = getWorkerRepository();
    const message = `OpenAI rate limit reached. Retry after ${rate.retryAfterSec ?? 60}s.`;
    repo.updateStatus(task.id, 'interrupted', { error: message });
    broadcastStatus(task.id, 'interrupted', message);
    return;
  }

  const budget = checkBudget({
    userId: task.userId || null,
    projectedTokens: 1024,
    projectedCostUsd: 0.1,
  });
  if (!budget.ok) {
    const repo = getWorkerRepository();
    const message = `OpenAI budget denied: ${budget.reason}`;
    repo.updateStatus(task.id, 'failed', { error: message });
    broadcastStatus(task.id, 'failed', message);
    return;
  }

  try {
    const routing = await resolveTaskModelRouting(task);
    const enabledTools = await listEnabledOpenAiWorkerToolNames();
    const run = await client.startRun({
      taskId: task.id,
      title: task.title,
      objective: task.objective,
      userId: task.userId || null,
      workspacePath: task.workspacePath || null,
      personaId: routing.personaId,
      preferredModelId: routing.preferredModelId,
      modelHubProfileId: routing.modelHubProfileId,
      enabledTools,
    });
    await finalizeResult(task, run);
    if (run.status === 'completed') {
      recordRunCost(task.userId || null, 0.1);
    }
  } catch (error) {
    const repo = getWorkerRepository();
    const { notifyRuntimeFailover } = await import('../workerCallback');
    const message = error instanceof Error ? error.message : String(error);
    repo.updateStatus(task.id, 'interrupted', { error: message });
    broadcastStatus(task.id, 'interrupted', message);
    await notifyRuntimeFailover(task, message);
  }
}

export async function submitOpenAiApproval(
  taskId: string,
  approved: boolean,
  approveAlways?: boolean,
  client: OpenAiWorkerClient = getOpenAiWorkerClient(),
): Promise<{ ok: boolean; reason?: string }> {
  const repo = getWorkerRepository();
  const task = repo.getTask(taskId);
  if (!task) return { ok: false, reason: 'task_not_found' };

  const checkpoint = task.lastCheckpoint ? JSON.parse(task.lastCheckpoint) : {};
  const token =
    typeof checkpoint.openaiApprovalToken === 'string' ? checkpoint.openaiApprovalToken : null;
  if (!token) return { ok: false, reason: 'missing_token' };

  await client.submitApproval({
    approvalToken: token,
    approved,
    approveAlways,
  });

  if (approved) {
    repo.updateStatus(taskId, 'executing');
    broadcastStatus(taskId, 'executing', 'Genehmigung erteilt');
  } else {
    repo.updateStatus(taskId, 'failed', { error: 'Genehmigung abgelehnt' });
    broadcastStatus(taskId, 'failed', 'Genehmigung abgelehnt');
  }
  return { ok: true };
}

export function resetOpenAiRuntimeStateForTests(): void {
  userDailyCostState.clear();
  userRateWindowState.clear();
}
