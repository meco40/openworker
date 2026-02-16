import { describe, it, expect, vi } from 'vitest';

// Hoist mock functions
const mockGetKnowledgeStats = vi.hoisted(() => vi.fn());
const mockResolveKnowledgeConfig = vi.hoisted(() => vi.fn());

vi.mock('../../../src/server/knowledge/runtime', () => ({
  getKnowledgeRepository: () => ({
    getKnowledgeStats: mockGetKnowledgeStats,
  }),
}));

vi.mock('../../../src/server/knowledge/config', () => ({
  resolveKnowledgeConfig: mockResolveKnowledgeConfig,
  getKnowledgeConfig: mockResolveKnowledgeConfig,
}));

import { runKnowledgeLayerCheck } from '../../../src/commands/health/checks/coreChecks';

describe('Knowledge health check', () => {
  it('returns ok when knowledge layer is enabled and stats are healthy', () => {
    mockResolveKnowledgeConfig.mockReturnValue({
      layerEnabled: true,
      ledgerEnabled: true,
      episodeEnabled: true,
      retrievalEnabled: true,
      maxContextTokens: 4000,
      ingestIntervalMs: 600_000,
    });
    mockGetKnowledgeStats.mockReturnValue({
      episodeCount: 10,
      ledgerCount: 5,
      retrievalErrorCount: 0,
      latestIngestionAt: new Date().toISOString(),
      ingestionLagMs: 120_000,
    });

    const result = runKnowledgeLayerCheck();
    expect(result.status).toBe('ok');
    expect(result.id).toBe('core.knowledge_layer');
    expect(result.details?.episodeCount).toBe(10);
  });

  it('returns skipped when knowledge layer is disabled', () => {
    mockResolveKnowledgeConfig.mockReturnValue({
      layerEnabled: false,
      ledgerEnabled: false,
      episodeEnabled: false,
      retrievalEnabled: false,
      maxContextTokens: 1200,
      ingestIntervalMs: 600_000,
    });

    const result = runKnowledgeLayerCheck();
    expect(result.status).toBe('skipped');
  });

  it('returns warning when ingestion lag exceeds threshold', () => {
    mockResolveKnowledgeConfig.mockReturnValue({
      layerEnabled: true,
      ledgerEnabled: true,
      episodeEnabled: true,
      retrievalEnabled: true,
      maxContextTokens: 4000,
      ingestIntervalMs: 600_000,
    });
    mockGetKnowledgeStats.mockReturnValue({
      episodeCount: 5,
      ledgerCount: 2,
      retrievalErrorCount: 0,
      latestIngestionAt: new Date(Date.now() - 1_800_000).toISOString(),
      ingestionLagMs: 1_800_000, // 30 minutes
    });

    const result = runKnowledgeLayerCheck();
    expect(result.status).toBe('warning');
    expect(result.message).toContain('lag');
  });

  it('returns critical on repository error', () => {
    mockResolveKnowledgeConfig.mockReturnValue({
      layerEnabled: true,
      ledgerEnabled: true,
      episodeEnabled: true,
      retrievalEnabled: true,
      maxContextTokens: 4000,
      ingestIntervalMs: 600_000,
    });
    mockGetKnowledgeStats.mockImplementation(() => {
      throw new Error('DB connection failed');
    });

    const result = runKnowledgeLayerCheck();
    expect(result.status).toBe('critical');
    expect(result.message).toContain('unavailable');
  });
});
