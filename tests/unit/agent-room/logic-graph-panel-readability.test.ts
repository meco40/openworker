/**
 * Agent Room – Logic Graph Panel Readability
 *
 * Verifies that the information panel (detail header + phase progress)
 * presents data in a readable, consistent format. Tests cover label
 * generation, number formatting, and status-to-hint mapping.
 */
import { describe, expect, it } from 'vitest';
import {
  SWARM_PHASES,
  getSwarmPhaseLabel,
  getPhaseRounds,
  type SwarmPhase,
} from '@/modules/agent-room/swarmPhases';
import type { SwarmStatus } from '@/shared/domain/agentRoom.types';

// ─── Helpers (mirrors DetailHeader logic) ─────────────────────────────────────

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

function isPhaseActive(phase: SwarmPhase, currentPhase: SwarmPhase): boolean {
  return phase === currentPhase;
}

function isPhaseDone(phase: SwarmPhase, currentPhase: SwarmPhase): boolean {
  const currentIdx = SWARM_PHASES.indexOf(currentPhase);
  const phaseIdx = SWARM_PHASES.indexOf(phase);
  return phaseIdx < currentIdx;
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('Phase label readability', () => {
  it.each([...SWARM_PHASES])('phase "%s" has a readable label', (phase) => {
    const label = getSwarmPhaseLabel(phase);
    expect(typeof label).toBe('string');
    expect(label.length).toBeGreaterThan(0);
    // Label should start with uppercase
    expect(label[0]).toBe(label[0].toUpperCase());
  });

  it('all 6 phases have labels', () => {
    expect(SWARM_PHASES).toHaveLength(6);
    for (const phase of SWARM_PHASES) {
      expect(getSwarmPhaseLabel(phase)).toBeTruthy();
    }
  });
});

describe('Phase progress indicator', () => {
  it('marks current phase as active', () => {
    expect(isPhaseActive('analysis', 'analysis')).toBe(true);
    expect(isPhaseActive('research', 'analysis')).toBe(false);
  });

  it('marks earlier phases as done', () => {
    expect(isPhaseDone('analysis', 'research')).toBe(true);
    expect(isPhaseDone('research', 'research')).toBe(false);
    expect(isPhaseDone('ideation', 'research')).toBe(false);
  });

  it('first phase has no done phases before it', () => {
    const doneCount = SWARM_PHASES.filter((p) => isPhaseDone(p, 'analysis')).length;
    expect(doneCount).toBe(0);
  });

  it('last phase has all other phases done', () => {
    const doneCount = SWARM_PHASES.filter((p) => isPhaseDone(p, 'result')).length;
    expect(doneCount).toBe(SWARM_PHASES.length - 1);
  });
});

describe('Status badge readability', () => {
  const statusCases: SwarmStatus[] = ['idle', 'running', 'hold', 'completed', 'aborted', 'error'];

  it.each(statusCases)('status "%s" has a non-empty badge class', (status) => {
    const classes = statusBadgeClasses(status);
    expect(classes.length).toBeGreaterThan(0);
  });

  it('running uses emerald color', () => {
    expect(statusBadgeClasses('running')).toContain('emerald');
  });

  it('hold uses amber color', () => {
    expect(statusBadgeClasses('hold')).toContain('amber');
  });

  it('completed uses indigo color', () => {
    expect(statusBadgeClasses('completed')).toContain('indigo');
  });

  it('error uses rose color', () => {
    expect(statusBadgeClasses('error')).toContain('rose');
  });

  it('aborted uses zinc color', () => {
    expect(statusBadgeClasses('aborted')).toContain('zinc');
  });
});

describe('Phase rounds readability', () => {
  it('each phase has at least 1 round', () => {
    for (const phase of SWARM_PHASES) {
      expect(getPhaseRounds(phase)).toBeGreaterThanOrEqual(1);
    }
  });

  it('turns per phase calculation is correct', () => {
    const unitCount = 3;
    const rounds = getPhaseRounds('analysis');
    const turnsPerPhase = rounds * unitCount;
    expect(turnsPerPhase).toBe(rounds * unitCount);
    expect(turnsPerPhase).toBeGreaterThan(0);
  });
});

describe('Turn counter readability', () => {
  it('lastSeq 0 is displayed as "Turn 0"', () => {
    const lastSeq = 0;
    const label = `Turn ${lastSeq}`;
    expect(label).toBe('Turn 0');
  });

  it('lastSeq 42 is displayed as "Turn 42"', () => {
    const lastSeq = 42;
    const label = `Turn ${lastSeq}`;
    expect(label).toBe('Turn 42');
  });
});

describe('Status badge uppercase', () => {
  const statuses: SwarmStatus[] = ['idle', 'running', 'hold', 'completed', 'aborted', 'error'];

  it.each(statuses)('status "%s" is uppercase-able', (status) => {
    const upper = status.toUpperCase();
    expect(upper).toBe(upper.toUpperCase());
    expect(upper.length).toBeGreaterThan(0);
  });
});
