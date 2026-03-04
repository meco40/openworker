import { describe, expect, it } from 'vitest';
import { SWARM_PHASES } from '@/shared/domain/swarmPhases';
import {
  buildPhaseIdempotencyKey,
  getPhaseCommandMethod,
} from '@/modules/agent-room/hooks/useAgentRoomRuntime';

describe('swarm sequencer contract', () => {
  it('uses deterministic command sequence and idempotency keys per phase', () => {
    const methods = SWARM_PHASES.map((phase) => getPhaseCommandMethod(phase));
    expect(methods[0]).toBe('agent.v2.session.input');
    expect(methods.slice(1).every((method) => method === 'agent.v2.session.follow_up')).toBe(true);

    const keys = SWARM_PHASES.map((phase) => buildPhaseIdempotencyKey('swarm-123', phase));
    expect(new Set(keys).size).toBe(SWARM_PHASES.length);
    expect(keys[0]).toBe('swarm-123:analysis');
    expect(keys[keys.length - 1]).toBe('swarm-123:result');
  });
});
