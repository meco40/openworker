import { describe, expect, it } from 'vitest';
import { resolveKnowledgeConfig } from '../../../src/server/knowledge/config';

/**
 * Tests for the trigger-knowledge-ingestion script's prerequisites.
 * The script itself depends on runtime services (Model Hub, Mem0, SQLite),
 * so these tests validate the configuration layer it relies on.
 */
describe('trigger-knowledge-ingestion prerequisites', () => {
  it('resolves layerEnabled from KNOWLEDGE_LAYER_ENABLED env', () => {
    expect(resolveKnowledgeConfig({ KNOWLEDGE_LAYER_ENABLED: 'true' }).layerEnabled).toBe(true);
    expect(resolveKnowledgeConfig({ KNOWLEDGE_LAYER_ENABLED: 'false' }).layerEnabled).toBe(false);
    expect(resolveKnowledgeConfig({}).layerEnabled).toBe(false);
  });

  it('resolves episodeEnabled from KNOWLEDGE_EPISODE_ENABLED env', () => {
    expect(resolveKnowledgeConfig({ KNOWLEDGE_EPISODE_ENABLED: 'true' }).episodeEnabled).toBe(true);
    expect(resolveKnowledgeConfig({ KNOWLEDGE_EPISODE_ENABLED: '1' }).episodeEnabled).toBe(true);
    expect(resolveKnowledgeConfig({}).episodeEnabled).toBe(false);
  });

  it('requires at least layerEnabled + one of episode/ledger for ingestion', () => {
    const nothingEnabled = resolveKnowledgeConfig({});
    expect(nothingEnabled.layerEnabled).toBe(false);
    expect(nothingEnabled.episodeEnabled).toBe(false);
    expect(nothingEnabled.ledgerEnabled).toBe(false);

    const fullEnabled = resolveKnowledgeConfig({
      KNOWLEDGE_LAYER_ENABLED: 'true',
      KNOWLEDGE_EPISODE_ENABLED: 'true',
      KNOWLEDGE_LEDGER_ENABLED: 'true',
    });
    expect(fullEnabled.layerEnabled).toBe(true);
    expect(fullEnabled.episodeEnabled).toBe(true);
    expect(fullEnabled.ledgerEnabled).toBe(true);
  });

  it('enables contradiction detection via env var', () => {
    const config = resolveKnowledgeConfig({
      KNOWLEDGE_LAYER_ENABLED: 'true',
      KNOWLEDGE_EPISODE_ENABLED: 'true',
      KNOWLEDGE_CONTRADICTION_DETECTION: 'true',
    });
    expect(config.contradictionDetectionEnabled).toBe(true);
  });
});
