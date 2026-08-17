import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ChannelType } from '@/shared/domain/types';

const deliverTelegram = vi.fn();
const handleTelegramModelCommand = vi.fn();
const deleteMessageWithSideEffects = vi.fn();
const getConversationByExternalChat = vi.fn();
const listMessages = vi.fn();

vi.mock('../../../src/server/channels/outbound/telegram', () => ({
  deliverTelegram,
}));

vi.mock('../../../src/server/channels/telegram/modelSelection', () => ({
  handleTelegramModelCommand,
}));

vi.mock('../../../src/server/channels/messages/deleteMessageAction', () => ({
  deleteMessageWithSideEffects,
}));

vi.mock('../../../src/server/channels/messages/runtime', () => ({
  getMessageService: () => ({
    getConversationByExternalChat,
    listMessages,
  }),
}));

describe('telegram native command handler', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getConversationByExternalChat.mockReset();
    listMessages.mockReset();
    deleteMessageWithSideEffects.mockReset();
    handleTelegramModelCommand.mockReset();
    deliverTelegram.mockReset();
  });

  it('parses /chatdelete and /chatdelete@botname as native delete commands', async () => {
    const { parseTelegramNativeCommand } =
      await import('@/server/channels/telegram/nativeCommandHandler');

    expect(parseTelegramNativeCommand('/chatdelete')).toEqual({
      kind: 'chatdelete',
      args: '',
      command: '/chatdelete',
    });
    expect(parseTelegramNativeCommand('/chatdelete@TestBot now')).toEqual({
      kind: 'chatdelete',
      args: 'now',
      command: '/chatdelete',
    });
  });

  it('does not create a conversation when /chatdelete is used in an empty chat', async () => {
    getConversationByExternalChat.mockReturnValue(null);
    const { handleTelegramNativeCommand } =
      await import('@/server/channels/telegram/nativeCommandHandler');

    const handled = await handleTelegramNativeCommand('123', '/chatdelete');

    expect(handled).toBe(true);
    expect(getConversationByExternalChat).toHaveBeenCalledWith(ChannelType.TELEGRAM, '123');
    expect(listMessages).not.toHaveBeenCalled();
    expect(deleteMessageWithSideEffects).not.toHaveBeenCalled();
    expect(deliverTelegram).toHaveBeenCalledWith('123', 'Nothing to delete.');
  });

  it('deletes the latest persisted message in the resolved topic conversation', async () => {
    getConversationByExternalChat.mockReturnValue({
      id: 'conv-topic-1',
      userId: 'user-telegram',
    });
    listMessages.mockReturnValue([
      {
        id: 'msg-latest',
      },
    ]);
    deleteMessageWithSideEffects.mockResolvedValue({
      ok: true,
      deletedMessage: {
        id: 'msg-latest',
        conversationId: 'conv-topic-1',
      },
    });
    const { handleTelegramNativeCommand } =
      await import('@/server/channels/telegram/nativeCommandHandler');

    const handled = await handleTelegramNativeCommand('123', '/chatdelete@TestBot', '123:topic:7');

    expect(handled).toBe(true);
    expect(getConversationByExternalChat).toHaveBeenCalledWith(ChannelType.TELEGRAM, '123:topic:7');
    expect(listMessages).toHaveBeenCalledWith('conv-topic-1', 'user-telegram', 1);
    expect(deleteMessageWithSideEffects).toHaveBeenCalledWith({
      service: expect.any(Object),
      messageId: 'msg-latest',
      userId: 'user-telegram',
      conversationId: 'conv-topic-1',
    });
    expect(deliverTelegram).toHaveBeenCalledWith('123:topic:7', 'Last message deleted.');
  });
});
