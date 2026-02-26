import type { RateLimitSnapshot, RateLimitWindow } from '@/server/model-hub/Models/types';

interface WindowPayload {
  used_percent?: unknown;
  limit_window_seconds?: unknown;
  reset_at?: unknown;
}

function asFiniteNumber(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined;
  return value;
}

function toWindowLabel(seconds: number): string {
  if (seconds >= 86_400 && seconds % 86_400 === 0) {
    return `${Math.round(seconds / 86_400)}d`;
  }
  if (seconds >= 3_600 && seconds % 3_600 === 0) {
    return `${Math.round(seconds / 3_600)}h`;
  }
  if (seconds >= 60 && seconds % 60 === 0) {
    return `${Math.round(seconds / 60)}m`;
  }
  return `${Math.max(1, Math.round(seconds))}s`;
}

function mapWindow(payload: WindowPayload | null | undefined): RateLimitWindow | null {
  if (!payload || typeof payload !== 'object') return null;
  const usedPercentRaw = asFiniteNumber(payload.used_percent);
  const windowSeconds = asFiniteNumber(payload.limit_window_seconds);
  if (usedPercentRaw === undefined || windowSeconds === undefined || windowSeconds <= 0) {
    return null;
  }

  const usedPercent = Math.min(100, Math.max(0, Math.round(usedPercentRaw)));
  const remainingPercent = Math.max(0, Math.min(100, 100 - usedPercent));
  const resetRaw = asFiniteNumber(payload.reset_at);
  return {
    window: toWindowLabel(windowSeconds),
    usedPercent,
    remainingPercent,
    reset: resetRaw !== undefined ? String(Math.round(resetRaw)) : undefined,
  };
}

export function parseCodexUsageRateLimits(payload: unknown): RateLimitSnapshot | undefined {
  if (!payload || typeof payload !== 'object') return undefined;
  const rateLimit = (payload as { rate_limit?: unknown }).rate_limit;
  if (!rateLimit || typeof rateLimit !== 'object') return undefined;

  const primaryWindow = mapWindow(
    (rateLimit as { primary_window?: WindowPayload | null }).primary_window,
  );
  const secondaryWindow = mapWindow(
    (rateLimit as { secondary_window?: WindowPayload | null }).secondary_window,
  );
  const windows = [primaryWindow, secondaryWindow].filter((window): window is RateLimitWindow =>
    Boolean(window),
  );
  if (windows.length === 0) return undefined;
  return { windows };
}

export function mergeRateLimitSnapshots(
  primary: RateLimitSnapshot | undefined,
  secondary: RateLimitSnapshot | undefined,
): RateLimitSnapshot | undefined {
  if (!primary && !secondary) return undefined;
  if (primary && !secondary) return primary;
  if (!primary && secondary) return secondary;

  const byWindow = new Map<string, RateLimitWindow>();
  for (const window of primary?.windows ?? []) {
    byWindow.set(window.window.toLowerCase(), { ...window });
  }
  for (const window of secondary?.windows ?? []) {
    const key = window.window.toLowerCase();
    const existing = byWindow.get(key);
    if (!existing) {
      byWindow.set(key, { ...window });
      continue;
    }
    byWindow.set(key, {
      ...window,
      ...existing,
      window: existing.window || window.window,
      limit: existing.limit ?? window.limit,
      remaining: existing.remaining ?? window.remaining,
      usedPercent: existing.usedPercent ?? window.usedPercent,
      remainingPercent: existing.remainingPercent ?? window.remainingPercent,
      reset: existing.reset ?? window.reset,
    });
  }

  return { windows: Array.from(byWindow.values()) };
}
