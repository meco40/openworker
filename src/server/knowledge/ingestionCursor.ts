import type { Conversation } from '@/shared/domain/types';
import type { MessageRepository, StoredMessage } from '@/server/channels/messages/repository';
import { resolveMemoryScopedUserIdForConversation } from '@/server/memory/userScope';
import type { KnowledgeRepository } from '@/server/knowledge/repository';
import { createPersonaIsolationPolicy } from '@/server/knowledge/personaIsolationPolicy';

/**
 * Maximum number of messages per ingestion window.
 * Keeps LLM extraction prompts within reasonable context size
 * and produces more granular episodes (one per window).
 */
const MAX_WINDOW_MESSAGES = 30;
const MIN_WINDOW_MESSAGES = 1;

export interface KnowledgeIngestionCursorOptions {
  minMessagesPerBatch?: number;
}

/**
 * Upper bound for minMessagesPerBatch. This is deliberately higher than
 * MAX_WINDOW_MESSAGES so callers can require e.g. 50 messages before starting
 * ingestion while the cursor still splits them into 25-message sub-windows.
 */
const MAX_MIN_BATCH = 200;

function clampMinMessagesPerBatch(value: number | undefined): number {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return MIN_WINDOW_MESSAGES;
  const rounded = Math.floor(numeric);
  return Math.max(MIN_WINDOW_MESSAGES, Math.min(MAX_MIN_BATCH, rounded));
}

export interface IngestionWindow {
  conversationId: string;
  userId: string;
  personaId: string;
  fromSeqExclusive: number;
  toSeqInclusive: number;
  messages: StoredMessage[];
}

function resolveNextMessages(
  repo: MessageRepository,
  conversation: Conversation,
  fromSeqExclusive: number,
): StoredMessage[] {
  const direct = repo.listMessagesAfterSeq?.(
    conversation.id,
    fromSeqExclusive,
    2000,
    conversation.userId,
  );
  if (Array.isArray(direct)) {
    return direct
      .filter((message) => Number.isFinite(Number(message.seq)))
      .sort((a, b) => Number(a.seq || 0) - Number(b.seq || 0));
  }

  return repo
    .listMessages(conversation.id, 2000, undefined, conversation.userId)
    .filter((message) => Number(message.seq || 0) > fromSeqExclusive)
    .sort((a, b) => Number(a.seq || 0) - Number(b.seq || 0));
}

export class KnowledgeIngestionCursor {
  private readonly minMessagesPerBatch: number;

  constructor(
    private readonly messageRepository: MessageRepository,
    private readonly knowledgeRepository: KnowledgeRepository,
    options: KnowledgeIngestionCursorOptions = {},
  ) {
    this.minMessagesPerBatch = clampMinMessagesPerBatch(options.minMessagesPerBatch);
  }

  getPendingWindows(limitConversations = 200): IngestionWindow[] {
    const conversations = this.messageRepository
      .listConversations(limitConversations)
      .filter((conversation) => String(conversation.personaId || '').trim().length > 0)
      .sort((a, b) => Date.parse(a.updatedAt) - Date.parse(b.updatedAt));

    const windows: IngestionWindow[] = [];

    for (const conversation of conversations) {
      const personaId = String(conversation.personaId || '').trim();
      if (!personaId) continue;

      const checkpoint = this.knowledgeRepository.getIngestionCheckpoint(
        conversation.id,
        personaId,
      );
      const fromSeqExclusive = Math.max(0, Number(checkpoint?.lastSeq || 0));
      const messages = resolveNextMessages(this.messageRepository, conversation, fromSeqExclusive);
      if (messages.length === 0) continue;

      // ── Persona isolation: filter out messages from other personas ──
      const isolationPolicy = createPersonaIsolationPolicy();
      const filteredMessages = isolationPolicy.filterByPersona(
        messages.map((m) => ({
          id: m.id,
          content: String(m.content || ''),
          personaAtMessage: (m as unknown as Record<string, unknown>).personaId as
            | string
            | null
            | undefined,
        })),
        personaId,
      );
      // Map back to original StoredMessage objects
      const filteredIds = new Set(filteredMessages.map((m) => m.id));
      const isolatedMessages = messages.filter((m) => filteredIds.has(m.id));
      if (isolatedMessages.length === 0) continue;
      if (isolatedMessages.length < this.minMessagesPerBatch) continue;

      const toSeqInclusive = Number(
        isolatedMessages[isolatedMessages.length - 1].seq || fromSeqExclusive,
      );
      if (toSeqInclusive <= fromSeqExclusive) continue;

      // ── Sub-windowing: split large message sets into chunks ──
      const userId = resolveMemoryScopedUserIdForConversation(conversation);
      if (isolatedMessages.length <= MAX_WINDOW_MESSAGES) {
        windows.push({
          conversationId: conversation.id,
          userId,
          personaId,
          fromSeqExclusive,
          toSeqInclusive,
          messages: isolatedMessages,
        });
      } else {
        // Chunk into sub-windows of MAX_WINDOW_MESSAGES each
        for (let i = 0; i < isolatedMessages.length; i += MAX_WINDOW_MESSAGES) {
          const chunk = isolatedMessages.slice(i, i + MAX_WINDOW_MESSAGES);
          if (chunk.length === 0) continue;
          // Don't emit a trailing rump smaller than MIN_WINDOW_MESSAGES,
          // but DO emit full-size chunks regardless of minMessagesPerBatch
          // (the outer check already ensured the conversation has enough total messages).
          if (chunk.length < MIN_WINDOW_MESSAGES) break;
          const chunkFromSeq =
            i === 0 ? fromSeqExclusive : Number(isolatedMessages[i - 1].seq || fromSeqExclusive);
          const chunkToSeq = Number(chunk[chunk.length - 1].seq || chunkFromSeq);
          if (chunkToSeq <= chunkFromSeq && i > 0) continue;

          windows.push({
            conversationId: conversation.id,
            userId,
            personaId,
            fromSeqExclusive: chunkFromSeq,
            toSeqInclusive: chunkToSeq,
            messages: chunk,
          });
        }
      }
    }

    return windows;
  }

  markWindowProcessed(window: IngestionWindow): void {
    const current = this.knowledgeRepository.getIngestionCheckpoint(
      window.conversationId,
      window.personaId,
    );
    const currentSeq = Math.max(0, Number(current?.lastSeq || 0));
    const nextSeq = Math.max(currentSeq, Math.floor(Number(window.toSeqInclusive || 0)));
    this.knowledgeRepository.upsertIngestionCheckpoint({
      conversationId: window.conversationId,
      personaId: window.personaId,
      lastSeq: nextSeq,
    });
  }
}
