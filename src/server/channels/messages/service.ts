import type { ChannelType } from '../../../../types';
import type { MessageRepository, StoredMessage, Conversation } from './repository';
import { getSSEManager } from '../sse/manager';
import { deliverOutbound } from '../outbound/router';
import { getModelHubService, getModelHubEncryptionKey } from '../../model-hub/runtime';

// ─── MessageService ──────────────────────────────────────────

export class MessageService {
  constructor(private readonly repo: MessageRepository) {}

  // ─── Conversation Management ────────────────────────────────

  listConversations(limit?: number): Conversation[] {
    return this.repo.listConversations(limit);
  }

  getOrCreateConversation(
    channelType: ChannelType,
    externalChatId: string,
    title?: string,
  ): Conversation {
    return this.repo.getOrCreateConversation(channelType, externalChatId, title);
  }

  getDefaultWebChatConversation(): Conversation {
    return this.repo.getDefaultWebChatConversation();
  }

  listMessages(conversationId: string, limit?: number, before?: string): StoredMessage[] {
    return this.repo.listMessages(conversationId, limit, before);
  }

  // ─── Core: Handle Inbound Message ──────────────────────────

  /**
   * Handles a message arriving from any channel (WebUI, Telegram, WhatsApp, etc.)
   * 1. Save user message to DB
   * 2. Dispatch to ModelHub Gateway for AI response
   * 3. Save agent response to DB
   * 4. Broadcast both via SSE to WebUI
   * 5. Deliver agent response back to the originating channel (outbound)
   */
  async handleInbound(
    platform: ChannelType,
    externalChatId: string,
    content: string,
    senderName?: string,
    externalMsgId?: string,
  ): Promise<{ userMsg: StoredMessage; agentMsg: StoredMessage }> {
    const conversation = this.repo.getOrCreateConversation(platform, externalChatId);

    // 1. Save user message
    const userMsg = this.repo.saveMessage({
      conversationId: conversation.id,
      role: 'user',
      content,
      platform,
      externalMsgId,
      senderName,
    });

    // Broadcast user message via SSE
    getSSEManager().broadcast({
      type: 'message',
      data: userMsg,
    });

    // 2. Build conversation history for the AI
    const history = this.repo.listMessages(conversation.id, 50);
    const messages = history.map((m) => ({
      role: m.role === 'agent' ? ('assistant' as const) : (m.role as 'user' | 'system'),
      content: m.content,
    }));

    // 3. Dispatch to ModelHub Gateway
    let agentContent: string;
    try {
      const service = getModelHubService();
      const encryptionKey = getModelHubEncryptionKey();
      const result = await service.dispatchWithFallback('p1', encryptionKey, { messages });

      if (result.ok) {
        agentContent = result.text || 'No response from model.';
      } else {
        agentContent = `⚠️ Gateway error: ${result.error || 'Unknown error'}`;
      }
    } catch (error) {
      agentContent = `⚠️ ${error instanceof Error ? error.message : 'AI dispatch failed'}`;
    }

    // 4. Save agent response
    const agentMsg = this.repo.saveMessage({
      conversationId: conversation.id,
      role: 'agent',
      content: agentContent,
      platform,
    });

    // Broadcast agent message via SSE
    getSSEManager().broadcast({
      type: 'message',
      data: agentMsg,
    });

    // 5. Deliver outbound to the originating channel (non-WebChat)
    try {
      await deliverOutbound(platform, externalChatId, agentContent);
    } catch (error) {
      console.error(`Outbound delivery failed for ${platform}:`, error);
    }

    return { userMsg, agentMsg };
  }

  /**
   * Handle a message from WebUI chat — same flow but conversation is pre-selected.
   */
  async handleWebUIMessage(
    conversationId: string,
    content: string,
  ): Promise<{ userMsg: StoredMessage; agentMsg: StoredMessage }> {
    const conversation = this.repo.getConversation(conversationId);
    if (!conversation) throw new Error('Conversation not found');

    return this.handleInbound(
      conversation.channelType,
      conversation.externalChatId || 'default',
      content,
      undefined,
      undefined,
    );
  }

  /**
   * Save a message without triggering AI dispatch (for system messages, etc.)
   */
  saveDirectMessage(
    conversationId: string,
    role: 'user' | 'agent' | 'system',
    content: string,
    platform: ChannelType,
  ): StoredMessage {
    const msg = this.repo.saveMessage({ conversationId, role, content, platform });
    getSSEManager().broadcast({ type: 'message', data: msg });
    return msg;
  }
}
