import { describe, expect, it } from 'vitest';
import { PROVIDER_CATALOG } from '../../../src/server/model-hub/providerCatalog';

describe('provider catalog coverage', () => {
  it('contains the required multi-provider set', () => {
    const ids = new Set(PROVIDER_CATALOG.map((provider) => provider.id));
    const required = [
      'openai',
      'openai-codex',
      'gemini',
      'openrouter',
      'zai',
      'kimi',
      'bytedance',
      'github-copilot',
      'anthropic',
      'xai',
      'mistral',
      'cohere',
    ];

    for (const id of required) {
      expect(ids.has(id)).toBe(true);
    }
  });

  it('exposes OAuth only where explicitly supported', () => {
    const openai = PROVIDER_CATALOG.find((provider) => provider.id === 'openai');
    const openaiCodex = PROVIDER_CATALOG.find((provider) => provider.id === 'openai-codex');
    const openrouter = PROVIDER_CATALOG.find((provider) => provider.id === 'openrouter');
    const github = PROVIDER_CATALOG.find((provider) => provider.id === 'github-copilot');
    const anthropic = PROVIDER_CATALOG.find((provider) => provider.id === 'anthropic');

    expect(openai?.authMethods.includes('oauth')).toBe(false);
    expect(openaiCodex?.authMethods.includes('oauth')).toBe(true);
    expect(openrouter?.authMethods.includes('oauth')).toBe(true);
    expect(github?.authMethods.includes('oauth')).toBe(true);
    expect(anthropic?.authMethods.includes('oauth')).toBe(false);
  });
});
