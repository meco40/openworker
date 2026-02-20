export async function pairDiscord(token: string) {
  if (!token) throw new Error('Discord bot token is required.');
  const response = await fetch('https://discord.com/api/v10/users/@me', {
    headers: { Authorization: `Bot ${token}` },
  });
  const data = (await response.json()) as { username?: string; discriminator?: string };
  if (!response.ok) {
    throw new Error(`Discord auth failed: ${JSON.stringify(data)}`);
  }

  // Persist token to credential store + env fallback
  const { getCredentialStore } = await import('@/server/channels/credentials');
  const store = getCredentialStore();
  store.setCredential('discord', 'bot_token', token);
  process.env.DISCORD_BOT_TOKEN = token;

  return {
    peerName: data.username ? `${data.username}#${data.discriminator || '0'}` : 'discord-bot',
    details: data,
  };
}
