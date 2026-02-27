import { SqliteMasterRepository } from '@/server/master/sqliteMasterRepository';
import { MasterOrchestrator } from '@/server/master/orchestrator';
import { runDailyLearningLoop } from '@/server/master/learning';
import { MasterExecutionRuntime } from '@/server/master/executionRuntime';
import type { MasterRepository } from '@/server/master/repository';

declare global {
  // eslint-disable-next-line no-var
  var __masterRepository: SqliteMasterRepository | undefined;
  // eslint-disable-next-line no-var
  var __masterOrchestrator: MasterOrchestrator | undefined;
  // eslint-disable-next-line no-var
  var __masterExecutionRuntime: MasterExecutionRuntime | undefined;
  // eslint-disable-next-line no-var
  var __masterMaintenanceInterval: NodeJS.Timeout | undefined;
  // eslint-disable-next-line no-var
  var __masterMaintenanceLastRunByScope: Map<string, string> | undefined;
}

export function getMasterRepository(): SqliteMasterRepository {
  if (!globalThis.__masterRepository) {
    globalThis.__masterRepository = new SqliteMasterRepository();
    ensureMasterMaintenanceScheduler();
  }
  return globalThis.__masterRepository;
}

export function resetMasterRepositoryForTests(): void {
  stopMasterMaintenanceScheduler();
  globalThis.__masterExecutionRuntime = undefined;
  globalThis.__masterOrchestrator = undefined;
  if (globalThis.__masterRepository) {
    globalThis.__masterRepository.close();
    globalThis.__masterRepository = undefined;
  }
}

export function getMasterOrchestrator(): MasterOrchestrator {
  if (!globalThis.__masterOrchestrator) {
    globalThis.__masterOrchestrator = new MasterOrchestrator(getMasterRepository());
  }
  return globalThis.__masterOrchestrator;
}

export function getMasterExecutionRuntime(): MasterExecutionRuntime {
  if (!globalThis.__masterExecutionRuntime) {
    globalThis.__masterExecutionRuntime = new MasterExecutionRuntime(
      getMasterRepository(),
      getMasterOrchestrator(),
    );
  }
  return globalThis.__masterExecutionRuntime;
}

function currentDayKey(date: Date): string {
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}-${String(date.getUTCDate()).padStart(2, '0')}`;
}

function ensureMaintenanceState(): Map<string, string> {
  if (!globalThis.__masterMaintenanceLastRunByScope) {
    globalThis.__masterMaintenanceLastRunByScope = new Map<string, string>();
  }
  return globalThis.__masterMaintenanceLastRunByScope;
}

function buildScopeKey(scope: { userId: string; workspaceId: string }): string {
  return `${scope.userId}::${scope.workspaceId}`;
}

export function runMasterMaintenanceTick(
  repo: MasterRepository,
  now = new Date(),
): { executedScopes: number; skippedScopes: number; dateKey: string } {
  const dateKey = currentDayKey(now);
  const tracker = ensureMaintenanceState();
  const scopes = repo.listKnownScopes();

  let executedScopes = 0;
  let skippedScopes = 0;
  for (const scope of scopes) {
    const scopeKey = buildScopeKey(scope);
    if (tracker.get(scopeKey) === dateKey) {
      skippedScopes += 1;
      continue;
    }
    const hasActiveRuns = repo
      .listRuns(scope, 200)
      .some((run) =>
        ['ANALYZING', 'PLANNING', 'DELEGATING', 'EXECUTING', 'VERIFYING', 'REFINING'].includes(
          run.status,
        ),
      );
    if (hasActiveRuns) {
      skippedScopes += 1;
      continue;
    }
    const cycle = runDailyLearningLoop(repo, scope, now);
    if (cycle.executed) {
      tracker.set(scopeKey, dateKey);
      executedScopes += 1;
    } else {
      skippedScopes += 1;
    }
  }

  return { executedScopes, skippedScopes, dateKey };
}

function ensureMasterMaintenanceScheduler(): void {
  if (globalThis.__masterMaintenanceInterval) {
    return;
  }
  const timer = setInterval(() => {
    try {
      runMasterMaintenanceTick(getMasterRepository(), new Date());
    } catch {
      // swallow scheduler errors; operational monitoring is handled by metrics endpoint
    }
  }, 60_000);
  timer.unref?.();
  globalThis.__masterMaintenanceInterval = timer;
}

function stopMasterMaintenanceScheduler(): void {
  if (globalThis.__masterMaintenanceInterval) {
    clearInterval(globalThis.__masterMaintenanceInterval);
    globalThis.__masterMaintenanceInterval = undefined;
  }
  if (globalThis.__masterMaintenanceLastRunByScope) {
    globalThis.__masterMaintenanceLastRunByScope.clear();
  }
}
