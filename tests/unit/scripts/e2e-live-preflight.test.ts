import { describe, expect, it } from 'vitest';
import { runLivePreflight } from '../../../scripts/e2e/live-preflight';

describe('e2e live preflight', () => {
  it('passes when live mode is disabled', () => {
    const result = runLivePreflight({});
    expect(result.ok).toBe(true);
    expect(result.enabled).toBe(false);
    expect(result.missing).toEqual([]);
  });

  it('fails when live mode is enabled and required env vars are missing', () => {
    const result = runLivePreflight({
      MEM0_E2E: '1',
      MEM0_BASE_URL: '',
      MEM0_API_KEY: '',
    });

    expect(result.ok).toBe(false);
    expect(result.enabled).toBe(true);
    expect(result.missing).toEqual(['MEM0_BASE_URL', 'MEM0_API_KEY']);
  });

  it('passes when live mode is enabled and required env vars are present', () => {
    const result = runLivePreflight({
      MEM0_E2E: '1',
      MEM0_BASE_URL: 'http://localhost:8010',
      MEM0_API_KEY: 'abc',
    });

    expect(result.ok).toBe(true);
    expect(result.enabled).toBe(true);
    expect(result.missing).toEqual([]);
  });
});
