import { afterEach, describe, expect, it, vi } from 'vitest';
import { ChannelType } from '../../../types';

const dispatchWithFallbackMock = vi.fn().mockResolvedValue({
  ok: true,
  text: 'Step completed',
});

vi.mock('../../../src/server/model-hub/runtime', () => ({
  getModelHubService: () => ({
    dispatchWithFallback: dispatchWithFallbackMock,
  }),
  getModelHubEncryptionKey: () => 'test-encryption-key',
}));

vi.mock('../../../src/server/clawhub/clawhubService', () => ({
  getClawHubService: () => ({
    getPromptBlock: vi.fn().mockResolvedValue('CLAWHUB WORKER BLOCK'),
  }),
}));

import { executeStep } from '../../../src/server/worker/workerExecutor';
import type { WorkerStepRecord, WorkerTaskRecord } from '../../../src/server/worker/workerTypes';

describe('worker executor ClawHub prompt hydration', () => {
  afterEach(() => {
    dispatchWithFallbackMock.mockClear();
  });

  it('appends ClawHub prompt block to worker system prompt', async () => {
    const task: WorkerTaskRecord = {
      id: 'task-1',
      title: 'Build feature',
      objective: 'Implement feature',
      status: 'executing',
      priority: 'normal',
      originPlatform: ChannelType.WEBCHAT,
      originConversation: 'conv-1',
      originExternalChat: null,
      currentStep: 1,
      totalSteps: 1,
      resultSummary: null,
      errorMessage: null,
      resumable: true,
      lastCheckpoint: null,
      workspacePath: null,
      workspaceType: 'general',
      assignedPersonaId: null,
      planningMessages: null,
      planningComplete: false,
      createdAt: new Date().toISOString(),
      startedAt: null,
      completedAt: null,
    };

    const step: WorkerStepRecord = {
      id: 'step-1',
      taskId: task.id,
      stepIndex: 0,
      description: 'Implement the feature',
      status: 'running',
      output: null,
      toolCalls: null,
      startedAt: null,
      completedAt: null,
    };

    await executeStep(task, step);

    expect(dispatchWithFallbackMock).toHaveBeenCalled();
    const payload = dispatchWithFallbackMock.mock.calls[0]?.[2] as
      | { messages?: Array<{ role: string; content: string }> }
      | undefined;
    expect(payload?.messages?.[0]?.content).toContain('CLAWHUB WORKER BLOCK');
  });
});
