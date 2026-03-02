import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export type SubagentRunStatus = 'running' | 'completed' | 'error' | 'killed';

export interface SubagentRunRecord {
  runId: string;
  requesterConversationId: string;
  requesterUserId: string;
  agentId: string;
  profileId?: string;
  profileName?: string;
  skillIds?: string[];
  toolFunctionNames?: string[];
  task: string;
  guidance?: string;
  modelOverride?: string;
  projectId?: string;
  workspacePath?: string;
  workspaceRelativePath?: string;
  status: SubagentRunStatus;
  createdAt: string;
  startedAt: string;
  endedAt?: string;
  resultPreview?: string;
  error?: string;
  replacedByRunId?: string;
}

interface SubagentRunStore {
  version: 1;
  runs: SubagentRunRecord[];
}

interface SubagentRuntime {
  abortController: AbortController;
}

interface CreateSubagentRunInput {
  requesterConversationId: string;
  requesterUserId: string;
  agentId: string;
  profileId?: string;
  profileName?: string;
  skillIds?: string[];
  toolFunctionNames?: string[];
  task: string;
  guidance?: string;
  modelOverride?: string;
  projectId?: string;
  workspacePath?: string;
  workspaceRelativePath?: string;
}

const STORE_VERSION = 1;
const MAX_PERSISTED_RUNS = 300;

const state: {
  loaded: boolean;
  runsById: Map<string, SubagentRunRecord>;
  runtimesById: Map<string, SubagentRuntime>;
} = {
  loaded: false,
  runsById: new Map<string, SubagentRunRecord>(),
  runtimesById: new Map<string, SubagentRuntime>(),
};

function resolveStorePath(): string {
  const custom = process.env.SUBAGENT_RUNS_STORE_PATH?.trim();
  if (custom) {
    return path.resolve(custom);
  }
  return path.resolve(process.cwd(), '.local', 'subagent-runs.json');
}

function ensureStoreDir(filePath: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
}

function readStore(filePath: string): SubagentRunStore {
  if (!fs.existsSync(filePath)) {
    return { version: STORE_VERSION, runs: [] };
  }

  try {
    const raw = fs.readFileSync(filePath, 'utf-8');
    const parsed = JSON.parse(raw) as Partial<SubagentRunStore>;
    if (!parsed || parsed.version !== STORE_VERSION || !Array.isArray(parsed.runs)) {
      return { version: STORE_VERSION, runs: [] };
    }

    const runs = parsed.runs.filter((entry): entry is SubagentRunRecord =>
      Boolean(
        entry &&
        typeof entry.runId === 'string' &&
        typeof entry.requesterConversationId === 'string' &&
        typeof entry.requesterUserId === 'string' &&
        typeof entry.agentId === 'string' &&
        typeof entry.task === 'string' &&
        typeof entry.status === 'string' &&
        typeof entry.createdAt === 'string' &&
        typeof entry.startedAt === 'string' &&
        (entry.projectId === undefined || typeof entry.projectId === 'string') &&
        (entry.workspacePath === undefined || typeof entry.workspacePath === 'string') &&
        (entry.workspaceRelativePath === undefined ||
          typeof entry.workspaceRelativePath === 'string'),
      ),
    );

    return { version: STORE_VERSION, runs };
  } catch {
    return { version: STORE_VERSION, runs: [] };
  }
}

function writeStore(filePath: string, runs: SubagentRunRecord[]): void {
  ensureStoreDir(filePath);
  const payload: SubagentRunStore = { version: STORE_VERSION, runs };
  fs.writeFileSync(filePath, JSON.stringify(payload, null, 2), 'utf-8');
}

