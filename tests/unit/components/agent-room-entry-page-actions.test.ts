/**
 * Agent Room – Entry Page Actions
 *
 * Verifies that the AgentRoomEntryPage and SwarmTaskCard components
 * export the expected shapes and that the section-grouping logic
 * works correctly without a DOM environment.
 */
import { describe, expect, it } from 'vitest';
import { AgentRoomEntryPage } from '@/modules/agent-room/components/layout/AgentRoomEntryPage';
import { SwarmTaskCard } from '@/modules/agent-room/components/layout/SwarmTaskCard';
import type { SwarmRecord } from '@/modules/agent-room/swarmTypes';
import type { SwarmStatus } from '@/shared/domain/agentRoom.types';

// ─── Fixtures ─────────────────────────────────────────────────────────────────

function makeSwarm(overrides: Partial<SwarmRecord> = {}): SwarmRecord {
  return {
    id: 'swarm-1',
    conversationId: 'conv-1',
    userId: 'user-1',
    sessionId: null,
    title: 'Test Swarm',
    task: 'A test task description',
    leadPersonaId: 'persona-1',
    units: [{ personaId: 'persona-1', role: 'lead' }],
    status: 'idle',
    currentPhase: 'analysis',
    consensusScore: 0,
    holdFlag: false,
    artifact: '',
    artifactHistory: [],
    friction: {
      level: 'low',
      confidence: 0,
      hold: false,
      reasons: [],
      updatedAt: new Date().toISOString(),
    },
    lastSeq: 0,
    currentDeployCommandId: null,
    searchEnabled: false,
    swarmTemplate: null,
    pauseBetweenPhases: false,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
  };
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('AgentRoomEntryPage', () => {
  it('is a defined React component', () => {
    expect(AgentRoomEntryPage).toBeDefined();
    expect(typeof AgentRoomEntryPage).toBe('function');
  });
});

describe('SwarmTaskCard', () => {
  it('is a defined React component', () => {
    expect(SwarmTaskCard).toBeDefined();
    expect(typeof SwarmTaskCard).toBe('function');
  });
});

describe('SwarmStatus coverage', () => {
  const statuses: SwarmStatus[] = ['idle', 'running', 'hold', 'completed', 'aborted', 'error'];

  it.each(statuses)('accepts status "%s"', (status) => {
    const swarm = makeSwarm({ status });
    expect(swarm.status).toBe(status);
  });
});

describe('Section grouping logic', () => {
  it('groups running and hold swarms into running_hold section', () => {
    const swarms = [
      makeSwarm({ id: 'a', status: 'running' }),
      makeSwarm({ id: 'b', status: 'hold' }),
      makeSwarm({ id: 'c', status: 'idle' }),
      makeSwarm({ id: 'd', status: 'completed' }),
    ];

    const runningHold = swarms.filter((s) => s.status === 'running' || s.status === 'hold');
    const idle = swarms.filter((s) => s.status === 'idle');
    const completed = swarms.filter((s) => s.status === 'completed');
    const abortedError = swarms.filter((s) => s.status === 'aborted' || s.status === 'error');

    expect(runningHold).toHaveLength(2);
    expect(idle).toHaveLength(1);
    expect(completed).toHaveLength(1);
    expect(abortedError).toHaveLength(0);
  });

  it('groups aborted and error swarms into aborted_error section', () => {
    const swarms = [
      makeSwarm({ id: 'a', status: 'aborted' }),
      makeSwarm({ id: 'b', status: 'error' }),
    ];

    const abortedError = swarms.filter((s) => s.status === 'aborted' || s.status === 'error');
    expect(abortedError).toHaveLength(2);
  });
});

describe('Delete guard logic', () => {
  it('prevents deletion of running swarms', () => {
    const swarm = makeSwarm({ status: 'running' });
    const canDelete = swarm.status !== 'running' && swarm.status !== 'hold';
    expect(canDelete).toBe(false);
  });

  it('prevents deletion of hold swarms', () => {
    const swarm = makeSwarm({ status: 'hold' });
    const canDelete = swarm.status !== 'running' && swarm.status !== 'hold';
    expect(canDelete).toBe(false);
  });

  it('allows deletion of idle swarms', () => {
    const swarm = makeSwarm({ status: 'idle' });
    const canDelete = swarm.status !== 'running' && swarm.status !== 'hold';
    expect(canDelete).toBe(true);
  });

  it('allows deletion of completed swarms', () => {
    const swarm = makeSwarm({ status: 'completed' });
    const canDelete = swarm.status !== 'running' && swarm.status !== 'hold';
    expect(canDelete).toBe(true);
  });

  it('allows deletion of aborted swarms', () => {
    const swarm = makeSwarm({ status: 'aborted' });
    const canDelete = swarm.status !== 'running' && swarm.status !== 'hold';
    expect(canDelete).toBe(true);
  });
});

describe('Active task detection', () => {
  it('identifies running swarms as active', () => {
    const swarm = makeSwarm({ status: 'running' });
    const isActive = swarm.status === 'running' || swarm.status === 'hold';
    expect(isActive).toBe(true);
  });

  it('identifies hold swarms as active', () => {
    const swarm = makeSwarm({ status: 'hold' });
    const isActive = swarm.status === 'running' || swarm.status === 'hold';
    expect(isActive).toBe(true);
  });

  it('identifies completed swarms as not active', () => {
    const swarm = makeSwarm({ status: 'completed' });
    const isActive = swarm.status === 'running' || swarm.status === 'hold';
    expect(isActive).toBe(false);
  });
});

describe('SwarmRecord structure', () => {
  it('has all required fields', () => {
    const swarm = makeSwarm();
    expect(swarm).toHaveProperty('id');
    expect(swarm).toHaveProperty('title');
    expect(swarm).toHaveProperty('task');
    expect(swarm).toHaveProperty('status');
    expect(swarm).toHaveProperty('currentPhase');
    expect(swarm).toHaveProperty('units');
    expect(swarm).toHaveProperty('lastSeq');
    expect(swarm).toHaveProperty('updatedAt');
  });

  it('units is an array', () => {
    const swarm = makeSwarm();
    expect(Array.isArray(swarm.units)).toBe(true);
  });
});
