import type { RateLimitSnapshot, RateLimitWindow } from '@/server/model-hub/Models/types';

function parseInteger(value: string): number | undefined {
  const match = value.match(/-?\d+/);
  if (!match) return undefined;
  const parsed = Number.parseInt(match[0], 10);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function extractWindowToken(headerName: string, headerValue: string): string | null {
  const fromName = headerName.match(/(?:^|[-_])(\d+[hdwm])(?:$|[-_])/i)?.[1];
  if (fromName) return fromName.toLowerCase();
  const fromValue = headerValue.match(/\b(\d+[hdwm])\b/i)?.[1];
  return fromValue ? fromValue.toLowerCase() : null;
}

function parseWindow(value: string): { amount: number; unitRank: number } {
  const match = value.match(/^(\d+)([hdwm])$/i);
  if (!match) return { amount: Number.MAX_SAFE_INTEGER, unitRank: Number.MAX_SAFE_INTEGER };
  const amount = Number.parseInt(match[1], 10);
  const unit = match[2].toLowerCase();
  const unitRankMap: Record<string, number> = { h: 0, d: 1, w: 2, m: 3 };
  return { amount, unitRank: unitRankMap[unit] ?? Number.MAX_SAFE_INTEGER };
}

function compareWindow(a: string, b: string): number {
  const parsedA = parseWindow(a);
  const parsedB = parseWindow(b);
  if (parsedA.unitRank !== parsedB.unitRank) {
    return parsedA.unitRank - parsedB.unitRank;
  }
  return parsedA.amount - parsedB.amount;
}

export function parseCodexRateLimitsFromHeaders(headers: Headers): RateLimitSnapshot | undefined {
  const windows = new Map<string, RateLimitWindow>();

  for (const [rawName, rawValue] of headers.entries()) {
    const headerName = rawName.toLowerCase();
    if (!headerName.includes('ratelimit')) continue;

    const value = rawValue.trim();
    if (!value) continue;

    const window = extractWindowToken(headerName, value);
    if (!window) continue;

    const entry = windows.get(window) ?? { window };
    const hasRemainingToken = /(^|[-_])remaining([-_]|$)/.test(headerName);
    const hasResetToken = /(^|[-_])reset([-_]|$)/.test(headerName);
    const hasLimitToken = /(^|[-_])limit([-_]|$)/.test(headerName);

    if (hasRemainingToken) {
      const remaining = parseInteger(value);
      if (remaining !== undefined) entry.remaining = remaining;
    } else if (hasResetToken) {
      entry.reset = value;
    } else if (hasLimitToken) {
      const limit = parseInteger(value);
      if (limit !== undefined) entry.limit = limit;
    } else {
      continue;
    }
    windows.set(window, entry);
  }

  if (windows.size === 0) return undefined;

  return {
    windows: Array.from(windows.values()).sort((left, right) =>
      compareWindow(left.window, right.window),
    ),
  };
}
