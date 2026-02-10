import { getCredentialStore } from '../credentials';

export type UnpairChannelType = 'whatsapp' | 'telegram' | 'discord' | 'imessage';

/**
 * Disconnects a channel by removing webhooks and clearing credentials.
 */
export async function unpairChannel(channel: UnpairChannelType): Promise<void> {
  const store = getCredentialStore();

  switch (channel) {
    case 'telegram':
      await unpairTelegram(store);
      break;
    case 'discord':
      unpairDiscord(store);
      break;
    case 'whatsapp':
      await unpairBridge('whatsapp', store);
      break;
    case 'imessage':
      await unpairBridge('imessage', store);
      break;
    default:
      throw new Error(`Unsupported channel for unpair: ${channel}`);
  }
}

async function unpairTelegram(store: ReturnType<typeof getCredentialStore>): Promise<void> {
  const token = store.getCredential('telegram', 'bot_token') || process.env.TELEGRAM_BOT_TOKEN;

  // Call Telegram deleteWebhook API if token available
  if (token) {
    try {
      await fetch(`https://api.telegram.org/bot${token}/deleteWebhook`, { method: 'POST' });
    } catch (error) {
      console.warn('Telegram deleteWebhook warning:', error);
    }
  }

  // Clear credentials
  store.deleteCredentials('telegram');
  delete process.env.TELEGRAM_BOT_TOKEN;
  delete process.env.TELEGRAM_WEBHOOK_SECRET;
}

function unpairDiscord(store: ReturnType<typeof getCredentialStore>): void {
  // Discord bot connections don't have a webhook to remove in this flow
  store.deleteCredentials('discord');
  delete process.env.DISCORD_BOT_TOKEN;
}

async function unpairBridge(
  channel: 'whatsapp' | 'imessage',
  store: ReturnType<typeof getCredentialStore>,
): Promise<void> {
  const envName = channel === 'whatsapp' ? 'WHATSAPP_BRIDGE_URL' : 'IMESSAGE_BRIDGE_URL';
  const bridgeUrl = process.env[envName];

  // Attempt to deregister our webhook from the bridge
  if (bridgeUrl) {
    try {
      await fetch(`${bridgeUrl.replace(/\/$/, '')}/webhook`, { method: 'DELETE' });
    } catch (error) {
      console.warn(`${channel} webhook deregistration warning:`, error);
    }
  }

  store.deleteCredentials(channel);
}
