import type { WorkerTask } from '../../../../types';

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' ? (value as Record<string, unknown>) : null;
}

export function mergeWorkerTaskDetailPayload(baseTask: WorkerTask, payload: unknown): WorkerTask {
  const root = asRecord(payload);
  if (!root) return baseTask;

  const taskRecord = asRecord(root.task);
  const taskFromPayload = taskRecord ? (taskRecord as unknown as Partial<WorkerTask>) : undefined;
  const mergedTask = { ...baseTask, ...(taskFromPayload || {}) } as WorkerTask;

  const topLevelSteps = Array.isArray(root.steps) ? (root.steps as WorkerTask['steps']) : undefined;
  const nestedSteps = Array.isArray(taskFromPayload?.steps)
    ? (taskFromPayload.steps as WorkerTask['steps'])
    : undefined;
  if (topLevelSteps || nestedSteps) {
    mergedTask.steps = topLevelSteps || nestedSteps;
  }

  const topLevelArtifacts = Array.isArray(root.artifacts)
    ? (root.artifacts as WorkerTask['artifacts'])
    : undefined;
  const nestedArtifacts = Array.isArray(taskFromPayload?.artifacts)
    ? (taskFromPayload.artifacts as WorkerTask['artifacts'])
    : undefined;
  if (topLevelArtifacts || nestedArtifacts) {
    mergedTask.artifacts = topLevelArtifacts || nestedArtifacts;
  }

  return mergedTask;
}
