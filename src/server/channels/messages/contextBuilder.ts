import type { MessageRepository } from './repository';

interface GatewayMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export class ContextBuilder {
  constructor(private readonly repo: MessageRepository) {}

  buildGatewayMessages(conversationId: string, userId: string, limit = 50): GatewayMessage[] {
    const context = this.repo.getConversationContext(conversationId, userId);
    const history = this.repo.listMessages(conversationId, limit, undefined, userId);
    const unsummarizedHistory = context
      ? history.filter((message) => typeof message.seq !== 'number' || message.seq > context.summaryUptoSeq)
      : history;

    const mapped: GatewayMessage[] = unsummarizedHistory.map((message) => ({
      role:
        message.role === 'agent'
          ? 'assistant'
          : message.role === 'system'
            ? 'system'
            : 'user',
      content: message.content,
    }));

    if (context?.summaryText?.trim()) {
      return [
        {
          role: 'system',
          content: `Conversation summary: ${context.summaryText.trim()}`,
        },
        ...mapped,
      ];
    }

    return mapped;
  }
}
