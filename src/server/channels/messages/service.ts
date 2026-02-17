import { ChannelType } from '../../../../types';
import type { MessageRepository, StoredMessage, Conversation } from './repository';
import { broadcastToUser } from '../../gateway/broadcast';
import { GatewayEvents } from '../../gateway/events';
import { deliverOutbound } from '../outbound/router';
import { getModelHubService, getModelHubEncryptionKey } from '../../model-hub/runtime';
import { routeMessage } from './messageRouter';
import { getWorkerRepository } from '../../worker/workerRepository';
import { SessionManager } from './sessionManager';
import { HistoryManager } from './historyManager';
import { ContextBuilder } from './contextBuilder';
import { fuseRecallSources } from './recallFusion';
import type { SearchMessagesOptions } from './sqliteMessageRepository';
import { getPersonaRepository } from '../../personas/personaRepository';
import { statusIconForWorker } from './statusIcons';
import { buildFallbackSummary, isAiSummaryEnabled } from './summary';
import {
  applyChannelBindingPersona,
  getChannelBindingPersonaId,
  setChannelBindingPersona,
} from './channelBindingPersona';
import { getMemoryService } from '../../memory/runtime';
import {
  resolveMemoryScopedUserId,
  resolveMemoryUserIdCandidates,
} from '../../memory/userScope';
import { resolveKnowledgeConfig } from '../../knowledge/config';
import { getKnowledgeIngestionService, getKnowledgeRetrievalService } from '../../knowledge/runtime';
import { buildAutoMemoryCandidates, isAutoSessionMemoryEnabled } from './autoMemory';
import type { MemoryFeedbackSignal } from '../../memory/service';
import { getProactiveGateService } from '../../proactive/runtime';
import {
  buildMessageAttachmentMetadata,
  type StoredMessageAttachment,
} from './attachments';
import { loadGatewayConfig } from '../../config/gatewayConfig';
import {
  resolveEnabledOpenAiWorkerToolNamesFromConfig,
  resolveOpenAiWorkerToolApprovalPolicyFromConfig,
  type OpenAiWorkerToolApprovalPolicy,
} from '../../worker/openai/openaiToolRegistry';
import { getOpenAiWorkerClient } from '../../worker/openai/openaiWorkerClient';

function extractMemorySaveContent(content: string): string | null {
  const trimmed = content.trim();
  const prefixMatch = /^speichere\s+ab\b/i.exec(trimmed);
  if (!prefixMatch) return null;

  let remainder = trimmed.slice(prefixMatch[0].length).trimStart();
  if (
    remainder.startsWith(':') ||
    remainder.startsWith('-') ||
    remainder.startsWith('–') ||
    remainder.startsWith('—')
  ) {
    remainder = remainder.slice(1).trimStart();
  }

  return remainder.trim();
}

const MEMORY_CONTEXT_CHAR_LIMIT = 5000;
const MEMORY_RECALL_LIMIT = 10;
const MEMORY_FEEDBACK_WINDOW_MS = 10 * 60 * 1000;
const MODEL_HUB_GATEWAY_PREFIX_RE = /^\[model-hub-gateway[^\]]*\]\s*/i;
const OPENAI_SIDECAR_COOLDOWN_MS = 30_000;
const OPENAI_SIDECAR_UNAVAILABLE_CODES = new Set([
  'ECONNREFUSED',
  'ENOTFOUND',
  'EHOSTUNREACH',
  'ETIMEDOUT',
  'ECONNRESET',
  'UND_ERR_CONNECT_TIMEOUT',
]);

type LastRecallState = {
  personaId: string;
  userId: string;
  nodeIds: string[];
  queriedAt: number;
};

type KnowledgeRetrievalServiceLike = {
  retrieve: (input: {
    userId: string;
    personaId: string;
    conversationId?: string;
    query: string;
  }) => Promise<{ context: string }>;
  shouldTriggerRecall?: (input: {
    userId: string;
    personaId: string;
    query: string;
  }) => Promise<boolean> | boolean;
};

const WORKER_AGENT_MODULE_PATH = ['..', '..', 'worker', 'workerAgent'].join('/');

function triggerWorkerQueue(logContext: string): void {
  void import(WORKER_AGENT_MODULE_PATH)
    .then(({ processQueue }) => processQueue())
    .catch((error: unknown) => console.error(`[Worker] Queue ${logContext}:`, error));
}

function shouldRecallMemoryForInput(content: string): boolean {
  const normalized = content.trim().toLowerCase();
  if (!normalized) return false;
  if (extractMemorySaveContent(normalized) !== null) return false;

  // Always-on recall for meaningful user turns (non-command, non-trivial)
  if (
    /^(ok|okay|danke|thx|merci|hi|hallo|hey|moin|ja|nein|passt|super|top|alles klar|gut)\W*$/i.test(
      normalized,
    )
  ) {
    return false;
  }

  const tokenCount = normalized.split(/\s+/).filter(Boolean).length;
  if (tokenCount <= 2 && !/[?]/.test(normalized)) return false;

  return true;
}

function normalizeMemoryContext(context: string): string | null {
  const trimmed = context.trim();
  if (!trimmed) return null;
  if (trimmed.toLowerCase() === 'no relevant memories found.') return null;
  return trimmed.slice(0, MEMORY_CONTEXT_CHAR_LIMIT);
}

