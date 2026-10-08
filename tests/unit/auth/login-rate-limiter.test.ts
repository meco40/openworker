import { describe, expect, it } from 'vitest';
import { LoginRateLimiter, resolveClientIp } from '@/server/auth/loginRateLimiter';

const WINDOW_MS = 15 * 60 * 1000;

function makeLimiter(options: { maxFailures?: number; maxEntries?: number } = {}) {
  const clock = { t: 1_000_000 };
  const limiter = new LoginRateLimiter({
    maxFailures: options.maxFailures ?? 10,
    windowMs: WINDOW_MS,
    maxEntries: options.maxEntries,
    now: () => clock.t,
  });
  return { limiter, clock };
}

describe('LoginRateLimiter', () => {
  it('blocks a key once it reaches the failure limit', () => {
    const { limiter } = makeLimiter();

    for (let i = 0; i < 9; i += 1) limiter.recordFailure('email:a@x.dev');
    expect(limiter.isBlocked('email:a@x.dev')).toBe(false);

    limiter.recordFailure('email:a@x.dev');
    expect(limiter.isBlocked('email:a@x.dev')).toBe(true);
  });

  it('keeps blocking until the window passes, then unblocks', () => {
    const { limiter, clock } = makeLimiter();
    for (let i = 0; i < 10; i += 1) limiter.recordFailure('email:a@x.dev');

    clock.t += WINDOW_MS - 1;
    expect(limiter.isBlocked('email:a@x.dev')).toBe(true);

    clock.t += 1;
    expect(limiter.isBlocked('email:a@x.dev')).toBe(false);
  });

  it('starts a fresh budget after the window expires', () => {
    const { limiter, clock } = makeLimiter();
    for (let i = 0; i < 10; i += 1) limiter.recordFailure('email:a@x.dev');

    clock.t += WINDOW_MS;
    limiter.recordFailure('email:a@x.dev');
    expect(limiter.isBlocked('email:a@x.dev')).toBe(false);
  });

  it('tracks keys independently', () => {
    const { limiter } = makeLimiter();
    for (let i = 0; i < 10; i += 1) limiter.recordFailure('email:a@x.dev');

    expect(limiter.isBlocked('email:a@x.dev')).toBe(true);
    expect(limiter.isBlocked('email:b@x.dev')).toBe(false);
  });

  it('resets a key on reset (successful login)', () => {
    const { limiter } = makeLimiter();
    for (let i = 0; i < 9; i += 1) limiter.recordFailure('email:a@x.dev');

    limiter.reset('email:a@x.dev');
    for (let i = 0; i < 9; i += 1) limiter.recordFailure('email:a@x.dev');
    expect(limiter.isBlocked('email:a@x.dev')).toBe(false);
  });

  it('prunes expired entries once a window has elapsed', () => {
    const { limiter, clock } = makeLimiter();
    limiter.recordFailure('email:old@x.dev');
    limiter.recordFailure('email:older@x.dev');
    expect(limiter.size).toBe(2);

    clock.t += WINDOW_MS;
    limiter.recordFailure('email:new@x.dev');
    expect(limiter.size).toBe(1);
  });

  it('caps the number of tracked keys by evicting the oldest', () => {
    const { limiter } = makeLimiter({ maxEntries: 3 });
    for (const key of ['k1', 'k2', 'k3', 'k4', 'k5']) limiter.recordFailure(key);

    expect(limiter.size).toBe(3);
    expect(limiter.isBlocked('k5')).toBe(false);
  });
});

describe('resolveClientIp', () => {
  it('uses the first forwarded-for hop', () => {
    expect(resolveClientIp({ 'x-forwarded-for': '203.0.113.7, 10.0.0.1' })).toBe('203.0.113.7');
  });

  it('accepts an array header value', () => {
    expect(resolveClientIp({ 'x-forwarded-for': ['198.51.100.2'] })).toBe('198.51.100.2');
  });

  it('returns null when the header is missing or empty', () => {
    expect(resolveClientIp({})).toBeNull();
    expect(resolveClientIp(null)).toBeNull();
    expect(resolveClientIp({ 'x-forwarded-for': '  ' })).toBeNull();
  });

  it('bounds the length of the returned value', () => {
    const ip = resolveClientIp({ 'x-forwarded-for': 'a'.repeat(500) });
    expect(ip?.length).toBe(64);
  });
});
