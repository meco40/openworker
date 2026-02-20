import { describe, expect, it } from 'vitest';
import { PROVIDER_CATALOG } from '@/server/model-hub/providerCatalog';
import { getProviderAdapter } from '@/server/model-hub/Models';

describe('model-hub provider registry', () => {
  it('has an adapter for each provider in catalog', () => {
    const missing = PROVIDER_CATALOG.filter((provider) => !getProviderAdapter(provider.id));
    expect(missing).toEqual([]);
  });

  it('exposes fetch, connectivity and gateway handlers for each provider adapter', () => {
    for (const provider of PROVIDER_CATALOG) {
      const adapter = getProviderAdapter(provider.id);
      expect(adapter).not.toBeNull();
      expect(adapter?.fetchModels).toBeTypeOf('function');
      expect(adapter?.testConnectivity).toBeTypeOf('function');
      expect(adapter?.dispatchGateway).toBeTypeOf('function');
    }
  });
});
