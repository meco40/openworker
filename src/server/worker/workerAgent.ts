// ─── Server-Side Worker Agent ────────────────────────────────
// Sequential queue processor: only 1 task runs at a time.
// All other tasks wait in FIFO queue.

import { getWorkerRepository } from './workerRepository';
import { notifyTaskFailed } from './workerCallback';
import { recoverFromCheckpoint } from './phases/checkpointPhase';
import { setupWorkspace } from './phases/workspacePhase';
import { executeOrchestraPhase } from './phases/orchestraPhase';
import { executeStandardTaskPhase } from './phases/standardTaskPhase';
import type { WorkerTaskRecord } from './workerTypes';

// ─── Queue Processor ─────────────────────────────────────────

let isProcessing = false;

/**
 * Processes the task queue sequentially. Only one task at a time.
 * Safe to call multiple times — will no-op if already processing.
 */
export async function processQueue(): Promise<void> {
  if (isProcessing) return;
  isProcessing = true;

  try {
    const repo = getWorkerRepository();

    while (true) {
      const task = repo.getNextQueuedTask();
      if (!task) break;

      try {
        await runWorkerAgent(task);
      } catch (error) {
        await handleTaskError(task, error);
      }
    }
  } finally {
    isProcessing = false;
  }
}

// ─── Worker Agent Main Loop ──────────────────────────────────

async function runWorkerAgent(task: WorkerTaskRecord): Promise<void> {
  // Phase 0a: Checkpoint Recovery
  const { startStepIndex } = recoverFromCheckpoint(task);

  // Phase 0b: Workspace Setup
  const { workspaceType, workspacePath } = setupWorkspace(task.id, task.workspaceType);
  const taskWithWorkspace: WorkerTaskRecord = { ...task, workspacePath };

  // Phase 1: Try Orchestra Flow execution first (if flowPublishedId is set)
  const orchestraHandled = await executeOrchestraPhase(taskWithWorkspace);
  if (orchestraHandled) return;

  // Phase 2: Standard Task Execution (Planning → Execution → Testing → Completion)
  await executeStandardTaskPhase(taskWithWorkspace, startStepIndex, workspaceType);
}

// ─── Error Handling ──────────────────────────────────────────

async function handleTaskError(task: WorkerTaskRecord, error: unknown): Promise<void> {
  console.error(`[Worker] Task ${task.id} failed:`, error);
  const repo = getWorkerRepository();
  const errorMsg = error instanceof Error ? error.message : String(error);
  repo.updateStatus(task.id, 'failed', { error: errorMsg });
  await notifyTaskFailed(task, errorMsg);
}

// ─── Graceful Shutdown ───────────────────────────────────────

function handleShutdown(): void {
  const repo = getWorkerRepository();
  const activeTask = repo.getActiveTask();
  if (activeTask) {
    console.log(`[Worker] Marking task ${activeTask.id} as interrupted for resume.`);
    repo.markInterrupted(activeTask.id);
  }
}

process.on('SIGTERM', handleShutdown);
process.on('SIGINT', handleShutdown);
