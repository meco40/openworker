import type { ChannelType } from '@/shared/domain/types';
import type { Conversation, StoredMessage } from '@/server/channels/messages/repository';
import { extractMemorySaveContent } from '../types';
import { getMemoryService } from '@/server/memory/runtime';
import { resolveMemoryScopedUserId } from '@/server/memory/userScope';
import type { CommandHandlerDeps } from './types';
import { isMem0FactualWriteBlocked } from '@/server/world-model/mem0Policy';

export async function handleMemorySave(
  conversation: Conversation,
  content: string,
  platform: ChannelType,
  externalChatId: string,
  sendResponse: CommandHandlerDeps['sendResponse'],
): Promise<{ saved: boolean; message?: StoredMessage }> {
  const memoryContent = extractMemorySaveContent(content);

  if (memoryContent === null) {
    return { saved: false };
  }

  if (!memoryContent) {
    return {
      saved: false,
      message: await sendResponse(
        conversation,
        '⚠️ Bitte schreibe nach `Speichere ab:` auch den Inhalt.',
        platform,
        externalChatId,
      ),
    };
  }

  if (!conversation.personaId) {
    return {
      saved: false,
      message: await sendResponse(
        conversation,
        '⚠️ Keine Persona aktiv. Bitte zuerst eine Persona wählen, dann `Speichere ab: ...` nutzen.',
        platform,
        externalChatId,
      ),
    };
  }

  if (isMem0FactualWriteBlocked()) {
    return {
      saved: false,
      message: await sendResponse(
        conversation,
        '⚠️ Im Canonical-Modus werden faktische Memories direkt in PostgreSQL gespeichert. Bitte nutze die Knowledge-Ingestion oder Mission Control.',
        platform,
        externalChatId,
      ),
    };
  }

  try {
    const memoryUserId = resolveMemoryScopedUserId({
      userId: conversation.userId,
      channelType: platform || conversation.channelType,
      externalChatId: externalChatId || conversation.externalChatId || 'default',
    });
    const memoryService = getMemoryService();
    if (typeof memoryService.storeMemory === 'function') {
      await memoryService.storeMemory({
        personaId: conversation.personaId,
        type: 'fact',
        content: memoryContent,
        importance: 4,
        userId: memoryUserId,
        metadata: { subject: 'user', sourceRole: 'user', sourceType: 'manual_save' },
      });
    } else {
      await memoryService.store(conversation.personaId, 'fact', memoryContent, 4, memoryUserId, {
        subject: 'user',
        sourceRole: 'user',
        sourceType: 'manual_save',
      });
    }
    return {
      saved: true,
      message: await sendResponse(
        conversation,
        `✅ Gespeichert: ${memoryContent}`,
        platform,
        externalChatId,
      ),
    };
  } catch (error) {
    console.error('Memory store failed:', error);
    return {
      saved: false,
      message: await sendResponse(
        conversation,
        '⚠️ Memory konnte nicht gespeichert werden.',
        platform,
        externalChatId,
      ),
    };
  }
}
