import { NextResponse } from 'next/server';

import { resolveRequestUserContext } from '@/server/auth/userContext';
import { getMessageService } from '@/server/channels/messages/runtime';

export const runtime = 'nodejs';

interface InboxItem {
  conversationId: string;
  channelType: string;
  title: string;
  updatedAt: string;
  lastMessage: {
    id: string;
    role: 'user' | 'agent' | 'system';
    content: string;
    createdAt: string;
    platform: string;
  } | null;
}

function normalizeText(value: string): string {
  return value.trim().toLowerCase();
}

export async function GET(request: Request) {
  const userContext = await resolveRequestUserContext();
  if (!userContext) {
    return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 });
  }
  const userId = userContext.userId;

  const { searchParams } = new URL(request.url);
  const filterChannel = normalizeText(searchParams.get('channel') || '');
  const query = normalizeText(searchParams.get('q') || '');
  const limit = Math.max(1, Math.min(100, parseInt(searchParams.get('limit') || '50', 10)));

  const service = getMessageService();
  const conversations = service.listConversations(userId, limit);

  const items: InboxItem[] = conversations
    .map((conversation) => {
      const lastMessage = service.listMessages(conversation.id, userId, 1).at(-1) || null;
      return {
        conversationId: conversation.id,
        channelType: conversation.channelType,
        title: conversation.title,
        updatedAt: conversation.updatedAt,
        lastMessage: lastMessage
          ? {
              id: lastMessage.id,
              role: lastMessage.role,
              content: lastMessage.content,
              createdAt: lastMessage.createdAt,
              platform: lastMessage.platform,
            }
          : null,
      };
    })
    .filter((item) => !filterChannel || normalizeText(item.channelType) === filterChannel)
    .filter((item) => {
      if (!query) return true;
      return (
        normalizeText(item.title).includes(query) ||
        normalizeText(item.lastMessage?.content || '').includes(query)
      );
    });

  return NextResponse.json({
    ok: true,
    items,
    total: items.length,
    nextCursor: null,
  });
}
