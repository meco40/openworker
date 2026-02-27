import { getOpenClawClient } from '@/lib/openclaw/client';
import type { SkillDispatchContext } from '@/server/skills/types';

function readString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function readLimit(value: unknown, fallback = 20): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.min(200, Math.floor(parsed));
}

function resolveSessionKey(args: Record<string, unknown>): string {
  return readString(args.sessionKey) || readString(args.to) || readString(args.sessionId);
}

async function resolveDeleteUserId(context?: SkillDispatchContext): Promise<string> {
  const fromContext = readString(context?.userId);
  if (fromContext) return fromContext;

  const { getPrincipalUserId } = await import('@/server/auth/principal');
  return getPrincipalUserId();
}

export async function messageCompatHandler(
  args: Record<string, unknown>,
  context?: SkillDispatchContext,
) {
  const action = (readString(args.action) || 'send').toLowerCase();
  const client = getOpenClawClient();

  if (action === 'send') {
    const sessionKey = resolveSessionKey(args);
    const message = readString(args.content) || readString(args.message) || readString(args.text);
    if (!sessionKey) throw new Error('message send requires to/sessionKey.');
    if (!message) throw new Error('message send requires content.');

    return client.call('chat.send', {
      sessionKey,
      message,
    });
  }

  if (action === 'read') {
    const sessionKey = resolveSessionKey(args);
    if (!sessionKey) throw new Error('message read requires sessionKey.');
    const limit = readLimit(args.limit, 20);
    const result = (await client.call('chat.history', {
      sessionKey,
      limit,
    })) as Record<string, unknown>;

    return {
      sessionKey,
      messages: Array.isArray(result.messages) ? result.messages : [],
      limit,
    };
  }

  if (action === 'delete') {
    const messageId = readString(args.messageId) || readString(args.id);
    if (!messageId) throw new Error('message delete requires messageId.');
    const conversationId = readString(args.conversationId) || undefined;
    const userId = await resolveDeleteUserId(context);
    const { getMessageService } = await import('@/server/channels/messages/runtime');
    const deleted = getMessageService().deleteMessage(messageId, userId, conversationId);

    return {
      deleted,
      messageId,
      ...(conversationId ? { conversationId } : {}),
    };
  }

  throw new Error(`Unsupported message action: ${action}`);
}
