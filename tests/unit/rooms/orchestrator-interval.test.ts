import { describe, expect, it } from 'vitest';

import {
  DEFAULT_ROOM_ORCHESTRATOR_INTERVAL_MS,
  getRoomOrchestratorIntervalMs,
} from '@/server/rooms/orchestratorInterval';

describe('room orchestrator interval', () => {
  it('defaults to 15 seconds when env is unset', () => {
    expect(DEFAULT_ROOM_ORCHESTRATOR_INTERVAL_MS).toBe(10_000);
    expect(getRoomOrchestratorIntervalMs({} as NodeJS.ProcessEnv)).toBe(10_000);
  });

  it('uses ROOM_ORCHESTRATOR_INTERVAL_MS when provided', () => {
    const env = {
      NODE_ENV: 'test',
      ROOM_ORCHESTRATOR_INTERVAL_MS: '42000',
    } as unknown as NodeJS.ProcessEnv;
    expect(getRoomOrchestratorIntervalMs(env)).toBe(42_000);
  });
});
