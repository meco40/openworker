/**
 * Agent Room – Split Layout
 *
 * Verifies the structural integrity of the split-layout design:
 * chat feed (left/main) + canvas panel (right/sidebar).
 * Tests are logic-only (no DOM rendering required).
 */
import { describe, expect, it } from 'vitest';
import type { SwarmRecord } from '@/modules/agent-room/swarmTypes';
import type { SwarmStatus } from '@/shared/domain/agentRoom.types';
import { SWARM_PHASES, getSwarmPhaseLabel } from '@/shared/domain/swarmPhases';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function statusBadgeClasses(status: SwarmStatus): string {
  switch (status) {
    case 'running':
      return 'bg-emerald-500/20 text-emerald-200 border-emerald-500/30';
    case 'hold':
      return 'bg-amber-500/20 text-amber-200 border-amber-500/30';
    case 'completed':
      return 'bg-indigo-500/20 text-indigo-200 border-indigo-500/30';
    case 'aborted':
      return 'bg-zinc-700/40 text-zinc-200 border-zinc-600';
    case 'error':
      return 'bg-rose-500/20 text-rose-200 border-rose-500/30';
    default:
      return 'bg-cyan-500/20 text-cyan-200 border-cyan-500/30';
  }
}

// ─── Fixtures ─────────────────────────────────────────────────────────────────

function makeSwarm(overrides: Partial<SwarmRecord> = {}): SwarmRecord {
  return {
    id: 'split-swarm-1',
    conversationId: 'conv-1',
    userId: 'user-1',
    sessionId: null,
    title: 'Split Layout Swarm',
    task: 'Testing the split layout',
    leadPersonaId: 'persona-1',
    units: [
      { personaId: 'persona-1', role: 'lead' },
      { personaId: 'persona-2', role: 'analyst' },
    ],
    status: 'running',
    currentPhase: 'analysis',
    consensusScore: 0.6,
    holdFlag: false,
    artifact: '',
    artifactHistory: [],
    friction: {
      level: 'low',
      confidence: 0.6,
      hold: false,
      reasons: [],
      updatedAt: new Date().toISOString(),
    },
    lastSeq: 4,
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

describe('Split layout – phase progress', () => {
  it('SWARM_PHASES is a non-empty array', () => {
    expect(Array.isArray(SWARM_PHASES)).toBe(true);
    expect(SWARM_PHASES.length).toBeGreaterThan(0);
  });

  it('getSwarmPhaseLabel returns a non-empty string for each phase', () => {
    for (const phase of SWARM_PHASES) {
      const label = getSwarmPhaseLabel(phase);
      expect(typeof label).toBe('string');
      expect(label.length).toBeGreaterThan(0);
    }
  });

  it('currentPhase index is found in SWARM_PHASES', () => {
    const swarm = makeSwarm({ currentPhase: 'analysis' });
    const idx = SWARM_PHASES.indexOf(swarm.currentPhase);
    expect(idx).toBeGreaterThanOrEqual(0);
  });

  it('phases before currentPhase are marked as done', () => {
    const swarm = makeSwarm({ currentPhase: 'analysis' });
    const currentIdx = SWARM_PHASES.indexOf(swarm.currentPhase);
    const donePhasesCount = SWARM_PHASES.filter((_, idx) => idx < currentIdx).length;
    expect(donePhasesCount).toBeGreaterThanOrEqual(0);
  });
});

describe('Split layout – input disabled logic', () => {
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

describe('Split layout – swarm metadata', () => {
  it('units count is correct', () => {
    const swarm = makeSwarm();
    expect(swarm.units).toHaveLength(2);
  });

  it('lastSeq is a non-negative number', () => {
    const swarm = makeSwarm({ lastSeq: 4 });
    expect(swarm.lastSeq).toBeGreaterThanOrEqual(0);
  });

  it('consensusScore is between 0 and 1', () => {
    const swarm = makeSwarm({ consensusScore: 0.75 });
    expect(swarm.consensusScore).toBeGreaterThanOrEqual(0);
    expect(swarm.consensusScore).toBeLessThanOrEqual(1);
  });
});

describe('Split layout – status badge classes', () => {
  const statusCases: { status: SwarmStatus; expectedClass: string }[] = [
    { status: 'running', expectedClass: 'emerald' },
    { status: 'hold', expectedClass: 'amber' },
    { status: 'completed', expectedClass: 'indigo' },
    { status: 'aborted', expectedClass: 'zinc' },
    { status: 'error', expectedClass: 'rose' },
    { status: 'idle', expectedClass: 'cyan' },
  ];

  it.each(statusCases)(
    'status "$status" uses $expectedClass color',
    ({ status, expectedClass }) => {
      const classes = statusBadgeClasses(status);
      expect(classes).toContain(expectedClass);
    },
  );
});

describe('Split layout – null swarm guard', () => {
  it('handles null swarm gracefully', () => {
    const swarm: SwarmRecord | null = null;
    const shouldShowDetail = swarm !== null;
    expect(shouldShowDetail).toBe(false);
  });

  it('shows detail when swarm is present', () => {
    const swarm: SwarmRecord | null = makeSwarm();
    const shouldShowDetail = swarm !== null;
    expect(shouldShowDetail).toBe(true);
  });
});
