import { getWorldModelConfig } from '@/server/world-model/config';

/**
 * Production hardening for the canonical world model. Fail-closed by default:
 * the world model is disabled unless explicitly enabled, and enabling it in
 * production requires an explicit app/worker database URL (or the shared
 * canonical fallback used during the migration window).
 */
export function assertProductionWorldModelConfig(): void {
  const isProduction = process.env.NODE_ENV === 'production';
  const config = getWorldModelConfig();
  if (!isProduction) {
    return;
  }
  if (config.e2eEnabled) {
    throw new Error('[world-model] WORLD_MODEL_E2E is not allowed in production');
  }
  const hasExplicitWorldModelDatabase = Boolean(
    process.env.WORLD_MODEL_APP_DATABASE_URL ||
    process.env.WORLD_MODEL_WORKER_DATABASE_URL ||
    process.env.CANONICAL_DATABASE_URL,
  );
  if (config.enabled && !hasExplicitWorldModelDatabase) {
    throw new Error(
      '[world-model] WORLD_MODEL_ENABLED=true requires WORLD_MODEL_APP_DATABASE_URL, WORLD_MODEL_WORKER_DATABASE_URL, or CANONICAL_DATABASE_URL in production',
    );
  }
}
