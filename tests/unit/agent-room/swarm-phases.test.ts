import { describe, expect, it } from 'vitest';
import {
  SWARM_PHASES,
  buildPhasePrompt,
  getPhaseRounds,
  getNextSwarmPhase,
  getSwarmPhaseLabel,
} from '@/shared/domain/swarmPhases';

describe('swarm phases', () => {
  it('keeps deterministic phase order without evaluation step', () => {
    expect(SWARM_PHASES).toEqual([
      'analysis',
      'research',
      'ideation',
      'critique',
      'best_case',
      'result',
    ]);
  });

  it('returns next phase and ends at result', () => {
    expect(getNextSwarmPhase('analysis')).toBe('research');
    expect(getNextSwarmPhase('research')).toBe('ideation');
    expect(getNextSwarmPhase('best_case')).toBe('result');
    expect(getNextSwarmPhase('result')).toBeNull();
  });

  it('exposes deterministic phase round configuration', () => {
    expect(getPhaseRounds('analysis')).toBe(1);
    expect(getPhaseRounds('research')).toBe(1);
    expect(getPhaseRounds('ideation')).toBe(2);
    expect(getPhaseRounds('critique')).toBe(3);
    expect(getPhaseRounds('best_case')).toBe(1);
    expect(getPhaseRounds('result')).toBe(1);
  });

  it('builds phase prompt with label and task', () => {
    const prompt = buildPhasePrompt({ task: 'Build reliable architecture', phase: 'critique' });
    expect(prompt).toContain(getSwarmPhaseLabel('critique'));
    expect(prompt).toContain('Build reliable architecture');
  });
});
