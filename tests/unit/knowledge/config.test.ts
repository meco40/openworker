import { describe, expect, it } from 'vitest';

import { resolveKnowledgeConfig } from '../../../src/server/knowledge/config';

describe('knowledge config', () => {
  it('returns safe defaults when env is unset', () => {
    const config = resolveKnowledgeConfig({} as NodeJS.ProcessEnv);

    expect(config).toEqual({
      layerEnabled: false,
      ledgerEnabled: false,
      episodeEnabled: false,
      retrievalEnabled: false,
      maxContextTokens: 1200,
      ingestIntervalMs: 600_000,
    });
  });

  it('parses all KNOWLEDGE_* env flags', () => {
    const env = {
      NODE_ENV: 'test',
      KNOWLEDGE_LAYER_ENABLED: '1',
      KNOWLEDGE_LEDGER_ENABLED: 'true',
      KNOWLEDGE_EPISODE_ENABLED: 'yes',
      KNOWLEDGE_RETRIEVAL_ENABLED: 'on',
      KNOWLEDGE_MAX_CONTEXT_TOKENS: '2400',
      KNOWLEDGE_INGEST_INTERVAL_MS: '900000',
    } as unknown as NodeJS.ProcessEnv;

    const config = resolveKnowledgeConfig(env);

    expect(config.layerEnabled).toBe(true);
    expect(config.ledgerEnabled).toBe(true);
    expect(config.episodeEnabled).toBe(true);
    expect(config.retrievalEnabled).toBe(true);
    expect(config.maxContextTokens).toBe(2400);
    expect(config.ingestIntervalMs).toBe(900_000);
  });

  it('uses defaults for invalid numeric values', () => {
    const env = {
      NODE_ENV: 'test',
      KNOWLEDGE_MAX_CONTEXT_TOKENS: 'invalid',
      KNOWLEDGE_INGEST_INTERVAL_MS: 'invalid',
    } as unknown as NodeJS.ProcessEnv;

    const config = resolveKnowledgeConfig(env);

    expect(config.maxContextTokens).toBe(1200);
    expect(config.ingestIntervalMs).toBe(600_000);
  });

  it('treats partially numeric strings as invalid and falls back to defaults', () => {
    const env = {
      NODE_ENV: 'test',
      KNOWLEDGE_MAX_CONTEXT_TOKENS: '2400tokens',
      KNOWLEDGE_INGEST_INTERVAL_MS: '900000ms',
    } as unknown as NodeJS.ProcessEnv;

    const config = resolveKnowledgeConfig(env);

    expect(config.maxContextTokens).toBe(1200);
    expect(config.ingestIntervalMs).toBe(600_000);
  });

  it('clamps numeric values to supported bounds', () => {
    const low = resolveKnowledgeConfig({
      KNOWLEDGE_MAX_CONTEXT_TOKENS: '10',
      KNOWLEDGE_INGEST_INTERVAL_MS: '500',
    } as unknown as NodeJS.ProcessEnv);
    const high = resolveKnowledgeConfig({
      KNOWLEDGE_MAX_CONTEXT_TOKENS: '99999',
      KNOWLEDGE_INGEST_INTERVAL_MS: '999999999',
    } as unknown as NodeJS.ProcessEnv);

    expect(low.maxContextTokens).toBe(256);
    expect(low.ingestIntervalMs).toBe(60_000);
    expect(high.maxContextTokens).toBe(4000);
    expect(high.ingestIntervalMs).toBe(3_600_000);
  });
});
