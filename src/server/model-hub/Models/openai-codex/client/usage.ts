import type { RateLimitSnapshot } from '@/server/model-hub/Models/types';
import { fetchWithTimeout } from '../../shared/http';
import { buildCodexUsageHeaders, resolveCodexUsageEndpoint } from './config';
import { parseCodexUsageRateLimits } from '../parsers/usageRateLimitParser';

const CODEX_USAGE_TIMEOUT_MS = 15_000;

export async function fetchCodexUsageRateLimits(
  secret: string,
): Promise<RateLimitSnapshot | undefined> {
  const endpoint = resolveCodexUsageEndpoint();
  const headers = buildCodexUsageHeaders(secret);
  const response = await fetchWithTimeout(
    endpoint,
    {
      method: 'GET',
      headers,
    },
    CODEX_USAGE_TIMEOUT_MS,
  );
  if (!response.ok) return undefined;
  const payload = (await response.json().catch(() => null)) as unknown;
  return parseCodexUsageRateLimits(payload);
}
