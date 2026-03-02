import {
  maybeConsumeProjectClarificationReply,
  maybeRequestProjectClarification,
  resolveConversationWorkspaceCwd,
} from '@/server/channels/messages/service/core/projectManagement';
import { handleMemorySave } from '@/server/channels/messages/service/handlers/memoryHandler';
import { inferShellCommandFromNaturalLanguage } from '@/server/channels/messages/service/types';
import { handleInferredShellQuestion } from '@/server/channels/messages/service/handlers/shellInference';
import {
  isMemoryEnabledForConversation,
  resolveChatModelRouting,
} from '@/server/channels/messages/service/routing/modelRouting';
import type { StoredMessage } from '@/server/channels/messages/repository';
import type { HandleInboundDeps, HandleInboundParams } from '../handleInbound';

export type PrepareDispatchStageResult =
  | { kind: 'continue'; effectiveUserInput: string; projectCreatedFromClarification: string | null }
  | { kind: 'done'; result: { userMsg: StoredMessage; agentMsg: StoredMessage } };

interface PrepareDispatchStageParams {
  deps: HandleInboundDeps;
  params: HandleInboundParams;
  userMsg: StoredMessage;
  effectiveConversation: ReturnType<HandleInboundDeps['sessionManager']['getOrCreateConversation']>;
  toolsDisabledForPersona: boolean;
}

export async function prepareDispatchStage(
  input: PrepareDispatchStageParams,
): Promise<PrepareDispatchStageResult> {
  const { deps, params, userMsg, effectiveConversation, toolsDisabledForPersona } = input;
  const { platform, externalChatId, content, onStreamDelta, opts } = params;
  const memoryEnabledForConversation = isMemoryEnabledForConversation(
    effectiveConversation,
    deps.repo,
  );
  let effectiveUserInput = content;
  let projectCreatedFromClarification: string | null = null;

  const consumedClarification = await maybeConsumeProjectClarificationReply({
    conversation: effectiveConversation,
    platform,
    externalChatId,
    content,
    repo: deps.repo,
    pendingProjectClarifications: deps.state.pendingProjectClarifications,
    sendResponse: deps.sendResponse,
  });

  if (consumedClarification && 'message' in consumedClarification) {
    return { kind: 'done', result: { userMsg, agentMsg: consumedClarification.message } };
  }
  if (consumedClarification && 'replayTaskInput' in consumedClarification) {
    effectiveUserInput = consumedClarification.replayTaskInput;
    projectCreatedFromClarification = consumedClarification.projectName;
  }

  if (memoryEnabledForConversation) {
    void deps.recallService.maybeLearnFromFeedback(effectiveConversation, content);
  }

  const memorySaveResult = await handleMemorySave(
    {
      conversation: effectiveConversation,
      content,
      platform,
      externalChatId,
      memoryEnabled: memoryEnabledForConversation,
    },
    deps.sendResponse,
  );

  if (memorySaveResult.message) {
    return { kind: 'done', result: { userMsg, agentMsg: memorySaveResult.message } };
  }

  const projectClarificationMessage = opts?.skipProjectGuard
    ? null
    : await maybeRequestProjectClarification({
        conversation: effectiveConversation,
        platform,
        externalChatId,
        content: effectiveUserInput,
        repo: deps.repo,
        pendingProjectClarifications: deps.state.pendingProjectClarifications,
        sendResponse: deps.sendResponse,
      });
  if (projectClarificationMessage) {
    return { kind: 'done', result: { userMsg, agentMsg: projectClarificationMessage } };
  }

  const inferredShellCommand = inferShellCommandFromNaturalLanguage(effectiveUserInput);
  if (inferredShellCommand && !toolsDisabledForPersona) {
    const inferredShellMessage = await handleInferredShellQuestion(
      {
        contextBuilder: deps.contextBuilder,
        toolManager: deps.toolManager,
        resolveChatModelRouting: deps.resolveChatModelRouting ?? resolveChatModelRouting,
        resolveConversationWorkspaceCwd: (conversation) =>
          resolveConversationWorkspaceCwd(conversation, deps.repo),
      },
      deps.sendResponse,
      {
        conversation: effectiveConversation,
        platform,
        externalChatId,
        userInput: effectiveUserInput,
        command: inferredShellCommand,
        onStreamDelta,
      },
    );
    return { kind: 'done', result: { userMsg, agentMsg: inferredShellMessage } };
  }

  const strictRecall = memoryEnabledForConversation
    ? await deps.recallService.buildStrictEvidenceReply(effectiveConversation, effectiveUserInput)
    : null;
  if (strictRecall) {
    const agentMsg = await deps.sendResponse(
      effectiveConversation,
      strictRecall.content,
      platform,
      externalChatId,
      strictRecall.metadata,
    );
    return { kind: 'done', result: { userMsg, agentMsg } };
  }

  return { kind: 'continue', effectiveUserInput, projectCreatedFromClarification };
}
