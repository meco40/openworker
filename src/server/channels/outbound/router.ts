import { ChannelType } from '../../../../types';
import { deliverTelegram } from './telegram';
import { deliverWhatsApp } from './whatsapp';
import { deliverDiscord } from './discord';
import { deliveriMessage } from './imessage';

/**
 * Routes an agent response back to the originating external messenger channel.
 */
export async function deliverOutbound(
  platform: ChannelType,
  externalChatId: string,
  content: string,
): Promise<void> {
  switch (platform) {
    case ChannelType.TELEGRAM:
      await deliverTelegram(externalChatId, content);
      break;
    case ChannelType.WHATSAPP:
      await deliverWhatsApp(externalChatId, content);
      break;
    case ChannelType.DISCORD:
      await deliverDiscord(externalChatId, content);
      break;
    case ChannelType.IMESSAGE:
      await deliveriMessage(externalChatId, content);
      break;
    case ChannelType.WEBCHAT:
      // WebChat relies on SSE broadcast, no external delivery needed
      break;
    default:
      console.warn(`Outbound delivery not implemented for platform: ${platform}`);
  }
}
