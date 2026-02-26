/**
 * Knowledge layer search operations
 */

import type { Conversation } from '@/server/channels/messages/repository';
import { ensureKnowledgeIngestedForConversation } from '@/server/knowledge/runtime';
import { normalizeMemoryContext } from '../../types';
import type { KnowledgeRetrievalServiceLike } from '../../types';

/**
 * Recall from Knowledge Layer (episodes / meeting ledger)
 */
export async function recallFromKnowledge(
  service: KnowledgeRetrievalServiceLike | null,
  memoryUserIds: string[],
  conversation: Conversation,
  userInput: string,
  options: { skipPreIngest: boolean; includeSemantic: boolean },
): Promise<string | null> {
  if (!service) return null;
  for (const userIdCandidate of memoryUserIds) {
    if (!options.skipPreIngest) {
      try {
        await ensureKnowledgeIngestedForConversation({
          conversationId: conversation.id,
          userId: userIdCandidate,
          personaId: conversation.personaId!,
        });
      } catch (error) {
        console.error('Knowledge pre-ingest failed:', error);
      }
    }
    try {
      const result = await service.retrieve({
        userId: userIdCandidate,
        personaId: conversation.personaId!,
        conversationId: conversation.id,
        query: userInput,
        includeSemantic: options.includeSemantic,
      });
      const normalized = normalizeMemoryContext(result.context || '');
      if (normalized) return normalized;
    } catch (error) {
      console.error('Knowledge recall failed:', error);
    }
  }
  return null;
}
