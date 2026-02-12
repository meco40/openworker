import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { getOpenRouterModelPricing } from '../../../src/server/stats/openRouterPricing';

describe('openRouter pricing', () => {
  beforeEach(() => {
    globalThis.__openRouterPricingCache = undefined;
  });

  afterEach(() => {
    vi.restoreAllMocks();
    globalThis.__openRouterPricingCache = undefined;
  });

  it('loads pricing from models endpoint and parses numeric token rates', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      json: async () => ({
        data: [
          {
            id: 'x-ai/grok-4-fast',
            pricing: {
              prompt: '0.00000125',
              completion: '0.0000025',
            },
          },
        ],
      }),
    } as Response);

    const pricing = await getOpenRouterModelPricing('x-ai/grok-4-fast', 100);

    expect(pricing).not.toBeNull();
    expect(pricing?.promptPricePerTokenUsd).toBeCloseTo(0.00000125, 12);
    expect(pricing?.completionPricePerTokenUsd).toBeCloseTo(0.0000025, 12);
    expect(pricing?.requestPriceUsd).toBe(0);
  });

  it('supports tier arrays and selects tier by prompt token threshold', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      json: async () => ({
        data: [
          {
            id: 'tiered/model',
            pricing: [
              { min_context: '0', prompt: '0.000001', completion: '0.000002' },
              { min_context: '1000', prompt: '0.0000005', completion: '0.000001' },
            ],
          },
        ],
      }),
    } as Response);

    const small = await getOpenRouterModelPricing('tiered/model', 500);
    const large = await getOpenRouterModelPricing('tiered/model', 1500);

    expect(small?.promptPricePerTokenUsd).toBeCloseTo(0.000001, 12);
    expect(large?.promptPricePerTokenUsd).toBeCloseTo(0.0000005, 12);
  });
});