function toTimestamp(value?: string): number {
  if (!value) return 0;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function sortRunsDescending(runs: SubagentRunRecord[]): SubagentRunRecord[] {
  return [...runs].sort(
    (a, b) => toTimestamp(b.startedAt || b.createdAt) - toTimestamp(a.startedAt || a.createdAt),
  );
}

function persist(): void {
  const allRuns = Array.from(state.runsById.values());
  const active = allRuns.filter((run) => run.status === 'running');
  const finished = allRuns.filter((run) => run.status !== 'running');
  const cappedFinished = sortRunsDescending(finished).slice(
    0,
    Math.max(0, MAX_PERSISTED_RUNS - active.length),
  );
  writeStore(resolveStorePath(), sortRunsDescending([...active, ...cappedFinished]));
}

function ensureLoaded(): void {
  if (state.loaded) return;
  const store = readStore(resolveStorePath());
  for (const run of store.runs) {
    if (run.status === 'running') {
      // Recover stale active runs as killed after restart.
      state.runsById.set(run.runId, {
        ...run,
        status: 'killed',
        endedAt: run.endedAt || new Date().toISOString(),
        error: run.error || 'Subagent stopped after runtime restart.',
      });
      continue;
    }
    state.runsById.set(run.runId, run);
  }
  state.loaded = true;
  persist();
}

function updateRun(
  runId: string,
  updater: (run: SubagentRunRecord) => SubagentRunRecord,
): SubagentRunRecord | null {
  ensureLoaded();
  const existing = state.runsById.get(runId);
  if (!existing) return null;
  const next = updater(existing);
  state.runsById.set(runId, next);
  persist();
  return next;
}

export function createSubagentRun(input: CreateSubagentRunInput): SubagentRunRecord {
  ensureLoaded();
  const now = new Date().toISOString();
  const run: SubagentRunRecord = {
    runId: `subagent-${crypto.randomUUID()}`,
    requesterConversationId: input.requesterConversationId,
    requesterUserId: input.requesterUserId,
    agentId: input.agentId,
    profileId: input.profileId,
    profileName: input.profileName,
    skillIds: input.skillIds,
    toolFunctionNames: input.toolFunctionNames,
    task: input.task,
    guidance: input.guidance,
    modelOverride: input.modelOverride,
    projectId: input.projectId,
    workspacePath: input.workspacePath,
    workspaceRelativePath: input.workspaceRelativePath,
    status: 'running',
    createdAt: now,
    startedAt: now,
  };
  state.runsById.set(run.runId, run);
  persist();
  return run;
}

export function attachSubagentRuntime(runId: string, runtime: SubagentRuntime): void {
  ensureLoaded();
  state.runtimesById.set(runId, runtime);
}

export function detachSubagentRuntime(runId: string): void {
  ensureLoaded();
  state.runtimesById.delete(runId);
}

export function completeSubagentRun(
  runId: string,
  resultPreview?: string,
): SubagentRunRecord | null {
  detachSubagentRuntime(runId);
  return updateRun(runId, (run) => ({
    ...run,
    status: 'completed',
    endedAt: run.endedAt || new Date().toISOString(),
    resultPreview: resultPreview?.trim() || run.resultPreview,
    error: undefined,
  }));
}

export function failSubagentRun(runId: string, error: string): SubagentRunRecord | null {
  detachSubagentRuntime(runId);
  return updateRun(runId, (run) => ({
    ...run,
    status: run.status === 'killed' ? 'killed' : 'error',
    endedAt: run.endedAt || new Date().toISOString(),
    error: error.trim() || run.error || 'Subagent execution failed.',
  }));
}

export function markSubagentRunKilled(runId: string, reason?: string): SubagentRunRecord | null {
  detachSubagentRuntime(runId);
  return updateRun(runId, (run) => ({
    ...run,
    status: 'killed',
    endedAt: run.endedAt || new Date().toISOString(),
    error: reason?.trim() || run.error || 'Subagent run was stopped.',
  }));
}

export function replaceSubagentRun(previousRunId: string, nextRunId: string): void {
  updateRun(previousRunId, (run) => ({
    ...run,
    replacedByRunId: nextRunId,
  }));
}

export function abortSubagentRun(runId: string, reason?: string): boolean {
  ensureLoaded();
  const runtime = state.runtimesById.get(runId);
  if (!runtime) {
    markSubagentRunKilled(runId, reason || 'Subagent run was stopped.');
    return false;
  }

  runtime.abortController.abort();
  markSubagentRunKilled(runId, reason || 'Subagent run was stopped.');
  return true;
}

export function countActiveSubagentRuns(requesterConversationId: string): number {
  ensureLoaded();
  let total = 0;
  for (const run of state.runsById.values()) {
    if (run.requesterConversationId === requesterConversationId && run.status === 'running') {
      total += 1;
    }
  }
  return total;
}

export function listSubagentRunsForConversation(
  requesterConversationId: string,
  recentMinutes = 60,
): { active: SubagentRunRecord[]; recent: SubagentRunRecord[] } {
  ensureLoaded();
  const now = Date.now();
  const cutoff = now - Math.max(1, Math.floor(recentMinutes)) * 60_000;
  const all = sortRunsDescending(
    Array.from(state.runsById.values()).filter(
      (run) => run.requesterConversationId === requesterConversationId,
    ),
  );
  const active = all.filter((run) => run.status === 'running');
  const recent = all.filter(
    (run) => run.status !== 'running' && toTimestamp(run.endedAt || run.startedAt) >= cutoff,
  );
  return { active, recent };
}

export function listActiveSubagentRuns(requesterConversationId: string): SubagentRunRecord[] {
  ensureLoaded();
  return sortRunsDescending(
    Array.from(state.runsById.values()).filter(
      (run) => run.requesterConversationId === requesterConversationId && run.status === 'running',
    ),
  );
}

export function resetSubagentRegistryForTests(): void {
  state.loaded = false;
  state.runsById.clear();
  state.runtimesById.clear();
}
