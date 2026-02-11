import type { ChannelType } from '../../../../types';
import type { MessageRepository, StoredMessage, Conversation } from './repository';
import { getSSEManager } from '../sse/manager';
import { deliverOutbound } from '../outbound/router';
import { getModelHubService, getModelHubEncryptionKey } from '../../model-hub/runtime';
import { routeMessage } from './messageRouter';
import { getWorkerRepository } from '../../worker/workerRepository';
import { processQueue } from '../../worker/workerAgent';
import { SessionManager } from './sessionManager';
import { HistoryManager } from './historyManager';
import { ContextBuilder } from './contextBuilder';

// ─── MessageService ──────────────────────────────────────────

export class MessageService {
  private readonly sessionManager = new SessionManager();
  private readonly historyManager: HistoryManager;
  private readonly contextBuilder: ContextBuilder;
  private readonly summaryRefreshInFlight = new Set<string>();

  constructor(private readonly repo: MessageRepository) {
    this.historyManager = new HistoryManager(repo);
    this.contextBuilder = new ContextBuilder(repo);
  }

  // ─── Conversation Management ────────────────────────────────

  listConversations(userId?: string, limit?: number): Conversation[] {
    const resolvedUserId = this.sessionManager.resolveUserId(userId);
    return this.repo.listConversations(limit, resolvedUserId);
  }

  getOrCreateConversation(
    channelType: ChannelType,
    externalChatId: string,
    title?: string,
    userId?: string,
  ): Conversation {
    return this.sessionManager.getOrCreateConversation(
      this.repo,
      channelType,
      externalChatId,
      title,
      userId,
    );
  }

  getDefaultWebChatConversation(userId?: string): Conversation {
    const resolvedUserId = this.sessionManager.resolveUserId(userId);
    return this.repo.getDefaultWebChatConversation(resolvedUserId);
  }

  listMessages(
    conversationId: string,
    userId?: string,
    limit?: number,
    before?: string,
  ): StoredMessage[] {
    const resolvedUserId = this.sessionManager.resolveUserId(userId);
    return this.repo.listMessages(conversationId, limit, before, resolvedUserId);
  }

  // ─── Core: Handle Inbound Message ──────────────────────────

  /**
   * Handles a message arriving from any channel (WebUI, Telegram, WhatsApp, etc.)
   * Routes through messageRouter:
   *  - @worker / /worker → create worker task
   *  - /worker-* commands → handle worker commands
   *  - Everything else → normal AI chat
   */
  async handleInbound(
    platform: ChannelType,
    externalChatId: string,
    content: string,
    senderName?: string,
    externalMsgId?: string,
    userId?: string,
  ): Promise<{ userMsg: StoredMessage; agentMsg: StoredMessage }> {
    const conversation = this.sessionManager.getOrCreateConversation(
      this.repo,
      platform,
      externalChatId,
      undefined,
      userId,
    );

    const userMsg = this.historyManager.appendUserMessage(conversation.id, platform, content, {
      externalMsgId,
      senderName,
    });

    getSSEManager().broadcast(
      {
        type: 'message',
        data: userMsg,
      },
      conversation.userId,
    );

    const route = routeMessage(content);

    if (route.target === 'worker') {
      return {
        userMsg,
        agentMsg: await this.handleWorkerTask(conversation, route.payload, platform, externalChatId),
      };
    }

    if (route.target === 'worker-command') {
      return {
        userMsg,
        agentMsg: await this.handleWorkerCommand(
          conversation,
          route.command!,
          route.payload,
          platform,
          externalChatId,
        ),
      };
    }

    return { userMsg, agentMsg: await this.dispatchToAI(conversation, platform, externalChatId) };
  }

  // ─── Worker Task Handling ──────────────────────────────────

  private async handleWorkerTask(
    conversation: Conversation,
    objective: string,
    platform: ChannelType,
    externalChatId: string,
  ): Promise<StoredMessage> {
    if (!objective) {
      return this.sendResponse(
        conversation,
        '⚠️ Bitte gib eine Aufgabe an.\nBeispiel: `@worker Erstelle eine HTML Seite`',
        platform,
        externalChatId,
      );
    }

    const workerRepo = getWorkerRepository();
    const task = workerRepo.createTask({
      title: objective.slice(0, 60),
      objective,
      originPlatform: platform,
      originConversation: conversation.id,
      originExternalChat: externalChatId,
    });

    processQueue().catch((err: Error) => console.error('[Worker] Queue processing error:', err));

    return this.sendResponse(
      conversation,
      `⚙️ **Task erstellt:** "${task.title}"\n📋 ID: \`${task.id}\`\nStatus: In Warteschlange\n\n_Befehle:_\n• \`/worker-status ${task.id}\` — Status\n• \`/worker-cancel ${task.id}\` — Abbrechen\n• \`/worker-list\` — Alle Tasks`,
      platform,
      externalChatId,
    );
  }

