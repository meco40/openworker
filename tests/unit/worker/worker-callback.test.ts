import { afterEach, describe, expect, it, vi } from 'vitest';
import type { WorkerTaskRecord } from '../../../src/server/worker/workerTypes';

const saveDirectMessageMock = vi.fn();
const deliverOutboundMock = vi.fn();

vi.mock('../../../src/server/channels/messages/runtime', () => ({
  getMessageService: () => ({
    saveDirectMessage: saveDirectMessageMock,
  }),
}));

vi.mock('../../../src/server/channels/outbound/router', () => ({
  deliverOutbound: deliverOutboundMock,
}));

function makeTask(): WorkerTaskRecord {
  return {
    id: 'task-1',
    title: 'Task callback test',
    objective: 'Verify callback behavior',
    status: 'completed',
    priority: 'normal',
    originPlatform: 'WebChat' as never,
    originConversation: 'conv-1',
    originExternalChat: 'chat-1',
    currentStep: 1,
    totalSteps: 1,
    resultSummary: null,
    errorMessage: null,
    resumable: false,
    lastCheckpoint: null,
    workspacePath: null,
    workspaceType: 'general',
    userId: 'user-a',
    flowPublishedId: null,
    currentRunId: null,
    assignedPersonaId: null,
    planningMessages: null,
    planningComplete: false,
    createdAt: new Date().toISOString(),
    startedAt: null,
    completedAt: null,
  };
}

describe('worker callback', () => {
  afterEach(() => {
    saveDirectMessageMock.mockReset();
    deliverOutboundMock.mockReset();
  });

  it('still sends outbound notification when saving direct message fails', async () => {
    saveDirectMessageMock.mockImplementationOnce(() => {
      throw new Error('Conversation not found for current user.');
    });
    deliverOutboundMock.mockImplementationOnce(async () => {});

    const { notifyTaskCompleted } = await import('../../../src/server/worker/workerCallback');
    const task = makeTask();
    await notifyTaskCompleted(task, 'done');

    expect(saveDirectMessageMock).toHaveBeenCalledTimes(1);
    expect(saveDirectMessageMock).toHaveBeenCalledWith(
      task.originConversation,
      'agent',
      'done',
      task.originPlatform,
      task.userId,
    );
    expect(deliverOutboundMock).toHaveBeenCalledTimes(1);
    expect(deliverOutboundMock).toHaveBeenCalledWith(
      task.originPlatform,
      task.originExternalChat,
      'done',
    );
  });
});
