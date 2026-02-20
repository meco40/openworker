import { registerMethod, type RespondFn } from '../method-router';
import type { GatewayClient } from '../client-registry';
import { broadcastToUser } from '../broadcast';
import { GatewayEvents } from '../events';
import { CHANNEL_CAPABILITIES } from '../../channels/adapters/capabilities';
import type { ChannelKey } from '../../channels/adapters/types';
import { listBridgeAccounts } from '../../channels/pairing/bridgeAccounts';

function safeString(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function normalizeText(value: string): string {
  return value.trim().toLowerCase();
}

registerMethod(
  'channels.list',
  async (_params: Record<string, unknown>, client: GatewayClient, respond: RespondFn) => {
    const { getMessageRepository } = await import('../../channels/messages/runtime');
    const repo = getMessageRepository();
    const bindings = repo.listChannelBindings?.(client.userId) ?? [];
    const bindingMap = new Map(bindings.map((binding) => [binding.channel, binding]));

    const channels = Object.entries(CHANNEL_CAPABILITIES).map(([channel, capabilities]) => {
      const binding = bindingMap.get(channel as ChannelKey);
      const bridgeAccounts =
        channel === 'whatsapp' || channel === 'imessage'
          ? listBridgeAccounts(channel)
          : undefined;
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

    const { isPairChannelType, pairChannel } = await import('../../channels/pairing');
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

    const { getMessageRepository } = await import('../../channels/messages/runtime');
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
    const { isPairChannelType, unpairChannel } = await import('../../channels/pairing');
    if (!isPairChannelType(channel)) {
      throw new Error(`Unsupported channel: ${channel}`);
    }

    await unpairChannel(channel, accountId || undefined);

    const { getMessageRepository } = await import('../../channels/messages/runtime');
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
    const filterChannel = normalizeText(safeString(params.channel));
    const query = normalizeText(safeString(params.q));
    const requestedLimit = Number(params.limit);
    const limit = Number.isFinite(requestedLimit) ? Math.max(1, Math.min(100, requestedLimit)) : 50;

    const { getMessageService } = await import('../../channels/messages/runtime');
    const service = getMessageService();

    const conversations = service.listConversations(client.userId, limit);
    const items = conversations
      .map((conversation) => {
        const lastMessage = service.listMessages(conversation.id, client.userId, 1).at(-1) || null;
        return {
          conversationId: conversation.id,
          channelType: conversation.channelType,
          title: conversation.title,
          updatedAt: conversation.updatedAt,
          lastMessage: lastMessage
            ? {
                id: lastMessage.id,
                role: lastMessage.role,
                content: lastMessage.content,
                createdAt: lastMessage.createdAt,
                platform: lastMessage.platform,
              }
            : null,
        };
      })
      .filter((item) => !filterChannel || normalizeText(item.channelType) === filterChannel)
      .filter((item) => {
        if (!query) return true;
        return (
          normalizeText(item.title).includes(query) ||
          normalizeText(item.lastMessage?.content || '').includes(query)
        );
      });

    respond({
      items,
      total: items.length,
      nextCursor: null,
    });
  },
);
