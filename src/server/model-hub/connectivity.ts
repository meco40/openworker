import { getProviderAdapter } from './Models';
import { testOpenAICompatibleModelsEndpoint } from './Models/shared/openaiCompatible';
import { decryptSecret } from './crypto';
import { PROVIDER_CATALOG } from './providerCatalog';
import type { ProviderAccountRecord } from './repository';

function findProvider(providerId: string) {
  return PROVIDER_CATALOG.find((provider) => provider.id === providerId) ?? null;
}

export async function testProviderAccountConnectivity(
  account: ProviderAccountRecord,
  encryptionKey: string,
  options: { model?: string } = {},
): Promise<{ ok: boolean; message: string }> {
  const provider = findProvider(account.providerId);
  if (!provider) {
    return { ok: false, message: `Unknown provider: ${account.providerId}` };
  }

  const secret = decryptSecret(account.encryptedSecret, encryptionKey);
  if (account.authMethod !== 'none' && (!secret || secret.trim().length === 0)) {
    return { ok: false, message: 'Missing secret token.' };
  }

  const adapter = getProviderAdapter(provider.id);
  const context = { provider, account, secret };

  if (adapter?.testConnectivity) {
    return adapter.testConnectivity(context, options);
  }

  if (provider.endpointType === 'openai-compatible') {
    const baseUrl = provider.apiBaseUrl?.replace(/\/$/, '');
    if (!baseUrl) {
      return { ok: false, message: `${provider.name} has no configured API base URL.` };
    }

    return testOpenAICompatibleModelsEndpoint(
      baseUrl,
      secret,
      `${provider.name} connectivity verified.`,
      `${provider.name} connectivity failed: `,
    );
  }

  return {
    ok: false,
    message: `${provider.name} connectivity adapter not implemented.`,
  };
}
