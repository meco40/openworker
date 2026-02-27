import type { StoredMessage } from '@/server/channels/messages/repository';

export function makeMessage(seq: number, content: string): StoredMessage {
  return {
    id: `m-${seq}`,
    conversationId: 'conv-1',
    seq,
    role: seq % 2 === 0 ? 'agent' : 'user',
    content,
    platform: 'WebChat' as never,
    externalMsgId: null,
    senderName: null,
    metadata: null,
    createdAt: new Date(2025, 7, 10, 9, seq).toISOString(),
  };
}
