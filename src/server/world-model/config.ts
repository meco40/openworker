import {
  isWorldModelActive,
  isWorldModelCanonical,
  modeFromLegacyFlags,
  parseWorldModelMode,
  type WorldModelMode,
} from '@/server/world-model/mode';

export interface WorldModelConfig {
  enabled: boolean;
  runtimeRole: 'app' | 'worker';
  databaseUrl: string;
  poolMax: number;
  poolIdleTimeoutMs: number;
  outboxPollIntervalMs: number;
  outboxBatchSize: number;
  ingestionBridgeEnabled: boolean;
  heartbeatIntervalMs: number;
  e2eEnabled: boolean;
  graphitiShadowEnabled: boolean;
  graphitiBackendEnabled: boolean;
  mem0PreferencesOnly: boolean;
  mode: WorldModelMode;
  prospectiveIntervalMs: number;
  userActiveWindowMs: number;
  dailyProactiveBudget: number;
  quietHours: { start: number; end: number } | null;
  canaryScopes: string[];
}

type EnvLike = Record<string, string | undefined>;

const DEFAULT_DATABASE_URL = 'postgresql://clawtest:clawtest@127.0.0.1:5434/clawtest';

export const WORLD_MODEL_DEFAULT_CONFIG: WorldModelConfig = {
  enabled: false,
  runtimeRole: 'app',
  databaseUrl: DEFAULT_DATABASE_URL,
  poolMax: 10,
  poolIdleTimeoutMs: 30_000,
  outboxPollIntervalMs: 10_000,
  outboxBatchSize: 100,
  ingestionBridgeEnabled: false,
  heartbeatIntervalMs: 60_000,
  e2eEnabled: false,
  graphitiShadowEnabled: false,
  graphitiBackendEnabled: false,
  mem0PreferencesOnly: false,
  mode: 'off',
  prospectiveIntervalMs: 60_000,
  userActiveWindowMs: 300_000,
  dailyProactiveBudget: 10,
  quietHours: null,
  canaryScopes: [],
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

function parseCanaryScopes(value: string | undefined): string[] {
  return String(value || '')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean);
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
  const runtimeRole = env.WORLD_MODEL_RUNTIME_ROLE === 'worker' ? 'worker' : 'app';
  const roleDatabaseUrl =
    runtimeRole === 'worker'
      ? env.WORLD_MODEL_WORKER_DATABASE_URL
      : env.WORLD_MODEL_APP_DATABASE_URL;

  return {
    enabled: legacyEnabled || isWorldModelActive(mode),
    runtimeRole,
    databaseUrl:
      roleDatabaseUrl ||
      env.CANONICAL_DATABASE_URL ||
      env.DATABASE_URL ||
      WORLD_MODEL_DEFAULT_CONFIG.databaseUrl,
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
    graphitiBackendEnabled: parseBoolean(
      env.GRAPHITI_PROJECTOR_ENABLED ?? env.GRAPHITI_ENABLED,
      WORLD_MODEL_DEFAULT_CONFIG.graphitiBackendEnabled,
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
    dailyProactiveBudget: parseNumber(
      env.WORLD_MODEL_DAILY_PROACTIVE_BUDGET,
      WORLD_MODEL_DEFAULT_CONFIG.dailyProactiveBudget,
      0,
      10_000,
    ),
    quietHours: parseQuietHours(env.WORLD_MODEL_QUIET_HOURS),
    canaryScopes: parseCanaryScopes(env.WORLD_MODEL_CANARY_SCOPES),
  };
}

function parseQuietHours(value: string | undefined): { start: number; end: number } | null {
  if (!value) return WORLD_MODEL_DEFAULT_CONFIG.quietHours;
  const parts = value.split('-').map((p) => Number(p.trim()));
  if (parts.length !== 2 || parts.some((n) => !Number.isFinite(n))) return null;
  const [start, end] = parts;
  if (start < 0 || start > 23 || end < 0 || end > 23) return null;
  return { start, end };
}

export function getWorldModelConfig(): WorldModelConfig {
  return resolveWorldModelConfig();
}
