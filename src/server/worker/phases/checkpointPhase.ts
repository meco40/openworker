// ─── Checkpoint Phase ────────────────────────────────────────
// Handles task checkpoint recovery and state restoration.

import type { WorkerTaskRecord } from '../workerTypes';

export interface CheckpointState {
  startStepIndex: number;
}

/**
 * Parses the checkpoint from a task and determines the starting step index.
 * If the checkpoint indicates an 'executing' phase with a valid step index,
 * resumes from that point. Otherwise, starts from the beginning.
 */
export function recoverFromCheckpoint(task: WorkerTaskRecord): CheckpointState {
  let startStepIndex = 0;

  if (task.lastCheckpoint) {
    try {
      const checkpoint = JSON.parse(task.lastCheckpoint);
      if (checkpoint.phase === 'executing' && typeof checkpoint.stepIndex === 'number') {
        startStepIndex = checkpoint.stepIndex;
      }
    } catch {
      // Ignore invalid checkpoint JSON, start from beginning
    }
  }

  return { startStepIndex };
}
