// ─── Log Method Handlers ─────────────────────────────────────
// RPC methods for log viewing and subscriptions.

import { registerMethod, type RespondFn } from '../method-router';
import type { GatewayClient } from '../client-registry';

// ─── logs.list ───────────────────────────────────────────────
// Fetch recent logs with optional filtering.

registerMethod(
  'logs.list',
  async (params: Record<string, unknown>, _client: GatewayClient, respond: RespondFn, _ctx) => {
    const { getLogRepository } = await import('../../telemetry/logRepository');
    const repo = getLogRepository();

    const filter: Record<string, unknown> = {};
    if (params.level) filter.level = params.level;
    if (params.source) filter.source = params.source;
    if (params.search) filter.search = params.search;
    if (params.limit) filter.limit = Number(params.limit);
    if (params.before) filter.before = params.before;

    const logs = repo.listLogs(filter);
    respond(logs);
  },
);

// ─── logs.subscribe ──────────────────────────────────────────
// Subscribe to real-time log events.

registerMethod(
  'logs.subscribe',
  (params: Record<string, unknown>, client: GatewayClient, respond: RespondFn, _ctx) => {
    const level = params.level as string | undefined;
    const source = params.source as string | undefined;

    // Subscription key encodes optional filters
    const subKey = level || source ? `logs:${level ?? '*'}:${source ?? '*'}` : 'logs';
    client.subscriptions.add(subKey);
    respond({ subscribed: true, filter: { level, source } });
  },
);

// ─── logs.unsubscribe ────────────────────────────────────────
// Unsubscribe from real-time log events.

registerMethod(
  'logs.unsubscribe',
  (_params: Record<string, unknown>, client: GatewayClient, respond: RespondFn, _ctx) => {
    // Remove all log subscriptions
    for (const sub of client.subscriptions) {
      if (sub === 'logs' || sub.startsWith('logs:')) {
        client.subscriptions.delete(sub);
      }
    }
    respond({ unsubscribed: true });
  },
);

// ─── logs.sources ────────────────────────────────────────────
// List distinct log sources.

registerMethod(
  'logs.sources',
  async (_params: Record<string, unknown>, _client: GatewayClient, respond: RespondFn, _ctx) => {
    const { getLogRepository } = await import('../../telemetry/logRepository');
    const repo = getLogRepository();
    respond(repo.getSources());
  },
);

// ─── logs.clear ──────────────────────────────────────────────
// Clear all logs.

registerMethod(
  'logs.clear',
  async (_params: Record<string, unknown>, _client: GatewayClient, respond: RespondFn, _ctx) => {
    const { getLogRepository } = await import('../../telemetry/logRepository');
    const repo = getLogRepository();
    const cleared = repo.clearLogs();
    respond({ cleared });
  },
);
