import { NextResponse } from 'next/server';

import type { OpsInstancesResponse } from '@/modules/ops/types';
import { resolveRequestUserContext } from '@/server/auth/userContext';
import { getClientRegistry } from '@/server/gateway/client-registry';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const DEFAULT_LIMIT = 25;
const MIN_LIMIT = 1;
const MAX_LIMIT = 100;

function parseLimit(request: Request): number {
  const raw = new URL(request.url).searchParams.get('limit');
  if (raw === null) {
    return DEFAULT_LIMIT;
  }

  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed)) {
    return DEFAULT_LIMIT;
  }

  return Math.min(Math.max(parsed, MIN_LIMIT), MAX_LIMIT);
}

function toIsoTimestamp(value: number): string {
  const safeValue = Number.isFinite(value) ? value : Date.now();
  return new Date(safeValue).toISOString();
}

export async function GET(request: Request) {
  const userContext = await resolveRequestUserContext();
  if (!userContext) {
    return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 });
  }

  const registry = getClientRegistry();
  const limit = parseLimit(request);
  const clients = registry.getByUserId(userContext.userId);

  const payload: OpsInstancesResponse = {
    ok: true,
    instances: {
      global: {
        connectionCount: registry.connectionCount,
        userCount: registry.getUserCount(),
      },
      currentUser: {
        connectionCount: clients.length,
        connections: clients.slice(0, limit).map((client) => ({
          connId: client.connId,
          connectedAt: toIsoTimestamp(client.connectedAt),
          subscriptionCount: client.subscriptions.size,
          requestCount: client.requestCount,
          seq: client.seq,
        })),
      },
      generatedAt: new Date().toISOString(),
    },
  };

  return NextResponse.json(payload);
}
