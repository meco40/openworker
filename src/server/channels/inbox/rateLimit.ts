interface RateLimitBucket {
  windowStart: number;
  count: number;
}

declare global {
  var __inboxRateLimitBuckets: Map<string, RateLimitBucket> | undefined;
}

const DEFAULT_HTTP_LIMIT = 120;
const DEFAULT_WS_LIMIT = 240;
const WINDOW_MS = 60_000;

function getBuckets(): Map<string, RateLimitBucket> {
  if (!globalThis.__inboxRateLimitBuckets) {
    globalThis.__inboxRateLimitBuckets = new Map();
  }
  return globalThis.__inboxRateLimitBuckets;
}

function resolveLimit(scope: 'http' | 'ws'): number {
  const envName =
    scope === 'http' ? 'INBOX_HTTP_RATE_LIMIT_PER_MINUTE' : 'INBOX_WS_RATE_LIMIT_PER_MINUTE';
  const fallback = scope === 'http' ? DEFAULT_HTTP_LIMIT : DEFAULT_WS_LIMIT;
  const raw = Number.parseInt(String(process.env[envName] || ''), 10);
  if (!Number.isFinite(raw) || raw <= 0) {
    return fallback;
  }
  return Math.max(1, Math.min(raw, 10_000));
}

export function consumeInboxRateLimit(
  scope: 'http' | 'ws',
  key: string,
): {
  allowed: boolean;
  retryAfterMs: number;
  limit: number;
} {
  const buckets = getBuckets();
  const now = Date.now();
  const bucketKey = `${scope}:${key}`;
  const limit = resolveLimit(scope);

  const existing = buckets.get(bucketKey);
  if (!existing || now - existing.windowStart >= WINDOW_MS) {
    buckets.set(bucketKey, { windowStart: now, count: 1 });
    return { allowed: true, retryAfterMs: 0, limit };
  }

  existing.count += 1;
  if (existing.count <= limit) {
    buckets.set(bucketKey, existing);
    return { allowed: true, retryAfterMs: 0, limit };
  }

  return {
    allowed: false,
    retryAfterMs: Math.max(0, WINDOW_MS - (now - existing.windowStart)),
    limit,
  };
}
