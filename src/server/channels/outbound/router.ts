import { ChannelType } from '@/shared/domain/types';
import { deliverTelegram } from '@/server/channels/outbound/telegram';
import { deliverWhatsApp } from '@/server/channels/outbound/whatsapp';
import { deliverDiscord } from '@/server/channels/outbound/discord';
import { deliveriMessage } from '@/server/channels/outbound/imessage';
import { deliverSlack } from '@/server/channels/outbound/slack';
import type { ChannelKey } from '@/server/channels/adapters/types';
import { getAdapter, registerAdapter } from '@/server/channels/routing/adapterRegistry';
import { routeOutbound } from '@/server/channels/routing/outboundRouter';

let defaultAdaptersRegistered = false;

function toChannelKey(platform: ChannelType): ChannelKey | null {
  switch (platform) {
    case ChannelType.WEBCHAT:
      return 'webchat';
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
      send: async ({ externalChatId, content }) => deliverTelegram(externalChatId, content),
    });
  }
  if (!getAdapter('whatsapp')) {
    registerAdapter({
      channel: 'whatsapp',
      send: async ({ externalChatId, content, metadata }) =>
        deliverWhatsApp(externalChatId, content, metadata),
    });
  }
  if (!getAdapter('discord')) {
    registerAdapter({
      channel: 'discord',
      send: async ({ externalChatId, content }) => deliverDiscord(externalChatId, content),
    });
  }
  if (!getAdapter('imessage')) {
    registerAdapter({
      channel: 'imessage',
      send: async ({ externalChatId, content }) => deliveriMessage(externalChatId, content),
    });
  }
  if (!getAdapter('slack')) {
    registerAdapter({
      channel: 'slack',
      send: async ({ externalChatId, content }) => deliverSlack(externalChatId, content),
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
): Promise<void> {
  ensureDefaultAdapters();

  const channel = toChannelKey(platform);
  if (!channel) {
    console.warn(`Outbound delivery not implemented for platform: ${platform}`);
    return;
  }

  if (channel === 'webchat') {
    // WebChat relies on WS broadcast, no external delivery needed.
    return;
  }

  const routed = await routeOutbound({ channel, externalChatId, content });
  if (!routed) {
    console.warn(`No outbound adapter registered for platform: ${platform}`);
  }
}
