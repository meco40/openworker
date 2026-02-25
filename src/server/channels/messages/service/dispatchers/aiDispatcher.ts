import type { ChannelType } from '@/shared/domain/types';
import type { Conversation } from '@/server/channels/messages/repository';
import { getModelHubService, getModelHubEncryptionKey } from '@/server/model-hub/runtime';
import type { ContextBuilder } from '@/server/channels/messages/contextBuilder';
import type { RecallService } from '@/server/channels/messages/service/recallService';
import type { SummaryService } from '@/server/channels/messages/service/summaryService';
import type { ToolManager } from '@/server/channels/messages/service/toolManager';
import {
  MODEL_HUB_GATEWAY_PREFIX_RE,
  MAX_TOOL_ROUNDS,
  TOOL_CALLS_HARD_CAP,
  MAX_REPEATED_FAILED_TOOL_CALLS,
} from '@/server/channels/messages/service/types';
import {
  createLoopDetectorState,
  buildArgsHash,
  buildResultHash,
  recordCall,
  recordOutcome,
  detectLoop,
} from '@/server/channels/messages/service/toolLoopDetector';
import { repairOrphanedToolCalls } from '@/server/channels/messages/service/transcriptRepair';
import { buildActiveSkillsPromptSection } from '@/server/channels/messages/service/dispatchers/skillsPrompt';

export interface AIDispatcherDeps {
  contextBuilder: ContextBuilder;
  recallService: RecallService;
  summaryService: SummaryService;
  toolManager: ToolManager;
  resolveChatModelRouting: (conversation: Conversation) => {
    preferredModelId?: string;
    modelHubProfileId: string;
  };
  resolveConversationWorkspaceCwd?: (conversation: Conversation) => string | undefined;
  runModelToolLoop: (
    toolManager: ToolManager,
    params: {
      conversation: Conversation;
      messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }>;
      modelHubProfileId: string;
      preferredModelId?: string;
      workspaceCwd?: string;
      toolContext: {
        tools: unknown[];
        installedFunctionNames: Set<string>;
        functionToSkillId: Map<string, string>;
      };
      maxToolCalls?: number;
      abortSignal?: AbortSignal;
      onStreamDelta?: (delta: string) => void;
      auditContextExtras?: { turnSeq?: number; memoryContext?: string };
    },
  ) => Promise<{ content: string; metadata: Record<string, unknown> }>;
  activeRequests: Map<string, AbortController>;
}

