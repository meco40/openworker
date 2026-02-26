/**
 * WebUI message handler
 * Extracted from the monolithic index.ts
 */

import type { MessageRepository, StoredMessage } from '@/server/channels/messages/repository';
import type { SessionManager } from '@/server/channels/messages/sessionManager';
import type { ChannelType } from '@/shared/domain/types';

/**
 * Dependencies for WebUI handler
 */
export interface WebUIHandlerDeps {
  sessionManager: SessionManager;
  repo: MessageRepository;
}

/**
 * WebUI message result
 */
export interface WebUIMessageResult {
  userMsg: StoredMessage;
  agentMsg: StoredMessage;
  newConversationId?: string;
}

/**
 * Handle WebUI message
 */
export async function handleWebUIMessage(
  deps: WebUIHandlerDeps,
  handleInbound: (
    platform: ChannelType,
    externalChatId: string,
    content: string,
    senderName?: string,
    externalMsgId?: string,
    userId?: string,
    clientMessageId?: string,
    attachments?: import('@/server/channels/messages/attachments').StoredMessageAttachment[],
    onStreamDelta?: (delta: string) => void,
    opts?: {
      skipProjectGuard?: boolean;
      executionDirective?: string;
      maxToolCalls?: number;
      requireToolCall?: boolean;
    },
  ) => Promise<WebUIMessageResult>,
  params: {
    conversationId: string;
    content: string;
    userId?: string;
    clientMessageId?: string;
    attachments?: import('@/server/channels/messages/attachments').StoredMessageAttachment[];
    onStreamDelta?: (delta: string) => void;
    opts?: {
      skipProjectGuard?: boolean;
      executionDirective?: string;
      maxToolCalls?: number;
      requireToolCall?: boolean;
    };
  },
): Promise<WebUIMessageResult> {
  const { conversationId, content, userId, clientMessageId, attachments, onStreamDelta, opts } =
    params;

  const conversation = deps.sessionManager.resolveConversationForWebChat(
    deps.repo,
    conversationId,
    userId,
  );

  return handleInbound(
    conversation.channelType,
    conversation.externalChatId || 'default',
    content,
    undefined,
    undefined,
    conversation.userId,
    clientMessageId,
    attachments,
    onStreamDelta,
    opts,
  );
}
