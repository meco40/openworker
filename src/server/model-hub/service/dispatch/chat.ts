import {
  dispatchGatewayRequest,
  type GatewayRequest,
  type GatewayResponse,
} from '@/server/model-hub/gateway';
import type { ModelHubRepository } from '@/server/model-hub/repository';
import { maybeRefreshOpenAICodexAccount } from '../provider';
import { mapPipelineReasoningEffort } from '../utils';
import type { DispatchWithFallbackOptions } from '../types';

export async function dispatchChat(
  repository: ModelHubRepository,
  accountId: string,
  encryptionKey: string,
  request: GatewayRequest,
): Promise<GatewayResponse> {
  const account = await maybeRefreshOpenAICodexAccount(
    repository,
    repository.getAccountRecordById(accountId)!,
    encryptionKey,
  );
  if (!account) {
    return {
      ok: false,
      text: '',
      model: request.model,
      provider: 'unknown',
      error: `Account ${accountId} not found.`,
    };
  }
  return dispatchGatewayRequest(account, encryptionKey, request);
}

/**
 * Dispatches a chat request using the pipeline's priority fallback.
 * Tries each active model in priority order until one succeeds.
 *
 * If modelOverride is specified, tries the preferred model first,
 * then falls back to other active models in the pipeline.
 */
export async function dispatchWithFallback(
  repository: ModelHubRepository,
  profileId: string,
  encryptionKey: string,
  request: Omit<GatewayRequest, 'model'>,
  options?: DispatchWithFallbackOptions,
): Promise<GatewayResponse> {
  const pipeline = repository.listPipelineModels(profileId);
  const activeModels = pipeline.filter((m) => m.status === 'active');

  if (activeModels.length === 0) {
    return {
      ok: false,
      text: '',
      model: '',
      provider: '',
      error: 'No active models in pipeline.',
    };
  }

  const errors: string[] = [];
  const attemptedModels = new Set<string>();

  // If modelOverride is specified, try preferred model first
  if (options?.modelOverride) {
    const preferredTarget = activeModels.find((m) => m.modelName === options.modelOverride);
    if (!preferredTarget) {
      errors.push(`Override model "${options.modelOverride}" not found in active pipeline.`);
    } else {
      const preferredAccount = repository.getAccountRecordById(preferredTarget.accountId);
      if (preferredAccount) {
        const usablePreferredAccount = await maybeRefreshOpenAICodexAccount(
          repository,
          preferredAccount,
          encryptionKey,
        );
        const preferredReasoningEffort = mapPipelineReasoningEffort(
          preferredTarget.reasoningEffort,
        );
        const preferredResult = await dispatchGatewayRequest(
          usablePreferredAccount,
          encryptionKey,
          {
            ...request,
            model: preferredTarget.modelName,
            reasoning_effort: preferredReasoningEffort ?? request.reasoning_effort,
          },
          { signal: options?.signal, onStreamDelta: options?.onStreamDelta },
        );

        if (preferredResult.ok) {
          return preferredResult;
        }

        // Preferred model failed - record error and mark as rate-limited if needed
        errors.push(
          `${preferredTarget.modelName}@${preferredTarget.providerId}: ${preferredResult.error}`,
        );
        attemptedModels.add(preferredTarget.modelName);

        if (
          preferredResult.error?.includes('429') ||
          preferredResult.error?.toLowerCase().includes('rate')
        ) {
          repository.updatePipelineModelStatus(preferredTarget.id, 'rate-limited');
        }
      } else {
        errors.push(
          `${preferredTarget.modelName}@${preferredTarget.providerId}: Account not found`,
        );
      }
    }
  }

  // Try remaining active models in priority order (fallback)
  for (const entry of activeModels) {
    // Skip if already attempted (preferred model)
    if (attemptedModels.has(entry.modelName)) continue;

    // Check abort before each model attempt
    if (options?.signal?.aborted) {
      return { ok: false, text: '', model: '', provider: '', error: 'Aborted' };
    }

    const account = repository.getAccountRecordById(entry.accountId);
    if (!account) continue;
    const usableAccount = await maybeRefreshOpenAICodexAccount(repository, account, encryptionKey);
    const pipelineReasoningEffort = mapPipelineReasoningEffort(entry.reasoningEffort);

    const result = await dispatchGatewayRequest(
      usableAccount,
      encryptionKey,
      {
        ...request,
        model: entry.modelName,
        reasoning_effort: pipelineReasoningEffort ?? request.reasoning_effort,
      },
      { signal: options?.signal, onStreamDelta: options?.onStreamDelta },
    );

    if (result.ok) {
      return result;
    }

    errors.push(`${entry.modelName}@${entry.providerId}: ${result.error}`);

    // Mark as rate-limited if the error suggests it
    if (result.error?.includes('429') || result.error?.toLowerCase().includes('rate')) {
      repository.updatePipelineModelStatus(entry.id, 'rate-limited');
    }
  }

  return {
    ok: false,
    text: '',
    model: '',
    provider: '',
    error: `All models failed: ${errors.join(' | ')}`,
  };
}
