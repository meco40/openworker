import { NextResponse } from 'next/server';

import type { OpsInstancesResponse } from '@/modules/ops/types';
import { getClientRegistry } from '@/server/gateway/client-registry';
import { parseClampedInt } from '../_shared/query';
import { withUserContext } from '../../_shared/withUserContext';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const DEFAULT_LIMIT = 25;
const MIN_LIMIT = 1;
const MAX_LIMIT = 100;

function toIsoTimestamp(value: number): string {
  const safeValue = Number.isFinite(value) ? value : Date.now();
  return new Date(safeValue).toISOString();
}

export const GET = withUserContext(async ({ request, userContext }) => {
  const registry = getClientRegistry();
  const limit = parseClampedInt(request, 'limit', DEFAULT_LIMIT, MIN_LIMIT, MAX_LIMIT);
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
});
