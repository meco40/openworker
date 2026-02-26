import { describe, expect, it } from 'vitest';
import {
  SWARM_PHASES,
  buildPhasePrompt,
  getNextSwarmPhase,
  getSwarmPhaseLabel,
} from '@/modules/agent-room/swarmPhases';

describe('swarm phases', () => {
  it('keeps deterministic phase order without evaluation step', () => {
    expect(SWARM_PHASES).toEqual(['analysis', 'ideation', 'critique', 'best_case', 'result']);
  });

  it('returns next phase and ends at result', () => {
    expect(getNextSwarmPhase('analysis')).toBe('ideation');
    expect(getNextSwarmPhase('best_case')).toBe('result');
    expect(getNextSwarmPhase('result')).toBeNull();
  });

  it('builds phase prompt with label and task', () => {
    const prompt = buildPhasePrompt({ task: 'Build reliable architecture', phase: 'critique' });
    expect(prompt).toContain(getSwarmPhaseLabel('critique'));
    expect(prompt).toContain('Build reliable architecture');
  });
});
