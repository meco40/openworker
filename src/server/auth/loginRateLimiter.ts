// ponytail: per-process, in-memory limiter. Multi-instance deployments need shared storage (Redis/DB) to count across processes.

export interface LoginRateLimiterOptions {
  maxFailures?: number;
  windowMs?: number;
  maxEntries?: number;
  now?: () => number;
}

interface Entry {
  count: number;
  windowStart: number;
}

const DEFAULT_MAX_FAILURES = 10;
const DEFAULT_WINDOW_MS = 15 * 60 * 1000;
const DEFAULT_MAX_ENTRIES = 10_000;
const MAX_IP_LENGTH = 64;

/**
 * Fixed-window failure counter. A key is blocked once it has `maxFailures`
 * failures inside the window that started at its first failure; the block
 * lifts when that window expires.
 */
export class LoginRateLimiter {
  private readonly entries = new Map<string, Entry>();
  private readonly maxFailures: number;
  private readonly windowMs: number;
  private readonly maxEntries: number;
  private readonly now: () => number;
  private lastPrune: number;

  constructor(options: LoginRateLimiterOptions = {}) {
    this.maxFailures = options.maxFailures ?? DEFAULT_MAX_FAILURES;
    this.windowMs = options.windowMs ?? DEFAULT_WINDOW_MS;
    this.maxEntries = options.maxEntries ?? DEFAULT_MAX_ENTRIES;
    this.now = options.now ?? (() => Date.now());
    this.lastPrune = this.now();
  }

  isBlocked(key: string): boolean {
    const entry = this.activeEntry(key);
    return entry !== undefined && entry.count >= this.maxFailures;
  }

  recordFailure(key: string): void {
    const now = this.now();
    this.pruneIfDue(now);

    const entry = this.activeEntry(key);
    if (entry) {
      entry.count += 1;
      return;
    }

    if (this.entries.size >= this.maxEntries) {
      // Evict the oldest-inserted key to keep memory bounded.
      const oldest = this.entries.keys().next().value;
      if (oldest !== undefined) this.entries.delete(oldest);
    }
    this.entries.set(key, { count: 1, windowStart: now });
  }

  reset(key: string): void {
    this.entries.delete(key);
  }

  get size(): number {
    return this.entries.size;
  }

  private activeEntry(key: string): Entry | undefined {
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    if (this.now() - entry.windowStart >= this.windowMs) {
      this.entries.delete(key);
      return undefined;
    }
    return entry;
  }

  private pruneIfDue(now: number): void {
    if (now - this.lastPrune < this.windowMs) return;
    this.lastPrune = now;
    for (const [key, entry] of this.entries) {
      if (now - entry.windowStart >= this.windowMs) this.entries.delete(key);
    }
  }
}

/**
 * Best-effort client IP from a forwarded-for header (first hop). The header is
 * client-controlled unless a trusted proxy sets it, so this is a secondary key only.
 */
export function resolveClientIp(
  headers: Record<string, unknown> | null | undefined,
): string | null {
  const raw = headers?.['x-forwarded-for'];
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (typeof value !== 'string') return null;
  const first = value.split(',')[0]?.trim().slice(0, MAX_IP_LENGTH);
  return first ? first : null;
}

declare global {
  var __loginRateLimiter: LoginRateLimiter | undefined;
}

export function getLoginRateLimiter(): LoginRateLimiter {
  if (!globalThis.__loginRateLimiter) {
    globalThis.__loginRateLimiter = new LoginRateLimiter();
  }
  return globalThis.__loginRateLimiter;
}
