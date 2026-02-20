import crypto from 'node:crypto';
import { ChannelType } from '../../../../types';
import type { Skill } from '../../../../types';
import type { MessageRepository, StoredMessage, Conversation } from './repository';
import { broadcastToUser } from '../../gateway/broadcast';
import { GatewayEvents } from '../../gateway/events';
import { deliverOutbound } from '../outbound/router';
import { getModelHubService, getModelHubEncryptionKey } from '../../model-hub/runtime';
import { routeMessage } from './messageRouter';
import { SessionManager } from './sessionManager';
import { HistoryManager } from './historyManager';
import { ContextBuilder } from './contextBuilder';
import { fuseRecallSources } from './recallFusion';
import type { SearchMessagesOptions } from './sqliteMessageRepository';
import { getPersonaRepository } from '../../personas/personaRepository';
import { buildFallbackSummary, isAiSummaryEnabled } from './summary';
import {
  applyChannelBindingPersona,
  getChannelBindingPersonaId,
  setChannelBindingPersona,
} from './channelBindingPersona';
import { getMemoryService } from '../../memory/runtime';
import { resolveMemoryScopedUserId, resolveMemoryUserIdCandidates } from '../../memory/userScope';
import { resolveKnowledgeConfig } from '../../knowledge/config';
import {
  getKnowledgeIngestionService,
  getKnowledgeRetrievalService,
} from '../../knowledge/runtime';
import { buildAutoMemoryCandidates, isAutoSessionMemoryEnabled } from './autoMemory';
import type { MemoryFeedbackSignal } from '../../memory/service';
import { getProactiveGateService } from '../../proactive/runtime';
import { buildMessageAttachmentMetadata, type StoredMessageAttachment } from './attachments';
import { mapSkillsToTools } from '../../../../skills/definitions';
import { getSkillRepository } from '../../skills/skillRepository';
import { approveCommand, isCommandApproved } from '../../gateway/exec-approval-manager';
import { evaluateNodeCommandPolicy } from '../../gateway/node-command-policy';
import {
  abortSubagentRun,
  attachSubagentRuntime,
  completeSubagentRun,
  countActiveSubagentRuns,
  createSubagentRun,
  detachSubagentRuntime,
  failSubagentRun,
  listActiveSubagentRuns,
  listSubagentRunsForConversation,
  markSubagentRunKilled,
  replaceSubagentRun,
  type SubagentRunRecord,
} from '../../agents/subagentRegistry';

function extractMemorySaveContent(content: string): string | null {
  const trimmed = content.trim();
  const prefixMatch = /^speichere\s+ab\b/i.exec(trimmed);
  if (!prefixMatch) return null;

  let remainder = trimmed.slice(prefixMatch[0].length).trimStart();
  if (
    remainder.startsWith(':') ||
    remainder.startsWith('-') ||
    remainder.startsWith('â€“') ||
    remainder.startsWith('â€”')
  ) {
    remainder = remainder.slice(1).trimStart();
  }

  return remainder.trim();
}

const MEMORY_CONTEXT_CHAR_LIMIT = 5000;
const MEMORY_RECALL_LIMIT = 10;
const MEMORY_FEEDBACK_WINDOW_MS = 10 * 60 * 1000;
const MODEL_HUB_GATEWAY_PREFIX_RE = /^\[model-hub-gateway[^\]]*\]\s*/i;
const MAX_TOOL_ROUNDS = 3;
const TOOL_OUTPUT_MAX_CHARS = 12_000;
const TOOL_APPROVAL_TTL_MS = 30 * 60 * 1000;
const SUBAGENT_RECENT_MINUTES = 60;
const SUBAGENT_DEFAULT_AGENT_ID = 'worker';
const SUBAGENT_MAX_ACTIVE_PER_CONVERSATION = 5;
const SUBAGENT_RESULT_PREVIEW_MAX_CHARS = 1200;
const SUBAGENT_ANNOUNCE_MAX_CHARS = 3000;

type LastRecallState = {
  personaId: string;
  userId: string;
  nodeIds: string[];
  queriedAt: number;
};

type ToolExecutionResult =
  | { kind: 'ok'; output: string }
  | { kind: 'error'; output: string }
  | { kind: 'approval_required'; prompt: string; pending: PendingToolApproval };

type ResolvedToolContext = {
  tools: unknown[];
  installedFunctionNames: Set<string>;
  functionToSkillId: Map<string, string>;
};

