import {
  dispatchToAI,
  runModelToolLoop,
} from '@/server/channels/messages/service/dispatchers/aiDispatcher';
import { isProjectRequiredIntent } from '@/server/channels/messages/service/projectGuard';
import {
  shouldAllowCodeInResponse,
  stripCodeBlocksIfNeeded,
} from '@/server/channels/messages/service/core/configuration';
import {
  buildAutonomousExecutionDirective,
  resolveMaxToolCalls,
  runBuildWorkspacePreflight,
} from '@/server/channels/messages/service/execution/buildExecution';
import { resolveConversationWorkspaceCwd } from '@/server/channels/messages/service/core/projectManagement';
import { resolveChatModelRouting } from '@/server/channels/messages/service/routing/modelRouting';
import { isExplicitRecallCommand } from '@/server/channels/messages/service/types';
import type { StoredMessage } from '@/server/channels/messages/repository';
import type { PersonaProfile } from '@/server/personas/personaTypes';
import type { HandleInboundDeps, HandleInboundParams } from '../handleInbound';

interface DispatchModelStageParams {
  deps: HandleInboundDeps;
  params: HandleInboundParams;
  userMsg: StoredMessage;
  effectiveConversation: ReturnType<HandleInboundDeps['sessionManager']['getOrCreateConversation']>;
  activePersona: PersonaProfile | null;
  toolsDisabledForPersona: boolean;
  effectiveUserInput: string;
  projectCreatedFromClarification: string | null;
}

export async function dispatchModelStage(
  input: DispatchModelStageParams,
): Promise<{ userMsg: StoredMessage; agentMsg: StoredMessage }> {
  const {
    deps,
    params,
    userMsg,
    effectiveConversation,
    activePersona,
    toolsDisabledForPersona,
    effectiveUserInput,
    projectCreatedFromClarification,
  } = input;

  const { platform, externalChatId, onStreamDelta, opts } = params;
  const activeWorkspaceCwd = resolveConversationWorkspaceCwd(effectiveConversation, deps.repo);
  const buildIntent = isProjectRequiredIntent(effectiveUserInput);
  const isAutonomousPersona = Boolean(activePersona?.isAutonomous);

  let dispatchUserInput = effectiveUserInput;
  const explicitRecallCommand = isExplicitRecallCommand(effectiveUserInput);
  if (buildIntent && activeWorkspaceCwd && !toolsDisabledForPersona) {
    const preflight = await runBuildWorkspacePreflight({
      conversation: effectiveConversation,
      platform,
      externalChatId,
      workspaceCwd: activeWorkspaceCwd,
      toolManager: deps.toolManager,
      sendResponse: deps.sendResponse,
    });
    if (preflight.kind === 'approval_required') {
      return { userMsg, agentMsg: preflight.message };
    }
    dispatchUserInput = `${effectiveUserInput}\n\n${preflight.text}`;
  }

  const autonomousExecutionDirective = buildAutonomousExecutionDirective({
    workspaceCwd: activeWorkspaceCwd,
    buildIntent: toolsDisabledForPersona ? false : buildIntent,
    isAutonomousPersona: toolsDisabledForPersona ? false : isAutonomousPersona,
  });
  const explicitExecutionDirective = String(opts?.executionDirective || '').trim();
  const roleplayToolDirective = toolsDisabledForPersona
    ? 'TOOL POLICY: Fuer diese Roleplay-Persona sind alle Tool-Calls deaktiviert.'
    : '';
  const combinedExecutionDirective = [roleplayToolDirective]
    .concat(explicitExecutionDirective || autonomousExecutionDirective || '')
    .filter((entry) => entry.trim().length > 0)
    .join('\n\n');
  const executionDirective =
    combinedExecutionDirective.trim().length > 0 ? combinedExecutionDirective : undefined;

  const modelOutcome = await dispatchToAI(
    {
      contextBuilder: deps.contextBuilder,
      recallService: deps.recallService,
      summaryService: deps.summaryService,
      toolManager: deps.toolManager,
      resolveChatModelRouting: deps.resolveChatModelRouting ?? resolveChatModelRouting,
      runModelToolLoop,
      resolveConversationWorkspaceCwd: (conversation) =>
        resolveConversationWorkspaceCwd(conversation, deps.repo),
      activeRequests: deps.state.activeRequests,
    },
    {
      conversation: effectiveConversation,
      platform,
      externalChatId,
      userInput: dispatchUserInput,
      onStreamDelta,
      turnSeq: userMsg.seq ?? undefined,
      executionDirective,
      maxToolCalls: resolveMaxToolCalls({
        isAutonomousPersona,
        activePersona,
        buildIntent,
        overrideMaxToolCalls: opts?.maxToolCalls,
      }),
      requireToolCall: opts?.requireToolCall,
      skipSummaryRefresh: explicitRecallCommand,
      toolsDisabled: toolsDisabledForPersona,
    },
  );

  const normalizedOutput = stripCodeBlocksIfNeeded(
    modelOutcome.content,
    shouldAllowCodeInResponse(effectiveUserInput, modelOutcome.metadata),
  );

  const finalOutput = projectCreatedFromClarification
    ? `Projekt automatisch erstellt und aktiviert: ${projectCreatedFromClarification}\n\n${normalizedOutput}`
    : normalizedOutput;

  const agentMsg = await deps.sendResponse(
    effectiveConversation,
    finalOutput,
    platform,
    externalChatId,
    {
      ...modelOutcome.metadata,
      ...(buildIntent && !toolsDisabledForPersona ? { executionMode: 'autonomous' } : {}),
      ...(activeWorkspaceCwd ? { workspaceCwd: activeWorkspaceCwd } : {}),
    },
  );

  return { userMsg, agentMsg };
}
