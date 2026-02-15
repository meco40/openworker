import { beforeEach, describe, expect, it, vi } from 'vitest';

const { createTaskMock, processQueueMock, getConversationMock, getDefaultWebChatConversationMock, assignPersonaMock, addActivityMock, getPersonaMock, getTaskMock } =
  vi.hoisted(() => ({
    createTaskMock: vi.fn(),
    processQueueMock: vi.fn().mockImplementation(async () => {}),
    getConversationMock: vi.fn(),
    getDefaultWebChatConversationMock: vi.fn(),
    assignPersonaMock: vi.fn(),
    addActivityMock: vi.fn(),
    getPersonaMock: vi.fn(),
    getTaskMock: vi.fn(),
  }));

vi.mock('../../../src/server/worker/workerRepository', () => ({
  getWorkerRepository: () => ({
    createTask: createTaskMock,
    listTasks: vi.fn(),
    deleteTask: vi.fn(),
    assignPersona: assignPersonaMock,
    addActivity: addActivityMock,
    getTask: getTaskMock,
  }),
}));

vi.mock('../../../src/server/personas/personaRepository', () => ({
  getPersonaRepository: () => ({
    getPersona: getPersonaMock,
  }),
}));

vi.mock('../../../src/server/worker/workerAgent', () => ({
  processQueue: processQueueMock,
}));

vi.mock('../../../src/server/channels/messages/runtime', () => ({
  getMessageRepository: () => ({
    getConversation: getConversationMock,
    getDefaultWebChatConversation: getDefaultWebChatConversationMock,
  }),
}));

import { POST } from '../../../app/api/worker/route';

describe('POST /api/worker conversation fallback', () => {
  beforeEach(() => {
    createTaskMock.mockReset();
    processQueueMock.mockClear();
    getConversationMock.mockReset();
    getDefaultWebChatConversationMock.mockReset();
    assignPersonaMock.mockReset();
    addActivityMock.mockReset();
    getPersonaMock.mockReset();
    getTaskMock.mockReset();

    createTaskMock.mockReturnValue({
      id: 'task-1',
      title: 'Test task',
      objective: 'Test objective',
      status: 'queued',
    });
    getDefaultWebChatConversationMock.mockReturnValue({ id: 'conv-default' });
    getConversationMock.mockReturnValue(null);
    getTaskMock.mockReturnValue({
      id: 'task-1',
      title: 'Test task',
      objective: 'Test objective',
      status: 'queued',
    });
  });

  it('uses default WebChat conversation when conversationId is missing', async () => {
    const response = await POST(
      new Request('http://localhost/api/worker', {
        method: 'POST',
        body: JSON.stringify({ objective: 'Build me a page' }),
      }),
    );

    expect(response.status).toBe(200);
    expect(createTaskMock).toHaveBeenCalledWith(
      expect.objectContaining({ originConversation: 'conv-default' }),
    );
  });

  it('falls back to default conversation when provided conversationId does not exist', async () => {
    const response = await POST(
      new Request('http://localhost/api/worker', {
        method: 'POST',
        body: JSON.stringify({
          objective: 'Build me a page',
          conversationId: 'web-123456',
        }),
      }),
    );

    expect(response.status).toBe(200);
    expect(getConversationMock).toHaveBeenCalledWith('web-123456', expect.any(String));
    expect(createTaskMock).toHaveBeenCalledWith(
      expect.objectContaining({ originConversation: 'conv-default' }),
    );
  });

  it('keeps provided conversationId when it exists', async () => {
    getConversationMock.mockReturnValueOnce({ id: 'conv-existing' });

    const response = await POST(
      new Request('http://localhost/api/worker', {
        method: 'POST',
        body: JSON.stringify({
          objective: 'Build me a page',
          conversationId: 'conv-existing',
        }),
      }),
    );

    expect(response.status).toBe(200);
    expect(createTaskMock).toHaveBeenCalledWith(
      expect.objectContaining({ originConversation: 'conv-existing' }),
    );
  });
});
