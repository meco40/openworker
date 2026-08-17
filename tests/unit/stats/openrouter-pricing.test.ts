import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { getOpenRouterModelPricing } from '@/server/stats/openRouterPricing';

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

  it('returns null when model is not found in cache', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      json: async () => ({
        data: [{ id: 'other/model', pricing: { prompt: '0.000001', completion: '0.000002' } }],
      }),
    } as Response);

    const pricing = await getOpenRouterModelPricing('unknown/model', 100);
    expect(pricing).toBeNull();
  });

  it('returns null when tiers array is empty (selectTier empty array branch)', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      json: async () => ({
        data: [
          // pricing is a falsy value → parsePricing returns [] → tiers.length===0 → skipped
          { id: 'empty/model', pricing: null },
        ],
      }),
    } as Response);

    const pricing = await getOpenRouterModelPricing('empty/model', 100);
    expect(pricing).toBeNull();
  });

  it('toNumber: Infinity → 0', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      json: async () => ({
        data: [{ id: 'inf/model', pricing: { prompt: Infinity, completion: '0.000001' } }],
      }),
    } as Response);

    const pricing = await getOpenRouterModelPricing('inf/model', 100);
    expect(pricing?.promptPricePerTokenUsd).toBe(0);
  });

  it('toNumber: non-numeric string → 0', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      json: async () => ({
        data: [{ id: 'str/model', pricing: { prompt: 'not-a-number', completion: '0.000001' } }],
      }),
    } as Response);

    const pricing = await getOpenRouterModelPricing('str/model', 100);
    expect(pricing?.promptPricePerTokenUsd).toBe(0);
  });

  it('toNumber: null value → 0', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      json: async () => ({
        data: [{ id: 'null/model', pricing: { prompt: null, completion: '0.000001' } }],
      }),
    } as Response);

    const pricing = await getOpenRouterModelPricing('null/model', 100);
    expect(pricing?.promptPricePerTokenUsd).toBe(0);
  });

  it('parseTier: null raw → null (filtered out)', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      json: async () => ({
        data: [
          {
            id: 'null-tier/model',
            pricing: [null, { min_context: '0', prompt: '0.000001', completion: '0.000002' }],
          },
        ],
      }),
    } as Response);

    const pricing = await getOpenRouterModelPricing('null-tier/model', 100);
    // null tier is filtered, valid tier should remain
    expect(pricing).not.toBeNull();
    expect(pricing?.promptPricePerTokenUsd).toBeCloseTo(0.000001, 12);
  });

  it('parseTier: primitive raw (non-object) → null', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      json: async () => ({
        data: [
          {
            id: 'prim-tier/model',
            pricing: [42, { min_context: '0', prompt: '0.000001', completion: '0.000002' }],
          },
        ],
      }),
    } as Response);

    const pricing = await getOpenRouterModelPricing('prim-tier/model', 100);
    expect(pricing).not.toBeNull();
  });

  it('parseTier: minContext camelCase fallback', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      json: async () => ({
        data: [
          {
            id: 'camel/model',
            pricing: [
              { minContext: '0', prompt: '0.000001', completion: '0.000002' },
              { minContext: '1000', prompt: '0.0000005', completion: '0.000001' },
            ],
          },
        ],
      }),
    } as Response);

    const pricing = await getOpenRouterModelPricing('camel/model', 1500);
    // Should pick the 1000 tier (lower price)
    expect(pricing?.promptPricePerTokenUsd).toBeCloseTo(0.0000005, 12);
  });

  it('parsePricing: non-array non-object falsy → empty array', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      json: async () => ({
        data: [{ id: 'falsy/model', pricing: 0 }],
      }),
    } as Response);

    const pricing = await getOpenRouterModelPricing('falsy/model', 100);
    expect(pricing).toBeNull();
  });

  it('getTtlMs: invalid env value → default 10 minutes', async () => {
    const originalTtl = process.env.OPENROUTER_PRICING_CACHE_TTL_MS;
    process.env.OPENROUTER_PRICING_CACHE_TTL_MS = 'invalid';

    vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      json: async () => ({
        data: [{ id: 'ttl/model', pricing: { prompt: '0.000001', completion: '0.000002' } }],
      }),
    } as Response);

    const pricing = await getOpenRouterModelPricing('ttl/model', 100);
    expect(pricing).not.toBeNull();

    process.env.OPENROUTER_PRICING_CACHE_TTL_MS = originalTtl;
  });

  it('getTimeoutMs: invalid env value → default 2500ms', async () => {
    const originalTimeout = process.env.OPENROUTER_PRICING_FETCH_TIMEOUT_MS;
    process.env.OPENROUTER_PRICING_FETCH_TIMEOUT_MS = 'invalid';

    vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      json: async () => ({
        data: [{ id: 'timeout/model', pricing: { prompt: '0.000001', completion: '0.000002' } }],
      }),
    } as Response);

    const pricing = await getOpenRouterModelPricing('timeout/model', 100);
    expect(pricing).not.toBeNull();

    process.env.OPENROUTER_PRICING_FETCH_TIMEOUT_MS = originalTimeout;
  });

  it('uses canonical_slug as model key', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      json: async () => ({
        data: [
          {
            id: 'some/id',
            canonical_slug: 'canonical/slug',
            pricing: { prompt: '0.000001', completion: '0.000002' },
          },
        ],
      }),
    } as Response);

    const pricing = await getOpenRouterModelPricing('canonical/slug', 100);
    expect(pricing).not.toBeNull();
  });
});
