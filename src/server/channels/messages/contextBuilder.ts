import type { MessageRepository } from './repository';
import { getPersonaRepository } from '../../personas/personaRepository';
import type { GatewayMessage } from '../../model-hub/Models/types';
import { extractStoredAttachmentsFromMetadata } from './attachments';

export class ContextBuilder {
  constructor(private readonly repo: MessageRepository) {}

  buildGatewayMessages(
    conversationId: string,
    userId: string,
    limit = 50,
    personaId?: string | null,
  ): GatewayMessage[] {
    const context = this.repo.getConversationContext(conversationId, userId);
    const history = this.repo.listMessages(conversationId, limit, undefined, userId);
    const unsummarizedHistory = context
      ? history.filter(
          (message) => typeof message.seq !== 'number' || message.seq > context.summaryUptoSeq,
        )
      : history;

    const mapped: GatewayMessage[] = unsummarizedHistory.map((message) => {
      const attachments = extractStoredAttachmentsFromMetadata(message.metadata);
      return {
        role: message.role === 'agent' ? 'assistant' : message.role === 'system' ? 'system' : 'user',
        content: message.content,
        attachments: attachments.length > 0 ? attachments : undefined,
      };
    });

    const prefix: GatewayMessage[] = [];

    // Prepend persona system instruction (if active)
    if (personaId) {
      try {
        const personaRepo = getPersonaRepository();
        const instruction = personaRepo.getPersonaSystemInstruction(personaId);
        if (instruction) {
          prefix.push({ role: 'system', content: instruction });
        }
      } catch {
        // Persona module unavailable — skip silently
      }
    }

    // Prepend conversation summary
    if (context?.summaryText?.trim()) {
      prefix.push({
        role: 'system',
        content: `Conversation summary: ${context.summaryText.trim()}`,
      });
    }

    return [...prefix, ...mapped];
  }
}
