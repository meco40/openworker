export interface KnowledgeConfig {
  // Phase 1 (existing)
  layerEnabled: boolean;
  ledgerEnabled: boolean;
  episodeEnabled: boolean;
  retrievalEnabled: boolean;
  maxContextTokens: number;
  ingestIntervalMs: number;
  minMessagesPerBatch: number;

  // Phase 3: Memory Reliability
  contradictionDetectionEnabled: boolean;
  correctionDetectionEnabled: boolean;

  // Phase 5: Dynamic Recall + Summaries
  dynamicRecallBudgetEnabled: boolean;
  conversationSummaryEnabled: boolean;
  memoryConsolidationEnabled: boolean;

  // Phase 6: Persona Type Awareness
  personaTypeAwarenessEnabled: boolean;

  // Phase 7: Domain Features
  emotionTrackingEnabled: boolean; // Only active for roleplay personas
  projectTrackingEnabled: boolean; // Only active for builder personas
  taskTrackingEnabled: boolean; // Only active for assistant personas
}

type EnvLike = Record<string, string | undefined>;

const MIN_CONTEXT_TOKENS = 200;
const MAX_CONTEXT_TOKENS = 8000;
const MIN_INGEST_INTERVAL_MS = 60_000;
const MAX_INGEST_INTERVAL_MS = 3_600_000;
const MIN_MESSAGES_PER_BATCH = 1;
const MAX_MESSAGES_PER_BATCH = 50;

export const KNOWLEDGE_DEFAULT_CONFIG: KnowledgeConfig = {
  layerEnabled: false,
  ledgerEnabled: false,
  episodeEnabled: false,
  retrievalEnabled: false,
  maxContextTokens: 4000,
  ingestIntervalMs: 600_000,
  minMessagesPerBatch: 1,
  contradictionDetectionEnabled: false,
  correctionDetectionEnabled: false,
  dynamicRecallBudgetEnabled: false,
  conversationSummaryEnabled: false,
  memoryConsolidationEnabled: false,
  personaTypeAwarenessEnabled: false,
  emotionTrackingEnabled: false,
  projectTrackingEnabled: false,
  taskTrackingEnabled: false,
};

function parseBoolean(value: string | undefined, fallback: boolean): boolean {
  const normalized = String(value || '')
    .trim()
    .toLowerCase();
  if (!normalized) return fallback;
  return normalized === '1' || normalized === 'true' || normalized === 'yes' || normalized === 'on';
}

function clampNumber(
  value: string | undefined,
  fallback: number,
  min: number,
  max: number,
): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, Math.round(parsed)));
}

export function resolveKnowledgeConfig(env: EnvLike = process.env as EnvLike): KnowledgeConfig {
  return {
    layerEnabled: parseBoolean(env.KNOWLEDGE_LAYER_ENABLED, KNOWLEDGE_DEFAULT_CONFIG.layerEnabled),
    ledgerEnabled: parseBoolean(
      env.KNOWLEDGE_LEDGER_ENABLED,
      KNOWLEDGE_DEFAULT_CONFIG.ledgerEnabled,
    ),
    episodeEnabled: parseBoolean(
      env.KNOWLEDGE_EPISODE_ENABLED,
      KNOWLEDGE_DEFAULT_CONFIG.episodeEnabled,
    ),
    retrievalEnabled: parseBoolean(
      env.KNOWLEDGE_RETRIEVAL_ENABLED,
      KNOWLEDGE_DEFAULT_CONFIG.retrievalEnabled,
    ),
    maxContextTokens: clampNumber(
      env.KNOWLEDGE_MAX_CONTEXT_TOKENS,
      KNOWLEDGE_DEFAULT_CONFIG.maxContextTokens,
      MIN_CONTEXT_TOKENS,
      MAX_CONTEXT_TOKENS,
    ),
    ingestIntervalMs: clampNumber(
      env.KNOWLEDGE_INGEST_INTERVAL_MS,
      KNOWLEDGE_DEFAULT_CONFIG.ingestIntervalMs,
      MIN_INGEST_INTERVAL_MS,
      MAX_INGEST_INTERVAL_MS,
    ),
    minMessagesPerBatch: clampNumber(
      env.KNOWLEDGE_MIN_MESSAGES_PER_BATCH,
      KNOWLEDGE_DEFAULT_CONFIG.minMessagesPerBatch,
      MIN_MESSAGES_PER_BATCH,
      MAX_MESSAGES_PER_BATCH,
    ),
    contradictionDetectionEnabled: parseBoolean(
      env.KNOWLEDGE_CONTRADICTION_DETECTION,
      KNOWLEDGE_DEFAULT_CONFIG.contradictionDetectionEnabled,
    ),
    correctionDetectionEnabled: parseBoolean(
      env.KNOWLEDGE_CORRECTION_DETECTION,
      KNOWLEDGE_DEFAULT_CONFIG.correctionDetectionEnabled,
    ),
    dynamicRecallBudgetEnabled: parseBoolean(
      env.KNOWLEDGE_DYNAMIC_RECALL_BUDGET,
      KNOWLEDGE_DEFAULT_CONFIG.dynamicRecallBudgetEnabled,
    ),
    conversationSummaryEnabled: parseBoolean(
      env.KNOWLEDGE_CONVERSATION_SUMMARY,
      KNOWLEDGE_DEFAULT_CONFIG.conversationSummaryEnabled,
    ),
    memoryConsolidationEnabled: parseBoolean(
      env.KNOWLEDGE_MEMORY_CONSOLIDATION,
      KNOWLEDGE_DEFAULT_CONFIG.memoryConsolidationEnabled,
    ),
    personaTypeAwarenessEnabled: parseBoolean(
      env.KNOWLEDGE_PERSONA_TYPE_AWARENESS,
      KNOWLEDGE_DEFAULT_CONFIG.personaTypeAwarenessEnabled,
    ),
    emotionTrackingEnabled: parseBoolean(
      env.KNOWLEDGE_EMOTION_TRACKING,
      KNOWLEDGE_DEFAULT_CONFIG.emotionTrackingEnabled,
    ),
    projectTrackingEnabled: parseBoolean(
      env.KNOWLEDGE_PROJECT_TRACKING,
      KNOWLEDGE_DEFAULT_CONFIG.projectTrackingEnabled,
    ),
    taskTrackingEnabled: parseBoolean(
      env.KNOWLEDGE_TASK_TRACKING,
      KNOWLEDGE_DEFAULT_CONFIG.taskTrackingEnabled,
    ),
  };
}

export function getKnowledgeConfig(): KnowledgeConfig {
  return resolveKnowledgeConfig();
}
