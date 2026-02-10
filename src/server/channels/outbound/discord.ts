/**
 * Delivers a message to a Discord channel via the Bot API.
 */
export async function deliverDiscord(channelId: string, text: string): Promise<void> {
  const { getCredentialStore } = await import('../credentials');
  const token =
    getCredentialStore().getCredential('discord', 'bot_token') || process.env.DISCORD_BOT_TOKEN;
  if (!token) {
    console.error('Discord bot token not configured (neither in credential store nor env).');
    return;
  }

  const url = `https://discord.com/api/v10/channels/${channelId}/messages`;
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bot ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ content: text }),
  });

  if (!response.ok) {
    const error = await response.json().catch(() => ({}));
    throw new Error(`Discord delivery failed: ${JSON.stringify(error)}`);
  }
}
