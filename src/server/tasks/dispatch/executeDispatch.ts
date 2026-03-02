import { MAX_DISPATCH_ATTEMPTS, classifyDispatchFailure } from './failure';
import type {
  DispatchChatSendResult,
  DispatchExecutionResult,
  PreparedDispatchContext,
} from './types';

export async function executeDispatch(
  context: PreparedDispatchContext,
): Promise<DispatchExecutionResult> {
  const { task, session, taskMessage, client } = context;
  const sessionKey = `agent:main:${session.openclaw_session_id}`;
  let sendResult: DispatchChatSendResult | null = null;

  for (let attempt = 1; attempt <= MAX_DISPATCH_ATTEMPTS; attempt += 1) {
    sendResult = await client.call<DispatchChatSendResult>('chat.send', {
      sessionKey,
      message: taskMessage,
      idempotencyKey: `dispatch-${task.id}-${Date.now()}-${attempt}`,
    });

    const failure = classifyDispatchFailure(sendResult);
    if (!failure) {
      return { kind: 'result', sendResult };
    }

    const isLastAttempt = attempt >= MAX_DISPATCH_ATTEMPTS;
    if (!failure.retryable || isLastAttempt) {
      console.error(
        `Dispatch failed for task ${task.id} on attempt ${attempt}/${MAX_DISPATCH_ATTEMPTS}`,
        {
          message: failure.message,
          details: failure.details,
          agentContent: sendResult?.agentContent,
        },
      );

      return {
        kind: 'response',
        response: {
          status: 502,
          body: {
            error: failure.message,
            details: failure.details ?? sendResult?.agentMetadata ?? null,
          },
        },
      };
    }

    console.warn(
      `Dispatch retry ${attempt}/${MAX_DISPATCH_ATTEMPTS} for task ${task.id}: ${failure.message}`,
    );
  }

  return { kind: 'result', sendResult };
}
