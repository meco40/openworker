import { describe, expect, it } from 'vitest';

import { resolveRoomRunnerMode, shouldRunRooms } from '../../../src/server/rooms/runtimeRole';

describe('room runtime role', () => {
  function withMode(mode: string): NodeJS.ProcessEnv {
    return { NODE_ENV: 'test', ROOMS_RUNNER: mode } as unknown as NodeJS.ProcessEnv;
  }

  it('defaults to both when env is unset', () => {
    expect(resolveRoomRunnerMode({} as NodeJS.ProcessEnv)).toBe('both');
    expect(shouldRunRooms('web', {} as NodeJS.ProcessEnv)).toBe(true);
    expect(shouldRunRooms('scheduler', {} as NodeJS.ProcessEnv)).toBe(true);
  });

  it('runs only scheduler when ROOMS_RUNNER=scheduler', () => {
    const env = withMode('scheduler');
    expect(resolveRoomRunnerMode(env)).toBe('scheduler');
    expect(shouldRunRooms('web', env)).toBe(false);
    expect(shouldRunRooms('scheduler', env)).toBe(true);
  });

  it('runs only web when ROOMS_RUNNER=web', () => {
    const env = withMode('web');
    expect(resolveRoomRunnerMode(env)).toBe('web');
    expect(shouldRunRooms('web', env)).toBe(true);
    expect(shouldRunRooms('scheduler', env)).toBe(false);
  });

  it('falls back to both for unknown values', () => {
    const env = withMode('invalid-mode');
    expect(resolveRoomRunnerMode(env)).toBe('both');
    expect(shouldRunRooms('web', env)).toBe(true);
    expect(shouldRunRooms('scheduler', env)).toBe(true);
  });
});
