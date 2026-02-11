import { getCredentialStore } from '../credentials';

export async function pairSlack(token: string) {
  if (!token) {
    throw new Error('Slack bot token is required.');
  }

  const response = await fetch('https://slack.com/api/auth.test', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
  });

  const data = (await response.json()) as {
    ok?: boolean;
    error?: string;
    team?: string;
    team_id?: string;
    user?: string;
    bot_id?: string;
  };

  if (!response.ok || !data.ok) {
    throw new Error(`Slack auth failed: ${data.error || response.statusText || 'unknown error'}`);
  }

  const store = getCredentialStore();
  store.setCredential('slack', 'bot_token', token);
  process.env.SLACK_BOT_TOKEN = token;

  return {
    status: 'connected' as const,
    peerName: data.team || data.user || 'slack-bot',
    details: {
      teamId: data.team_id || null,
      botId: data.bot_id || null,
    },
  };
}
