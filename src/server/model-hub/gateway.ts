import {
  getProviderAdapter,
  type GatewayMessage,
  type GatewayRequest,
  type GatewayResponse,
} from './Models';
import { dispatchOpenAICompatibleChat } from './Models/shared/openaiCompatible';
import { decryptSecret } from './crypto';
import { PROVIDER_CATALOG } from './providerCatalog';
import type { ProviderAccountRecord } from './repository';
import type { ProviderCatalogEntry } from './types';
import { getTokenUsageRepository } from '../stats/tokenUsageRepository';
import { getPromptDispatchRepository } from '../stats/promptDispatchRepository';
import {
  detectPromptInjection,
  estimatePromptTokens,
  redactGatewayRequest,
} from '../stats/promptAudit';
import {
  markPromptDispatchAttempt,
  markPromptDispatchError,
  markPromptDispatchInsert,
} from '../stats/promptDispatchDiagnostics';
import { getOpenRouterModelPricing } from '../stats/openRouterPricing';
import { getXaiModelPricing } from '../stats/xaiPricing';

function findProvider(providerId: string): ProviderCatalogEntry | null {
  return PROVIDER_CATALOG.find((provider) => provider.id === providerId) ?? null;
}

/**
 * Dispatches a chat request through the appropriate provider.
 * Handles all configured providers using modular provider adapters.
 */
export async function dispatchGatewayRequest(
  account: ProviderAccountRecord,
  encryptionKey: string,
  request: GatewayRequest,
  options?: { signal?: AbortSignal },
): Promise<GatewayResponse> {
  const provider = findProvider(account.providerId);
  if (!provider) {
    return {
      ok: false,
      text: '',
      model: request.model,
      provider: account.providerId,
      error: `Unknown provider: ${account.providerId}`,
    };
  }

  const secret = decryptSecret(account.encryptedSecret, encryptionKey);
  if (!secret?.trim()) {
    return {
      ok: false,
      text: '',
      model: request.model,
      provider: provider.id,
      error: 'Account secret is missing or empty.',
    };
  }

  const adapter = getProviderAdapter(provider.id);
  const context = { provider, account, secret };

  let result: GatewayResponse;

  if (adapter?.dispatchGateway) {
    result = await adapter.dispatchGateway(context, request, { signal: options?.signal });
  } else if (provider.apiBaseUrl) {
    result = await dispatchOpenAICompatibleChat(provider.apiBaseUrl, secret, provider.id, request, {
      signal: options?.signal,
    });
  } else {
    result = {
      ok: false,
      text: '',
      model: request.model,
      provider: provider.id,
      error: `No gateway adapter for provider: ${provider.name}`,
    };
  }

  // Record token usage (fire-and-forget, never breaks dispatch)
  if (result.ok && result.usage) {
    try {
      getTokenUsageRepository().recordUsage(
        account.providerId,
        request.model,
        result.usage.prompt_tokens,
        result.usage.completion_tokens,
        result.usage.total_tokens,
      );
    } catch {
      // Silently ignore — stats must never break AI dispatch
    }
  }

  // Record prompt dispatch logs (fire-and-forget, never breaks dispatch)
  try {
    markPromptDispatchAttempt();
    const redactedRequest = redactGatewayRequest(request);
    const promptTokens =
      typeof result.usage?.prompt_tokens === 'number'
        ? result.usage.prompt_tokens
        : estimatePromptTokens(redactedRequest);
    const completionTokens = result.usage?.completion_tokens ?? 0;
    const totalTokens = result.usage?.total_tokens ?? promptTokens + completionTokens;
    const promptPayloadJson = JSON.stringify(redactedRequest);
    let promptCostUsd: number | null = null;
    let completionCostUsd: number | null = null;
    let totalCostUsd: number | null = null;

    if (account.providerId === 'openrouter') {
      const pricing = await getOpenRouterModelPricing(request.model, promptTokens, secret);
      if (pricing) {
        const requestCostUsd = Number.isFinite(pricing.requestPriceUsd)
          ? Math.max(0, pricing.requestPriceUsd)
          : 0;
        promptCostUsd = Math.max(0, promptTokens * pricing.promptPricePerTokenUsd);
        completionCostUsd = Math.max(0, completionTokens * pricing.completionPricePerTokenUsd);
        totalCostUsd = promptCostUsd + completionCostUsd + requestCostUsd;
      }
    } else if (account.providerId === 'xai') {
      const pricing = await getXaiModelPricing(request.model);
      if (pricing) {
        const requestCostUsd = Number.isFinite(pricing.requestPriceUsd)
          ? Math.max(0, pricing.requestPriceUsd)
          : 0;
        promptCostUsd = Math.max(0, promptTokens * pricing.promptPricePerTokenUsd);
        completionCostUsd = Math.max(0, completionTokens * pricing.completionPricePerTokenUsd);
        totalCostUsd = promptCostUsd + completionCostUsd + requestCostUsd;
      }
    }

    const promptPreview = redactedRequest.messages
      .map((message) => {
        const text = message.content.replace(/\s+/g, ' ').trim();
        const attachmentHint = (message.attachments || [])
          .map((attachment) => `[attachment:${attachment.name}:${attachment.mimeType}]`)
          .join(' ');
        return [text, attachmentHint].filter(Boolean).join(' ');
      })
      .join(' ')
      .slice(0, 600);

    const risk = detectPromptInjection([promptPreview, promptPayloadJson].join('\n'));

    const entry = getPromptDispatchRepository().recordDispatch({
      providerId: account.providerId,
      modelName: request.model,
      accountId: account.id,
      dispatchKind: request.auditContext?.kind || 'api_gateway',
      promptTokens: Math.max(0, promptTokens),
      promptTokensSource: typeof result.usage?.prompt_tokens === 'number' ? 'exact' : 'estimated',
      completionTokens: Math.max(0, completionTokens),
      totalTokens: Math.max(0, totalTokens),
      status: result.ok ? 'success' : 'error',
      errorMessage: result.ok ? null : result.error || null,
      riskLevel: risk.riskLevel,
      riskScore: risk.score,
      riskReasons: risk.reasons,
      promptPreview: promptPreview || '(empty prompt)',
      promptPayloadJson,
      promptCostUsd,
      completionCostUsd,
      totalCostUsd,
    });
    markPromptDispatchInsert(entry.createdAt);
  } catch (error) {
    markPromptDispatchError(error);
    // Silently ignore — prompt logging must never break AI dispatch
  }

  return result;
}

export type { GatewayMessage, GatewayRequest, GatewayResponse };
