import type { Conversation } from '@/server/channels/messages/repository';
import type { ContextBuilder } from '@/server/channels/messages/contextBuilder';
import type { RecallService } from '@/server/channels/messages/service/recall';
import type { SummaryService } from '@/server/channels/messages/service/summaryService';
import type { ToolManager } from '@/server/channels/messages/service/toolManager';
import { prepareDispatchMessages } from '@/server/channels/messages/service/dispatchers/ai/prepareDispatchMessages';
import { runModelToolLoop } from '@/server/channels/messages/service/dispatchers/ai/runModelToolLoop';
import type {
  DispatchToAIParams,
  ModelOutcome,
  RunModelToolLoopParams,
  ToolContextState,
} from './ai/types';

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
    params: RunModelToolLoopParams,
  ) => Promise<ModelOutcome>;
  activeRequests: Map<string, AbortController>;
}

function createEmptyToolContext(): ToolContextState {
  return {
    tools: [],
    installedFunctionNames: new Set<string>(),
    functionToSkillId: new Map<string, string>(),
  };
}

function resolveDispatchFailure(error: unknown): ModelOutcome {
  if (error instanceof Error && error.name === 'AbortError') {
    return {
      content: 'Generation aborted.',
      metadata: { ok: false, aborted: true },
    };
  }
  return {
    content: `AI dispatch failed: ${error instanceof Error ? error.message : String(error)}`,
    metadata: {
      ok: false,
      error: error instanceof Error ? error.message : 'AI dispatch failed',
    },
  };
}

function enforceRequiredToolExecution(
  modelOutcome: ModelOutcome,
  requireToolCall?: boolean,
): ModelOutcome {
  const executedToolCalls = Number(modelOutcome.metadata?.executedToolCalls ?? 0);
  const status = String(modelOutcome.metadata?.status || '');
  if (!requireToolCall || executedToolCalls >= 1 || status === 'approval_required') {
    return modelOutcome;
  }

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

export async function dispatchToAI(
  deps: AIDispatcherDeps,
  params: DispatchToAIParams,
): Promise<ModelOutcome> {
  const { conversation, userInput, maxToolCalls, onStreamDelta, executionDirective } = params;
  const { messages, memoryContext } = await prepareDispatchMessages(
    {
      contextBuilder: deps.contextBuilder,
      recallService: deps.recallService,
      resolveConversationWorkspaceCwd: deps.resolveConversationWorkspaceCwd,
    },
    {
      conversation,
      userInput,
      executionDirective,
      toolsDisabled: params.toolsDisabled,
    },
  );

  const existingController = deps.activeRequests.get(conversation.id);
  if (existingController) {
    existingController.abort();
  }
  const abortController = new AbortController();
  deps.activeRequests.set(conversation.id, abortController);

  let modelOutcome: ModelOutcome;
  try {
    const { preferredModelId, modelHubProfileId } = deps.resolveChatModelRouting(conversation);
    const workspaceCwd = deps.resolveConversationWorkspaceCwd?.(conversation);
    const toolContext = params.toolsDisabled
      ? createEmptyToolContext()
      : await deps.toolManager.resolveToolContext();

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
    modelOutcome = resolveDispatchFailure(error);
  } finally {
    deps.activeRequests.delete(conversation.id);
  }

  if (!params.skipSummaryRefresh) {
    void deps.summaryService.maybeRefreshConversationSummary(conversation);
  }

  return enforceRequiredToolExecution(modelOutcome, params.requireToolCall);
}

export { runModelToolLoop };
