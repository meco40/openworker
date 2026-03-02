import { getCredentialStore } from '@/server/channels/credentials';
import { stopTelegramPolling } from '@/server/channels/pairing/telegramPolling';
import {
  listBridgeAccountIds,
  normalizeBridgeAccountId,
  removeBridgeAccount,
  resolveBridgeAccountSecret,
  type BridgeChannel,
} from '@/server/channels/pairing/bridgeAccounts';

export type UnpairChannelType = 'whatsapp' | 'telegram' | 'discord' | 'imessage' | 'slack';
type CredentialStore = ReturnType<typeof getCredentialStore>;

/**
 * Disconnects a channel by removing webhooks and clearing credentials.
 */
export async function unpairChannel(
  channel: UnpairChannelType,
  accountId?: string,
  storeOverride?: CredentialStore,
): Promise<void> {
  const store = storeOverride ?? getCredentialStore();
  switch (channel) {
    case 'telegram':
      await unpairTelegram(store);
      break;
    case 'discord':
      unpairDiscord(store);
      break;
    case 'whatsapp':
      await unpairBridge('whatsapp', store, accountId);
      break;
    case 'imessage':
      await unpairBridge('imessage', store, accountId);
      break;
    case 'slack':
      unpairSlack(store);
      break;
    default:
      throw new Error(`Unsupported channel for unpair: ${channel}`);
  }
}

async function unpairTelegram(store: CredentialStore): Promise<void> {
  stopTelegramPolling();

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
  const hasTokenAfterDelete = Boolean(store.getCredential('telegram', 'bot_token'));
  const hasResidualCredentials = store.listCredentials('telegram').length > 0;
  if (hasTokenAfterDelete || hasResidualCredentials) {
    throw new Error('Telegram disconnect incomplete: bot token still present in credential store.');
  }
  delete process.env.TELEGRAM_BOT_TOKEN;
  delete process.env.TELEGRAM_WEBHOOK_SECRET;
}

function unpairDiscord(store: CredentialStore): void {
  // Discord bot connections don't have a webhook to remove in this flow
  store.deleteCredentials('discord');
  delete process.env.DISCORD_BOT_TOKEN;
}

function unpairSlack(store: CredentialStore): void {
  store.deleteCredentials('slack');
  delete process.env.SLACK_BOT_TOKEN;
}

async function unpairBridge(
  channel: BridgeChannel,
  store: CredentialStore,
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
