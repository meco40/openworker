export function isPersistentSessionV2Enabled(): boolean {
  return String(process.env.CHAT_PERSISTENT_SESSION_V2 || 'true').toLowerCase() === 'true';
}
