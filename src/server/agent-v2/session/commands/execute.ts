/**
 * Command execution operations.
 */

import type { AgentV2Repository } from '@/server/agent-v2/repository';
import type {
  AgentCommand,
  AgentCommandResult,
  AgentSessionSnapshot,
  AgentV2EventEnvelope,
} from '@/server/agent-v2/types';
import { getMessageService } from '@/server/channels/messages/runtime';
import type { AgentV2ExtensionHost } from '@/server/agent-v2/extensions/host';
import { buildApprovalResultMessage, safeJsonParse } from '../utils';

export interface ExecuteContext {
  repository: AgentV2Repository;
  extensionHost: AgentV2ExtensionHost;
  activeHandles: Map<string, { sessionId: string; userId: string; snapshot: AgentSessionSnapshot }>;
  getSession: (sessionId: string, userId: string) => AgentSessionSnapshot;
  runHooks: (stage: string, context: unknown) => Promise<void>;
  emitPersistedEvents: (userId: string, events: unknown[]) => void;
  emitEphemeralEvent: (params: {
    sessionId: string;
    userId: string;
    commandId?: string;
    type: AgentV2EventEnvelope['type'];
    payload: Record<string, unknown>;
  }) => Promise<void>;
}

/**
 * Executes a single command based on its type.
 */
export async function executeCommand(
  command: AgentCommand,
  userId: string,
  ctx: ExecuteContext,
): Promise<AgentCommandResult> {
  const session = ctx.getSession(command.sessionId, userId);
  if (command.commandType === 'abort') {
    const aborted = getMessageService().abortGeneration(session.conversationId);
    return {
      status: 'ok',
      message: aborted ? 'Abort signal sent.' : 'No in-flight command to abort.',
      metadata: { aborted },
    };
  }

  if (command.commandType === 'approval') {
    return executeApprovalCommand(command, session, userId, ctx);
  }

  return executeContentCommand(command, session, userId, ctx);
}

/**
 * Executes an approval command.
 */
async function executeApprovalCommand(
  command: AgentCommand,
  session: AgentSessionSnapshot,
  userId: string,
  ctx: ExecuteContext,
): Promise<AgentCommandResult> {
  const payload = command.payload;
  const approvalToken = String(payload.approvalToken || '').trim();
  if (!approvalToken) {
    return { status: 'error', message: 'approvalToken is required.' };
  }

  const result = await getMessageService().respondToolApproval({
    conversationId: session.conversationId,
    userId,
    approvalToken,
    approved: Boolean(payload.approved),
    approveAlways: Boolean(payload.approveAlways),
    toolId: payload.toolId ? String(payload.toolId) : undefined,
    toolFunctionName: payload.toolFunctionName ? String(payload.toolFunctionName) : undefined,
  });

  if (result.status === 'approval_required') {
    const event = ctx.repository.appendEvent({
      sessionId: session.id,
      userId,
      commandId: command.id,
      type: 'agent.v2.approval.required',
      payload: {
        approvalToken,
        reason: 'Further approval is required.',
      },
    });
    ctx.emitPersistedEvents(userId, [event]);
  }

  return {
    status: result.status === 'not_found' ? 'error' : 'ok',
    message: buildApprovalResultMessage(result.status),
    metadata: {
      status: result.status,
      policyUpdated: result.policyUpdated,
    },
  };
}

/**
 * Executes a content-based command (input, steer, follow_up).
 */
async function executeContentCommand(
  command: AgentCommand,
  session: AgentSessionSnapshot,
  userId: string,
  ctx: ExecuteContext,
): Promise<AgentCommandResult> {
  const content = String(command.payload.content || '').trim();
  if (!content) {
    return {
      status: 'error',
      message: `${command.commandType} requires non-empty content.`,
    };
  }

  await ctx.runHooks('model.before_dispatch', {
    session,
    command,
    stage: 'model.before_dispatch',
    payload: {
      commandType: command.commandType,
    },
  });

  let activeTool: string | null = null;
  const messageService = getMessageService();
  const result = await messageService.handleWebUIMessage(
    session.conversationId,
    content,
    userId,
    undefined,
    undefined,
    (delta) =>
      handleStreamDelta(
        delta,
        session,
        command,
        ctx,
        () => activeTool,
        (tool) => {
          activeTool = tool;
        },
      ),
    { skipProjectGuard: true },
  );

  await ctx.runHooks('model.after_dispatch', {
    session: ctx.getSession(session.id, userId),
    command,
    stage: 'model.after_dispatch',
    payload: {
      messageId: result.agentMsg.id,
    },
  });

  const metadata = safeJsonParse<Record<string, unknown>>(result.agentMsg.metadata);
  if (String(metadata?.status || '').trim() === 'approval_required') {
    const event = ctx.repository.appendEvent({
      sessionId: session.id,
      userId,
      commandId: command.id,
      type: 'agent.v2.approval.required',
      payload: metadata || {},
    });
    ctx.emitPersistedEvents(userId, [event]);
    await ctx.runHooks('approval.required', {
      session: ctx.getSession(session.id, userId),
      command,
      stage: 'approval.required',
      payload: metadata || {},
    });
  }

  return {
    status: 'ok',
    message: result.agentMsg.content,
    metadata: {
      userMessageId: result.userMsg.id,
      agentMessageId: result.agentMsg.id,
      newConversationId: result.newConversationId || null,
      status: metadata?.status || 'ok',
    },
  };
}

/**
 * Handles stream delta from the message service.
 */
function handleStreamDelta(
  delta: string,
  session: AgentSessionSnapshot,
  command: AgentCommand,
  ctx: ExecuteContext,
  getActiveTool: () => string | null,
  setActiveTool: (tool: string | null) => void,
): void {
  if (typeof delta !== 'string') return;
  if (delta.startsWith('\u0000tc:')) {
    const toolName = delta.slice('\u0000tc:'.length).trim();
    if (toolName) {
      setActiveTool(toolName);
      void ctx.emitEphemeralEvent({
        sessionId: session.id,
        userId: session.userId,
        commandId: command.id,
        type: 'agent.v2.tool.started',
        payload: { toolName },
      });
      void ctx
        .runHooks('tool.before_execute', {
          session,
          command,
          stage: 'tool.before_execute',
          payload: { toolName },
        })
        .catch(() => {});
    } else {
      const completedTool = getActiveTool();
      setActiveTool(null);
      if (completedTool) {
        void ctx.emitEphemeralEvent({
          sessionId: session.id,
          userId: session.userId,
          commandId: command.id,
          type: 'agent.v2.tool.completed',
          payload: { toolName: completedTool },
        });
        void ctx
          .runHooks('tool.after_execute', {
            session,
            command,
            stage: 'tool.after_execute',
            payload: { toolName: completedTool },
          })
          .catch(() => {});
        if (ctx.repository.hasQueuedAbort(session.id)) {
          getMessageService().abortGeneration(session.conversationId);
        }
      }
    }
    return;
  }

  void ctx.emitEphemeralEvent({
    sessionId: session.id,
    userId: session.userId,
    commandId: command.id,
    type: 'agent.v2.model.delta',
    payload: { delta },
  });
}
