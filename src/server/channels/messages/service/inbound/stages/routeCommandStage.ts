import {
  handleApprovalCommand,
  handleAutomationCommand,
  handlePersonaCommand,
  handleProjectCommand,
  handleShellCommand,
  handleSubagentCommand,
} from '@/server/channels/messages/service/commands';
import { ROLEPLAY_TOOLS_DISABLED_MESSAGE } from '@/server/channels/messages/service/core/toolPolicy';
import { getProjectClarificationKey } from '@/server/channels/messages/service/core/projectManagement';
import type { RouteResult } from '@/server/channels/messages/messageRouter';
import type { StoredMessage } from '@/server/channels/messages/repository';
import type { HandleInboundDeps } from '../handleInbound';

interface RouteStageParams {
  deps: HandleInboundDeps;
  route: RouteResult;
  userMsg: StoredMessage;
  effectiveConversation: Parameters<typeof handleAutomationCommand>[0];
  platform: Parameters<typeof handleAutomationCommand>[2];
  externalChatId: string;
  userId?: string;
  toolsDisabledForPersona: boolean;
}

export interface RouteStageResult {
  userMsg: StoredMessage;
  agentMsg: StoredMessage;
  newConversationId?: string;
}

export async function routeCommandStage(
  params: RouteStageParams,
): Promise<RouteStageResult | null> {
  const {
    deps,
    route,
    userMsg,
    effectiveConversation,
    platform,
    externalChatId,
    userId,
    toolsDisabledForPersona,
  } = params;

  if (route.target === 'session-command') {
    const newConv = deps.repo.createConversation({
      channelType: platform,
      externalChatId: `manual-${userId || 'local'}-${Date.now()}`,
      title: route.payload || undefined,
      userId: effectiveConversation.userId,
    });
    const agentMsg = await deps.sendResponse(
      effectiveConversation,
      '✨ Neue Konversation erstellt.',
      platform,
      externalChatId,
    );
    return { userMsg, agentMsg, newConversationId: newConv.id };
  }

  if (route.target === 'automation-command') {
    return {
      userMsg,
      agentMsg: await handleAutomationCommand(
        effectiveConversation,
        route.payload,
        platform,
        externalChatId,
        deps.sendResponse,
      ),
    };
  }

  if (route.target === 'persona-command') {
    return {
      userMsg,
      agentMsg: await handlePersonaCommand(
        effectiveConversation,
        route.payload,
        platform,
        externalChatId,
        deps.repo,
        deps.sendResponse,
      ),
    };
  }

  if (route.target === 'project-command') {
    deps.state.pendingProjectClarifications.delete(
      getProjectClarificationKey(effectiveConversation),
    );
    return {
      userMsg,
      agentMsg: await handleProjectCommand(
        effectiveConversation,
        route.payload,
        platform,
        externalChatId,
        deps.repo,
        deps.sendResponse,
      ),
    };
  }

  if (route.target === 'approval-command') {
    return {
      userMsg,
      agentMsg: await handleApprovalCommand(
        effectiveConversation,
        route.payload,
        route.command,
        platform,
        externalChatId,
        deps.getCommandHandlerDeps(),
        deps.respondToolApproval,
      ),
    };
  }

  if (route.target === 'shell-command') {
    if (toolsDisabledForPersona) {
      return {
        userMsg,
        agentMsg: await deps.sendResponse(
          effectiveConversation,
          ROLEPLAY_TOOLS_DISABLED_MESSAGE,
          platform,
          externalChatId,
          {
            ok: false,
            status: 'tools_disabled_for_roleplay',
          },
        ),
      };
    }
    return {
      userMsg,
      agentMsg: await handleShellCommand(
        effectiveConversation,
        route.payload,
        platform,
        externalChatId,
        deps.getCommandHandlerDeps(),
      ),
    };
  }

  if (route.target === 'subagent-command') {
    if (toolsDisabledForPersona) {
      return {
        userMsg,
        agentMsg: await deps.sendResponse(
          effectiveConversation,
          ROLEPLAY_TOOLS_DISABLED_MESSAGE,
          platform,
          externalChatId,
          {
            ok: false,
            status: 'tools_disabled_for_roleplay',
          },
        ),
      };
    }
    return {
      userMsg,
      agentMsg: await handleSubagentCommand(
        {
          conversation: effectiveConversation,
          platform,
          externalChatId,
        },
        route.payload,
        route.command,
        deps.getCommandHandlerDeps(),
      ),
    };
  }

  return null;
}
