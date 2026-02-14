import { describe, expect, it } from 'vitest';
import { WorkerTaskStatus } from '../../../types';
import type { WorkerTask } from '../../../types';
import { mergeWorkerTaskDetailPayload } from '../../../src/modules/worker/services/workerTaskDetailMerge';

function makeTask(): WorkerTask {
  return {
    id: 'task-1',
    title: 'Task',
    objective: 'Objective',
    status: WorkerTaskStatus.QUEUED,
    workspaceType: 'general',
    priority: 'normal',
    currentStep: 0,
    totalSteps: 0,
    resultSummary: null,
    errorMessage: null,
    workspacePath: null,
    resumable: false,
    assignedPersonaId: null,
    planningMessages: null,
    planningComplete: false,
    createdAt: new Date().toISOString(),
    startedAt: null,
    completedAt: null,
  };
}

describe('mergeWorkerTaskDetailPayload', () => {
  it('hydrates steps and artifacts from top-level API fields', () => {
    const baseTask = makeTask();

    const merged = mergeWorkerTaskDetailPayload(baseTask, {
      task: { ...baseTask, title: 'Hydrated' },
      steps: [
        {
          id: 'step-1',
          taskId: 'task-1',
          stepIndex: 0,
          description: 'Do thing',
          status: 'completed',
          output: 'Done',
          startedAt: null,
          completedAt: null,
        },
      ],
      artifacts: [
        { id: 'art-1', name: 'out.md', type: 'doc', content: 'x', mimeType: 'text/plain' },
      ],
    });

    expect(merged.title).toBe('Hydrated');
    expect(merged.steps).toHaveLength(1);
    expect(merged.steps?.[0]?.description).toBe('Do thing');
    expect(merged.artifacts).toHaveLength(1);
    expect(merged.artifacts?.[0]?.name).toBe('out.md');
  });

  it('falls back to nested task.steps when top-level steps are absent', () => {
    const baseTask = makeTask();
    const merged = mergeWorkerTaskDetailPayload(baseTask, {
      task: {
        ...baseTask,
        steps: [
          {
            id: 'step-1',
            taskId: 'task-1',
            stepIndex: 0,
            description: 'Nested step',
            status: 'running',
            output: null,
            startedAt: null,
            completedAt: null,
          },
        ],
      },
    });

    expect(merged.steps).toHaveLength(1);
    expect(merged.steps?.[0]?.description).toBe('Nested step');
  });

  it('returns base task when payload is invalid', () => {
    const baseTask = makeTask();
    const merged = mergeWorkerTaskDetailPayload(baseTask, null);
    expect(merged).toEqual(baseTask);
  });
});
