import { describe, expect, it } from 'vitest';

import { getXaiModelPricing } from '@/server/stats/xaiPricing';

describe('xai pricing', () => {
  it('returns per-token rates from per-million pricing for a known model', async () => {
    const pricing = await getXaiModelPricing('grok-4-1-fast-reasoning');

    expect(pricing).not.toBeNull();
    expect(pricing?.promptPricePerTokenUsd).toBeCloseTo(0.2 / 1_000_000, 12);
    expect(pricing?.completionPricePerTokenUsd).toBeCloseTo(0.5 / 1_000_000, 12);
    expect(pricing?.requestPriceUsd).toBe(0);
  });

  it('supports the default model alias grok-4', async () => {
    const pricing = await getXaiModelPricing('grok-4');

    expect(pricing).not.toBeNull();
    expect(pricing?.promptPricePerTokenUsd).toBeCloseTo(3 / 1_000_000, 12);
    expect(pricing?.completionPricePerTokenUsd).toBeCloseTo(15 / 1_000_000, 12);
  });

  it('returns null for unknown models', async () => {
    await expect(getXaiModelPricing('grok-unknown')).resolves.toBeNull();
  });
});
