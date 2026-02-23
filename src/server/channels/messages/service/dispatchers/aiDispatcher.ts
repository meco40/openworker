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
} from '@/server/channels/messages/service/types';

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
  },
): Promise<{ content: string; metadata: Record<string, unknown> }> {
  const { conversation, userInput, onStreamDelta } = params;
  const messages = deps.contextBuilder.buildGatewayMessages(
    conversation.id,
    conversation.userId,
    50,
    conversation.personaId,
  );

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

  void deps.summaryService.maybeRefreshConversationSummary(conversation);
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
    abortSignal?: AbortSignal;
    onStreamDelta?: (delta: string) => void;
    auditContextExtras?: { turnSeq?: number; memoryContext?: string };
  },
): Promise<{ content: string; metadata: Record<string, unknown> }> {
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
      const toolExecution = await toolManager.executeToolFunctionCall({
        conversation,
        platform: conversation.channelType,
        externalChatId: conversation.externalChatId || 'default',
        functionName,
        args: (functionCall.args as Record<string, unknown>) || {},
        workspaceCwd: params.workspaceCwd,
        installedFunctions: toolContext.installedFunctionNames,
        toolId: toolContext.functionToSkillId.get(functionName),
      });

      if (toolExecution.kind === 'approval_required') {
        return {
          content: toolExecution.prompt,
          metadata: toolManager.buildApprovalMetadata(toolExecution.pending, toolExecution.prompt, {
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
