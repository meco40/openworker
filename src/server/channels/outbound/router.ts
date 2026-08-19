import { ChannelType } from '@/shared/domain/types';
import { deliverTelegram } from '@/server/channels/outbound/telegram';
import { deliverWhatsApp } from '@/server/channels/outbound/whatsapp';
import { deliverDiscord } from '@/server/channels/outbound/discord';
import { deliveriMessage } from '@/server/channels/outbound/imessage';
import { deliverSlack } from '@/server/channels/outbound/slack';
import type { ChannelKey, OutboundDeliveryReceipt } from '@/server/channels/adapters/types';
import { getAdapter, registerAdapter } from '@/server/channels/routing/adapterRegistry';
import { routeOutboundWithReceipt } from '@/server/channels/routing/outboundRouter';

let defaultAdaptersRegistered = false;

function toChannelKey(platform: ChannelType): ChannelKey | null {
  switch (platform) {
    case ChannelType.WEBCHAT:
      return 'webchat';
    case ChannelType.AGENT_ROOM:
      return 'agent_room';
    case ChannelType.TELEGRAM:
      return 'telegram';
    case ChannelType.WHATSAPP:
      return 'whatsapp';
    case ChannelType.DISCORD:
      return 'discord';
    case ChannelType.IMESSAGE:
      return 'imessage';
    case ChannelType.SLACK:
      return 'slack';
    default:
      return null;
  }
}

function ensureDefaultAdapters(): void {
  if (defaultAdaptersRegistered) {
    return;
  }

  if (!getAdapter('telegram')) {
    registerAdapter({
      channel: 'telegram',
      send: async ({ externalChatId, content, metadata }) => {
        const providerMessageId = await deliverTelegram(externalChatId, content, {
          personaId: metadata?.personaId as string | undefined,
        });
        return { providerId: 'telegram', providerMessageId, deliveredAt: new Date().toISOString() };
      },
    });
  }
  if (!getAdapter('whatsapp')) {
    registerAdapter({
      channel: 'whatsapp',
      send: async ({ externalChatId, content, metadata }) => {
        const providerMessageId = await deliverWhatsApp(externalChatId, content, metadata);
        return { providerId: 'whatsapp', providerMessageId, deliveredAt: new Date().toISOString() };
      },
    });
  }
  if (!getAdapter('discord')) {
    registerAdapter({
      channel: 'discord',
      send: async ({ externalChatId, content }) => {
        const providerMessageId = await deliverDiscord(externalChatId, content);
        return { providerId: 'discord', providerMessageId, deliveredAt: new Date().toISOString() };
      },
    });
  }
  if (!getAdapter('imessage')) {
    registerAdapter({
      channel: 'imessage',
      send: async ({ externalChatId, content }) => {
        const providerMessageId = await deliveriMessage(externalChatId, content);
        return { providerId: 'imessage', providerMessageId, deliveredAt: new Date().toISOString() };
      },
    });
  }
  if (!getAdapter('slack')) {
    registerAdapter({
      channel: 'slack',
      send: async ({ externalChatId, content }) => {
        const providerMessageId = await deliverSlack(externalChatId, content);
        return { providerId: 'slack', providerMessageId, deliveredAt: new Date().toISOString() };
      },
    });
  }

  defaultAdaptersRegistered = true;
}

/**
 * Routes an agent response back to the originating external messenger channel.
 */
export async function deliverOutbound(
  platform: ChannelType,
  externalChatId: string,
  content: string,
  options?: { personaId?: string },
): Promise<void> {
  await deliverOutboundWithReceipt(platform, externalChatId, content, options);
}

export async function deliverOutboundWithReceipt(
  platform: ChannelType,
  externalChatId: string,
  content: string,
  options?: { personaId?: string },
): Promise<(OutboundDeliveryReceipt & { channel: ChannelType; target: string }) | null> {
  ensureDefaultAdapters();

  const channel = toChannelKey(platform);
  if (!channel) {
    console.warn(`Outbound delivery not implemented for platform: ${platform}`);
    return null;
  }

  if (channel === 'webchat') {
    // WebChat relies on WS broadcast, no external delivery needed.
    return {
      providerId: platform,
      channel: platform,
      target: externalChatId,
      deliveredAt: new Date().toISOString(),
    };
  }

  if (channel === 'agent_room') {
    // Agent Room is fully isolated; WS streaming handles all output.
    return {
      providerId: platform,
      channel: platform,
      target: externalChatId,
      deliveredAt: new Date().toISOString(),
    };
  }

  const routed = await routeOutboundWithReceipt({
    channel,
    externalChatId,
    content,
    ...(options?.personaId ? { metadata: { personaId: options.personaId } } : {}),
  });
  if (!routed) {
    console.warn(`No outbound adapter registered for platform: ${platform}`);
    return null;
  }
  return { ...routed, channel: platform, target: externalChatId };
}
