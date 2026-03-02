import type { DispatchChatSendResult, DispatchFailure } from './types';

export const MAX_DISPATCH_ATTEMPTS = 3;

export function classifyDispatchFailure(
  result: DispatchChatSendResult | null | undefined,
): DispatchFailure | null {
  const metadata = result?.agentMetadata ?? {};
  const executionStatus = String(metadata.status || '')
    .trim()
    .toLowerCase();
  const content = String(result?.agentContent || '').trim();
  const contentLower = content.toLowerCase();

  if (executionStatus === 'tool_execution_required_unmet') {
    return {
      message:
        'Agent dispatch failed: no real execution was performed. Please retry dispatch after adjusting task instructions.',
      retryable: false,
      details: metadata,
    };
  }

  if (contentLower.startsWith('ai dispatch failed:')) {
    return {
      message: `Agent dispatch failed: ${content}`,
      retryable:
        contentLower.includes('aborted') ||
        contentLower.includes('all models failed') ||
        contentLower.includes('timeout') ||
        contentLower.includes('temporarily'),
      details: metadata,
    };
  }

  if (contentLower.startsWith('execution failed:')) {
    return {
      message: content || 'Agent execution failed.',
      retryable: false,
      details: metadata,
    };
  }

  if (metadata.ok === false) {
    const statusText = executionStatus || 'unknown_error';
    return {
      message: `Agent dispatch failed (${statusText}).`,
      retryable:
        statusText.includes('aborted') ||
        statusText.includes('timeout') ||
        statusText.includes('temporary') ||
        statusText.includes('rate_limit'),
      details: metadata,
    };
  }

  return null;
}