type PendingToolApproval = {
  token: string;
  userId: string;
  conversationId: string;
  platform: ChannelType;
  externalChatId: string;
  toolFunctionName: string;
  toolId?: string;
  args: Record<string, unknown>;
  command?: string;
  createdAtMs: number;
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

type SubagentAction = 'list' | 'spawn' | 'kill' | 'steer' | 'log' | 'info' | 'help';

type SubagentDispatchContext = {
  conversation: Conversation;
  platform: ChannelType;
  externalChatId: string;
};

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

function inferShellCommandFromNaturalLanguage(content: string): string | null {
  const normalized = content.trim().toLowerCase();
  if (!normalized) return null;

  const asksFileCount =
    ((/\bwie viele\b/.test(normalized) && /\bdatei(?:en)?\b/.test(normalized)) ||
      (/\bhow many\b/.test(normalized) && /\bfiles?\b/.test(normalized))) &&
    /\bdesktop\b/.test(normalized);

  if (asksFileCount) {
    if (process.platform === 'win32') {
      return "$desktop=[Environment]::GetFolderPath('Desktop'); (Get-ChildItem -LiteralPath $desktop -Force -File | Measure-Object).Count";
    }
    return 'if [ -d "$HOME/Desktop" ]; then find "$HOME/Desktop" -maxdepth 1 -type f | wc -l; else echo 0; fi';
  }

  return null;
}

// --- MessageService ------------------------------------------

export class MessageService {
  private readonly sessionManager = new SessionManager();
  private readonly historyManager: HistoryManager;
  private readonly contextBuilder: ContextBuilder;
  private readonly summaryRefreshInFlight = new Set<string>();
  /** In-flight AI requests keyed by conversationId â€” used for abort */
  private readonly activeRequests = new Map<string, AbortController>();
  /** In-memory deduplication guard for active clientMessageIds */
  private readonly processingMessages = new Set<string>();
  /** Tracks last recalled memory nodes per conversation for error-learning feedback */
  private readonly lastRecallByConversation = new Map<string, LastRecallState>();
  /** Pending interactive tool approvals keyed by approval token */
  private readonly pendingToolApprovals = new Map<string, PendingToolApproval>();

  constructor(private readonly repo: MessageRepository) {
    this.historyManager = new HistoryManager(repo);
    this.contextBuilder = new ContextBuilder(repo);
  }

  // --- Conversation Management --------------------------------

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

  // --- Core: Handle Inbound Message --------------------------

  /**
   * Handles a message arriving from any channel (WebUI, Telegram, WhatsApp, etc.)
   * Routes through messageRouter:
   *  - legacy worker commands ? show deprecation notice
   *  - Everything else ? normal AI chat
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
    onStreamDelta?: (delta: string) => void,
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
      throw new Error('Duplicate request â€” already processing');
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

      // --- /new or /reset ? create fresh conversation ------
      if (route.target === 'session-command') {
        const newConv = this.repo.createConversation({
          channelType: platform,
          externalChatId: `manual-${userId || 'local'}-${Date.now()}`,
          title: route.payload || undefined,
          userId: conversation.userId,
        });
        const agentMsg = await this.sendResponse(
          conversation,
          `?? Neue Konversation erstellt.`,
          platform,
          externalChatId,
        );
        return { userMsg, agentMsg, newConversationId: newConv.id };
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

      if (route.target === 'shell-command') {
        return {
          userMsg,
          agentMsg: await this.handleShellCommand(
            conversation,
            route.payload,
            platform,
            externalChatId,
          ),
        };
      }

      if (route.target === 'subagent-command') {
        return {
          userMsg,
          agentMsg: await this.handleSubagentCommand(
            {
              conversation,
              platform,
              externalChatId,
            },
            route.payload,
            route.command,
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
              '?? Bitte schreibe nach `Speichere ab:` auch den Inhalt.',
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
              '?? Keine Persona aktiv. Bitte zuerst eine Persona wÃ¤hlen, dann `Speichere ab: ...` nutzen.',
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
              `?? Gespeichert: ${memoryContent}`,
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
              '?? Memory konnte nicht gespeichert werden.',
              platform,
              externalChatId,
            ),
          };
        }
      }

      const inferredShellCommand = inferShellCommandFromNaturalLanguage(content);
      if (inferredShellCommand) {
        return {
          userMsg,
          agentMsg: await this.handleInferredShellQuestion({
            conversation: effectiveConversation,
            platform,
            externalChatId,
            userInput: content,
            command: inferredShellCommand,
            onStreamDelta,
          }),
        };
      }

      return {
        userMsg,
        agentMsg: await this.dispatchToAI(
          effectiveConversation,
          platform,
          externalChatId,
          content,
          onStreamDelta,
        ),
      };
    } finally {
      if (clientMessageId) this.processingMessages.delete(clientMessageId);
    }
  }

  // --- Automation Commands Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬

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
            'Ã¢ÂÂ±Ã¯Â¸Â Keine Cron-Regeln vorhanden.\nNutze z. B.: `/cron add "0 10 * * *" --tz "Europe/Berlin" --prompt "Gib mir ein Briefing"`',
            platform,
            externalChatId,
          );
        }

        const lines = rules.map(
          (rule) =>
            `Ã¢â‚¬Â¢ ${rule.enabled ? 'Ã¢Å“â€¦' : 'Ã¢ÂÂ¸Ã¯Â¸Â'} **${rule.name}** (\`${rule.id}\`)\n  \`${rule.cronExpression}\` @ ${rule.timezone}\n  next: ${rule.nextRunAt || 'n/a'}`,
        );

        return this.sendResponse(
          conversation,
          `Ã¢ÂÂ±Ã¯Â¸Â **Cron-Regeln:**\n${lines.join('\n')}`,
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
          `Ã¢Å“â€¦ Cron-Regel erstellt: **${rule.name}**\nID: \`${rule.id}\`\nSchedule: \`${rule.cronExpression}\` (${rule.timezone})\nNÃƒÂ¤chster Lauf: ${rule.nextRunAt || 'n/a'}`,
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
            `Ã¢ÂÅ’ Regel \`${parsed.ruleId}\` nicht gefunden.`,
            platform,
            externalChatId,
          );
        }
        return this.sendResponse(
          conversation,
          `Ã¢ÂÂ¸Ã¯Â¸Â Regel **${rule.name}** pausiert.`,
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
            `Ã¢ÂÅ’ Regel \`${parsed.ruleId}\` nicht gefunden.`,
            platform,
            externalChatId,
          );
        }
        return this.sendResponse(
          conversation,
          `Ã¢â€“Â¶Ã¯Â¸Â Regel **${rule.name}** aktiviert.`,
          platform,
          externalChatId,
        );
      }

      case 'remove': {
        const removed = automationService.deleteRule(parsed.ruleId, conversation.userId);
        if (!removed) {
          return this.sendResponse(
            conversation,
            `Ã¢ÂÅ’ Regel \`${parsed.ruleId}\` nicht gefunden.`,
            platform,
            externalChatId,
          );
        }
        return this.sendResponse(
          conversation,
          `Ã°Å¸â€”â€˜Ã¯Â¸Â Regel \`${parsed.ruleId}\` gelÃƒÂ¶scht.`,
          platform,
          externalChatId,
        );
      }

      case 'run': {
        try {
          const run = automationService.createManualRun(parsed.ruleId, conversation.userId);
          return this.sendResponse(
            conversation,
            `Ã°Å¸Å¡â‚¬ Manueller Run erstellt: \`${run.id}\` (Regel: \`${run.ruleId}\`).`,
            platform,
            externalChatId,
          );
        } catch (error) {
          const message =
            error instanceof Error ? error.message : 'Run konnte nicht erstellt werden.';
          return this.sendResponse(conversation, `Ã¢ÂÅ’ ${message}`, platform, externalChatId);
        }
      }

      case 'unsupported':
      default:
        return this.sendResponse(
          conversation,
          `Ã¢Å¡Â Ã¯Â¸Â ${parsed.reason}\n\nUnterstÃƒÂ¼tzt:\nÃ¢â‚¬Â¢ /cron list\nÃ¢â‚¬Â¢ /cron add "<cron>" --tz "<TZ>" --prompt "<Text>"\nÃ¢â‚¬Â¢ /cron every "10m|1h|1d" --prompt "<Text>"\nÃ¢â‚¬Â¢ /cron pause <id>\nÃ¢â‚¬Â¢ /cron resume <id>\nÃ¢â‚¬Â¢ /cron remove <id>\nÃ¢â‚¬Â¢ /cron run <id>`,
          platform,
          externalChatId,
        );
    }
  }
  // Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬ AI Dispatch (existing logic) Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬

  private buildApprovalMetadata(
    pending: PendingToolApproval,
    prompt: string,
    extra: Record<string, unknown> = {},
  ): Record<string, unknown> {
    return {
      ...extra,
      status: 'approval_required',
      approvalToken: pending.token,
      approval_token: pending.token,
      approvalPrompt: prompt,
      approval_prompt: prompt,
      approvalToolId: pending.toolId || null,
      approvalToolFunction: pending.toolFunctionName,
    };
  }

  private async ensureShellSkillInstalled(): Promise<void> {
    const skillRepo = await getSkillRepository();
    const repoLike = skillRepo as Partial<{
      getSkill: (id: string) => { id: string; installed: boolean } | null;
      setInstalled: (id: string, installed: boolean) => boolean;
    }>;

    if (typeof repoLike.getSkill !== 'function' || typeof repoLike.setInstalled !== 'function') {
      return;
    }

    const requiredSkills = ['shell-access', 'subagents'];
    for (const skillId of requiredSkills) {
      const skill = repoLike.getSkill.call(skillRepo, skillId);
      if (skill && !skill.installed) {
        repoLike.setInstalled.call(skillRepo, skill.id, true);
      }
    }
  }

  private async handleShellCommand(
    conversation: Conversation,
    payload: string,
    platform: ChannelType,
    externalChatId: string,
  ): Promise<StoredMessage> {
    const command = String(payload || '').trim();
    if (!command) {
      return this.sendResponse(
        conversation,
        'Bitte nutze /shell <command> oder !<command>.',
        platform,
        externalChatId,
      );
    }

    await this.ensureShellSkillInstalled();
    const toolContext = await this.resolveToolContext();
    const installedFunctions = new Set(toolContext.installedFunctionNames);
    installedFunctions.add('shell_execute');

    const toolExecution = await this.executeToolFunctionCall({
      conversation,
      platform,
      externalChatId,
      functionName: 'shell_execute',
      args: { command },
      installedFunctions,
      toolId: toolContext.functionToSkillId.get('shell_execute') || 'shell-access',
    });

    if (toolExecution.kind === 'approval_required') {
      return this.sendResponse(
        conversation,
        toolExecution.prompt,
        platform,
        externalChatId,
        this.buildApprovalMetadata(toolExecution.pending, toolExecution.prompt, {
          ok: false,
          runtime: 'chat-shell-command',
        }),
      );
    }

    const message =
      toolExecution.kind === 'ok'
        ? `CLI command completed:\n${toolExecution.output}`
        : `CLI command failed:\n${toolExecution.output}`;

    return this.sendResponse(conversation, message, platform, externalChatId, {
      ok: toolExecution.kind === 'ok',
      runtime: 'chat-shell-command',
      tool: 'shell_execute',
      command,
    });
  }

  private getSubagentMaxActivePerConversation(): number {
    const raw = Number.parseInt(String(process.env.SUBAGENT_MAX_ACTIVE || ''), 10);
    if (!Number.isFinite(raw) || raw <= 0) {
      return SUBAGENT_MAX_ACTIVE_PER_CONVERSATION;
    }
    return Math.max(1, Math.min(20, raw));
  }

  private parseSubagentAction(
    payload: string,
    command?: string,
  ): { action: SubagentAction; args: string[] } {
    const normalizedCommand = (command || '').trim().toLowerCase();
    const tokens = payload
      .trim()
      .split(/\s+/)
      .map((value) => value.trim())
      .filter(Boolean);

    if (normalizedCommand === '/kill') {
      return { action: 'kill', args: tokens };
    }
    if (normalizedCommand === '/steer') {
      return { action: 'steer', args: tokens };
    }

    if (tokens.length === 0) {
      return { action: 'list', args: [] };
    }

    const first = tokens[0].toLowerCase();
    const args = tokens.slice(1);
    if (
      first === 'list' ||
      first === 'spawn' ||
      first === 'kill' ||
      first === 'steer' ||
      first === 'log' ||
      first === 'info' ||
      first === 'help'
    ) {
      return { action: first as SubagentAction, args };
    }

    // "/subagents <id>" falls back to info for convenience.
    return { action: 'info', args: tokens };
  }

  private formatSubagentList(conversationId: string): string {
    const runs = listSubagentRunsForConversation(conversationId, SUBAGENT_RECENT_MINUTES);
    const lines: string[] = [];
    lines.push('Subagents');
    lines.push('');
    lines.push('active:');
    if (runs.active.length === 0) {
      lines.push('(none)');
    } else {
      runs.active.forEach((run, index) => {
        lines.push(`${index + 1}. ${run.agentId} (${run.runId.slice(0, 8)}) - running`);
      });
    }
    lines.push('');
    lines.push(`recent (last ${SUBAGENT_RECENT_MINUTES}m):`);
    if (runs.recent.length === 0) {
      lines.push('(none)');
    } else {
      runs.recent.forEach((run, index) => {
        const status = run.status;
        const preview = (run.resultPreview || run.error || '').trim();
        const suffix = preview ? ` - ${preview.slice(0, 80)}` : '';
        lines.push(`${index + 1}. ${run.agentId} (${run.runId.slice(0, 8)}) - ${status}${suffix}`);
      });
    }
    return lines.join('\n');
  }

  private resolveSubagentTarget(
    conversationId: string,
    rawTarget: string,
  ): { run: SubagentRunRecord | null; error?: string } {
    const target = rawTarget.trim();
    if (!target) {
      return { run: null, error: 'Missing subagent target.' };
    }

    const runs = listSubagentRunsForConversation(conversationId, SUBAGENT_RECENT_MINUTES);
    const ordered = [...runs.active, ...runs.recent];

    const numberMatch = /^#?(\d+)$/.exec(target);
    if (numberMatch) {
      const index = Number.parseInt(numberMatch[1], 10);
      if (!Number.isFinite(index) || index < 1 || index > ordered.length) {
        return { run: null, error: `Unknown target ${target}.` };
      }
      return { run: ordered[index - 1] || null };
    }

    const normalized = target.toLowerCase();
    const exact = ordered.find((run) => run.runId.toLowerCase() === normalized);
    if (exact) return { run: exact };

    const byPrefix = ordered.find((run) => run.runId.toLowerCase().startsWith(normalized));
    if (byPrefix) return { run: byPrefix };

    const byAgent = ordered.find((run) => run.agentId.toLowerCase() === normalized);
    if (byAgent) return { run: byAgent };

    return { run: null, error: `Unknown target ${target}.` };
  }

  private filterToolContextForSubagent(toolContext: ResolvedToolContext): ResolvedToolContext {
    const filteredTools = toolContext.tools.filter((tool) => {
      if (!tool || typeof tool !== 'object') return true;
      const entry = tool as { function?: { name?: unknown }; name?: unknown };
      const functionName =
        typeof entry.function?.name === 'string'
          ? entry.function.name
          : typeof entry.name === 'string'
            ? entry.name
            : '';
      return functionName !== 'subagents';
    });

    const installedFunctionNames = new Set(toolContext.installedFunctionNames);
    installedFunctionNames.delete('subagents');

    const functionToSkillId = new Map(toolContext.functionToSkillId);
    functionToSkillId.delete('subagents');

    return {
      tools: filteredTools,
      installedFunctionNames,
      functionToSkillId,
    };
  }

  private async runSubagent(params: {
    conversation: Conversation;
    platform: ChannelType;
    externalChatId: string;
    run: SubagentRunRecord;
  }): Promise<void> {
    const { conversation, platform, externalChatId, run } = params;
    const abortController = new AbortController();
    attachSubagentRuntime(run.runId, { abortController });

    try {
      const routing = this.resolveChatModelRouting(conversation);
      const toolContext = this.filterToolContextForSubagent(await this.resolveToolContext());
      const preferredModelId = run.modelOverride || routing.preferredModelId;
      const messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }> = [
        {
          role: 'system',
          content:
            'You are a focused subagent. Solve only the delegated task and return concise, factual results.',
        },
        {
          role: 'user',
          content: run.guidance
            ? `${run.task}\n\nAdditional guidance from requester:\n${run.guidance}`
            : run.task,
        },
      ];

      const modelOutcome = await this.runModelToolLoop({
        conversation,
        messages,
        modelHubProfileId: routing.modelHubProfileId,
        preferredModelId,
        toolContext,
        abortSignal: abortController.signal,
      });

      const preview = (modelOutcome.content || '')
        .trim()
        .slice(0, SUBAGENT_RESULT_PREVIEW_MAX_CHARS);
      completeSubagentRun(run.runId, preview);

      const announceContent = [
        `Subagent ${run.agentId} finished (${run.runId.slice(0, 8)}).`,
        '',
        preview || '(empty response)',
      ].join('\n');

      await this.sendResponse(
        conversation,
        announceContent.slice(0, SUBAGENT_ANNOUNCE_MAX_CHARS),
        platform,
        externalChatId,
        {
          runtime: 'subagent',
          subagentStatus: 'completed',
          subagentRunId: run.runId,
          subagentAgentId: run.agentId,
        },
      );
    } catch (error) {
      const message =
        error instanceof Error && error.name === 'AbortError'
          ? 'Subagent run aborted.'
          : error instanceof Error
            ? error.message
            : String(error);
      failSubagentRun(run.runId, message);
      if (message !== 'Subagent run aborted.') {
        await this.sendResponse(
          conversation,
          `Subagent ${run.agentId} failed (${run.runId.slice(0, 8)}): ${message}`,
          platform,
          externalChatId,
          {
            runtime: 'subagent',
            subagentStatus: 'error',
            subagentRunId: run.runId,
            subagentAgentId: run.agentId,
          },
        );
      }
    } finally {
      detachSubagentRuntime(run.runId);
    }
  }

  private async startSubagentRun(params: {
    conversation: Conversation;
    platform: ChannelType;
    externalChatId: string;
    agentId: string;
    task: string;
    guidance?: string;
    modelOverride?: string;
  }): Promise<SubagentRunRecord> {
    const active = countActiveSubagentRuns(params.conversation.id);
    const maxActive = this.getSubagentMaxActivePerConversation();
    if (active >= maxActive) {
      throw new Error(`Subagent limit reached (${active}/${maxActive}).`);
    }

    const run = createSubagentRun({
      requesterConversationId: params.conversation.id,
      requesterUserId: params.conversation.userId,
      agentId: params.agentId,
      task: params.task,
      guidance: params.guidance,
      modelOverride: params.modelOverride,
    });

    void this.runSubagent({
      conversation: params.conversation,
      platform: params.platform,
      externalChatId: params.externalChatId,
      run,
    });

    return run;
  }

  private parseSpawnInput(args: string[]): {
    agentId: string;
    task: string;
    modelOverride?: string;
    error?: string;
  } {
    if (args.length < 2) {
      return {
        agentId: '',
        task: '',
        error: 'Usage: /subagents spawn <agentId> <task> [--model <model>]',
      };
    }

    const agentId = args[0].trim() || SUBAGENT_DEFAULT_AGENT_ID;
    let modelOverride: string | undefined;
    const taskParts: string[] = [];
    for (let i = 1; i < args.length; i += 1) {
      const token = args[i];
      if (token === '--model' && i + 1 < args.length) {
        modelOverride = args[i + 1].trim() || undefined;
        i += 1;
        continue;
      }
      taskParts.push(token);
    }
    const task = taskParts.join(' ').trim();
    if (!task) {
      return {
        agentId,
        task: '',
        error: 'Usage: /subagents spawn <agentId> <task> [--model <model>]',
      };
    }
    return { agentId, task, modelOverride };
  }

  private async executeSubagentAction(
    context: SubagentDispatchContext,
    action: SubagentAction,
    args: string[],
  ): Promise<{ text: string; payload?: Record<string, unknown> }> {
    const { conversation, platform, externalChatId } = context;

    if (action === 'help') {
      return {
        text: [
          'Subagent commands:',
          '- /subagents list',
          '- /subagents spawn <agentId> <task> [--model <model>]',
          '- /subagents kill <id|#|all>',
          '- /subagents steer <id|#> <message>',
          '- /subagents info <id|#>',
          '- /subagents log <id|#>',
          '- /kill <id|#|all>',
          '- /steer <id|#> <message>',
        ].join('\n'),
      };
    }

    if (action === 'list') {
      const runs = listSubagentRunsForConversation(conversation.id, SUBAGENT_RECENT_MINUTES);
      return {
        text: this.formatSubagentList(conversation.id),
        payload: {
          status: 'ok',
          action: 'list',
          active: runs.active,
          recent: runs.recent,
        },
      };
    }

    if (action === 'spawn') {
      const parsed = this.parseSpawnInput(args);
      if (parsed.error) {
        return {
          text: parsed.error,
          payload: {
            status: 'error',
            action: 'spawn',
            error: parsed.error,
          },
        };
      }
      const run = await this.startSubagentRun({
        conversation,
        platform,
        externalChatId,
        agentId: parsed.agentId,
        task: parsed.task,
        modelOverride: parsed.modelOverride,
      });
      return {
        text: `Spawned subagent ${run.agentId} (${run.runId.slice(0, 8)}).`,
        payload: {
          status: 'accepted',
          action: 'spawn',
          runId: run.runId,
          agentId: run.agentId,
        },
      };
    }

    if (action === 'kill') {
      const target = String(args[0] || '').trim();
      if (!target) {
        return {
          text: 'Usage: /subagents kill <id|#|all>',
          payload: {
            status: 'error',
            action: 'kill',
            error: 'Missing target.',
          },
        };
      }

      if (target === 'all' || target === '*') {
        const activeRuns = listActiveSubagentRuns(conversation.id);
        let killed = 0;
        for (const run of activeRuns) {
          const wasRunning = abortSubagentRun(run.runId, 'Subagent run was stopped by requester.');
          if (wasRunning || run.status === 'running') {
            killed += 1;
          }
        }
        return {
          text:
            killed > 0
              ? `Killed ${killed} subagent${killed === 1 ? '' : 's'}.`
              : 'No running subagents.',
          payload: {
            status: 'ok',
            action: 'kill',
            target: 'all',
            killed,
          },
        };
      }

      const resolved = this.resolveSubagentTarget(conversation.id, target);
      if (!resolved.run) {
        return {
          text: resolved.error || 'Unknown subagent target.',
          payload: {
            status: 'error',
            action: 'kill',
            target,
            error: resolved.error || 'Unknown subagent target.',
          },
        };
      }
      const wasRunning = abortSubagentRun(
        resolved.run.runId,
        'Subagent run was stopped by requester.',
      );
      if (!wasRunning) {
        markSubagentRunKilled(resolved.run.runId, 'Subagent run was stopped by requester.');
      }
      return {
        text: `Killed ${resolved.run.agentId} (${resolved.run.runId.slice(0, 8)}).`,
        payload: {
          status: 'ok',
          action: 'kill',
          target,
          runId: resolved.run.runId,
        },
      };
    }

    if (action === 'steer') {
      const target = String(args[0] || '').trim();
      const guidance = args.slice(1).join(' ').trim();
      if (!target || !guidance) {
        return {
          text: 'Usage: /subagents steer <id|#> <message>',
          payload: {
            status: 'error',
            action: 'steer',
            error: 'Missing target or message.',
          },
        };
      }

      const resolved = this.resolveSubagentTarget(conversation.id, target);
      if (!resolved.run) {
        return {
          text: resolved.error || 'Unknown subagent target.',
          payload: {
            status: 'error',
            action: 'steer',
            target,
            error: resolved.error || 'Unknown subagent target.',
          },
        };
      }

      const previous = resolved.run;
      if (previous.status === 'running') {
        abortSubagentRun(previous.runId, 'Run interrupted by steer request.');
      }

      const replacement = await this.startSubagentRun({
        conversation,
        platform,
        externalChatId,
        agentId: previous.agentId,
        task: previous.task,
        guidance,
        modelOverride: previous.modelOverride,
      });
      replaceSubagentRun(previous.runId, replacement.runId);

      return {
        text: `Steered ${previous.agentId}: ${replacement.runId.slice(0, 8)} started.`,
        payload: {
          status: 'accepted',
          action: 'steer',
          target,
          previousRunId: previous.runId,
          runId: replacement.runId,
        },
      };
    }

    if (action === 'info' || action === 'log') {
      const target = String(args[0] || '').trim();
      if (!target) {
        return {
          text: `Usage: /subagents ${action} <id|#>`,
          payload: {
            status: 'error',
            action,
            error: 'Missing target.',
          },
        };
      }
      const resolved = this.resolveSubagentTarget(conversation.id, target);
      if (!resolved.run) {
        return {
          text: resolved.error || 'Unknown subagent target.',
          payload: {
            status: 'error',
            action,
            target,
            error: resolved.error || 'Unknown subagent target.',
          },
        };
      }

      const run = resolved.run;
      const logText =
        action === 'log'
          ? run.resultPreview || run.error || '(no output)'
          : [
              `runId: ${run.runId}`,
              `agentId: ${run.agentId}`,
              `status: ${run.status}`,
              `startedAt: ${run.startedAt}`,
              `endedAt: ${run.endedAt || '-'}`,
              `task: ${run.task}`,
              run.guidance ? `guidance: ${run.guidance}` : null,
              run.error ? `error: ${run.error}` : null,
            ]
              .filter(Boolean)
              .join('\n');
      return {
        text: logText,
        payload: {
          status: 'ok',
          action,
          run,
        },
      };
    }

    return {
      text: 'Unsupported subagent action.',
      payload: {
        status: 'error',
        action,
        error: 'Unsupported subagent action.',
      },
    };
  }

  private async handleSubagentCommand(
    context: SubagentDispatchContext,
    payload: string,
    command?: string,
  ): Promise<StoredMessage> {
    const parsed = this.parseSubagentAction(payload, command);
    const result = await this.executeSubagentAction(context, parsed.action, parsed.args);
    return this.sendResponse(
      context.conversation,
      result.text,
      context.platform,
      context.externalChatId,
      {
        runtime: 'subagents-command',
        action: parsed.action,
        ...(result.payload || {}),
      },
    );
  }

  async invokeSubagentToolCall(params: {
    args: Record<string, unknown>;
    conversationId: string;
    userId: string;
    platform: ChannelType;
    externalChatId: string;
  }): Promise<Record<string, unknown>> {
    const conversation = this.getConversation(params.conversationId, params.userId);
    if (!conversation) {
      return {
        status: 'error',
        error: 'Conversation not found for subagent tool context.',
      };
    }

    const actionRaw = String(params.args.action || 'list')
      .trim()
      .toLowerCase();
    const action: SubagentAction =
      actionRaw === 'spawn' ||
      actionRaw === 'kill' ||
      actionRaw === 'steer' ||
      actionRaw === 'log' ||
      actionRaw === 'info' ||
      actionRaw === 'help'
        ? (actionRaw as SubagentAction)
        : 'list';

    const args: string[] = [];
    if (action === 'spawn') {
      const agentId = String(params.args.agentId || SUBAGENT_DEFAULT_AGENT_ID).trim();
      const task = String(params.args.task || '').trim();
      const modelOverride = String(params.args.model || '').trim();
      if (!task) {
        return {
          status: 'error',
          action,
          error: 'subagents spawn requires task.',
        };
      }
      args.push(agentId, task);
      if (modelOverride) {
        args.push('--model', modelOverride);
      }
    } else if (action === 'kill' || action === 'info' || action === 'log') {
      args.push(String(params.args.target || '').trim());
    } else if (action === 'steer') {
      args.push(String(params.args.target || '').trim(), String(params.args.message || '').trim());
    }

    const result = await this.executeSubagentAction(
      {
        conversation,
        platform: params.platform,
        externalChatId: params.externalChatId,
      },
      action,
      args.filter(Boolean),
    );

    return {
      status: (result.payload?.status as string) || 'ok',
      action,
      text: result.text,
      ...(result.payload || {}),
    };
  }

  private async handleInferredShellQuestion(params: {
    conversation: Conversation;
    platform: ChannelType;
    externalChatId: string;
    userInput: string;
    command: string;
    onStreamDelta?: (delta: string) => void;
  }): Promise<StoredMessage> {
    const { conversation, platform, externalChatId, userInput, command, onStreamDelta } = params;
    await this.ensureShellSkillInstalled();
    const toolContext = await this.resolveToolContext();
    const installedFunctions = new Set(toolContext.installedFunctionNames);
    installedFunctions.add('shell_execute');

    const toolExecution = await this.executeToolFunctionCall({
      conversation,
      platform,
      externalChatId,
      functionName: 'shell_execute',
      args: { command },
      installedFunctions,
      toolId: toolContext.functionToSkillId.get('shell_execute') || 'shell-access',
    });

    if (toolExecution.kind === 'approval_required') {
      return this.sendResponse(
        conversation,
        toolExecution.prompt,
        platform,
        externalChatId,
        this.buildApprovalMetadata(toolExecution.pending, toolExecution.prompt, {
          ok: false,
          runtime: 'chat-shell-inference',
          inferredCommand: command,
          inferredFrom: userInput,
        }),
      );
    }

    const toolResultContent =
      toolExecution.kind === 'ok'
        ? `Tool "shell_execute" result:\n${toolExecution.output}`
        : `Tool "shell_execute" failed:\n${toolExecution.output}`;

    const messages = this.contextBuilder.buildGatewayMessages(
      conversation.id,
      conversation.userId,
      50,
      conversation.personaId,
    );
    messages.push({ role: 'assistant', content: '[Tool call: shell_execute]' });
    messages.push({ role: 'user', content: toolResultContent });

    const { preferredModelId, modelHubProfileId } = this.resolveChatModelRouting(conversation);
    const modelOutcome = await this.runModelToolLoop({
      conversation,
      messages,
      modelHubProfileId,
      preferredModelId,
      toolContext,
      onStreamDelta,
    });

    return this.sendResponse(conversation, modelOutcome.content, platform, externalChatId, {
      ...modelOutcome.metadata,
      runtime: 'chat-shell-inference',
      inferredCommand: command,
    });
  }

  private resolveChatModelRouting(conversation: Conversation): {
    preferredModelId?: string;
    modelHubProfileId: string;
  } {
    let preferredModelId = conversation.modelOverride ?? undefined;
    let modelHubProfileId = process.env.MODEL_HUB_PROFILE_ID?.trim() || 'p1';

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

  private requiresInteractiveToolApproval(): boolean {
    return String(process.env.OPENCLAW_EXEC_APPROVALS_REQUIRED || 'false').toLowerCase() === 'true';
  }

  private prunePendingToolApprovals(now = Date.now()): void {
    for (const [token, pending] of this.pendingToolApprovals) {
      if (now - pending.createdAtMs > TOOL_APPROVAL_TTL_MS) {
        this.pendingToolApprovals.delete(token);
      }
    }
  }

  private formatToolOutput(value: unknown): string {
    let output = '';

    if (typeof value === 'string') {
      output = value;
    } else {
      try {
        output = JSON.stringify(value, null, 2);
      } catch {
        output = String(value);
      }
    }

    const trimmed = output.trim();
    if (trimmed.length <= TOOL_OUTPUT_MAX_CHARS) {
      return trimmed;
    }

    const omitted = trimmed.length - TOOL_OUTPUT_MAX_CHARS;
    return `${trimmed.slice(0, TOOL_OUTPUT_MAX_CHARS)}\n...(truncated ${omitted} chars)`;
  }

  private buildToolApprovalPrompt(command: string): string {
    return [
      'Der angefragte CLI-Befehl braucht eine Freigabe.',
      '',
      `Command: ${command}`,
      '',
      'Waehle: Approve once, Approve always oder Deny.',
    ].join('\n');
  }

  private async resolveToolContext(): Promise<ResolvedToolContext> {
    await this.ensureShellSkillInstalled();
    const skillRepo = await getSkillRepository();
    const skillRows = skillRepo.listSkills();
    const installedRows = skillRows.filter((row) => row.installed);

    const installedSkills: Skill[] = installedRows.map((row) => ({
      id: row.id,
      name: row.name,
      description: row.description,
      category: row.category,
      installed: row.installed,
      version: row.version,
      functionName: row.functionName,
      source: row.source,
      sourceUrl: row.sourceUrl ?? undefined,
    }));

    return {
      tools: mapSkillsToTools(installedSkills, 'openai'),
      installedFunctionNames: new Set(installedRows.map((row) => row.functionName)),
      functionToSkillId: new Map(installedRows.map((row) => [row.functionName, row.id])),
    };
  }

  private normalizeToolArgs(args: unknown): Record<string, unknown> {
    if (!args || typeof args !== 'object' || Array.isArray(args)) {
      return {};
    }
    return args as Record<string, unknown>;
  }

  private async executeToolFunctionCall(params: {
    conversation: Conversation;
    platform: ChannelType;
    externalChatId: string;
    functionName: string;
    args: Record<string, unknown>;
    installedFunctions: Set<string>;
    toolId?: string;
    skipApprovalCheck?: boolean;
  }): Promise<ToolExecutionResult> {
    const { functionName, args, installedFunctions } = params;

    if (!installedFunctions.has(functionName)) {
      return {
        kind: 'error',
        output: `Tool "${functionName}" ist nicht installiert.`,
      };
    }

    if (functionName === 'shell_execute') {
      const command = String(args.command || '').trim();
      if (!command) {
        return { kind: 'error', output: 'shell_execute requires command.' };
      }

      const policy = evaluateNodeCommandPolicy(command);
      if (!policy.allowed) {
        return {
          kind: 'error',
          output: policy.reason || 'Command blocked by security policy.',
        };
      }

      if (
        this.requiresInteractiveToolApproval() &&
        !params.skipApprovalCheck &&
        !isCommandApproved(policy.normalizedCommand)
      ) {
        this.prunePendingToolApprovals();
        const token = crypto.randomUUID();
        const pending: PendingToolApproval = {
          token,
          userId: params.conversation.userId,
          conversationId: params.conversation.id,
          platform: params.platform,
          externalChatId: params.externalChatId,
          toolFunctionName: functionName,
          toolId: params.toolId,
          args,
          command: policy.normalizedCommand,
          createdAtMs: Date.now(),
        };
        this.pendingToolApprovals.set(token, pending);
        return {
          kind: 'approval_required',
          prompt: this.buildToolApprovalPrompt(policy.normalizedCommand),
          pending,
        };
      }
    }

    try {
      const { dispatchSkill, normalizeSkillArgs } = await import('../../skills/executeSkill');
      const result = await dispatchSkill(functionName, normalizeSkillArgs(args), {
        bypassApproval: functionName === 'shell_execute' && Boolean(params.skipApprovalCheck),
        conversationId: params.conversation.id,
        userId: params.conversation.userId,
        platform: params.platform,
        externalChatId: params.externalChatId,
        invokeSubagentToolCall: (subagentParams) => this.invokeSubagentToolCall(subagentParams),
      });
      return {
        kind: 'ok',
        output: this.formatToolOutput(result),
      };
    } catch (error) {
      return {
        kind: 'error',
        output: error instanceof Error ? error.message : String(error),
      };
    }
  }

  private async runModelToolLoop(params: {
    conversation: Conversation;
    messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }>;
    modelHubProfileId: string;
    preferredModelId?: string;
    toolContext: ResolvedToolContext;
    abortSignal?: AbortSignal;
    onStreamDelta?: (delta: string) => void;
  }): Promise<{ content: string; metadata: Record<string, unknown> }> {
    const { conversation, messages, modelHubProfileId, preferredModelId, toolContext } = params;
    const encryptionKey = getModelHubEncryptionKey();

    for (let round = 0; round <= MAX_TOOL_ROUNDS; round += 1) {
      const result = await getModelHubService().dispatchWithFallback(
        modelHubProfileId,
        encryptionKey,
        {
          messages,
          tools: toolContext.tools.length > 0 ? toolContext.tools : undefined,
          stream: Boolean(params.onStreamDelta),
          auditContext: {
            kind: 'chat',
            conversationId: conversation.id,
          },
        },
        {
          signal: params.abortSignal,
          modelOverride: preferredModelId,
          onStreamDelta: params.onStreamDelta,
        },
      );

      if (!result.ok) {
        return {
          content: `AI dispatch failed: ${result.error || 'unknown error'}`,
          metadata: {
            ok: false,
            runtime: 'model-hub',
            profileId: modelHubProfileId,
            model: result.model || null,
            provider: result.provider || null,
            error: result.error || 'AI dispatch failed',
          },
        };
      }

      const functionCall = result.functionCalls?.[0];
      if (
        functionCall &&
        typeof functionCall.name === 'string' &&
        functionCall.name.trim() &&
        round < MAX_TOOL_ROUNDS
      ) {
        const functionName = functionCall.name.trim();
        const toolExecution = await this.executeToolFunctionCall({
          conversation,
          platform: conversation.channelType,
          externalChatId: conversation.externalChatId || 'default',
          functionName,
          args: this.normalizeToolArgs(functionCall.args),
          installedFunctions: toolContext.installedFunctionNames,
          toolId: toolContext.functionToSkillId.get(functionName),
        });

        if (toolExecution.kind === 'approval_required') {
          return {
            content: toolExecution.prompt,
            metadata: this.buildApprovalMetadata(toolExecution.pending, toolExecution.prompt, {
              ok: false,
              runtime: 'model-hub',
              profileId: modelHubProfileId,
              model: result.model || null,
              provider: result.provider || null,
            }),
          };
        }

        const toolResultContent =
          toolExecution.kind === 'ok'
            ? `Tool "${functionName}" result:\n${toolExecution.output}`
            : `Tool "${functionName}" failed:\n${toolExecution.output}`;
        messages.push({ role: 'assistant', content: `[Tool call: ${functionName}]` });
        messages.push({ role: 'user', content: toolResultContent });
        continue;
      }

      const normalized = String(result.text || '')
        .replace(MODEL_HUB_GATEWAY_PREFIX_RE, '')
        .trim();
      return {
        content: normalized || '(empty response)',
        metadata: {
          ok: true,
          runtime: 'model-hub',
          profileId: modelHubProfileId,
          model: result.model,
          provider: result.provider,
          usage: result.usage || null,
        },
      };
    }

    return {
      content: 'Tool loop exceeded maximum rounds.',
      metadata: {
        ok: false,
        runtime: 'model-hub',
        profileId: modelHubProfileId,
        error: 'Tool loop exceeded maximum rounds.',
      },
    };
  }

  private async dispatchToAI(
    conversation: Conversation,
    platform: ChannelType,
    externalChatId: string,
    userInput: string,
    onStreamDelta?: (delta: string) => void,
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
          '- Memories tagged "[Subject: assistant]" describe you (the persona).',
          '- Memories tagged "[Subject: assistant, Self-Reference]" contain statements you made about yourself (e.g., "I slept with Max").',
          '- When the user asks "Did you...?" and a memory says "I...", the answer is YES.',
          '- Never claim user preferences, habits, or facts as your own.',
          '- When the user asks about something mentioned in [Chat History], reference the specific content rather than paraphrasing from later conversation patterns.',
          '- User messages in [Chat History] represent explicit instructions or facts - prioritize them over assistant summaries.',
        ].join('\n'),
      });
    }

    const abortController = new AbortController();
    this.activeRequests.set(conversation.id, abortController);

    let modelOutcome: { content: string; metadata: Record<string, unknown> };
    try {
      const { preferredModelId, modelHubProfileId } = this.resolveChatModelRouting(conversation);
      const toolContext = await this.resolveToolContext();
      modelOutcome = await this.runModelToolLoop({
        conversation,
        messages,
        modelHubProfileId,
        preferredModelId,
        toolContext,
        abortSignal: abortController.signal,
        onStreamDelta,
      });
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') {
        modelOutcome = {
          content: 'Generation aborted.',
          metadata: { ok: false, aborted: true },
        };
      } else {
        modelOutcome = {
          content: `AI dispatch failed: ${error instanceof Error ? error.message : String(error)}`,
          metadata: {
            ok: false,
            error: error instanceof Error ? error.message : 'AI dispatch failed',
          },
        };
      }
    } finally {
      this.activeRequests.delete(conversation.id);
    }

    const agentMsg = await this.sendResponse(
      conversation,
      modelOutcome.content,
      platform,
      externalChatId,
      modelOutcome.metadata,
    );

    void this.maybeRefreshConversationSummary(conversation);
    return agentMsg;
  }

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

  async respondToolApproval(params: {
    conversationId: string;
    userId: string;
    approvalToken: string;
    approved: boolean;
    approveAlways?: boolean;
    toolId?: string;
    toolFunctionName?: string;
  }): Promise<{
    ok: boolean;
    status: 'approved' | 'denied' | 'not_found' | 'approval_required';
    policyUpdated: boolean;
  }> {
    this.prunePendingToolApprovals();

    const token = String(params.approvalToken || '').trim();
    if (!token) {
      return { ok: false, status: 'not_found', policyUpdated: false };
    }

    const pending = this.pendingToolApprovals.get(token);
    if (
      !pending ||
      pending.userId !== this.sessionManager.resolveUserId(params.userId) ||
      pending.conversationId !== params.conversationId
    ) {
      return { ok: false, status: 'not_found', policyUpdated: false };
    }

    if (params.toolFunctionName && params.toolFunctionName !== pending.toolFunctionName) {
      return { ok: false, status: 'not_found', policyUpdated: false };
    }
    if (params.toolId && pending.toolId && params.toolId !== pending.toolId) {
      return { ok: false, status: 'not_found', policyUpdated: false };
    }

    this.pendingToolApprovals.delete(token);

    const conversation = this.getConversation(pending.conversationId, pending.userId);
    if (!conversation) {
      return { ok: false, status: 'not_found', policyUpdated: false };
    }

    if (!params.approved) {
      await this.sendResponse(
        conversation,
        'Befehl wurde abgelehnt. Ich fuehre diesen Tool-Aufruf nicht aus.',
        pending.platform,
        pending.externalChatId,
      );
      return { ok: true, status: 'denied', policyUpdated: false };
    }

    let policyUpdated = false;
    if (params.approveAlways && pending.command) {
      approveCommand(pending.command);
      policyUpdated = true;
    }

    const toolContext = await this.resolveToolContext();
    const toolExecution = await this.executeToolFunctionCall({
      conversation,
      platform: pending.platform,
      externalChatId: pending.externalChatId,
      functionName: pending.toolFunctionName,
      args: pending.args,
      installedFunctions: toolContext.installedFunctionNames,
      toolId: pending.toolId,
      skipApprovalCheck: true,
    });

    const toolResultContent =
      toolExecution.kind === 'ok'
        ? `Tool "${pending.toolFunctionName}" result:\n${toolExecution.output}`
        : `Tool "${pending.toolFunctionName}" failed:\n${
            toolExecution.kind === 'approval_required'
              ? 'Approval unresolved.'
              : toolExecution.output
          }`;

    const messages = this.contextBuilder.buildGatewayMessages(
      conversation.id,
      conversation.userId,
      50,
      conversation.personaId,
    );
    messages.push({ role: 'assistant', content: `[Tool call: ${pending.toolFunctionName}]` });
    messages.push({ role: 'user', content: toolResultContent });

    const { preferredModelId, modelHubProfileId } = this.resolveChatModelRouting(conversation);
    const modelOutcome = await this.runModelToolLoop({
      conversation,
      messages,
      modelHubProfileId,
      preferredModelId,
      toolContext,
    });

    await this.sendResponse(
      conversation,
      modelOutcome.content,
      pending.platform,
      pending.externalChatId,
      modelOutcome.metadata,
    );

    void this.maybeRefreshConversationSummary(conversation);
    const nextStatus =
      String(modelOutcome.metadata.status || '').trim() === 'approval_required'
        ? 'approval_required'
        : 'approved';
    return { ok: true, status: nextStatus, policyUpdated };
  }

  // Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬ Persona Command Handling Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬

  /**
   * Handle /persona commands from any channel (primarily Telegram/WhatsApp).
   * - /persona list       Ã¢â€ â€™ show all available personas
   * - /persona <name>     Ã¢â€ â€™ switch to a persona by name (fuzzy match)
   * - /persona off|clear  Ã¢â€ â€™ deactivate persona for this channel
   * - /persona            Ã¢â€ â€™ show current persona + help
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
        'Ã¢Å¡Â Ã¯Â¸Â Persona-System nicht verfÃƒÂ¼gbar.',
        platform,
        externalChatId,
      );
    }

    const personas = personaRepo.listPersonas(conversation.userId);

    // /persona (no args) Ã¢â€ â€™ show current + help
    if (!lower) {
      const currentPersonaId = getChannelBindingPersonaId(this.repo, conversation.userId, platform);
      const currentPersona = currentPersonaId ? personaRepo.getPersona(currentPersonaId) : null;

      const lines = [
        'Ã°Å¸Å½Â­ **Persona-System**',
        '',
        currentPersona
          ? `Aktive Persona: ${currentPersona.emoji} **${currentPersona.name}**`
          : 'Keine Persona aktiv (Default-Modus)',
        '',
        '**Befehle:**',
        '`/persona list` Ã¢â‚¬â€ Alle Personas anzeigen',
        '`/persona <Name>` Ã¢â‚¬â€ Persona wechseln',
        '`/persona off` Ã¢â‚¬â€ Persona deaktivieren',
      ];
      return this.sendResponse(conversation, lines.join('\n'), platform, externalChatId);
    }

    // /persona list Ã¢â€ â€™ list all personas
    if (lower === 'list') {
      if (personas.length === 0) {
        return this.sendResponse(
          conversation,
          'Ã°Å¸Å½Â­ Keine Personas erstellt.\nErstelle Personas in der WebApp unter "Agent Personas".',
          platform,
          externalChatId,
        );
      }

      const currentPersonaId = getChannelBindingPersonaId(this.repo, conversation.userId, platform);
      const lines = ['Ã°Å¸Å½Â­ **VerfÃƒÂ¼gbare Personas:**', ''];
      for (const p of personas) {
        const active = p.id === currentPersonaId ? ' Ã¢Å“â€¦' : '';
        const vibe = p.vibe ? ` Ã¢â‚¬â€ _${p.vibe}_` : '';
        lines.push(`${p.emoji} **${p.name}**${vibe}${active}`);
      }
      lines.push('', 'Wechseln: `/persona <Name>`');
      return this.sendResponse(conversation, lines.join('\n'), platform, externalChatId);
    }

    // /persona off|clear|default Ã¢â€ â€™ deactivate
    if (lower === 'off' || lower === 'clear' || lower === 'default') {
      setChannelBindingPersona(this.repo, conversation.userId, platform, null);
      // Also clear on current conversation
      this.repo.updatePersonaId(conversation.id, null, conversation.userId);
      return this.sendResponse(
        conversation,
        'Ã°Å¸Å½Â­ Persona deaktiviert. Du chattest jetzt im Default-Modus.',
        platform,
        externalChatId,
      );
    }

    // /persona <name> Ã¢â€ â€™ fuzzy match by name
    const match = personas.find(
      (p) => p.name.toLowerCase() === lower || p.name.toLowerCase().startsWith(lower),
    );

    if (!match) {
      const available = personas.map((p) => `${p.emoji} ${p.name}`).join(', ');
      return this.sendResponse(
        conversation,
        `Ã¢Å¡Â Ã¯Â¸Â Persona "${payload}" nicht gefunden.\nVerfÃƒÂ¼gbar: ${available || '(keine)'}`,
        platform,
        externalChatId,
      );
    }

    // Apply persona to channel binding + current conversation
    setChannelBindingPersona(this.repo, conversation.userId, platform, match.id);
    this.repo.updatePersonaId(conversation.id, match.id, conversation.userId);

    return this.sendResponse(
      conversation,
      `Ã°Å¸Å½Â­ Persona gewechselt: ${match.emoji} **${match.name}**\nAlle neuen Nachrichten in ${platform} nutzen jetzt diese Persona.`,
      platform,
      externalChatId,
    );
  }

  // Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬ Helper: Send & Broadcast Response Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬

  private async sendResponse(
    conversation: Conversation,
    content: string,
    platform: ChannelType,
    externalChatId: string,
    metadata?: Record<string, unknown>,
  ): Promise<StoredMessage> {
    const agentMsg = this.historyManager.appendAgentMessage(
      conversation.id,
      platform,
      content,
      metadata,
    );

    broadcastToUser(conversation.userId, GatewayEvents.CHAT_MESSAGE, agentMsg);

    try {
      await deliverOutbound(platform, externalChatId, content);
    } catch (error) {
      console.error(`Outbound delivery failed for ${platform}:`, error);
    }

    return agentMsg;
  }

  // Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬ WebUI Handler Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬

  /**
   * Handle a message from WebUI chat Ã¢â‚¬â€ same flow but conversation is pre-selected.
   */
  async handleWebUIMessage(
    conversationId: string,
    content: string,
    userId?: string,
    clientMessageId?: string,
    attachments?: StoredMessageAttachment[],
    onStreamDelta?: (delta: string) => void,
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
      onStreamDelta,
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
    metadata?: Record<string, unknown>,
  ): StoredMessage {
    const conversation = userId
      ? this.repo.getConversation(conversationId, this.sessionManager.resolveUserId(userId))
      : this.repo.getConversation(conversationId);

    if (!conversation) {
      throw new Error('Conversation not found for current user.');
    }

    const msg = this.repo.saveMessage({ conversationId, role, content, platform, metadata });
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

    // Ã¢â€â‚¬Ã¢â€â‚¬ Parallel recall from all three sources Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬
    const [knowledgeResult, memoryResult, chatResult] = await Promise.allSettled([
      this.recallFromKnowledge(knowledgeRetrievalService, memoryUserIds, conversation, userInput),
      this.recallFromMemory(memoryUserIds, conversation, userInput),
      this.recallFromChat(conversation, userInput),
    ]);

    const knowledgeContext = knowledgeResult.status === 'fulfilled' ? knowledgeResult.value : null;
    const memoryContext = memoryResult.status === 'fulfilled' ? memoryResult.value : null;
    const chatHits = chatResult.status === 'fulfilled' ? chatResult.value : [];

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
  private recallFromChat(conversation: Conversation, userInput: string): StoredMessage[] {
    if (!this.repo.searchMessages) return [];
    try {
      const inputNorm = userInput
        .trim()
        .toLowerCase()
        .replace(/[?.!]+$/, '');
      // Overfetch generously to survive duplicate flooding from repeated queries
      const raw = this.repo.searchMessages(userInput, {
        userId: conversation.userId,
        personaId: conversation.personaId ?? undefined,
        limit: 50,
      } as SearchMessagesOptions);

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
