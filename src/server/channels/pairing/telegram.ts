export async function pairTelegram(token: string) {
  if (!token) throw new Error('Telegram token is required.');
  const response = await fetch(`https://api.telegram.org/bot${token}/getMe`);
  const data = (await response.json()) as { ok?: boolean; result?: { username?: string; id?: number } };
  if (!response.ok || !data.ok) {
    throw new Error(`Telegram auth failed: ${JSON.stringify(data)}`);
  }
  return {
    peerName: data.result?.username || `telegram:${data.result?.id || 'unknown'}`,
    details: data.result,
  };
}
