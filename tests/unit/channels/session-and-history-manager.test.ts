import { describe, expect, it, vi } from 'vitest';

import { SessionManager } from '@/server/channels/messages/sessionManager';
import { HistoryManager } from '@/server/channels/messages/historyManager';
import { ChannelType } from '@/shared/domain/types';
import { LEGACY_LOCAL_USER_ID } from '@/server/auth/constants';
import type {
  Conversation,
  MessageRepository,
  StoredMessage,
} from '@/server/channels/messages/repository';

function makeRepo(overrides: Partial<MessageRepository> = {}): MessageRepository {
  return {
    createConversation: vi.fn(),
    getConversation: vi.fn(),
    getConversationByExternalChat: vi.fn(),
    getOrCreateConversation: vi.fn(),
    listConversations: vi.fn(),
    updateConversationTitle: vi.fn(),
    saveMessage: vi.fn(),
    listMessages: vi.fn(),
    listMessagesAfterSeq: vi.fn(),
    getDefaultWebChatConversation: vi.fn(),
    getConversationContext: vi.fn(),
    upsertConversationContext: vi.fn(),
    deleteConversation: vi.fn(),
    updateModelOverride: vi.fn(),
    updatePersonaId: vi.fn(),
    findMessageByClientId: vi.fn(),
    ...overrides,
  } as unknown as MessageRepository;
}

describe('SessionManager', () => {
  it('normalizes empty user ids to legacy local user', () => {
    const manager = new SessionManager();

    expect(manager.resolveUserId()).toBe(LEGACY_LOCAL_USER_ID);
    expect(manager.resolveUserId('  ')).toBe(LEGACY_LOCAL_USER_ID);
    expect(manager.resolveUserId('user-a')).toBe('user-a');
  });

  it('returns default webchat conversation when no conversationId is provided', () => {
    const manager = new SessionManager();
    const conversation: Conversation = {
      id: 'conv-default',
      channelType: ChannelType.WEBCHAT,
      externalChatId: 'default',
      userId: 'user-a',
      title: 'Default',
      modelOverride: null,
      personaId: null,
      createdAt: '2026-02-22T00:00:00.000Z',
      updatedAt: '2026-02-22T00:00:00.000Z',
    };
    const repo = makeRepo({
      getDefaultWebChatConversation: vi.fn(() => conversation),
    });

    const result = manager.resolveConversationForWebChat(repo, undefined, 'user-a');

    expect(result).toBe(conversation);
    expect(repo.getDefaultWebChatConversation).toHaveBeenCalledWith('user-a');
  });

  it('throws when requested conversation does not belong to user', () => {
    const manager = new SessionManager();
    const repo = makeRepo({
      getConversation: vi.fn(() => null),
    });

    expect(() => manager.resolveConversationForWebChat(repo, 'conv-missing', 'user-a')).toThrow(
      'Conversation not found for current user.',
    );
  });

  it('returns existing conversation for current user', () => {
    const manager = new SessionManager();
    const conversation: Conversation = {
      id: 'conv-1',
      channelType: ChannelType.WEBCHAT,
      externalChatId: 'default',
      userId: 'user-a',
      title: 'Chat',
      modelOverride: null,
      personaId: null,
      createdAt: '2026-02-22T00:00:00.000Z',
      updatedAt: '2026-02-22T00:00:00.000Z',
    };
    const repo = makeRepo({
      getConversation: vi.fn(() => conversation),
    });

    const result = manager.resolveConversationForWebChat(repo, 'conv-1', 'user-a');

    expect(result).toBe(conversation);
    expect(repo.getConversation).toHaveBeenCalledWith('conv-1', 'user-a');
  });

  it('delegates getOrCreateConversation with normalized user id', () => {
    const manager = new SessionManager();
    const conversation: Conversation = {
      id: 'conv-1',
      channelType: ChannelType.TELEGRAM,
      externalChatId: 'ext-1',
      userId: LEGACY_LOCAL_USER_ID,
      title: 'Title',
      modelOverride: null,
      personaId: null,
      createdAt: '2026-02-22T00:00:00.000Z',
      updatedAt: '2026-02-22T00:00:00.000Z',
    };
    const repo = makeRepo({
      getOrCreateConversation: vi.fn(() => conversation),
    });

    const result = manager.getOrCreateConversation(
      repo,
      ChannelType.TELEGRAM,
      'ext-1',
      'Title',
      '   ',
    );

    expect(result).toBe(conversation);
    expect(repo.getOrCreateConversation).toHaveBeenCalledWith(
      ChannelType.TELEGRAM,
      'ext-1',
      'Title',
      LEGACY_LOCAL_USER_ID,
    );
  });
});

describe('HistoryManager', () => {
  it('appends user messages with optional metadata fields', () => {
    const saved: StoredMessage = {
      id: 'm-1',
      conversationId: 'conv-1',
      role: 'user',
      content: 'hello',
      platform: ChannelType.WEBCHAT,
      externalMsgId: 'ext-1',
      senderName: 'Alice',
      metadata: '{"source":"test"}',
      createdAt: '2026-02-22T00:00:00.000Z',
      seq: 1,
    };
    const repo = makeRepo({
      saveMessage: vi.fn(() => saved),
    });
    const manager = new HistoryManager(repo);

    const result = manager.appendUserMessage('conv-1', ChannelType.WEBCHAT, 'hello', {
      externalMsgId: 'ext-1',
      senderName: 'Alice',
      clientMessageId: 'client-1',
      metadata: { source: 'test' },
    });

    expect(result).toBe(saved);
    expect(repo.saveMessage).toHaveBeenCalledWith({
      conversationId: 'conv-1',
      role: 'user',
      content: 'hello',
      platform: ChannelType.WEBCHAT,
      externalMsgId: 'ext-1',
      senderName: 'Alice',
      clientMessageId: 'client-1',
      metadata: { source: 'test' },
    });
  });

  it('appends agent messages', () => {
    const saved: StoredMessage = {
      id: 'm-2',
      conversationId: 'conv-1',
      role: 'agent',
      content: 'response',
      platform: ChannelType.WEBCHAT,
      externalMsgId: null,
      senderName: null,
      metadata: null,
      createdAt: '2026-02-22T00:00:00.000Z',
      seq: 2,
    };
    const repo = makeRepo({
      saveMessage: vi.fn(() => saved),
    });
    const manager = new HistoryManager(repo);

    const result = manager.appendAgentMessage('conv-1', ChannelType.WEBCHAT, 'response', {
      model: 'test-model',
    });

    expect(result).toBe(saved);
    expect(repo.saveMessage).toHaveBeenCalledWith({
      conversationId: 'conv-1',
      role: 'agent',
      content: 'response',
      platform: ChannelType.WEBCHAT,
      metadata: { model: 'test-model' },
    });
  });

  it('lists recent messages with default and explicit limits', () => {
    const repo = makeRepo({
      listMessages: vi.fn(() => []),
    });
    const manager = new HistoryManager(repo);

    manager.listRecentMessages('conv-1', 'user-a');
    manager.listRecentMessages('conv-1', 'user-a', 10);

    expect(repo.listMessages).toHaveBeenNthCalledWith(1, 'conv-1', 50, undefined, 'user-a');
    expect(repo.listMessages).toHaveBeenNthCalledWith(2, 'conv-1', 10, undefined, 'user-a');
  });
});
