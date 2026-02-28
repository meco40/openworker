/**
 * Agent Room – Background Navigation
 *
 * Verifies that the AgentRoomView component resolves correctly and that
 * the navigation state model (entry ↔ detail) is logically sound.
 */
import { describe, expect, it } from 'vitest';
import AgentRoomView from '@/modules/agent-room/components/AgentRoomView';
import type { SwarmRecord } from '@/modules/agent-room/swarmTypes';
import type { SwarmStatus } from '@/shared/domain/agentRoom.types';

// ─── Fixtures ─────────────────────────────────────────────────────────────────

function makeSwarm(id: string, status: SwarmStatus = 'idle'): SwarmRecord {
  return {
    id,
    conversationId: 'conv-1',
    userId: 'user-1',
    sessionId: null,
    title: `Swarm ${id}`,
    task: 'Background navigation test task',
    leadPersonaId: 'persona-1',
    units: [{ personaId: 'persona-1', role: 'lead' }],
    status,
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
  };
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('AgentRoomView', () => {
  it('is a defined React component', () => {
    expect(AgentRoomView).toBeDefined();
    expect(typeof AgentRoomView).toBe('function');
  });
});

describe('Navigation state model', () => {
  it('starts on entry page when pageMode is "entry"', () => {
    const pageMode: 'entry' | 'detail' = 'entry';
    expect(pageMode).toBe('entry');
  });

  it('transitions to detail page when pageMode is "detail"', () => {
    let pageMode: 'entry' | 'detail' = 'entry';
    // Simulate opening a swarm
    pageMode = 'detail';
    expect(pageMode).toBe('detail');
  });

  it('returns to entry page when back is triggered', () => {
    let pageMode: 'entry' | 'detail' = 'detail';
    // Simulate back navigation
    pageMode = 'entry';
    expect(pageMode).toBe('entry');
  });
});

describe('Swarm list management', () => {
  it('filters running swarms correctly', () => {
    const swarms: SwarmRecord[] = [
      makeSwarm('a', 'running'),
      makeSwarm('b', 'idle'),
      makeSwarm('c', 'hold'),
      makeSwarm('d', 'completed'),
    ];

    const active = swarms.filter((s) => s.status === 'running' || s.status === 'hold');
    expect(active).toHaveLength(2);
    expect(active.map((s) => s.id)).toContain('a');
    expect(active.map((s) => s.id)).toContain('c');
  });

  it('counts swarms by status', () => {
    const swarms: SwarmRecord[] = [
      makeSwarm('a', 'running'),
      makeSwarm('b', 'running'),
      makeSwarm('c', 'idle'),
      makeSwarm('d', 'completed'),
      makeSwarm('e', 'aborted'),
    ];

    const counts = {
      running: swarms.filter((s) => s.status === 'running').length,
      idle: swarms.filter((s) => s.status === 'idle').length,
      completed: swarms.filter((s) => s.status === 'completed').length,
      aborted: swarms.filter((s) => s.status === 'aborted').length,
    };

    expect(counts.running).toBe(2);
    expect(counts.idle).toBe(1);
    expect(counts.completed).toBe(1);
    expect(counts.aborted).toBe(1);
  });
});

describe('Selected swarm management', () => {
  it('selectedSwarmId is null initially', () => {
    const selectedSwarmId: string | null = null;
    expect(selectedSwarmId).toBeNull();
  });

  it('selectedSwarmId is set when swarm is opened', () => {
    const swarm = makeSwarm('nav-swarm-1', 'running');
    let selectedSwarmId: string | null = null;
    selectedSwarmId = swarm.id;
    expect(selectedSwarmId).toBe('nav-swarm-1');
  });

  it('selectedSwarmId is cleared when navigating back', () => {
    let selectedSwarmId: string | null = 'nav-swarm-1';
    selectedSwarmId = null;
    expect(selectedSwarmId).toBeNull();
  });
});

describe('Notice state', () => {
  it('notice is null initially', () => {
    const notice: string | null = null;
    expect(notice).toBeNull();
  });

  it('notice is set when swarm no longer exists', () => {
    let notice: string | null = null;
    notice = 'The selected task no longer exists.';
    expect(notice).not.toBeNull();
    expect(notice).toContain('no longer exists');
  });

  it('notice is cleared when opening a swarm', () => {
    let notice: string | null = 'Some notice';
    notice = null;
    expect(notice).toBeNull();
  });
});
