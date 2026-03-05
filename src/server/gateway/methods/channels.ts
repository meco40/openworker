import { registerMethod, type RespondFn } from '@/server/gateway/method-router';
import type { GatewayClient } from '@/server/gateway/client-registry';
import { broadcastToUser } from '@/server/gateway/broadcast';
import { GatewayEvents } from '@/server/gateway/events';
import { CHANNEL_CAPABILITIES } from '@/server/channels/adapters/capabilities';
import type { ChannelKey } from '@/server/channels/adapters/types';
import { listBridgeAccounts } from '@/server/channels/pairing/bridgeAccounts';
import {
  createUnavailableError,
  isInboxV2Enabled,
  resolveInboxListInput,
  toInboxV1Response,
  toInboxV2Response,
} from '@/server/channels/inbox/contract';
import { consumeInboxRateLimit } from '@/server/channels/inbox/rateLimit';
import {
  logInboxObservability,
  recordInboxQueryDuration,
  recordInboxReconnectResync,
} from '@/server/channels/inbox/observability';

function safeString(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

registerMethod(
  'channels.list',
  async (_params: Record<string, unknown>, client: GatewayClient, respond: RespondFn) => {
    const { getMessageRepository } = await import('@/server/channels/messages/runtime');
    const repo = getMessageRepository();
    const bindings = repo.listChannelBindings?.(client.userId) ?? [];
    const bindingMap = new Map(bindings.map((binding) => [binding.channel, binding]));

    const channels = Object.entries(CHANNEL_CAPABILITIES).map(([channel, capabilities]) => {
      const binding = bindingMap.get(channel as ChannelKey);
      const bridgeAccounts =
        channel === 'whatsapp' || channel === 'imessage' ? listBridgeAccounts(channel) : undefined;
      return {
        channel,
        status: binding?.status ?? 'idle',
        peerName: binding?.peerName ?? null,
        transport: binding?.transport ?? null,
        lastSeenAt: binding?.lastSeenAt ?? null,
        accounts: bridgeAccounts,
        ...capabilities,
      };
    });

    respond({
      channels,
      generatedAt: new Date().toISOString(),
    });
  },
);

registerMethod(
  'channels.pair',
  async (params: Record<string, unknown>, client: GatewayClient, respond: RespondFn) => {
    const channel = safeString(params.channel).trim().toLowerCase();
    const token = safeString(params.token);
    const accountId = safeString(params.accountId);

    const { isPairChannelType, pairChannel } = await import('@/server/channels/pairing');
    if (!isPairChannelType(channel)) {
      throw new Error(`Unsupported channel: ${channel}`);
    }

    const result = await pairChannel(channel, token, accountId || undefined);
    const status =
      typeof result === 'object' &&
      result !== null &&
      'status' in result &&
      typeof (result as { status?: unknown }).status === 'string'
        ? (result as { status: string }).status
        : 'connected';
    const transport =
      typeof result === 'object' &&
      result !== null &&
      'transport' in result &&
      typeof (result as { transport?: unknown }).transport === 'string'
        ? (result as { transport: string }).transport
        : undefined;
    const peerName =
      typeof result === 'object' &&
      result !== null &&
      'peerName' in result &&
      typeof (result as { peerName?: unknown }).peerName === 'string'
        ? (result as { peerName: string }).peerName
        : undefined;

    const { getMessageRepository } = await import('@/server/channels/messages/runtime');
    const repo = getMessageRepository();
    repo.upsertChannelBinding?.({
      userId: client.userId,
      channel,
      status: status === 'awaiting_code' ? 'awaiting_code' : 'connected',
      peerName,
      transport,
      metadata:
        typeof result === 'object' && result !== null && 'accountId' in result
          ? { accountId: (result as { accountId?: unknown }).accountId || accountId || 'default' }
          : accountId
            ? { accountId }
            : undefined,
    });

    const updatedAt = new Date().toISOString();
    broadcastToUser(client.userId, GatewayEvents.CHANNELS_STATUS, {
      channel,
      accountId: accountId || 'default',
      status,
      peerName,
      transport,
      updatedAt,
    });

    respond({
      ok: true,
      channel,
      accountId:
        typeof result === 'object' &&
        result !== null &&
        typeof (result as { accountId?: unknown }).accountId === 'string'
          ? ((result as { accountId: string }).accountId as string)
          : accountId || 'default',
      status,
      transport,
      peerName,
      connectedAt: updatedAt,
      details:
        typeof result === 'object' && result !== null && 'details' in result
          ? (result as { details?: unknown }).details
          : undefined,
    });
  },
);

registerMethod(
  'channels.unpair',
  async (params: Record<string, unknown>, client: GatewayClient, respond: RespondFn) => {
    const channel = safeString(params.channel).trim().toLowerCase();
    const accountId = safeString(params.accountId);
    const { isPairChannelType, unpairChannel } = await import('@/server/channels/pairing');
    if (!isPairChannelType(channel)) {
      throw new Error(`Unsupported channel: ${channel}`);
    }

    await unpairChannel(channel, accountId || undefined);

    const { getMessageRepository } = await import('@/server/channels/messages/runtime');
    const repo = getMessageRepository();
    repo.upsertChannelBinding?.({
      userId: client.userId,
      channel,
      status: 'disconnected',
      metadata: accountId ? { accountId } : undefined,
    });

    const updatedAt = new Date().toISOString();
    broadcastToUser(client.userId, GatewayEvents.CHANNELS_STATUS, {
      channel,
      accountId: accountId || 'default',
      status: 'disconnected',
      updatedAt,
    });

    respond({
      ok: true,
      channel,
      accountId: accountId || 'default',
      status: 'disconnected',
      updatedAt,
    });
  },
);

registerMethod(
  'inbox.list',
  async (params: Record<string, unknown>, client: GatewayClient, respond: RespondFn) => {
    const startedAt = Date.now();
    const input = resolveInboxListInput({
      channel: safeString(params.channel),
      q: safeString(params.q),
      limit: params.limit as number | string | undefined,
      cursor: safeString(params.cursor),
      resync: params.resync as string | number | boolean | undefined,
      version: params.version as string | number | undefined,
    });

    const v2Enabled = isInboxV2Enabled();
    if (input.version === 'v2' && !v2Enabled) {
      throw createUnavailableError('Inbox v2 is temporarily disabled.');
    }

    const rateLimit = consumeInboxRateLimit('ws', `${client.userId}:${client.connId}`);
    if (!rateLimit.allowed) {
      const error = new Error('Too many inbox requests.') as Error & { code: 'RATE_LIMITED' };
      error.code = 'RATE_LIMITED';
      throw error;
    }

    const { getMessageService } = await import('@/server/channels/messages/runtime');
    const service = getMessageService();
    const result = service.listInbox({
      userId: client.userId,
      channel: input.channel,
      query: input.query,
      limit: input.limit,
      cursor: input.cursor,
    });

    const durationMs = Date.now() - startedAt;
    recordInboxQueryDuration('ws', durationMs);
    if (input.resync) {
      recordInboxReconnectResync();
    }
    logInboxObservability('query.ws', {
      userId: client.userId,
      version: input.version,
      resync: input.resync,
      limit: input.limit,
      hasCursor: Boolean(input.cursor),
      returned: result.items.length,
      totalMatched: result.totalMatched,
      durationMs,
    });

    if (input.version === 'v1') {
      respond({
        ...toInboxV1Response(result),
        deprecated: {
          sunset: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(),
        },
      });
      return;
    }

    respond(toInboxV2Response(result));
  },
);
