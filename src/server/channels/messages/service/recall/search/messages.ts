/**
 * Chat message search operations
 */

import type { Conversation, StoredMessage } from '@/server/channels/messages/repository';
import type { SearchMessagesOptions } from '@/server/channels/messages/repository/types';
import {
  getChatRecallSlowThresholdMs,
  logChatRecallTrace,
  previewRecallText,
} from '@/server/diagnostics/chatRecallTrace';
import { summarizeError } from '@/server/diagnostics/errorSummary';

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
  const startedAt = Date.now();
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
    const result = [...userMsgs, ...agentMsgs].slice(0, 10);
    const durationMs = Date.now() - startedAt;
    const slowThresholdMs = getChatRecallSlowThresholdMs();
    const slow = durationMs >= slowThresholdMs;
    logChatRecallTrace(
      'fts.recall_completed',
      {
        durationMs,
        slow,
        slowThresholdMs,
        conversationId: conversation.id,
        channelType: conversation.channelType,
        externalChatId: conversation.externalChatId || null,
        personaId: conversation.personaId ?? null,
        userId: conversation.userId,
        queryLength: userInput.trim().length,
        queryPreview: previewRecallText(userInput),
        rawCount: raw.length,
        filteredCount: filtered.length,
        dedupedCount: deduped.length,
        returnedCount: result.length,
      },
      { force: slow },
    );
    return result;
  } catch (error) {
    logChatRecallTrace(
      'fts.recall_failed',
      {
        durationMs: Date.now() - startedAt,
        conversationId: conversation.id,
        channelType: conversation.channelType,
        externalChatId: conversation.externalChatId || null,
        personaId: conversation.personaId ?? null,
        userId: conversation.userId,
        queryLength: userInput.trim().length,
        queryPreview: previewRecallText(userInput),
        error: summarizeError(error),
      },
      { force: true, level: 'error' },
    );
    console.error('Chat FTS5 recall failed:', error);
    return [];
  }
}