function detectMemoryFeedbackSignal(content: string): MemoryFeedbackSignal | null {
  const normalized = content.trim().toLowerCase();
  if (!normalized) return null;

  if (
    /\b(falsch|stimmt nicht|nicht korrekt|inkorrekt|wrong|incorrect|not true|das ist nicht richtig)\b/i.test(
      normalized,
    )
  ) {
    return 'negative';
  }

  if (/\b(genau|stimmt|korrekt|richtig|exactly|correct|that's right)\b/i.test(normalized)) {
    return 'positive';
  }

  return null;
}

function extractCorrectionContent(content: string): string | null {
  const normalized = content.replace(/\s+/g, ' ').trim();
  if (!normalized) return null;

  const patterns = [
    /\bsondern\s+(.+)$/i,
    /\b(richtig ist|korrekt ist|eigentlich)\s+(.+)$/i,
    /\bfalsch\b\s*[,.:;-]\s*(.+)$/i,
    /^\s*(falsch|nein)\s*[,.:;-]?\s*(.+)$/i,
  ];

  for (const pattern of patterns) {
    const match = pattern.exec(normalized);
    if (!match) continue;
    const candidate = (match[2] || match[1] || '').trim();
    if (candidate.length < 8) continue;
    return candidate;
  }

  return null;
}

function readNodeLikeErrorCode(error: unknown): string | null {
  if (!error || typeof error !== 'object') return null;
  const directCode = (error as { code?: unknown }).code;
  if (typeof directCode === 'string' && directCode.trim().length > 0) {
    return directCode.trim().toUpperCase();
  }
  const cause = (error as { cause?: unknown }).cause;
  if (!cause || typeof cause !== 'object') return null;
  const causeCode = (cause as { code?: unknown }).code;
  if (typeof causeCode === 'string' && causeCode.trim().length > 0) {
    return causeCode.trim().toUpperCase();
  }
  return null;
}

function isOpenAiSidecarUnavailableError(error: unknown): { unavailable: boolean; code: string | null } {
  const code = readNodeLikeErrorCode(error);
  if (code && OPENAI_SIDECAR_UNAVAILABLE_CODES.has(code)) {
    return { unavailable: true, code };
  }

  const message = error instanceof Error ? error.message.toUpperCase() : '';
  if (message.includes('ECONNREFUSED')) {
    return { unavailable: true, code: 'ECONNREFUSED' };
  }

  return { unavailable: false, code };
}

// ─── MessageService ──────────────────────────────────────────

export class MessageService {
  private readonly sessionManager = new SessionManager();
  private readonly historyManager: HistoryManager;
  private readonly contextBuilder: ContextBuilder;
  private readonly summaryRefreshInFlight = new Set<string>();
  /** In-flight AI requests keyed by conversationId — used for abort */
  private readonly activeRequests = new Map<string, AbortController>();
  /** In-memory deduplication guard for active clientMessageIds */
  private readonly processingMessages = new Set<string>();
  /** Tracks last recalled memory nodes per conversation for error-learning feedback */
  private readonly lastRecallByConversation = new Map<string, LastRecallState>();
  /** Cooldown timestamp for skipping sidecar attempts after connection-level failures */
  private openAiSidecarCooldownUntil = 0;

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

  getConversation(conversationId: string, userId?: string): Conversation | null {
    const resolvedUserId = this.sessionManager.resolveUserId(userId);
    return this.repo.getConversation(conversationId, resolvedUserId);
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

  getMessage(messageId: string, userId?: string): StoredMessage | null {
    const resolvedUserId = this.sessionManager.resolveUserId(userId);
    if (this.repo.getMessage) {
      return this.repo.getMessage(messageId, resolvedUserId);
    }
    return null;
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
    clientMessageId?: string,
    attachments?: StoredMessageAttachment[],
  ): Promise<{ userMsg: StoredMessage; agentMsg: StoredMessage; newConversationId?: string }> {
    const conversation = this.sessionManager.getOrCreateConversation(
      this.repo,
      platform,
      externalChatId,
      undefined,
      userId,
    );

    // In-memory deduplication: if this clientMessageId is already being processed, reject
    if (clientMessageId && this.processingMessages.has(clientMessageId)) {
      throw new Error('Duplicate request — already processing');
    }
    if (clientMessageId) this.processingMessages.add(clientMessageId);

    try {
      const userMsg = this.historyManager.appendUserMessage(conversation.id, platform, content, {
        externalMsgId,
        senderName,
        clientMessageId,
        metadata: buildMessageAttachmentMetadata(attachments),
      });

      broadcastToUser(conversation.userId, GatewayEvents.CHAT_MESSAGE, userMsg);

      const route = routeMessage(content);

      // ─── /new or /reset → create fresh conversation ──────
      if (route.target === 'session-command') {
        const newConv = this.repo.createConversation({
          channelType: platform,
          externalChatId: `manual-${userId || 'local'}-${Date.now()}`,
          title: route.payload || undefined,
          userId: conversation.userId,
        });
        const agentMsg = await this.sendResponse(
          conversation,
          `🔄 Neue Konversation erstellt.`,
          platform,
          externalChatId,
        );
        return { userMsg, agentMsg, newConversationId: newConv.id };
      }

      if (route.target === 'worker') {
        return {
          userMsg,
          agentMsg: await this.handleWorkerTask(
            conversation,
            route.payload,
            platform,
            externalChatId,
          ),
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

      if (route.target === 'automation-command') {
        return {
          userMsg,
          agentMsg: await this.handleAutomationCommand(
            conversation,
            route.payload,
            platform,
            externalChatId,
          ),
        };
      }

      if (route.target === 'persona-command') {
        return {
          userMsg,
          agentMsg: await this.handlePersonaCommand(
            conversation,
            route.payload,
            platform,
            externalChatId,
          ),
        };
      }

      // For external channels, auto-apply persona from channel binding
      const effectiveConversation = applyChannelBindingPersona(this.repo, conversation, platform);
      await this.maybeLearnFromFeedback(effectiveConversation, content, platform, externalChatId);
      const memoryContent = extractMemorySaveContent(content);

      if (memoryContent !== null) {
        if (!memoryContent) {
          return {
            userMsg,
            agentMsg: await this.sendResponse(
              effectiveConversation,
              '⚠️ Bitte schreibe nach `Speichere ab:` auch den Inhalt.',
              platform,
              externalChatId,
            ),
          };
        }

        if (!effectiveConversation.personaId) {
          return {
            userMsg,
            agentMsg: await this.sendResponse(
              effectiveConversation,
              '⚠️ Keine Persona aktiv. Bitte zuerst eine Persona wählen, dann `Speichere ab: ...` nutzen.',
              platform,
              externalChatId,
            ),
          };
        }

        try {
          const memoryUserId = resolveMemoryScopedUserId({
            userId: effectiveConversation.userId,
            channelType: platform || effectiveConversation.channelType,
            externalChatId: externalChatId || effectiveConversation.externalChatId || 'default',
          });
          await getMemoryService().store(
            effectiveConversation.personaId,
            'fact',
            memoryContent,
            4,
            memoryUserId,
            {
              subject: 'user',
              sourceRole: 'user',
              sourceType: 'manual_save',
            },
          );
          return {
            userMsg,
            agentMsg: await this.sendResponse(
              effectiveConversation,
              `💾 Gespeichert: ${memoryContent}`,
              platform,
              externalChatId,
            ),
          };
        } catch (error) {
          console.error('Memory store failed:', error);
          return {
            userMsg,
            agentMsg: await this.sendResponse(
              effectiveConversation,
              '⚠️ Memory konnte nicht gespeichert werden.',
              platform,
              externalChatId,
            ),
          };
        }
      }

      return {
        userMsg,
        agentMsg: await this.dispatchToAI(effectiveConversation, platform, externalChatId, content),
      };
    } finally {
      if (clientMessageId) this.processingMessages.delete(clientMessageId);
    }
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

    triggerWorkerQueue('processing error');

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
        const personaRepo = getPersonaRepository();
        const lines = tasks.map((t) => {
          const personaTag = t.assignedPersonaId
            ? (() => {
                const p = personaRepo.getPersona(t.assignedPersonaId);
                return p ? ` → ${p.emoji} ${p.name}` : '';
              })()
            : '';
          return `• ${statusIconForWorker(t.status)} **${t.title}** (\`${t.id}\`) — ${t.status}${personaTag}`;
        });
        return this.sendResponse(
          conversation,
          `📋 **Tasks:**\n${lines.join('\n')}`,
          platform,
          externalChatId,
        );
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
        const personaInfo = (() => {
          if (!task.assignedPersonaId) return '';
          const p = getPersonaRepository().getPersona(task.assignedPersonaId);
          return p ? `\nPersona: ${p.emoji} ${p.name}` : '';
        })();
        return this.sendResponse(
          conversation,
          `${statusIconForWorker(task.status)} **${task.title}**\nStatus: ${task.status}\nSchritt: ${task.currentStep}/${task.totalSteps}${personaInfo}${task.resultSummary ? `\n\n${task.resultSummary}` : ''}${task.errorMessage ? `\n\n⚠️ ${task.errorMessage}` : ''}`,
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
        triggerWorkerQueue('error');
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
        triggerWorkerQueue('error');
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

      case '/worker-assign': {
        if (!payload) {
          return this.sendResponse(
            conversation,
            '⚠️ Bitte Task-ID und Persona-Name angeben: `/worker-assign <task-id> <persona-name>`',
            platform,
            externalChatId,
          );
        }
        const parts = payload.split(/\s+/);
        const taskId = parts[0];
        const personaQuery = parts.slice(1).join(' ');
        if (!personaQuery) {
          return this.sendResponse(
            conversation,
            '⚠️ Bitte Persona-Name angeben: `/worker-assign <task-id> <persona-name>`',
            platform,
            externalChatId,
          );
        }
        const task = workerRepo.getTask(taskId);
        if (!task) {
          return this.sendResponse(
            conversation,
            `❌ Task \`${taskId}\` nicht gefunden.`,
            platform,
            externalChatId,
          );
        }
        // Find persona by name (case-insensitive prefix match)
        const personaRepo = getPersonaRepository();
        const allPersonas = personaRepo.listPersonas('default');
        const match = allPersonas.find(
          (p) =>
            p.name.toLowerCase() === personaQuery.toLowerCase() ||
            p.name.toLowerCase().startsWith(personaQuery.toLowerCase()),
        );
        if (!match) {
          return this.sendResponse(
            conversation,
            `❌ Persona "${personaQuery}" nicht gefunden. Verfügbar: ${allPersonas.map((p) => `${p.emoji} ${p.name}`).join(', ') || '(keine)'}`,
            platform,
            externalChatId,
          );
        }
        workerRepo.assignPersona(taskId, match.id);
        workerRepo.addActivity({
          taskId,
          type: 'persona_assigned',
          message: `Persona ${match.emoji} ${match.name} per Chat-Befehl zugewiesen`,
          metadata: { personaId: match.id, personaName: match.name },
        });
        return this.sendResponse(
          conversation,
          `✅ Persona ${match.emoji} **${match.name}** wurde Task "${task.title}" zugewiesen.`,
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

  // ─── Automation Commands ───────────────────────────────────

  private async handleAutomationCommand(
    conversation: Conversation,
    payload: string,
    platform: ChannelType,
    externalChatId: string,
  ): Promise<StoredMessage> {
    const fullCommand = payload ? `/cron ${payload}` : '/cron';
    const { parseCronCommand } = await import('../../automation/commands');
    const parsed = parseCronCommand(fullCommand);

    const { getAutomationService } = await import('../../automation/runtime');
    const automationService = getAutomationService();

    switch (parsed.action) {
      case 'list': {
        const rules = automationService.listRules(conversation.userId);
        if (rules.length === 0) {
          return this.sendResponse(
            conversation,
            '⏱️ Keine Cron-Regeln vorhanden.\nNutze z. B.: `/cron add "0 10 * * *" --tz "Europe/Berlin" --prompt "Gib mir ein Briefing"`',
            platform,
            externalChatId,
          );
        }

        const lines = rules.map(
          (rule) =>
            `• ${rule.enabled ? '✅' : '⏸️'} **${rule.name}** (\`${rule.id}\`)\n  \`${rule.cronExpression}\` @ ${rule.timezone}\n  next: ${rule.nextRunAt || 'n/a'}`,
        );

        return this.sendResponse(
          conversation,
          `⏱️ **Cron-Regeln:**\n${lines.join('\n')}`,
          platform,
          externalChatId,
        );
      }

      case 'add':
      case 'every': {
        const rule = automationService.createRule({
          userId: conversation.userId,
          name: parsed.name || parsed.prompt.slice(0, 40),
          cronExpression: parsed.cronExpression,
          timezone: parsed.timezone,
          prompt: parsed.prompt,
          enabled: true,
        });

        return this.sendResponse(
          conversation,
          `✅ Cron-Regel erstellt: **${rule.name}**\nID: \`${rule.id}\`\nSchedule: \`${rule.cronExpression}\` (${rule.timezone})\nNächster Lauf: ${rule.nextRunAt || 'n/a'}`,
          platform,
          externalChatId,
        );
      }

      case 'pause': {
        const rule = automationService.updateRule(parsed.ruleId, conversation.userId, {
          enabled: false,
        });
        if (!rule) {
          return this.sendResponse(
            conversation,
            `❌ Regel \`${parsed.ruleId}\` nicht gefunden.`,
            platform,
            externalChatId,
          );
        }
        return this.sendResponse(
          conversation,
          `⏸️ Regel **${rule.name}** pausiert.`,
          platform,
          externalChatId,
        );
      }

      case 'resume': {
        const rule = automationService.updateRule(parsed.ruleId, conversation.userId, {
          enabled: true,
        });
        if (!rule) {
          return this.sendResponse(
            conversation,
            `❌ Regel \`${parsed.ruleId}\` nicht gefunden.`,
            platform,
            externalChatId,
          );
        }
        return this.sendResponse(
          conversation,
          `▶️ Regel **${rule.name}** aktiviert.`,
          platform,
          externalChatId,
        );
      }

      case 'remove': {
        const removed = automationService.deleteRule(parsed.ruleId, conversation.userId);
        if (!removed) {
          return this.sendResponse(
            conversation,
            `❌ Regel \`${parsed.ruleId}\` nicht gefunden.`,
            platform,
            externalChatId,
          );
        }
        return this.sendResponse(
          conversation,
          `🗑️ Regel \`${parsed.ruleId}\` gelöscht.`,
          platform,
          externalChatId,
        );
      }

      case 'run': {
        try {
          const run = automationService.createManualRun(parsed.ruleId, conversation.userId);
          return this.sendResponse(
            conversation,
            `🚀 Manueller Run erstellt: \`${run.id}\` (Regel: \`${run.ruleId}\`).`,
            platform,
            externalChatId,
          );
        } catch (error) {
          const message =
            error instanceof Error ? error.message : 'Run konnte nicht erstellt werden.';
          return this.sendResponse(conversation, `❌ ${message}`, platform, externalChatId);
        }
      }

      case 'unsupported':
      default:
        return this.sendResponse(
          conversation,
          `⚠️ ${parsed.reason}\n\nUnterstützt:\n• /cron list\n• /cron add "<cron>" --tz "<TZ>" --prompt "<Text>"\n• /cron every "10m|1h|1d" --prompt "<Text>"\n• /cron pause <id>\n• /cron resume <id>\n• /cron remove <id>\n• /cron run <id>`,
          platform,
          externalChatId,
        );
    }
  }
  // ─── AI Dispatch (existing logic) ──────────────────────────

  private resolveChatModelRouting(conversation: Conversation): {
    preferredModelId?: string;
    modelHubProfileId: string;
  } {
    let preferredModelId = conversation.modelOverride ?? undefined;
    let modelHubProfileId =
      process.env.OPENAI_WORKER_MODEL_HUB_PROFILE?.trim() ||
      process.env.MODEL_HUB_PROFILE_ID?.trim() ||
      'p1';

    if (conversation.personaId) {
      try {
        const persona = getPersonaRepository().getPersona(conversation.personaId);
        if (!preferredModelId && persona?.preferredModelId) {
          preferredModelId = persona.preferredModelId;
        }
        if (persona?.modelHubProfileId?.trim()) {
          modelHubProfileId = persona.modelHubProfileId.trim();
        }
      } catch {
        // Persona storage should not block model routing.
      }
    }

    return {
      preferredModelId,
      modelHubProfileId,
    };
  }

  private async tryDispatchViaOpenAiSidecar(
    conversation: Conversation,
    platform: ChannelType,
    userInput: string,
    messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }>,
  ): Promise<{ agentContent: string; gatewayMeta: Record<string, unknown> } | null> {
    if (platform !== ChannelType.WEBCHAT) return null;
    if (Date.now() < this.openAiSidecarCooldownUntil) return null;

    let enabledTools: string[] = [];
    let toolApprovalPolicy: OpenAiWorkerToolApprovalPolicy = {
      defaultMode: 'ask_approve',
      byFunctionName: {},
    };
    try {
      const configState = await loadGatewayConfig();
      enabledTools = resolveEnabledOpenAiWorkerToolNamesFromConfig(configState.config);
      toolApprovalPolicy = resolveOpenAiWorkerToolApprovalPolicyFromConfig(
        configState.config,
        enabledTools,
      );
    } catch {
      return null;
    }

    if (enabledTools.length === 0) return null;

    const routing = this.resolveChatModelRouting(conversation);
    const sidecarClient = getOpenAiWorkerClient();
    const toolPolicyMessage = [
      'Tool runtime is enabled for this chat.',
      `Available tool functions: ${enabledTools.join(', ')}.`,
      'Do not claim that tools are unavailable.',
      'If a tool is needed, call the function directly and continue with real results.',
    ].join('\n');
    const messagesWithToolContext: Array<{ role: 'system' | 'user' | 'assistant'; content: string }> = [
      { role: 'system', content: toolPolicyMessage },
      ...messages,
    ];

    try {
      const run = await sidecarClient.startRun({
        taskId: `chat-${conversation.id}-${Date.now()}`,
        title: conversation.title || `Chat ${conversation.id}`,
        objective: userInput,
        userId: conversation.userId,
        personaId: conversation.personaId ?? null,
        preferredModelId: routing.preferredModelId ?? null,
        modelHubProfileId: routing.modelHubProfileId,
        enabledTools,
        messages: messagesWithToolContext,
        toolApprovalPolicy,
      });

      const cleanedOutput = String(run.output || '')
        .replace(MODEL_HUB_GATEWAY_PREFIX_RE, '')
        .trim();

      if (run.status === 'completed') {
        return {
          agentContent: cleanedOutput || 'OpenAI sidecar completed without output.',
          gatewayMeta: {
            ok: true,
            runtime: 'openai-sidecar',
            status: run.status,
            model: routing.preferredModelId || 'auto',
            profileId: routing.modelHubProfileId,
            enabledTools,
          },
        };
      }

      if (run.status === 'approval_required') {
        return {
          agentContent:
            '⏸️ Tool-Ausführung benötigt Genehmigung. Nutze den Worker-Flow für Approval/Resume.',
          gatewayMeta: {
            ok: false,
            runtime: 'openai-sidecar',
            status: run.status,
            approvalToken: run.approvalToken || null,
            model: routing.preferredModelId || 'auto',
            profileId: routing.modelHubProfileId,
            enabledTools,
          },
        };
      }

      return {
        agentContent: cleanedOutput || '⚠️ OpenAI sidecar run failed.',
        gatewayMeta: {
          ok: false,
          runtime: 'openai-sidecar',
          status: run.status,
          model: routing.preferredModelId || 'auto',
          profileId: routing.modelHubProfileId,
          enabledTools,
        },
      };
    } catch (error) {
      const sidecarAvailability = isOpenAiSidecarUnavailableError(error);
      if (sidecarAvailability.unavailable) {
        this.openAiSidecarCooldownUntil = Date.now() + OPENAI_SIDECAR_COOLDOWN_MS;
        console.warn(
          `OpenAI sidecar unavailable (${sidecarAvailability.code || 'connection_error'}). ` +
            `Skipping sidecar dispatch for ${Math.round(OPENAI_SIDECAR_COOLDOWN_MS / 1000)}s and falling back to model hub.`,
        );
        return null;
      }
      console.error('OpenAI sidecar chat dispatch failed, falling back to model hub:', error);
      return null;
    }
  }

  private async dispatchToAI(
    conversation: Conversation,
    platform: ChannelType,
    externalChatId: string,
    userInput: string,
  ): Promise<StoredMessage> {
    const messages = this.contextBuilder.buildGatewayMessages(
      conversation.id,
      conversation.userId,
      50,
      conversation.personaId,
    );

    const memoryContext = await this.buildRecallContext(
      conversation,
      userInput,
      platform,
      externalChatId,
    );
    if (memoryContext) {
      messages.unshift({
        role: 'system',
        content: [
          'Relevant memory context (use this to ground your answers):',
          memoryContext,
          '',
          'Interpretation rules:',
          '- Memories tagged "[Subject: user]" describe the user, not the assistant/persona.',
          '- Never claim user preferences, habits, or facts as your own.',
          '- When the user asks about something mentioned in [Chat History], reference the specific content rather than paraphrasing from later conversation patterns.',
          '- User messages in [Chat History] represent explicit instructions or facts — prioritize them over assistant summaries.',
        ].join('\n'),
      });
    }

    // ─── Abort tracking ──────────────────────────────────
    const abortController = new AbortController();
    this.activeRequests.set(conversation.id, abortController);

    let agentContent: string;
    let gatewayMeta: Record<string, unknown> | undefined;
    try {
      const normalizedMessages = messages.map((message) => ({
        role: message.role,
        content: message.content,
      }));

      const sidecarResult = await this.tryDispatchViaOpenAiSidecar(
        conversation,
        platform,
        userInput,
        normalizedMessages,
      );

      if (sidecarResult) {
        agentContent = sidecarResult.agentContent;
        gatewayMeta = sidecarResult.gatewayMeta;
      } else {
        const service = getModelHubService();
        const encryptionKey = getModelHubEncryptionKey();
        const routing = this.resolveChatModelRouting(conversation);

        const result = await service.dispatchWithFallback(
          routing.modelHubProfileId,
          encryptionKey,
          {
            messages,
            auditContext: {
              kind: 'chat',
              conversationId: conversation.id,
            },
          },
          {
            signal: abortController.signal,
            modelOverride: routing.preferredModelId,
          },
        );

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
      }
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') {
        agentContent = '⚠️ Generation aborted.';
        gatewayMeta = { ok: false, aborted: true };
      } else {
        agentContent = `⚠️ ${error instanceof Error ? error.message : 'AI dispatch failed'}`;
        gatewayMeta = {
          ok: false,
          error: error instanceof Error ? error.message : 'AI dispatch failed',
        };
      }
    } finally {
      this.activeRequests.delete(conversation.id);
    }

    const agentMsg = this.historyManager.appendAgentMessage(
      conversation.id,
      platform,
      agentContent,
      gatewayMeta,
    );

    broadcastToUser(conversation.userId, GatewayEvents.CHAT_MESSAGE, agentMsg);

    void this.maybeRefreshConversationSummary(conversation);

    try {
      await deliverOutbound(platform, externalChatId, agentContent);
    } catch (error) {
      console.error(`Outbound delivery failed for ${platform}:`, error);
    }

    return agentMsg;
  }

  // ─── Abort / Delete / Model Override ───────────────────────

  /**
   * Abort the currently running AI generation for a conversation.
   * Returns true if an active request was found and aborted.
   */
  abortGeneration(conversationId: string): boolean {
    const controller = this.activeRequests.get(conversationId);
    if (!controller) return false;
    controller.abort();
    this.activeRequests.delete(conversationId);
    return true;
  }

  /**
   * Delete a conversation and all its messages.
   * Aborts any in-flight generation first.
   */
  deleteConversation(conversationId: string, userId: string): boolean {
    this.abortGeneration(conversationId);
    this.activeRequests.delete(conversationId);
    this.summaryRefreshInFlight.delete(conversationId);
    return this.repo.deleteConversation(conversationId, userId);
  }

  /**
   * Set or clear a per-session model override.
   */
  setModelOverride(conversationId: string, modelOverride: string | null, userId: string): void {
    this.repo.updateModelOverride(conversationId, modelOverride, userId);
  }

  setPersonaId(conversationId: string, personaId: string | null, userId: string): void {
    this.repo.updatePersonaId(conversationId, personaId, userId);
  }

  // ─── Persona Command Handling ──────────────────────────────

  /**
   * Handle /persona commands from any channel (primarily Telegram/WhatsApp).
   * - /persona list       → show all available personas
   * - /persona <name>     → switch to a persona by name (fuzzy match)
   * - /persona off|clear  → deactivate persona for this channel
   * - /persona            → show current persona + help
   */
  private async handlePersonaCommand(
    conversation: Conversation,
    payload: string,
    platform: ChannelType,
    externalChatId: string,
  ): Promise<StoredMessage> {
    const lower = payload.toLowerCase().trim();

    // Load persona repository
    let personaRepo: ReturnType<typeof getPersonaRepository>;
    try {
      personaRepo = getPersonaRepository();
    } catch {
      return this.sendResponse(
        conversation,
        '⚠️ Persona-System nicht verfügbar.',
        platform,
        externalChatId,
      );
    }

    const personas = personaRepo.listPersonas(conversation.userId);

    // /persona (no args) → show current + help
    if (!lower) {
      const currentPersonaId = getChannelBindingPersonaId(this.repo, conversation.userId, platform);
      const currentPersona = currentPersonaId ? personaRepo.getPersona(currentPersonaId) : null;

      const lines = [
        '🎭 **Persona-System**',
        '',
        currentPersona
          ? `Aktive Persona: ${currentPersona.emoji} **${currentPersona.name}**`
          : 'Keine Persona aktiv (Default-Modus)',
        '',
        '**Befehle:**',
        '`/persona list` — Alle Personas anzeigen',
        '`/persona <Name>` — Persona wechseln',
        '`/persona off` — Persona deaktivieren',
      ];
      return this.sendResponse(conversation, lines.join('\n'), platform, externalChatId);
    }

    // /persona list → list all personas
    if (lower === 'list') {
      if (personas.length === 0) {
        return this.sendResponse(
          conversation,
          '🎭 Keine Personas erstellt.\nErstelle Personas in der WebApp unter "Agent Personas".',
          platform,
          externalChatId,
        );
      }

      const currentPersonaId = getChannelBindingPersonaId(this.repo, conversation.userId, platform);
      const lines = ['🎭 **Verfügbare Personas:**', ''];
      for (const p of personas) {
        const active = p.id === currentPersonaId ? ' ✅' : '';
        const vibe = p.vibe ? ` — _${p.vibe}_` : '';
        lines.push(`${p.emoji} **${p.name}**${vibe}${active}`);
      }
      lines.push('', 'Wechseln: `/persona <Name>`');
      return this.sendResponse(conversation, lines.join('\n'), platform, externalChatId);
    }

    // /persona off|clear|default → deactivate
    if (lower === 'off' || lower === 'clear' || lower === 'default') {
      setChannelBindingPersona(this.repo, conversation.userId, platform, null);
      // Also clear on current conversation
      this.repo.updatePersonaId(conversation.id, null, conversation.userId);
      return this.sendResponse(
        conversation,
        '🎭 Persona deaktiviert. Du chattest jetzt im Default-Modus.',
        platform,
        externalChatId,
      );
    }

    // /persona <name> → fuzzy match by name
    const match = personas.find(
      (p) => p.name.toLowerCase() === lower || p.name.toLowerCase().startsWith(lower),
    );

    if (!match) {
      const available = personas.map((p) => `${p.emoji} ${p.name}`).join(', ');
      return this.sendResponse(
        conversation,
        `⚠️ Persona "${payload}" nicht gefunden.\nVerfügbar: ${available || '(keine)'}`,
        platform,
        externalChatId,
      );
    }

    // Apply persona to channel binding + current conversation
    setChannelBindingPersona(this.repo, conversation.userId, platform, match.id);
    this.repo.updatePersonaId(conversation.id, match.id, conversation.userId);

    return this.sendResponse(
      conversation,
      `🎭 Persona gewechselt: ${match.emoji} **${match.name}**\nAlle neuen Nachrichten in ${platform} nutzen jetzt diese Persona.`,
      platform,
      externalChatId,
    );
  }

  // ─── Helper: Send & Broadcast Response ─────────────────────

  private async sendResponse(
    conversation: Conversation,
    content: string,
    platform: ChannelType,
    externalChatId: string,
  ): Promise<StoredMessage> {
    const agentMsg = this.historyManager.appendAgentMessage(conversation.id, platform, content);

    broadcastToUser(conversation.userId, GatewayEvents.CHAT_MESSAGE, agentMsg);

    try {
      await deliverOutbound(platform, externalChatId, content);
    } catch (error) {
      console.error(`Outbound delivery failed for ${platform}:`, error);
    }

    return agentMsg;
  }

  // ─── WebUI Handler ─────────────────────────────────────────

  /**
   * Handle a message from WebUI chat — same flow but conversation is pre-selected.
   */
  async handleWebUIMessage(
    conversationId: string,
    content: string,
    userId?: string,
    clientMessageId?: string,
    attachments?: StoredMessageAttachment[],
  ): Promise<{ userMsg: StoredMessage; agentMsg: StoredMessage; newConversationId?: string }> {
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
      clientMessageId,
      attachments,
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
    broadcastToUser(conversation.userId, GatewayEvents.CHAT_MESSAGE, msg);
    return msg;
  }

  private async buildRecallContext(
    conversation: Conversation,
    userInput: string,
    platform: ChannelType,
    externalChatId: string,
  ): Promise<string | null> {
    if (!conversation.personaId) {
      this.lastRecallByConversation.delete(conversation.id);
      return null;
    }
    const memoryUserIds = resolveMemoryUserIdCandidates({
      userId: conversation.userId,
      channelType: platform || conversation.channelType,
      externalChatId: externalChatId || conversation.externalChatId || 'default',
    });
    const knowledgeConfig = resolveKnowledgeConfig();
    const knowledgeRetrievalService =
      knowledgeConfig.layerEnabled && knowledgeConfig.retrievalEnabled
        ? (getKnowledgeRetrievalService() as unknown as KnowledgeRetrievalServiceLike)
        : null;

    const shouldRecall = shouldRecallMemoryForInput(userInput);
    if (!shouldRecall) return null;

    // ── Parallel recall from all three sources ────────────────
    const [knowledgeResult, memoryResult, chatResult] = await Promise.allSettled([
      this.recallFromKnowledge(knowledgeRetrievalService, memoryUserIds, conversation, userInput),
      this.recallFromMemory(memoryUserIds, conversation, userInput),
      this.recallFromChat(conversation, userInput),
    ]);

    const knowledgeContext =
      knowledgeResult.status === 'fulfilled' ? knowledgeResult.value : null;
    const memoryContext =
      memoryResult.status === 'fulfilled' ? memoryResult.value : null;
    const chatHits =
      chatResult.status === 'fulfilled' ? chatResult.value : [];

    const fused = fuseRecallSources({
      knowledge: knowledgeContext,
      memory: memoryContext,
      chatHits,
    });

    return fused;
  }

  /** Recall from Knowledge Layer (episodes / meeting ledger). */
  private async recallFromKnowledge(
    service: KnowledgeRetrievalServiceLike | null,
    memoryUserIds: string[],
    conversation: Conversation,
    userInput: string,
  ): Promise<string | null> {
    if (!service) return null;
    for (const userIdCandidate of memoryUserIds) {
      try {
        const result = await service.retrieve({
          userId: userIdCandidate,
          personaId: conversation.personaId!,
          conversationId: conversation.id,
          query: userInput,
        });
        const normalized = normalizeMemoryContext(result.context || '');
        if (normalized) return normalized;
      } catch (error) {
        console.error('Knowledge recall failed:', error);
      }
    }
    return null;
  }

  /** Recall from Mem0 semantic memory. */
  private async recallFromMemory(
    memoryUserIds: string[],
    conversation: Conversation,
    userInput: string,
  ): Promise<string | null> {
    for (const userIdCandidate of memoryUserIds) {
      try {
        const recalled = await getMemoryService().recallDetailed(
          conversation.personaId!,
          userInput,
          MEMORY_RECALL_LIMIT,
          userIdCandidate,
        );
        if (recalled.matches.length > 0) {
          this.lastRecallByConversation.set(conversation.id, {
            personaId: conversation.personaId!,
            userId: userIdCandidate,
            nodeIds: recalled.matches.map((entry) => entry.node.id),
            queriedAt: Date.now(),
          });
        }
        const normalized = normalizeMemoryContext(recalled.context);
        if (normalized) return normalized;
      } catch (error) {
        console.error('Memory recall failed:', error);
      }
    }
    return null;
  }

  /** Recall from FTS5 full-text search on chat messages (persona-scoped). */
  private recallFromChat(
    conversation: Conversation,
    userInput: string,
  ): StoredMessage[] {
    if (!this.repo.searchMessages) return [];
    try {
      const inputNorm = userInput.trim().toLowerCase().replace(/[?.!]+$/, '');
      // Overfetch generously to survive duplicate flooding from repeated queries
      const raw = this.repo.searchMessages(userInput, {
        userId: conversation.userId,
        personaId: conversation.personaId ?? undefined,
        limit: 50,
      } as SearchMessagesOptions);

      const filtered = raw
        .filter((m) => {
          // Exclude messages that are (near-)exact duplicates of the current query
          const content = m.content.trim().toLowerCase().replace(/[?.!]+$/, '');
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

  private async maybeLearnFromFeedback(
    conversation: Conversation,
    userInput: string,
    platform: ChannelType,
    externalChatId: string,
  ): Promise<void> {
    if (!conversation.personaId) return;

    const feedback = detectMemoryFeedbackSignal(userInput);
    if (!feedback) return;

    const state = this.lastRecallByConversation.get(conversation.id);
    if (!state) return;
    if (state.personaId !== conversation.personaId) return;
    if (Date.now() - state.queriedAt > MEMORY_FEEDBACK_WINDOW_MS) {
      this.lastRecallByConversation.delete(conversation.id);
      return;
    }

    try {
      const memoryUserId =
        state.userId ||
        resolveMemoryScopedUserId({
          userId: conversation.userId,
          channelType: platform || conversation.channelType,
          externalChatId: externalChatId || conversation.externalChatId || 'default',
        });
      await getMemoryService().registerFeedback(
        conversation.personaId,
        state.nodeIds,
        feedback,
        memoryUserId,
      );

      if (feedback === 'negative') {
        const correction = extractCorrectionContent(userInput);
        if (correction) {
          await getMemoryService().store(
            conversation.personaId,
            'fact',
            correction,
            5,
            memoryUserId,
            {
              subject: 'user',
              sourceRole: 'user',
              sourceType: 'feedback_correction',
            },
          );
        }
      }
    } catch (error) {
      console.error('Memory feedback learning failed:', error);
    } finally {
      this.lastRecallByConversation.delete(conversation.id);
    }
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
      const summarizationChunk = unsummarized.slice(0, 40);

      const mergedSummary = await this.buildConversationSummary(
        existing?.summaryText || '',
        summarizationChunk.map((message) => ({
          role: message.role,
          content: message.content,
        })),
        conversation.id,
      );

      if (!mergedSummary) {
        return;
      }

      const uptoSeq = summarizationChunk[summarizationChunk.length - 1]?.seq;
      if (typeof uptoSeq !== 'number') {
        return;
      }

      this.repo.upsertConversationContext(
        conversation.id,
        mergedSummary,
        uptoSeq,
        conversation.userId,
      );

      await this.maybeStoreAutoSessionMemory(conversation, summarizationChunk);
      await this.maybeStoreKnowledgeArtifacts(conversation, summarizationChunk, mergedSummary);
      await this.maybeEvaluateProactiveGate(conversation, summarizationChunk);
    } finally {
      this.summaryRefreshInFlight.delete(conversation.id);
    }
  }

  private async maybeStoreAutoSessionMemory(
    conversation: Conversation,
    messages: StoredMessage[],
  ): Promise<void> {
    if (!conversation.personaId) return;
    if (!isAutoSessionMemoryEnabled()) return;

    const candidates = buildAutoMemoryCandidates(messages);
    if (candidates.length === 0) return;
    const memoryUserId = resolveMemoryScopedUserId({
      userId: conversation.userId,
      channelType: conversation.channelType,
      externalChatId: conversation.externalChatId || 'default',
    });

    for (const candidate of candidates) {
      try {
        await getMemoryService().store(
          conversation.personaId,
          candidate.type,
          candidate.content,
          candidate.importance,
          memoryUserId,
          {
            subject: 'user',
            sourceRole: 'user',
            sourceType: 'auto_session',
          },
        );
      } catch (error) {
        console.error('Auto session memory store failed:', error);
      }
    }
  }

  private async maybeStoreKnowledgeArtifacts(
    conversation: Conversation,
    messages: StoredMessage[],
    mergedSummary: string,
  ): Promise<void> {
    if (!conversation.personaId) return;
    if (messages.length === 0) return;

    const knowledgeConfig = resolveKnowledgeConfig();
    if (!knowledgeConfig.layerEnabled) return;
    if (!knowledgeConfig.episodeEnabled && !knowledgeConfig.ledgerEnabled) return;

    try {
      await getKnowledgeIngestionService().ingestConversationWindow({
        conversationId: conversation.id,
        userId: resolveMemoryScopedUserId({
          userId: conversation.userId,
          channelType: conversation.channelType,
          externalChatId: conversation.externalChatId || 'default',
        }),
        personaId: conversation.personaId,
        messages,
        summaryText: mergedSummary,
      });
    } catch (error) {
      console.error('Knowledge ingestion failed:', error);
    }
  }

  private async maybeEvaluateProactiveGate(
    conversation: Conversation,
    messages: StoredMessage[],
  ): Promise<void> {
    if (!conversation.personaId) return;
    if (messages.length === 0) return;

    try {
      const service = getProactiveGateService();
      service.ingestMessages(
        conversation.userId,
        conversation.personaId,
        messages.map((message) => ({
          role: message.role,
          content: message.content,
          createdAt: message.createdAt,
        })),
      );
      service.evaluate(conversation.userId, conversation.personaId);
    } catch (error) {
      console.error('Proactive gate evaluation failed:', error);
    }
  }

  private async buildConversationSummary(
    previousSummary: string,
    messages: Array<{ role: 'user' | 'agent' | 'system'; content: string }>,
    conversationId: string,
  ): Promise<string> {
    const fallbackSummary = buildFallbackSummary(previousSummary, messages);

    if (!isAiSummaryEnabled()) {
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
        auditContext: {
          kind: 'summary',
          conversationId,
        },
      });

      if (result.ok && result.text?.trim()) {
        return result.text.trim().slice(-5000);
      }

      return fallbackSummary;
    } catch {
      return fallbackSummary;
    }
  }
}
