import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SkillDispatchContext } from '@/server/skills/types';

const callMock = vi.fn();
const deleteMessageMock = vi.fn();

beforeEach(() => {
  vi.resetModules();
  callMock.mockReset();
  deleteMessageMock.mockReset();

  vi.doMock('@/lib/openclaw/client', () => ({
    getOpenClawClient: () => ({ call: callMock }),
  }));

  vi.doMock('@/server/channels/messages/runtime', () => ({
    getMessageService: () => ({ deleteMessage: deleteMessageMock }),
  }));
});

describe('message compat handler', () => {
  it('supports send/read/delete actions', async () => {
    const { messageCompatHandler } = await import('@/server/skills/handlers/messageCompat');

    callMock.mockImplementation(async (method: string) => {
      if (method === 'chat.send') return { ok: true, conversationId: 'conv-1' };
      if (method === 'chat.history')
        return { messages: [{ role: 'assistant', content: [{ type: 'text', text: 'pong' }] }] };
      return { ok: true };
    });
    deleteMessageMock.mockReturnValue(true);

    const send = await messageCompatHandler({
      action: 'send',
      to: 'agent:main:s-1',
      content: 'ping',
    });
    expect((send as { ok: boolean }).ok).toBe(true);

    const read = (await messageCompatHandler({
      action: 'read',
      sessionKey: 'agent:main:s-1',
      limit: 5,
    })) as {
      messages: unknown[];
    };
    expect(Array.isArray(read.messages)).toBe(true);

    const context: SkillDispatchContext = { userId: 'user-1' };
    const deleted = (await messageCompatHandler(
      { action: 'delete', messageId: 'm-1', conversationId: 'conv-1' },
      context,
    )) as { deleted: boolean };
    expect(deleted.deleted).toBe(true);

    expect(callMock).toHaveBeenCalledWith('chat.send', {
      sessionKey: 'agent:main:s-1',
      message: 'ping',
    });
    expect(callMock).toHaveBeenCalledWith('chat.history', {
      sessionKey: 'agent:main:s-1',
      limit: 5,
    });
    expect(deleteMessageMock).toHaveBeenCalledWith('m-1', 'user-1', 'conv-1');
  });
});
