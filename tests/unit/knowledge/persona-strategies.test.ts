import { describe, it, expect } from 'vitest';
import {
  PERSONA_STRATEGIES,
  adjustScoreByStrategy,
  type PersonaType,
} from '@/server/knowledge/personaStrategies';

describe('PERSONA_STRATEGIES', () => {
  it('has strategies for all persona types', () => {
    const types: PersonaType[] = ['roleplay', 'builder', 'assistant', 'general'];
    for (const t of types) {
      expect(PERSONA_STRATEGIES[t]).toBeDefined();
      expect(PERSONA_STRATEGIES[t].personaType).toBe(t);
    }
  });

  it('roleplay emphasizes emotional relevance', () => {
    const s = PERSONA_STRATEGIES.roleplay;
    expect(s.recallWeights.emotionalRelevance).toBeGreaterThan(0.7);
    expect(s.recallWeights.taskRelevance).toBeLessThan(0.3);
    expect(s.summaryStyle).toBe('narrative');
    expect(s.consolidationAggressiveness).toBe('conservative');
  });

  it('builder emphasizes project relevance', () => {
    const s = PERSONA_STRATEGIES.builder;
    expect(s.recallWeights.projectRelevance).toBeGreaterThan(0.7);
    expect(s.recallWeights.emotionalRelevance).toBeLessThan(0.3);
    expect(s.summaryStyle).toBe('status_report');
    expect(s.consolidationAggressiveness).toBe('aggressive');
  });

  it('assistant emphasizes task relevance', () => {
    const s = PERSONA_STRATEGIES.assistant;
    expect(s.recallWeights.taskRelevance).toBeGreaterThan(0.7);
    expect(s.summaryStyle).toBe('task_list');
  });

  it('general has balanced weights', () => {
    const s = PERSONA_STRATEGIES.general;
    const weights = Object.values(s.recallWeights);
    const spread = Math.max(...weights) - Math.min(...weights);
    expect(spread).toBeLessThanOrEqual(0.3);
  });
});

describe('adjustScoreByStrategy', () => {
  it('boosts emotional nodes for roleplay persona', () => {
    const base = 1.0;
    const emotional = adjustScoreByStrategy(base, 'roleplay', {
      emotionalTone: 'traurig',
    });
    const neutral = adjustScoreByStrategy(base, 'roleplay', {});
    expect(emotional).toBeGreaterThan(neutral);
  });

  it('boosts task nodes for assistant persona', () => {
    const base = 1.0;
    const task = adjustScoreByStrategy(base, 'assistant', { type: 'task' });
    const fact = adjustScoreByStrategy(base, 'assistant', { type: 'fact' });
    expect(task).toBeGreaterThan(fact);
  });

  it('boosts project nodes for builder persona', () => {
    const base = 1.0;
    const project = adjustScoreByStrategy(base, 'builder', {
      type: 'project_milestone',
    });
    const fact = adjustScoreByStrategy(base, 'builder', { type: 'fact' });
    expect(project).toBeGreaterThan(fact);
  });

  it('does not boost unrelated node types', () => {
    const base = 1.0;
    // Builder persona with emotional node — minimal boost
    const result = adjustScoreByStrategy(base, 'builder', {
      emotionalTone: 'traurig',
    });
    // Should barely boost — builder has emotionalRelevance = 0.1
    expect(result).toBeLessThan(1.15);
  });
});