  // ─── Worker Commands ───────────────────────────────────────

  private async handleWorkerCommand(
    conversation: Conversation,
    command: string,
    payload: string,
    platform: ChannelType,
    externalChatId: string,
  ): Promise<StoredMessage> {
    const workerRepo = getWorkerRepository();

    switch (command) {
      case '/worker-list': {
        const tasks = workerRepo.listTasks({ limit: 10 });
        if (tasks.length === 0) {
          return this.sendResponse(
            conversation,
            '📋 Keine Tasks vorhanden.',
            platform,
            externalChatId,
          );
        }
        const lines = tasks.map(
          (t) => `• ${this.statusIcon(t.status)} **${t.title}** (\`${t.id}\`) — ${t.status}`,
        );
        return this.sendResponse(conversation, `📋 **Tasks:**\n${lines.join('\n')}`, platform, externalChatId);
      }

      case '/worker-status': {
        if (!payload) {
          const active = workerRepo.getActiveTask();
          if (!active) {
            const queued = workerRepo.listTasks({ status: 'queued' });
            return this.sendResponse(
              conversation,
              queued.length > 0
                ? `📋 Kein aktiver Task. ${queued.length} in Warteschlange.`
                : '📋 Kein aktiver Task.',
              platform,
              externalChatId,
            );
          }
          return this.sendResponse(
            conversation,
            `⚙️ **${active.title}**\nStatus: ${active.status}\nSchritt: ${active.currentStep}/${active.totalSteps}\nID: \`${active.id}\``,
            platform,
            externalChatId,
          );
        }
        const task = workerRepo.getTask(payload);
        if (!task)
          return this.sendResponse(
            conversation,
            `❌ Task \`${payload}\` nicht gefunden.`,
            platform,
            externalChatId,
          );
        return this.sendResponse(
          conversation,
          `${this.statusIcon(task.status)} **${task.title}**\nStatus: ${task.status}\nSchritt: ${task.currentStep}/${task.totalSteps}${task.resultSummary ? `\n\n${task.resultSummary}` : ''}${task.errorMessage ? `\n\n⚠️ ${task.errorMessage}` : ''}`,
          platform,
          externalChatId,
        );
      }

      case '/worker-cancel': {
        if (!payload)
          return this.sendResponse(
            conversation,
            '⚠️ Bitte Task-ID angeben: `/worker-cancel <id>`',
            platform,
            externalChatId,
          );
        const task = workerRepo.getTask(payload);
        if (!task)
          return this.sendResponse(
            conversation,
            `❌ Task \`${payload}\` nicht gefunden.`,
            platform,
            externalChatId,
          );
        workerRepo.cancelTask(payload);
        return this.sendResponse(
          conversation,
          `🛑 Task "${task.title}" abgebrochen.`,
          platform,
          externalChatId,
        );
      }

      case '/worker-resume': {
        if (!payload)
          return this.sendResponse(
            conversation,
            '⚠️ Bitte Task-ID angeben: `/worker-resume <id>`',
            platform,
            externalChatId,
          );
        const task = workerRepo.getTask(payload);
        if (!task)
          return this.sendResponse(
            conversation,
            `❌ Task \`${payload}\` nicht gefunden.`,
            platform,
            externalChatId,
          );
        if (task.status !== 'interrupted' && task.status !== 'failed') {
          return this.sendResponse(
            conversation,
            `⚠️ Task ist nicht wiederaufnehmbar (Status: ${task.status}).`,
            platform,
            externalChatId,
          );
        }
        workerRepo.updateStatus(payload, 'queued');
        processQueue().catch((err: unknown) => console.error('[Worker] Queue error:', err));
        return this.sendResponse(
          conversation,
          `🔄 Task "${task.title}" wird fortgesetzt.`,
          platform,
          externalChatId,
        );
      }

      case '/worker-retry': {
        if (!payload)
          return this.sendResponse(
            conversation,
            '⚠️ Bitte Task-ID angeben: `/worker-retry <id>`',
            platform,
            externalChatId,
          );
        const task = workerRepo.getTask(payload);
        if (!task)
          return this.sendResponse(
            conversation,
            `❌ Task \`${payload}\` nicht gefunden.`,
            platform,
            externalChatId,
          );
        if (task.status !== 'failed') {
          return this.sendResponse(
            conversation,
            `⚠️ Nur fehlgeschlagene Tasks können wiederholt werden (Status: ${task.status}).`,
            platform,
            externalChatId,
          );
        }
        workerRepo.updateStatus(payload, 'queued');
        processQueue().catch((err: unknown) => console.error('[Worker] Queue error:', err));
        return this.sendResponse(
          conversation,
          `🔄 Task "${task.title}" wird wiederholt.`,
          platform,
          externalChatId,
        );
      }

      case '/approve':
      case '/deny':
      case '/approve-always': {
        if (!payload)
          return this.sendResponse(
            conversation,
            '⚠️ Bitte Task-ID angeben.',
            platform,
            externalChatId,
          );
        const task = workerRepo.getTask(payload);
        if (!task)
          return this.sendResponse(
            conversation,
            `❌ Task \`${payload}\` nicht gefunden.`,
            platform,
            externalChatId,
          );
        if (task.status !== 'waiting_approval') {
          return this.sendResponse(
            conversation,
            '⚠️ Task wartet nicht auf Genehmigung.',
            platform,
            externalChatId,
          );
        }

        if (command === '/deny') {
          workerRepo.saveCheckpoint(payload, { approvalResponse: 'denied' });
          return this.sendResponse(
            conversation,
            '❌ Befehl abgelehnt. Task wird angepasst.',
            platform,
            externalChatId,
          );
        }

        if (command === '/approve-always') {
          const checkpoint = task.lastCheckpoint ? JSON.parse(task.lastCheckpoint) : {};
          if (checkpoint.pendingCommand) {
            workerRepo.addApprovalRule(checkpoint.pendingCommand);
          }
          workerRepo.saveCheckpoint(payload, { approvalResponse: 'approved' });
          return this.sendResponse(
            conversation,
            '✅🔓 Befehl genehmigt und für die Zukunft gespeichert.',
            platform,
            externalChatId,
          );
        }

        workerRepo.saveCheckpoint(payload, { approvalResponse: 'approved' });
        return this.sendResponse(
          conversation,
          '✅ Befehl genehmigt. Worker fährt fort.',
          platform,
          externalChatId,
        );
      }

      default:
        return this.sendResponse(
          conversation,
          `⚠️ Unbekannter Befehl: ${command}`,
          platform,
          externalChatId,
        );
    }
  }

