import type { Conversation } from '../../../types';
import type { MessageRepository, StoredMessage } from '../channels/messages/repository';
import { resolveMemoryScopedUserIdForConversation } from '../memory/userScope';
import type { KnowledgeRepository } from './repository';
import { createPersonaIsolationPolicy } from './personaIsolationPolicy';

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
  constructor(
    private readonly messageRepository: MessageRepository,
    private readonly knowledgeRepository: KnowledgeRepository,
  ) {}

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

      const toSeqInclusive = Number(
        isolatedMessages[isolatedMessages.length - 1].seq || fromSeqExclusive,
      );
      if (toSeqInclusive <= fromSeqExclusive) continue;

      windows.push({
        conversationId: conversation.id,
        userId: resolveMemoryScopedUserIdForConversation(conversation),
        personaId,
        fromSeqExclusive,
        toSeqInclusive,
        messages: isolatedMessages,
      });
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
