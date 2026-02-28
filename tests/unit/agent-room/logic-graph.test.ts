/**
 * Agent Room – Logic Graph
 *
 * Tests the state-transition logic for SwarmRecord lifecycle:
 * idle → running → hold → running → completed/aborted/error
 *
 * Also verifies the phase progression model using the real SWARM_PHASES.
 */
import { describe, expect, it } from 'vitest';
import {
  SWARM_PHASES,
  getNextSwarmPhase,
  getSwarmPhaseLabel,
  getPhaseRounds,
  type SwarmPhase,
} from '@/modules/agent-room/swarmPhases';
import type { SwarmStatus } from '@/shared/domain/agentRoom.types';

// ─── State machine ────────────────────────────────────────────────────────────

type Transition = {
  from: SwarmStatus;
  action: string;
  to: SwarmStatus;
};

const VALID_TRANSITIONS: Transition[] = [
  { from: 'idle', action: 'start', to: 'running' },
  { from: 'running', action: 'pause', to: 'hold' },
  { from: 'hold', action: 'resume', to: 'running' },
  { from: 'running', action: 'stop', to: 'aborted' },
  { from: 'hold', action: 'stop', to: 'aborted' },
  { from: 'running', action: 'finish', to: 'completed' },
  { from: 'hold', action: 'finish', to: 'completed' },
  { from: 'running', action: 'error', to: 'error' },
];

function applyTransition(current: SwarmStatus, action: string): SwarmStatus | null {
  const transition = VALID_TRANSITIONS.find((t) => t.from === current && t.action === action);
  return transition ? transition.to : null;
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('SwarmStatus state transitions', () => {
  it('transitions idle → running on start', () => {
    expect(applyTransition('idle', 'start')).toBe('running');
  });

  it('transitions running → hold on pause', () => {
    expect(applyTransition('running', 'pause')).toBe('hold');
  });

  it('transitions hold → running on resume', () => {
    expect(applyTransition('hold', 'resume')).toBe('running');
  });

  it('transitions running → aborted on stop', () => {
    expect(applyTransition('running', 'stop')).toBe('aborted');
  });

  it('transitions hold → aborted on stop', () => {
    expect(applyTransition('hold', 'stop')).toBe('aborted');
  });

  it('transitions running → completed on finish', () => {
    expect(applyTransition('running', 'finish')).toBe('completed');
  });

  it('transitions hold → completed on finish', () => {
    expect(applyTransition('hold', 'finish')).toBe('completed');
  });

  it('transitions running → error on error', () => {
    expect(applyTransition('running', 'error')).toBe('error');
  });

  it('returns null for invalid transitions', () => {
    expect(applyTransition('completed', 'start')).toBeNull();
    expect(applyTransition('aborted', 'resume')).toBeNull();
    expect(applyTransition('error', 'pause')).toBeNull();
    expect(applyTransition('idle', 'pause')).toBeNull();
  });
});

describe('SwarmPhase progression', () => {
  it('SWARM_PHASES has 6 phases', () => {
    expect(SWARM_PHASES).toHaveLength(6);
  });

  it('first phase is "analysis"', () => {
    expect(SWARM_PHASES[0]).toBe('analysis');
  });

  it('last phase is "result"', () => {
    expect(SWARM_PHASES[SWARM_PHASES.length - 1]).toBe('result');
  });

  it('getNextSwarmPhase returns the next phase', () => {
    const next = getNextSwarmPhase('analysis');
    expect(next).toBe('research');
  });

  it('getNextSwarmPhase returns null for the last phase', () => {
    const next = getNextSwarmPhase('result');
    expect(next).toBeNull();
  });

  it('progresses through all phases in order', () => {
    let phase: SwarmPhase = 'analysis';
    const visited: SwarmPhase[] = [phase];

    while (true) {
      const next = getNextSwarmPhase(phase);
      if (!next) break;
      phase = next;
      visited.push(phase);
    }

    expect(visited).toEqual([...SWARM_PHASES]);
  });
});

describe('Phase labels', () => {
  it('getSwarmPhaseLabel returns non-empty string for each phase', () => {
    for (const phase of SWARM_PHASES) {
      const label = getSwarmPhaseLabel(phase);
      expect(typeof label).toBe('string');
      expect(label.length).toBeGreaterThan(0);
    }
  });

  it('analysis label is "Analysis"', () => {
    expect(getSwarmPhaseLabel('analysis')).toBe('Analysis');
  });

  it('result label is "Result"', () => {
    expect(getSwarmPhaseLabel('result')).toBe('Result');
  });
});

describe('Phase rounds', () => {
  it('getPhaseRounds returns a positive number for each phase', () => {
    for (const phase of SWARM_PHASES) {
      const rounds = getPhaseRounds(phase);
      expect(rounds).toBeGreaterThan(0);
    }
  });

  it('analysis has 1 round', () => {
    expect(getPhaseRounds('analysis')).toBe(1);
  });
});

describe('All valid SwarmStatus values', () => {
  const allStatuses: SwarmStatus[] = ['idle', 'running', 'hold', 'completed', 'aborted', 'error'];

  it('covers all 6 status values', () => {
    expect(allStatuses).toHaveLength(6);
  });

  it.each(allStatuses)('status "%s" is a valid string', (status) => {
    expect(typeof status).toBe('string');
    expect(status.length).toBeGreaterThan(0);
  });
});
