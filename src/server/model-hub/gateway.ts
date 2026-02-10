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

  if (adapter?.dispatchGateway) {
    return adapter.dispatchGateway(context, request);
  }

  if (provider.apiBaseUrl) {
    return dispatchOpenAICompatibleChat(provider.apiBaseUrl, secret, provider.id, request);
  }

  return {
    ok: false,
    text: '',
    model: request.model,
    provider: provider.id,
    error: `No gateway adapter for provider: ${provider.name}`,
  };
}

export type { GatewayMessage, GatewayRequest, GatewayResponse };
