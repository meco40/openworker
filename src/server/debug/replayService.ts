import type { MessageRepository } from '@/server/channels/messages/repository';
import type { PromptDispatchRepository } from '@/server/stats/promptDispatchRepository';
import { getMessageRepository } from '@/server/channels/messages/runtime';
import { getPromptDispatchRepository } from '@/server/stats/promptDispatchRepository';

export class ReplayService {
  constructor(
    private readonly messageRepo: MessageRepository,
    private readonly dispatchRepo: PromptDispatchRepository,
  ) {}

  async replayFrom(
    conversationId: string,
    fromSeq: number,
    _modelOverride?: string,
  ): Promise<string> {
    if (!Number.isInteger(fromSeq) || fromSeq < 1) {
      throw new Error('fromSeq must be an integer >= 1');
    }

    // 1. Load original conversation — preserve channelType, personaId, userId
    const original = this.messageRepo.getConversation(conversationId);
    if (!original) {
      throw new Error(`Conversation ${conversationId} not found`);
    }

    // 2. Load history: all messages up to (but not including) fromSeq
    const allMessages = this.messageRepo.listMessages(conversationId, 500);
    const history = allMessages.filter((msg) => (msg.seq ?? Infinity) < fromSeq);

    // 3. Create new conversation with same metadata
    const newConversation = this.messageRepo.createConversation({
      channelType: original.channelType,
      externalChatId: `replay-${Date.now()}`,
      title: `[Replay from T${String(fromSeq)}] ${original.title ?? conversationId}`,
      userId: original.userId,
      personaId: original.personaId ?? undefined,
    });

    // 4. Seed history as pre-existing messages (in original order)
    const sortedHistory = history.slice().sort((a, b) => (a.seq ?? 0) - (b.seq ?? 0));
    for (const msg of sortedHistory) {
      this.messageRepo.saveMessage({
        conversationId: newConversation.id,
        role: msg.role,
        content: msg.content,
        platform: msg.platform,
      });
    }

    // 5. modelOverride: Phase 2 — user selects the model in the new chat after navigating
    return newConversation.id;
  }
}

let _instance: ReplayService | undefined;

export function getReplayService(): ReplayService {
  if (!_instance) {
    _instance = new ReplayService(getMessageRepository(), getPromptDispatchRepository());
  }
  return _instance;
}
