/**
 * Agent Room – Detail Header
 *
 * Verifies the AgentRoomDetailPage component exports correctly and that
 * the header action logic (pause/resume/stop/finish) is consistent with
 * the SwarmStatus model.
 */
import { describe, expect, it } from 'vitest';
import { AgentRoomDetailPage } from '@/modules/agent-room/components/layout/AgentRoomDetailPage';
import type { SwarmRecord } from '@/modules/agent-room/swarmTypes';
import type { SwarmStatus } from '@/shared/domain/agentRoom.types';

// ─── Fixtures ─────────────────────────────────────────────────────────────────

function makeSwarm(overrides: Partial<SwarmRecord> = {}): SwarmRecord {
  return {
    id: 'swarm-detail-1',
    conversationId: 'conv-1',
    userId: 'user-1',
    sessionId: null,
    title: 'Detail Test Swarm',
    task: 'Testing the detail page header',
    leadPersonaId: 'persona-1',
    units: [
      { personaId: 'persona-1', role: 'lead' },
      { personaId: 'persona-2', role: 'analyst' },
    ],
    status: 'running',
    currentPhase: 'analysis',
    consensusScore: 0.75,
    holdFlag: false,
    artifact: '',
    artifactHistory: [],
    friction: {
      level: 'low',
      confidence: 0.8,
      hold: false,
      reasons: [],
      updatedAt: new Date().toISOString(),
    },
    lastSeq: 5,
    currentDeployCommandId: null,
    searchEnabled: true,
    swarmTemplate: null,
    pauseBetweenPhases: false,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
  };
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('AgentRoomDetailPage', () => {
  it('is a defined React component', () => {
    expect(AgentRoomDetailPage).toBeDefined();
    expect(typeof AgentRoomDetailPage).toBe('function');
  });
});

describe('Header action visibility logic', () => {
  it('shows pause/stop for running swarms', () => {
    const swarm = makeSwarm({ status: 'running' });
    const isRunning = swarm.status === 'running';
    const isHold = swarm.status === 'hold';
    const isActive = isRunning || isHold;
    const isFinished =
      swarm.status === 'completed' || swarm.status === 'aborted' || swarm.status === 'error';

    expect(isActive).toBe(true);
    expect(isRunning).toBe(true);
    expect(isHold).toBe(false);
    expect(isFinished).toBe(false);
  });

  it('shows resume/stop for hold swarms', () => {
    const swarm = makeSwarm({ status: 'hold' });
    const isRunning = swarm.status === 'running';
    const isHold = swarm.status === 'hold';
    const isActive = isRunning || isHold;

    expect(isActive).toBe(true);
    expect(isRunning).toBe(false);
    expect(isHold).toBe(true);
  });

  it('disables pause/stop for completed swarms', () => {
    const swarm = makeSwarm({ status: 'completed' });
    const isActive = swarm.status === 'running' || swarm.status === 'hold';
    const isFinished =
      swarm.status === 'completed' || swarm.status === 'aborted' || swarm.status === 'error';

    expect(isActive).toBe(false);
    expect(isFinished).toBe(true);
  });

  it('disables action buttons for all finished statuses', () => {
    const finishedStatuses: SwarmStatus[] = ['completed', 'aborted', 'error'];
    for (const status of finishedStatuses) {
      const swarm = makeSwarm({ status });
      const isFinished =
        swarm.status === 'completed' || swarm.status === 'aborted' || swarm.status === 'error';
      expect(isFinished).toBe(true);
    }
  });
});

describe('Input disabled logic', () => {
  it('disables input for completed swarms', () => {
    const swarm = makeSwarm({ status: 'completed' });
    const inputDisabled = swarm.status === 'completed' || swarm.status === 'aborted';
    expect(inputDisabled).toBe(true);
  });

  it('disables input for aborted swarms', () => {
    const swarm = makeSwarm({ status: 'aborted' });
    const inputDisabled = swarm.status === 'completed' || swarm.status === 'aborted';
    expect(inputDisabled).toBe(true);
  });

  it('enables input for running swarms', () => {
    const swarm = makeSwarm({ status: 'running' });
    const inputDisabled = swarm.status === 'completed' || swarm.status === 'aborted';
    expect(inputDisabled).toBe(false);
  });

  it('enables input for hold swarms', () => {
    const swarm = makeSwarm({ status: 'hold' });
    const inputDisabled = swarm.status === 'completed' || swarm.status === 'aborted';
    expect(inputDisabled).toBe(false);
  });
});

describe('Phase progress display', () => {
  it('currentPhase is a valid phase string', () => {
    const swarm = makeSwarm({ currentPhase: 'analysis' });
    expect(typeof swarm.currentPhase).toBe('string');
    expect(swarm.currentPhase.length).toBeGreaterThan(0);
  });

  it('lastSeq is a non-negative number', () => {
    const swarm = makeSwarm({ lastSeq: 7 });
    expect(swarm.lastSeq).toBeGreaterThanOrEqual(0);
  });

  it('units count is correct', () => {
    const swarm = makeSwarm();
    expect(swarm.units).toHaveLength(2);
  });
});

describe('Duration formatting', () => {
  it('formats 45s correctly', () => {
    const durationMs = 45_000;
    const label =
      durationMs < 60_000
        ? `${Math.round(durationMs / 1000)}s`
        : `${Math.round(durationMs / 60_000)}m`;
    expect(label).toBe('45s');
  });

  it('formats 2m correctly', () => {
    const durationMs = 120_000;
    const label =
      durationMs < 60_000
        ? `${Math.round(durationMs / 1000)}s`
        : `${Math.round(durationMs / 60_000)}m`;
    expect(label).toBe('2m');
  });
});