  // ─── AI Dispatch (existing logic) ──────────────────────────

  private async dispatchToAI(
    conversation: Conversation,
    platform: ChannelType,
    externalChatId: string,
  ): Promise<StoredMessage> {
    const messages = this.contextBuilder.buildGatewayMessages(conversation.id, conversation.userId, 50);

    let agentContent: string;
    let gatewayMeta: Record<string, unknown> | undefined;
    try {
      const service = getModelHubService();
      const encryptionKey = getModelHubEncryptionKey();
      const result = await service.dispatchWithFallback('p1', encryptionKey, { messages });

      if (result.ok) {
        agentContent = result.text || 'No response from model.';
        gatewayMeta = {
          provider: result.provider,
          model: result.model,
          usage: result.usage || null,
          ok: true,
        };
      } else {
        agentContent = `⚠️ Gateway error: ${result.error || 'Unknown error'}`;
        gatewayMeta = {
          provider: result.provider,
          model: result.model,
          error: result.error || 'Unknown error',
          ok: false,
        };
      }
    } catch (error) {
      agentContent = `⚠️ ${error instanceof Error ? error.message : 'AI dispatch failed'}`;
      gatewayMeta = {
        ok: false,
        error: error instanceof Error ? error.message : 'AI dispatch failed',
      };
    }

    const agentMsg = this.historyManager.appendAgentMessage(
      conversation.id,
      platform,
      agentContent,
      gatewayMeta,
    );

    getSSEManager().broadcast(
      {
        type: 'message',
        data: agentMsg,
      },
      conversation.userId,
    );

    void this.maybeRefreshConversationSummary(conversation);

    try {
      await deliverOutbound(platform, externalChatId, agentContent);
    } catch (error) {
      console.error(`Outbound delivery failed for ${platform}:`, error);
    }

    return agentMsg;
  }

  // ─── Helper: Send & Broadcast Response ─────────────────────

  private async sendResponse(
    conversation: Conversation,
    content: string,
    platform: ChannelType,
    externalChatId: string,
  ): Promise<StoredMessage> {
    const agentMsg = this.historyManager.appendAgentMessage(conversation.id, platform, content);

    getSSEManager().broadcast({ type: 'message', data: agentMsg }, conversation.userId);

    try {
      await deliverOutbound(platform, externalChatId, content);
    } catch (error) {
      console.error(`Outbound delivery failed for ${platform}:`, error);
    }

    return agentMsg;
  }

  private statusIcon(status: string): string {
    const icons: Record<string, string> = {
      queued: '⏳',
      planning: '📝',
      executing: '⚙️',
      completed: '✅',
      failed: '❌',
      cancelled: '🛑',
      interrupted: '⚡',
      waiting_approval: '⚠️',
      clarifying: '❓',
      review: '🔍',
    };
    return icons[status] || '❔';
  }

