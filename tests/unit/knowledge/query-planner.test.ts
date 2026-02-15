import { describe, expect, it } from 'vitest';
import { planKnowledgeQuery } from '../../../src/server/knowledge/queryPlanner';

describe('planKnowledgeQuery', () => {
  it('parses counterpart, topic and long-range time intent', () => {
    const now = new Date('2026-02-15T20:00:00.000Z');
    const plan = planKnowledgeQuery('Wie war das meeting mit Andreas vor 6 Monaten?', now);

    expect(plan.counterpart).toBe('andreas');
    expect(plan.topic).toBe('meeting');
    expect(plan.detailDepth).toBe('high');
    expect(plan.timeRange).not.toBeNull();
    expect(plan.timeRange?.from).toBe('2025-08-15');
    expect(plan.timeRange?.to).toBe('2026-02-15');
  });

  it('parses retrospective topic phrasing like "letztes über sauna gesprochen"', () => {
    const now = new Date('2026-02-15T20:00:00.000Z');
    const plan = planKnowledgeQuery('Was haben wir letztes über sauna gesprochen?', now);

    expect(plan.topic).toBe('sauna');
    expect(plan.detailDepth).toBe('high');
  });
});
