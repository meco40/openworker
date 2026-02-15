import { describe, expect, it } from 'vitest';
import {
  KNOWLEDGE_DEFAULT_CONFIG,
  resolveKnowledgeConfig,
} from '../../../src/server/knowledge/config';

describe('knowledge config', () => {
  it('returns safe defaults when env is empty', () => {
    const config = resolveKnowledgeConfig({});

    expect(config).toEqual(KNOWLEDGE_DEFAULT_CONFIG);
    expect(config.layerEnabled).toBe(false);
    expect(config.ledgerEnabled).toBe(false);
    expect(config.episodeEnabled).toBe(false);
    expect(config.retrievalEnabled).toBe(false);
    expect(config.maxContextTokens).toBe(1200);
    expect(config.ingestIntervalMs).toBe(600000);
  });

  it('parses booleans from common env variants', () => {
    const config = resolveKnowledgeConfig({
      KNOWLEDGE_LAYER_ENABLED: '1',
      KNOWLEDGE_LEDGER_ENABLED: 'true',
      KNOWLEDGE_EPISODE_ENABLED: 'yes',
      KNOWLEDGE_RETRIEVAL_ENABLED: 'on',
    });

    expect(config.layerEnabled).toBe(true);
    expect(config.ledgerEnabled).toBe(true);
    expect(config.episodeEnabled).toBe(true);
    expect(config.retrievalEnabled).toBe(true);
  });

  it('clamps numeric values to operational bounds', () => {
    const tooLow = resolveKnowledgeConfig({
      KNOWLEDGE_MAX_CONTEXT_TOKENS: '5',
      KNOWLEDGE_INGEST_INTERVAL_MS: '100',
    });

    expect(tooLow.maxContextTokens).toBe(200);
    expect(tooLow.ingestIntervalMs).toBe(60000);

    const tooHigh = resolveKnowledgeConfig({
      KNOWLEDGE_MAX_CONTEXT_TOKENS: '999999',
      KNOWLEDGE_INGEST_INTERVAL_MS: '999999999',
    });

    expect(tooHigh.maxContextTokens).toBe(8000);
    expect(tooHigh.ingestIntervalMs).toBe(3600000);
  });
});
