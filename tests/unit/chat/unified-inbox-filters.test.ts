import { describe, expect, it } from 'vitest';

import { ChannelType, type Conversation } from '@/shared/domain/types';
import { filterConversations } from '@/modules/chat/hooks/useChatInterfaceState';

function conversation(overrides: Partial<Conversation>): Conversation {
  return {
    id: overrides.id || 'conv-1',
    channelType: overrides.channelType || ChannelType.WEBCHAT,
    externalChatId: overrides.externalChatId || 'chat-1',
    userId: overrides.userId || 'u-1',
    title: overrides.title || 'Untitled',
    modelOverride: overrides.modelOverride || null,
    personaId: overrides.personaId || null,
    createdAt: overrides.createdAt || '2026-02-11T00:00:00.000Z',
    updatedAt: overrides.updatedAt || '2026-02-11T00:00:00.000Z',
  };
}

describe('unified inbox filters', () => {
  it('filters by channel', () => {
    const conversations = [
      conversation({ id: 'c1', channelType: ChannelType.TELEGRAM, title: 'Alpha' }),
      conversation({ id: 'c2', channelType: ChannelType.DISCORD, title: 'Beta' }),
    ];

    const filtered = filterConversations(conversations, 'Telegram', '');
    expect(filtered).toHaveLength(1);
    expect(filtered[0].id).toBe('c1');
  });

  it('filters by search query', () => {
    const conversations = [
      conversation({ id: 'c1', channelType: ChannelType.TELEGRAM, title: 'Build Status' }),
      conversation({ id: 'c2', channelType: ChannelType.DISCORD, title: 'General Chat' }),
    ];

    const filtered = filterConversations(conversations, 'All', 'build');
    expect(filtered).toHaveLength(1);
    expect(filtered[0].id).toBe('c1');
  });
});
