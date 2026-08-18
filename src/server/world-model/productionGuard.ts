import { getWorldModelConfig } from '@/server/world-model/config';

/**
 * Production hardening for the canonical world model. Fail-closed by default:
 * the world model is disabled unless explicitly enabled, and enabling it in
 * production requires an explicit canonical database URL.
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
  if (config.enabled && !process.env.CANONICAL_DATABASE_URL) {
    throw new Error(
      '[world-model] WORLD_MODEL_ENABLED=true requires CANONICAL_DATABASE_URL in production',
    );
  }
}
