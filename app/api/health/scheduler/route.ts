import { timingSafeEqual } from 'node:crypto';

import { NextResponse } from 'next/server';

import { getAutomationService } from '@/server/automation/runtime';
import type { SchedulerLeaseState } from '@/server/automation/types';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const DEFAULT_LEASE_TTL_MS = 30_000;
const DEFAULT_TICK_INTERVAL_MS = 15_000;

function parsePositiveMs(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback;
  }
  return Math.floor(parsed);
}

function computeAgeMs(lease: SchedulerLeaseState | null): number | null {
  if (!lease) return null;
  const updatedAt = Date.parse(String(lease.updatedAt || '').trim());
  if (!Number.isFinite(updatedAt)) return null;
  return Math.max(0, Date.now() - updatedAt);
}

function isAuthorized(request: Request): boolean {
  const expectedToken = String(process.env.SCHEDULER_HEALTH_TOKEN || '').trim();
  if (!expectedToken) return true;

  const providedToken = String(request.headers.get('x-scheduler-health-token') || '').trim();
  if (!providedToken) return false;

  const expected = Buffer.from(expectedToken);
  const provided = Buffer.from(providedToken);
  if (expected.length !== provided.length) return false;
  return timingSafeEqual(expected, provided);
}

export async function GET(request: Request) {
  if (!isAuthorized(request)) {
    return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 });
  }

  const service = getAutomationService();
  const lease = service.getLeaseState();
  const leaseTtlMs = parsePositiveMs(process.env.AUTOMATION_LEASE_TTL_MS, DEFAULT_LEASE_TTL_MS);
  const tickIntervalMs = parsePositiveMs(
    process.env.AUTOMATION_TICK_INTERVAL_MS,
    DEFAULT_TICK_INTERVAL_MS,
  );
  const staleAfterMs = parsePositiveMs(
    process.env.SCHEDULER_HEALTH_STALE_AFTER_MS,
    Math.max(leaseTtlMs, tickIntervalMs * 2),
  );

  const ageMs = computeAgeMs(lease);
  const healthy = lease !== null && ageMs !== null && ageMs <= staleAfterMs;
  const status = healthy ? 200 : 503;
  const error = lease === null ? 'Scheduler heartbeat not found.' : 'Scheduler heartbeat is stale.';

  return NextResponse.json(
    {
      ok: healthy,
      healthy,
      source: 'automation_scheduler_lease',
      scheduler: {
        singletonKey: lease?.singletonKey ?? null,
        instanceId: lease?.instanceId ?? null,
        heartbeatAt: lease?.heartbeatAt ?? null,
        updatedAt: lease?.updatedAt ?? null,
        ageMs,
        leaseTtlMs,
        tickIntervalMs,
        staleAfterMs,
      },
      checkedAt: new Date().toISOString(),
      ...(healthy ? {} : { error }),
    },
    { status },
  );
}
