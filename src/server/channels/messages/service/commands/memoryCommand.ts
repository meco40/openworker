import type { ChannelType } from '@/shared/domain/types';
import type { Conversation, StoredMessage } from '@/server/channels/messages/repository';
import { extractMemorySaveContent } from '../types';
import { getMemoryService } from '@/server/memory/runtime';
import { resolveMemoryScopedUserId } from '@/server/memory/userScope';
import type { CommandHandlerDeps } from './types';

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

  try {
    const memoryUserId = resolveMemoryScopedUserId({
      userId: conversation.userId,
      channelType: platform || conversation.channelType,
      externalChatId: externalChatId || conversation.externalChatId || 'default',
    });
    await getMemoryService().store(conversation.personaId, 'fact', memoryContent, 4, memoryUserId, {
      subject: 'user',
      sourceRole: 'user',
      sourceType: 'manual_save',
    });
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
