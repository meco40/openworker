import type { ChannelType } from '@/shared/domain/types';
import type { Conversation } from '@/server/channels/messages/repository';
import {
  completeSubagentRun,
  failSubagentRun,
  type SubagentRunRecord,
} from '@/server/agents/subagentRegistry';
import type { SubagentManager } from '@/server/channels/messages/service/subagentManager';
import type { ToolManager } from '@/server/channels/messages/service/toolManager';
import {
  SUBAGENT_RESULT_PREVIEW_MAX_CHARS,
  SUBAGENT_ANNOUNCE_MAX_CHARS,
} from '@/server/channels/messages/service/types';
import type { CommandHandlerDeps } from '@/server/channels/messages/service/utils/responseHelper';

export interface SubagentExecutorDeps {
  subagentManager: SubagentManager;
  toolManager: ToolManager;
  resolveChatModelRouting: (conversation: Conversation) => {
    preferredModelId?: string;
    modelHubProfileId: string;
  };
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
    },
  ) => Promise<{ content: string; metadata: Record<string, unknown> }>;
}

export async function runSubagent(
  deps: SubagentExecutorDeps,
  sendResponse: (
    conversation: Conversation,
    content: string,
    platform: ChannelType,
    externalChatId: string,
    metadata?: Record<string, unknown>,
  ) => Promise<import('@/server/channels/messages/repository').StoredMessage>,
  params: {
    conversation: Conversation;
    platform: ChannelType;
    externalChatId: string;
    run: SubagentRunRecord;
  },
): Promise<void> {
  const { conversation, platform, externalChatId, run } = params;
  const abortController = new AbortController();
  const { attachSubagentRuntime, detachSubagentRuntime } =
    await import('@/server/agents/subagentRegistry');
  attachSubagentRuntime(run.runId, { abortController });

  try {
    const routing = deps.resolveChatModelRouting(conversation);
    const toolContext = deps.subagentManager.filterToolContextForSubagent(
      await deps.toolManager.resolveToolContext(),
    );
    const preferredModelId = run.modelOverride || routing.preferredModelId;
    const messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }> = [
      {
        role: 'system',
        content:
          'You are a focused subagent. Solve only the delegated task and return concise, factual results.',
      },
      ...(run.workspacePath
        ? [
            {
              role: 'system' as const,
              content: `Task workspace directory: ${run.workspacePath}`,
            },
          ]
        : []),
      {
        role: 'user',
        content: run.guidance
          ? `${run.task}\n\nAdditional guidance from requester:\n${run.guidance}`
          : run.task,
      },
    ];

    const modelOutcome = await deps.runModelToolLoop(deps.toolManager, {
      conversation,
      messages,
      modelHubProfileId: routing.modelHubProfileId,
      preferredModelId,
      workspaceCwd: run.workspacePath,
      toolContext,
      abortSignal: abortController.signal,
    });

    const preview = (modelOutcome.content || '').trim().slice(0, SUBAGENT_RESULT_PREVIEW_MAX_CHARS);
    completeSubagentRun(run.runId, preview);

    const announceContent = [
      `Subagent ${run.agentId} finished (${run.runId.slice(0, 8)}).`,
      '',
      preview || '(empty response)',
    ].join('\n');

    await sendResponse(
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
      await sendResponse(
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

export async function invokeSubagentToolCall(
  deps: SubagentExecutorDeps & {
    getConversation: (conversationId: string, userId: string) => Conversation | null;
    getCommandHandlerDeps: () => CommandHandlerDeps;
  },
  params: {
    args: Record<string, unknown>;
    conversationId: string;
    userId: string;
    platform: ChannelType;
    externalChatId: string;
  },
): Promise<Record<string, unknown>> {
  const conversation = deps.getConversation(params.conversationId, params.userId);
  if (!conversation) {
    return {
      status: 'error',
      error: 'Conversation not found for subagent tool context.',
    };
  }

  const actionRaw = String(params.args.action || 'list')
    .trim()
    .toLowerCase();
  const validActions = ['spawn', 'kill', 'steer', 'log', 'info', 'help', 'list'] as const;
  const action = validActions.includes(actionRaw as (typeof validActions)[number])
    ? (actionRaw as (typeof validActions)[number])
    : 'list';

  const args: string[] = [];
  if (action === 'spawn') {
    const agentId = String(params.args.agentId || 'worker').trim();
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

  const result = await deps.subagentManager.executeSubagentAction(
    {
      conversation,
      platform: params.platform,
      externalChatId: params.externalChatId,
    },
    action,
    args.filter(Boolean),
    deps.getCommandHandlerDeps(),
  );

  return {
    status: (result.payload?.status as string) || 'ok',
    action,
    text: result.text,
    ...(result.payload || {}),
  };
}
