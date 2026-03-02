import type { ToolManager } from '@/server/channels/messages/service/toolManager';
import { getModelHubEncryptionKey, getModelHubService } from '@/server/model-hub/runtime';
import {
  MAX_REPEATED_FAILED_TOOL_CALLS,
  MAX_TOOL_ROUNDS,
  MODEL_HUB_GATEWAY_PREFIX_RE,
  TOOL_CALLS_HARD_CAP,
} from '@/server/channels/messages/service/types';
import {
  buildArgsHash,
  buildResultHash,
  createLoopDetectorState,
  detectLoop,
  recordCall,
  recordOutcome,
} from '@/server/channels/messages/service/toolLoopDetector';
import type { ModelOutcome, RunModelToolLoopParams } from './types';

export async function runModelToolLoop(
  toolManager: ToolManager,
  params: RunModelToolLoopParams,
): Promise<ModelOutcome> {
  const { conversation, messages, modelHubProfileId, preferredModelId, toolContext } = params;
  const encryptionKey = getModelHubEncryptionKey();
  const maxToolCalls = normalizeMaxToolCalls(params.maxToolCalls);
  let executedToolCalls = 0;
  let failedToolSignature: string | null = null;
  let consecutiveFailedSameToolCalls = 0;
  const loopState = createLoopDetectorState();

  const withToolStats = <T extends Record<string, unknown>>(metadata: T) => ({
    ...metadata,
    executedToolCalls,
  });

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

      params.onStreamDelta?.('\x00tc:');
      const resultOutput = toolExecution.output;
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
      }
      if (postCheck.level === 'warning') {
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
