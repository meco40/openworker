/**
 * Chat message search operations
 */

import type { Conversation, StoredMessage } from '@/server/channels/messages/repository';
import type { SearchMessagesOptions } from '@/server/channels/messages/repository/types';

/**
 * Search messages in chat history using FTS5
 * Filters out duplicates and prioritizes user messages
 */
export async function recallFromChat(
  conversation: Conversation,
  userInput: string,
  searchMessages?: (
    query: string,
    options: SearchMessagesOptions,
  ) => StoredMessage[] | Promise<StoredMessage[]>,
): Promise<StoredMessage[]> {
  if (!searchMessages) return [];
  try {
    const inputNorm = userInput
      .trim()
      .toLowerCase()
      .replace(/[?.!]+$/, '');
    // Overfetch generously to survive duplicate flooding from repeated queries
    const maybeRaw = await searchMessages(userInput, {
      userId: conversation.userId,
      personaId: conversation.personaId ?? undefined,
      limit: 50,
    } as SearchMessagesOptions);
    const raw = Array.isArray(maybeRaw) ? maybeRaw : [];

    const filtered = raw.filter((m) => {
      // Exclude messages that are (near-)exact duplicates of the current query
      const content = m.content
        .trim()
        .toLowerCase()
        .replace(/[?.!]+$/, '');
      return content !== inputNorm;
    });

    // Deduplicate near-identical agent responses (e.g. repeated "Ja, die Regeln sind...")
    const seen = new Set<string>();
    const deduped = filtered.filter((m) => {
      // For agent messages, use first 80 chars as fingerprint to collapse repetitions
      if (m.role !== 'user') {
        const fingerprint = m.content.substring(0, 80).toLowerCase();
        if (seen.has(fingerprint)) return false;
        seen.add(fingerprint);
      }
      return true;
    });

    // Prioritize user messages (explicit instructions) over agent paraphrases
    const userMsgs = deduped.filter((m) => m.role === 'user');
    const agentMsgs = deduped.filter((m) => m.role !== 'user');
    return [...userMsgs, ...agentMsgs].slice(0, 10);
  } catch (error) {
    console.error('Chat FTS5 recall failed:', error);
    return [];
  }
}
