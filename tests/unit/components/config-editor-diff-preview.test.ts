import { describe, expect, it } from 'vitest';
import { summarizeConfigDiff, hasHighRiskDiff } from '../../../src/shared/config/diffSummary';

describe('config editor diff preview utilities', () => {
  it('builds diff summary with risk tags', () => {
    const before = {
      gateway: { port: 8080, host: '127.0.0.1' },
      channels: { telegram: { token: 'old' } },
    };
    const after = {
      gateway: { port: 9090, host: '127.0.0.1' },
      channels: { telegram: { token: 'new' } },
    };

    const diff = summarizeConfigDiff(before, after);
    expect(diff.some((item) => item.path === 'gateway.port' && item.risk === 'restart-required')).toBe(true);
    expect(diff.some((item) => item.path === 'channels.telegram.token' && item.risk === 'sensitive')).toBe(true);
    expect(hasHighRiskDiff(diff)).toBe(true);
  });

  it('detects no high-risk changes for safe fields only', () => {
    const diff = summarizeConfigDiff({ ui: { density: 'comfortable' } }, { ui: { density: 'compact' } });
    expect(diff.some((item) => item.path === 'ui.density')).toBe(true);
    expect(hasHighRiskDiff(diff)).toBe(false);
  });
});
