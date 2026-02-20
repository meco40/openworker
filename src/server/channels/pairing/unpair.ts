import { getCredentialStore } from '@/server/channels/credentials';
import {
  listBridgeAccountIds,
  normalizeBridgeAccountId,
  removeBridgeAccount,
  resolveBridgeAccountSecret,
  type BridgeChannel,
} from '@/server/channels/pairing/bridgeAccounts';

export type UnpairChannelType = 'whatsapp' | 'telegram' | 'discord' | 'imessage' | 'slack';

/**
 * Disconnects a channel by removing webhooks and clearing credentials.
 */
export async function unpairChannel(channel: UnpairChannelType, accountId?: string): Promise<void> {
  switch (channel) {
    case 'telegram':
      await unpairTelegram(getCredentialStore());
      break;
    case 'discord':
      unpairDiscord(getCredentialStore());
      break;
    case 'whatsapp':
      await unpairBridge('whatsapp', getCredentialStore(), accountId);
      break;
    case 'imessage':
      await unpairBridge('imessage', getCredentialStore(), accountId);
      break;
    case 'slack':
      unpairSlack(getCredentialStore());
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

function unpairSlack(store: ReturnType<typeof getCredentialStore>): void {
  store.deleteCredentials('slack');
  delete process.env.SLACK_BOT_TOKEN;
}

async function unpairBridge(
  channel: BridgeChannel,
  store: ReturnType<typeof getCredentialStore>,
  accountIdInput?: string,
): Promise<void> {
  const envName = channel === 'whatsapp' ? 'WHATSAPP_BRIDGE_URL' : 'IMESSAGE_BRIDGE_URL';
  const bridgeUrl = process.env[envName];
  const accountId = normalizeBridgeAccountId(accountIdInput);
  const shouldUnpairAll = accountIdInput === undefined;
  const targetAccountIds = shouldUnpairAll ? listBridgeAccountIds(channel, store) : [accountId];
  const accountsToClear = targetAccountIds.length > 0 ? targetAccountIds : [accountId];

  for (const targetAccountId of accountsToClear) {
    // Attempt to deregister our webhook from the bridge
    if (bridgeUrl) {
      try {
        const url = `${bridgeUrl.replace(/\/$/, '')}/webhook?accountId=${encodeURIComponent(targetAccountId)}`;
        const secret = resolveBridgeAccountSecret(channel, targetAccountId, store);
        await fetch(url, {
          method: 'DELETE',
          headers: secret ? { 'x-webhook-secret': secret } : undefined,
        });
      } catch (error) {
        console.warn(`${channel} webhook deregistration warning:`, error);
      }
    }

    removeBridgeAccount(channel, targetAccountId, store);
  }

  if (shouldUnpairAll) {
    const hasRemainingAccounts = listBridgeAccountIds(channel, store).length > 0;
    if (!hasRemainingAccounts) {
      store.deleteCredentials(channel);
    }
  }
}
