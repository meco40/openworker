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
    expect(config.maxContextTokens).toBe(4000);
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

  it('new phase flags default to false', () => {
    const config = resolveKnowledgeConfig({});
    expect(config.contradictionDetectionEnabled).toBe(false);
    expect(config.correctionDetectionEnabled).toBe(false);
    expect(config.dynamicRecallBudgetEnabled).toBe(false);
    expect(config.conversationSummaryEnabled).toBe(false);
    expect(config.memoryConsolidationEnabled).toBe(false);
    expect(config.personaTypeAwarenessEnabled).toBe(false);
    expect(config.emotionTrackingEnabled).toBe(false);
    expect(config.projectTrackingEnabled).toBe(false);
    expect(config.taskTrackingEnabled).toBe(false);
  });

  it('activates phase flags from env variables', () => {
    const config = resolveKnowledgeConfig({
      KNOWLEDGE_CONVERSATION_SUMMARY: 'true',
      KNOWLEDGE_DYNAMIC_RECALL_BUDGET: '1',
      KNOWLEDGE_PERSONA_TYPE_AWARENESS: 'yes',
      KNOWLEDGE_EMOTION_TRACKING: 'on',
      KNOWLEDGE_PROJECT_TRACKING: 'true',
      KNOWLEDGE_TASK_TRACKING: 'true',
    });
    expect(config.conversationSummaryEnabled).toBe(true);
    expect(config.dynamicRecallBudgetEnabled).toBe(true);
    expect(config.personaTypeAwarenessEnabled).toBe(true);
    expect(config.emotionTrackingEnabled).toBe(true);
    expect(config.projectTrackingEnabled).toBe(true);
    expect(config.taskTrackingEnabled).toBe(true);
  });
});