  // ─── WebUI Handler ─────────────────────────────────────────

  /**
   * Handle a message from WebUI chat — same flow but conversation is pre-selected.
   */
  async handleWebUIMessage(
    conversationId: string,
    content: string,
    userId?: string,
  ): Promise<{ userMsg: StoredMessage; agentMsg: StoredMessage }> {
    const conversation = this.sessionManager.resolveConversationForWebChat(
      this.repo,
      conversationId,
      userId,
    );

    return this.handleInbound(
      conversation.channelType,
      conversation.externalChatId || 'default',
      content,
      undefined,
      undefined,
      conversation.userId,
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
    userId?: string,
  ): StoredMessage {
    const conversation = userId
      ? this.repo.getConversation(conversationId, this.sessionManager.resolveUserId(userId))
      : this.repo.getConversation(conversationId);

    if (!conversation) {
      throw new Error('Conversation not found for current user.');
    }

    const msg = this.repo.saveMessage({ conversationId, role, content, platform });
    getSSEManager().broadcast({ type: 'message', data: msg }, conversation.userId);
    return msg;
  }

  private async maybeRefreshConversationSummary(conversation: Conversation): Promise<void> {
    if (this.summaryRefreshInFlight.has(conversation.id)) {
      return;
    }

    this.summaryRefreshInFlight.add(conversation.id);
    try {
      const recent = this.repo.listMessages(conversation.id, 200, undefined, conversation.userId);
      if (recent.length === 0) {
        return;
      }

      const existing = this.repo.getConversationContext(conversation.id, conversation.userId);
      const summaryUptoSeq = existing?.summaryUptoSeq ?? 0;
      const lastSeq = recent[recent.length - 1]?.seq ?? 0;

      if (lastSeq - summaryUptoSeq < 20) {
        return;
      }

      const unsummarized = recent.filter(
        (message) => typeof message.seq === 'number' && message.seq > summaryUptoSeq,
      );
      if (unsummarized.length === 0) {
        return;
      }

      const mergedSummary = await this.buildConversationSummary(
        existing?.summaryText || '',
        unsummarized.slice(0, 40).map((message) => ({
          role: message.role,
          content: message.content,
        })),
      );

      if (!mergedSummary) {
        return;
      }

      const uptoSeq = unsummarized[unsummarized.length - 1]?.seq;
      if (typeof uptoSeq !== 'number') {
        return;
      }

      this.repo.upsertConversationContext(
        conversation.id,
        mergedSummary,
        uptoSeq,
        conversation.userId,
      );
    } finally {
      this.summaryRefreshInFlight.delete(conversation.id);
    }
  }

  private async buildConversationSummary(
    previousSummary: string,
    messages: Array<{ role: 'user' | 'agent' | 'system'; content: string }>,
  ): Promise<string> {
    const fallbackSummary = this.buildFallbackSummary(previousSummary, messages);

    if (!this.isAiSummaryEnabled()) {
      return fallbackSummary;
    }

    try {
      const service = getModelHubService();
      const encryptionKey = getModelHubEncryptionKey();
      const summaryMessages = [
        {
          role: 'system' as const,
          content:
            'You summarize a conversation for long-term continuity. Return concise plain text summary only.',
        },
        {
          role: 'user' as const,
          content: [
            'Previous summary:',
            previousSummary || '(none)',
            '',
            'New messages:',
            ...messages.map((message) => `[${message.role}] ${message.content}`),
            '',
            'Task: Write an updated conversation summary in <= 400 words.',
          ].join('\n'),
        },
      ];

      const result = await service.dispatchWithFallback('p1', encryptionKey, {
        messages: summaryMessages,
      });

      if (result.ok && result.text?.trim()) {
        return result.text.trim().slice(-5000);
      }

      return fallbackSummary;
    } catch {
      return fallbackSummary;
    }
  }

  private buildFallbackSummary(
    previousSummary: string,
    messages: Array<{ role: 'user' | 'agent' | 'system'; content: string }>,
  ): string {
    const summaryChunk = messages
      .map((message) => `[${message.role}] ${message.content.replace(/\s+/g, ' ').trim()}`)
      .join(' ')
      .slice(0, 2500);

    if (!summaryChunk) {
      return previousSummary.slice(-5000);
    }

    return previousSummary ? `${previousSummary}\n${summaryChunk}`.slice(-5000) : summaryChunk;
  }

  private isAiSummaryEnabled(): boolean {
    const mode = String(process.env.CHAT_SUMMARY_MODE || 'ai').toLowerCase();
    return mode !== 'fallback' && mode !== 'concat';
  }
}