export async function dispatchToAI(
  deps: AIDispatcherDeps,
  params: {
    conversation: Conversation;
    platform: ChannelType;
    externalChatId: string;
    userInput: string;
    onStreamDelta?: (delta: string) => void;
    turnSeq?: number;
    executionDirective?: string;
    maxToolCalls?: number;
    skipSummaryRefresh?: boolean;
    requireToolCall?: boolean;
  },
): Promise<{ content: string; metadata: Record<string, unknown> }> {
  const { conversation, userInput, onStreamDelta, executionDirective, maxToolCalls } = params;
  let messages = deps.contextBuilder.buildGatewayMessages(
    conversation.id,
    conversation.userId,
    50,
    conversation.personaId,
  );
  // Repair orphaned tool-call stubs before the model sees the transcript
  messages = repairOrphanedToolCalls(messages);

  if (executionDirective?.trim()) {
    messages.unshift({
      role: 'system',
      content: executionDirective.trim(),
    });
  }

  const memoryContext = await deps.recallService.buildRecallContext(conversation, userInput);
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

  // Inject SKILL.md guidance bodies into the system prompt (server-only, dynamic import
  // prevents this from being bundled into the browser client).
  try {
    const { loadAllSkillMd, filterEligibleSkills } = await import('@/server/skills/skillMd/index');
    const [{ BUILT_IN_SKILLS }, { getSkillRepository }] = await Promise.all([
      import('@/server/skills/builtInSkills'),
      import('@/server/skills/skillRepository'),
    ]);
    const skillRepo = await getSkillRepository();
    const installedSkills = skillRepo.listSkills().filter((skill) => skill.installed);
    const workspaceCwd = params.conversation.id
      ? deps.resolveConversationWorkspaceCwd?.(params.conversation)
      : undefined;
    const allParsed = loadAllSkillMd({ workspaceCwd: workspaceCwd ?? undefined });
    const eligible = filterEligibleSkills(allParsed);
    const skillsSection = buildActiveSkillsPromptSection({
      installedSkills,
      eligibleParsedSkills: eligible,
      builtInSeeds: BUILT_IN_SKILLS,
    });
    if (skillsSection) {
      messages.unshift({ role: 'system', content: skillsSection });
    }
  } catch {
    // Non-fatal: if skill guidance fails to load, continue without it.
  }

  // Abort any existing in-flight request for this conversation before creating a new one.
  // Without this, re-dispatching the same conversation leaks the old controller.
  const existingController = deps.activeRequests.get(conversation.id);
  if (existingController) existingController.abort();
  const abortController = new AbortController();
  deps.activeRequests.set(conversation.id, abortController);

  let modelOutcome: { content: string; metadata: Record<string, unknown> };
  try {
    const { preferredModelId, modelHubProfileId } = deps.resolveChatModelRouting(conversation);
    const workspaceCwd = deps.resolveConversationWorkspaceCwd?.(conversation);
    const toolContext = await deps.toolManager.resolveToolContext();
    modelOutcome = await deps.runModelToolLoop(deps.toolManager, {
      conversation,
      messages,
      modelHubProfileId,
      preferredModelId,
      workspaceCwd,
      toolContext,
      maxToolCalls,
      abortSignal: abortController.signal,
      onStreamDelta,
      auditContextExtras: {
        turnSeq: params.turnSeq,
        memoryContext: memoryContext ?? undefined,
      },
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
    deps.activeRequests.delete(conversation.id);
  }

  if (!params.skipSummaryRefresh) {
    void deps.summaryService.maybeRefreshConversationSummary(conversation);
  }
  const executedToolCalls = Number(modelOutcome.metadata?.executedToolCalls ?? 0);
  const status = String(modelOutcome.metadata?.status || '');
  if (params.requireToolCall && executedToolCalls < 1 && status !== 'approval_required') {
    return {
      content:
        'Execution failed: no real tool execution happened for this task. Retry dispatch with an execution-capable agent response.',
      metadata: {
        ...modelOutcome.metadata,
        ok: false,
        status: 'tool_execution_required_unmet',
        executedToolCalls,
      },
    };
  }
  return modelOutcome;
}

export async function runModelToolLoop(
  toolManager: ToolManager,
  params: {
    conversation: Conversation;
    messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }>;
    modelHubProfileId: string;
    preferredModelId?: string;
    workspaceCwd?: string;
    toolContext: {
      tools: unknown[];
      installedFunctionNames: Set<string>;
      functionToSkillId: Map<string, string>;
    };
    maxToolCalls?: number;
    abortSignal?: AbortSignal;
    onStreamDelta?: (delta: string) => void;
    auditContextExtras?: { turnSeq?: number; memoryContext?: string };
  },
): Promise<{ content: string; metadata: Record<string, unknown> }> {
  const { conversation, messages, modelHubProfileId, preferredModelId, toolContext } = params;
  const encryptionKey = getModelHubEncryptionKey();
  const maxToolCalls = normalizeMaxToolCalls(params.maxToolCalls);
  const withToolStats = <T extends Record<string, unknown>>(metadata: T) => ({
    ...metadata,
    executedToolCalls,
  });

  let executedToolCalls = 0;
  let failedToolSignature: string | null = null;
  let consecutiveFailedSameToolCalls = 0;
  const loopState = createLoopDetectorState();
  while (executedToolCalls <= maxToolCalls) {
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
          ...(params.auditContextExtras ?? {}),
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
        metadata: withToolStats({
          ok: false,
          runtime: 'model-hub',
          profileId: modelHubProfileId,
          model: result.model || null,
          provider: result.provider || null,
          error: result.error || 'AI dispatch failed',
        }),
      };
    }

    const functionCall = result.functionCalls?.[0];
    if (functionCall && typeof functionCall.name === 'string' && functionCall.name.trim()) {
      if (executedToolCalls >= maxToolCalls) {
        const functionName = functionCall.name.trim();
        return {
          content: `Tool loop stopped before completion: reached max tool calls (${maxToolCalls}) while model requested "${functionName}".`,
          metadata: withToolStats({
            ok: false,
            status: 'tool_limit_reached',
            runtime: 'model-hub',
            profileId: modelHubProfileId,
            model: result.model || null,
            provider: result.provider || null,
            requestedTool: functionName,
            maxToolCalls,
            usage: result.usage || null,
          }),
        };
      }

      const functionName = functionCall.name.trim();
      const toolArgs = (functionCall.args as Record<string, unknown>) || {};
      const toolSignature = buildToolSignature(functionName, toolArgs);
      const argsHash = buildArgsHash(functionName, toolArgs);
      // Pre-call loop detection (circuit breaker only, no result hash yet)
      recordCall(loopState, functionName, argsHash);
      const preCheck = detectLoop(loopState, functionName, argsHash);
      if (preCheck.level === 'critical') {
        return {
          content: preCheck.message,
          metadata: {
            ok: false,
            status: 'loop_detected_critical',
            runtime: 'model-hub',
            profileId: modelHubProfileId,
            model: null,
            provider: null,
          },
        };
      }
      // Emit tool-call start signal (\x00tc: prefix, never shown as text)
      params.onStreamDelta?.(`\x00tc:${functionName}`);
      const toolExecution = await toolManager.executeToolFunctionCall({
        conversation,
        platform: conversation.channelType,
        externalChatId: conversation.externalChatId || 'default',
        functionName,
        args: toolArgs,
        workspaceCwd: params.workspaceCwd,
        installedFunctions: toolContext.installedFunctionNames,
        toolId: toolContext.functionToSkillId.get(functionName),
      });

      if (toolExecution.kind === 'approval_required') {
        return {
          content: toolExecution.prompt,
          metadata: withToolStats(
            toolManager.buildApprovalMetadata(toolExecution.pending, toolExecution.prompt, {
              ok: false,
              status: 'approval_required',
              runtime: 'model-hub',
              profileId: modelHubProfileId,
              model: result.model || null,
              provider: result.provider || null,
            }),
          ),
        };
      }

      if (toolExecution.kind !== 'ok') {
        if (toolSignature === failedToolSignature) {
          consecutiveFailedSameToolCalls += 1;
        } else {
          failedToolSignature = toolSignature;
          consecutiveFailedSameToolCalls = 1;
        }
      } else {
        failedToolSignature = null;
        consecutiveFailedSameToolCalls = 0;
      }

      if (consecutiveFailedSameToolCalls >= MAX_REPEATED_FAILED_TOOL_CALLS) {
        return {
          content: `Tool loop stopped: "${functionName}" failed ${consecutiveFailedSameToolCalls} times in a row with the same arguments. I stopped to prevent an endless retry loop.`,
          metadata: withToolStats({
            ok: false,
            status: 'tool_stuck_repetition',
            runtime: 'model-hub',
            profileId: modelHubProfileId,
            model: result.model || null,
            provider: result.provider || null,
            requestedTool: functionName,
            repeatedFailedToolCalls: consecutiveFailedSameToolCalls,
            usage: result.usage || null,
          }),
        };
      }

      // Emit tool-call done signal
      params.onStreamDelta?.('\x00tc:');
      // Post-call loop detection (record outcome, then check for warning/critical)
      const resultOutput =
        toolExecution.kind === 'ok' ? toolExecution.output : toolExecution.output;
      const resultHash = buildResultHash(resultOutput);
      recordOutcome(loopState, functionName, argsHash, resultHash);
      const postCheck = detectLoop(loopState, functionName, argsHash);
      let loopWarningPrefix = '';
      if (postCheck.level === 'critical') {
        return {
          content: postCheck.message,
          metadata: withToolStats({
            ok: false,
            status: 'loop_detected_critical',
            runtime: 'model-hub',
            profileId: modelHubProfileId,
            model: null,
            provider: null,
          }),
        };
      } else if (postCheck.level === 'warning') {
        loopWarningPrefix = `${postCheck.message}\n\n`;
      }
      const toolResultContent =
        toolExecution.kind === 'ok'
          ? `${loopWarningPrefix}Tool "${functionName}" result:\n${toolExecution.output}`
          : `${loopWarningPrefix}Tool "${functionName}" failed:\n${toolExecution.output}`;
      messages.push({ role: 'assistant', content: `[Tool call: ${functionName}]` });
      messages.push({ role: 'user', content: toolResultContent });
      executedToolCalls += 1;
      continue;
    }

    const normalized = String(result.text || '')
      .replace(MODEL_HUB_GATEWAY_PREFIX_RE, '')
      .trim();
    if (!normalized) {
      return {
        content:
          'Model returned no text output. Execution ended without a final narrative response. Please retry or continue with the latest task state.',
        metadata: withToolStats({
          ok: false,
          status: 'empty_model_response',
          runtime: 'model-hub',
          profileId: modelHubProfileId,
          model: result.model || null,
          provider: result.provider || null,
          usage: result.usage || null,
        }),
      };
    }

    return {
      content: normalized,
      metadata: withToolStats({
        ok: true,
        runtime: 'model-hub',
        profileId: modelHubProfileId,
        model: result.model,
        provider: result.provider,
        usage: result.usage || null,
      }),
    };
  }

  return {
    content: `Tool loop exceeded maximum rounds (${maxToolCalls}).`,
    metadata: withToolStats({
      ok: false,
      runtime: 'model-hub',
      profileId: modelHubProfileId,
      error: `Tool loop exceeded maximum rounds (${maxToolCalls}).`,
    }),
  };
}

function normalizeMaxToolCalls(requested?: number): number {
  if (!Number.isFinite(requested)) return MAX_TOOL_ROUNDS;
  const numeric = Math.floor(Number(requested));
  if (numeric < MAX_TOOL_ROUNDS) return MAX_TOOL_ROUNDS;
  return Math.min(numeric, TOOL_CALLS_HARD_CAP);
}

function buildToolSignature(functionName: string, args: Record<string, unknown>): string {
  let serializedArgs = '{}';
  try {
    serializedArgs = JSON.stringify(args || {});
  } catch {
    serializedArgs = '[unserializable-args]';
  }
  return `${functionName}:${serializedArgs}`;
}
