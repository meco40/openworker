export function isAgentRoomEnabled(): boolean {
  return String(process.env.NEXT_PUBLIC_AGENT_ROOM_ENABLED || 'true').toLowerCase() === 'true';
}
