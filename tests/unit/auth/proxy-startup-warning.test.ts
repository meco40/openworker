import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

describe('proxy startup auth logging', () => {
  const originalToken = process.env.MC_API_TOKEN;

  beforeEach(() => {
    vi.resetModules();
    delete process.env.MC_API_TOKEN;
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.resetModules();
    if (originalToken) {
      process.env.MC_API_TOKEN = originalToken;
      return;
    }
    delete process.env.MC_API_TOKEN;
  });

  it('does not warn when MC_API_TOKEN is missing', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    await import('../../../proxy');

    expect(warnSpy).not.toHaveBeenCalledWith(expect.stringContaining('MC_API_TOKEN not set'));
  });
});
