export const DEFAULT_ROOM_ORCHESTRATOR_INTERVAL_MS = 10_000;

export function getRoomOrchestratorIntervalMs(env: NodeJS.ProcessEnv = process.env): number {
  return Number(env.ROOM_ORCHESTRATOR_INTERVAL_MS || DEFAULT_ROOM_ORCHESTRATOR_INTERVAL_MS);
}
