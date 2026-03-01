import { queryAll } from '@/lib/db';
import {
  cleanupOrphanTaskWorkspaces,
  type TaskWorkspaceCleanupReasonCounts,
  type TaskWorkspaceCleanupReport,
} from '@/server/tasks/taskWorkspace';

const DEFAULT_CLEANUP_INTERVAL_MS = 1_800_000;

declare global {
  var __taskWorkspaceCleanupRuntime: TaskWorkspaceCleanupRuntime | undefined;
}

function buildEmptyReasonCounts(): TaskWorkspaceCleanupReasonCounts {
  return {
    activeTask: 0,
    missingMetadata: 0,
    invalidMetadata: 0,
    protected: 0,
    limitReached: 0,
    removeFailed: 0,
  };
}

function buildEmptyReport(): TaskWorkspaceCleanupReport {
  return {
    scanned: 0,
    removed: 0,
    kept: 0,
    skipped: 0,
    reasonCounts: buildEmptyReasonCounts(),
  };
}

function parseBooleanEnv(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined) return fallback;
  const normalized = value.trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(normalized)) return true;
  if (['0', 'false', 'no', 'off'].includes(normalized)) return false;
  return fallback;
}

function isCleanupEnabled(): boolean {
  return parseBooleanEnv(process.env.TASK_WORKSPACES_CLEANUP_ENABLED, true);
}

function shouldRunStartupCleanup(): boolean {
  return parseBooleanEnv(process.env.TASK_WORKSPACES_CLEANUP_STARTUP, true);
}

function resolveCleanupIntervalMs(): number {
  const configured = Number(process.env.TASK_WORKSPACES_CLEANUP_INTERVAL_MS);
  if (Number.isFinite(configured) && configured > 0) {
    return Math.floor(configured);
  }
  return DEFAULT_CLEANUP_INTERVAL_MS;
}

function logCleanupReport(source: string, report: TaskWorkspaceCleanupReport): void {
  console.log(
    `[task-workspaces] cleanup source=${source} scanned=${report.scanned} removed=${report.removed} kept=${report.kept} skipped=${report.skipped} reasons=${JSON.stringify(report.reasonCounts)}`,
  );
}

export function runTaskWorkspaceCleanupOnce(source: string): TaskWorkspaceCleanupReport {
  try {
    const rows = queryAll<{ id: string }>('SELECT id FROM tasks');
    const activeTaskIds = rows.map((row) => row.id);
    const report = cleanupOrphanTaskWorkspaces(activeTaskIds);
    logCleanupReport(source, report);
    return report;
  } catch (error) {
    console.error(`[task-workspaces] cleanup failed source=${source}:`, error);
    return buildEmptyReport();
  }
}

class TaskWorkspaceCleanupRuntime {
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(private readonly intervalMs: number) {}

  start(): void {
    if (this.timer) return;

    if (shouldRunStartupCleanup()) {
      runTaskWorkspaceCleanupOnce('startup');
    }

    this.timer = setInterval(() => {
      runTaskWorkspaceCleanupOnce('interval');
    }, this.intervalMs);
    this.timer.unref();

    console.log(`[task-workspaces] cleanup runtime started interval=${this.intervalMs}ms`);
  }

  stop(): void {
    if (!this.timer) return;
    clearInterval(this.timer);
    this.timer = null;
    console.log('[task-workspaces] cleanup runtime stopped');
  }
}

export function startTaskWorkspaceCleanupRuntime(): { stop(): void } {
  if (!isCleanupEnabled()) {
    return {
      stop() {},
    };
  }

  if (!globalThis.__taskWorkspaceCleanupRuntime) {
    const intervalMs = resolveCleanupIntervalMs();
    const runtime = new TaskWorkspaceCleanupRuntime(intervalMs);
    globalThis.__taskWorkspaceCleanupRuntime = runtime;
    runtime.start();
  }

  return {
    stop() {
      globalThis.__taskWorkspaceCleanupRuntime?.stop();
      globalThis.__taskWorkspaceCleanupRuntime = undefined;
    },
  };
}
