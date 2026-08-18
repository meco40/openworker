import {
  isWorldModelActive,
  isWorldModelCanonical,
  modeFromLegacyFlags,
  parseWorldModelMode,
  type WorldModelMode,
} from '@/server/world-model/mode';

export interface WorldModelConfig {
  enabled: boolean;
  databaseUrl: string;
  poolMax: number;
  poolIdleTimeoutMs: number;
  outboxPollIntervalMs: number;
  outboxBatchSize: number;
  ingestionBridgeEnabled: boolean;
  heartbeatIntervalMs: number;
  e2eEnabled: boolean;
  graphitiShadowEnabled: boolean;
  mem0PreferencesOnly: boolean;
  mode: WorldModelMode;
  prospectiveIntervalMs: number;
  userActiveWindowMs: number;
}

type EnvLike = Record<string, string | undefined>;

const DEFAULT_DATABASE_URL = 'postgresql://clawtest:clawtest@127.0.0.1:5434/clawtest';

export const WORLD_MODEL_DEFAULT_CONFIG: WorldModelConfig = {
  enabled: false,
  databaseUrl: DEFAULT_DATABASE_URL,
  poolMax: 10,
  poolIdleTimeoutMs: 30_000,
  outboxPollIntervalMs: 10_000,
  outboxBatchSize: 100,
  ingestionBridgeEnabled: false,
  heartbeatIntervalMs: 60_000,
  e2eEnabled: false,
  graphitiShadowEnabled: false,
  mem0PreferencesOnly: false,
  mode: 'off',
  prospectiveIntervalMs: 60_000,
  userActiveWindowMs: 300_000,
};

function parseBoolean(value: string | undefined, fallback: boolean): boolean {
  const normalized = String(value || '')
    .trim()
    .toLowerCase();
  if (!normalized) return fallback;
  return normalized === '1' || normalized === 'true' || normalized === 'yes' || normalized === 'on';
}

function parseNumber(
  value: string | undefined,
  fallback: number,
  min: number,
  max: number,
): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, Math.round(parsed)));
}

export function resolveWorldModelConfig(env: EnvLike = process.env as EnvLike): WorldModelConfig {
  const legacyEnabled = parseBoolean(env.WORLD_MODEL_ENABLED, WORLD_MODEL_DEFAULT_CONFIG.enabled);
  const legacyBridgeEnabled = parseBoolean(
    env.WORLD_MODEL_INGESTION_BRIDGE,
    WORLD_MODEL_DEFAULT_CONFIG.ingestionBridgeEnabled,
  );
  const legacyMem0PreferencesOnly = parseBoolean(
    env.WORLD_MODEL_MEM0_PREFERENCES_ONLY,
    WORLD_MODEL_DEFAULT_CONFIG.mem0PreferencesOnly,
  );
  const mode = env.WORLD_MODEL_MODE?.trim()
    ? parseWorldModelMode(env.WORLD_MODEL_MODE)
    : modeFromLegacyFlags({
        enabled: legacyEnabled,
        ingestionBridgeEnabled: legacyBridgeEnabled,
        mem0PreferencesOnly: legacyMem0PreferencesOnly,
      });

  return {
    enabled: legacyEnabled || isWorldModelActive(mode),
    databaseUrl:
      env.CANONICAL_DATABASE_URL || env.DATABASE_URL || WORLD_MODEL_DEFAULT_CONFIG.databaseUrl,
    poolMax: parseNumber(env.WORLD_MODEL_POOL_MAX, WORLD_MODEL_DEFAULT_CONFIG.poolMax, 1, 100),
    poolIdleTimeoutMs: parseNumber(
      env.WORLD_MODEL_POOL_IDLE_TIMEOUT_MS,
      WORLD_MODEL_DEFAULT_CONFIG.poolIdleTimeoutMs,
      1_000,
      300_000,
    ),
    outboxPollIntervalMs: parseNumber(
      env.WORLD_MODEL_OUTBOX_POLL_INTERVAL_MS,
      WORLD_MODEL_DEFAULT_CONFIG.outboxPollIntervalMs,
      1_000,
      300_000,
    ),
    outboxBatchSize: parseNumber(
      env.WORLD_MODEL_OUTBOX_BATCH_SIZE,
      WORLD_MODEL_DEFAULT_CONFIG.outboxBatchSize,
      1,
      5_000,
    ),
    ingestionBridgeEnabled: legacyBridgeEnabled || isWorldModelActive(mode),
    heartbeatIntervalMs: parseNumber(
      env.WORLD_MODEL_HEARTBEAT_INTERVAL_MS,
      WORLD_MODEL_DEFAULT_CONFIG.heartbeatIntervalMs,
      5_000,
      3_600_000,
    ),
    e2eEnabled: parseBoolean(env.WORLD_MODEL_E2E, WORLD_MODEL_DEFAULT_CONFIG.e2eEnabled),
    graphitiShadowEnabled: parseBoolean(
      env.GRAPHITI_SHADOW_ENABLED,
      WORLD_MODEL_DEFAULT_CONFIG.graphitiShadowEnabled,
    ),
    mem0PreferencesOnly: legacyMem0PreferencesOnly || isWorldModelCanonical(mode),
    mode,
    prospectiveIntervalMs: parseNumber(
      env.WORLD_MODEL_PROSPECTIVE_INTERVAL_MS,
      WORLD_MODEL_DEFAULT_CONFIG.prospectiveIntervalMs,
      1_000,
      3_600_000,
    ),
    userActiveWindowMs: parseNumber(
      env.WORLD_MODEL_USER_ACTIVE_WINDOW_MS,
      WORLD_MODEL_DEFAULT_CONFIG.userActiveWindowMs,
      1_000,
      3_600_000,
    ),
  };
}

export function getWorldModelConfig(): WorldModelConfig {
  return resolveWorldModelConfig();
}
