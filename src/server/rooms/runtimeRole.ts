export type RoomRunnerMode = 'web' | 'scheduler' | 'both';

const VALID_ROOM_RUNNER_MODES = new Set<RoomRunnerMode>(['web', 'scheduler', 'both']);

export function resolveRoomRunnerMode(env: NodeJS.ProcessEnv = process.env): RoomRunnerMode {
  const raw = (env.ROOMS_RUNNER || 'both').trim().toLowerCase() as RoomRunnerMode;
  return VALID_ROOM_RUNNER_MODES.has(raw) ? raw : 'both';
}

export function shouldRunRooms(
  processRole: 'web' | 'scheduler',
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  const mode = resolveRoomRunnerMode(env);
  return mode === 'both' || mode === processRole;
}
