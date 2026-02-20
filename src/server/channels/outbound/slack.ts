import { getCredentialStore } from '@/server/channels/credentials';

/**
 * Delivers a message to Slack via chat.postMessage API.
 */
export async function deliverSlack(channelId: string, text: string): Promise<void> {
  const token =
    getCredentialStore().getCredential('slack', 'bot_token') || process.env.SLACK_BOT_TOKEN;
  if (!token) {
    console.error('Slack bot token not configured (neither in credential store nor env).');
    return;
  }

  const response = await fetch('https://slack.com/api/chat.postMessage', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      channel: channelId,
      text,
    }),
  });

  const data = (await response.json()) as { ok?: boolean; error?: string };
  if (!response.ok || !data.ok) {
    throw new Error(
      `Slack delivery failed: ${data.error || response.statusText || 'unknown error'}`,
    );
  }
}
