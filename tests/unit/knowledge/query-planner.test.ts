import { describe, expect, it } from 'vitest';
import { planKnowledgeQuery } from '@/server/knowledge/queryPlanner';

describe('knowledge query planner', () => {
  it('parses meeting with counterpart and relative time range', () => {
    const now = new Date('2026-02-15T12:00:00.000Z');
    const plan = planKnowledgeQuery('meeting mit andreas vor 6 monaten', now);

    expect(plan.intent).toBe('meeting_recall');
    expect(plan.counterpart).toBe('andreas');
    expect(plan.timeRange).not.toBeNull();
    expect(plan.timeRange?.from).toBe('2025-08-15T12:00:00.000Z');
    expect(plan.timeRange?.to).toBe('2026-02-15T12:00:00.000Z');
    expect(plan.detailDepth).toBe('medium');
  });

  it('detects negotiation detail intent depth', () => {
    const plan = planKnowledgeQuery(
      'was haben wir ausgehandelt',
      new Date('2026-02-15T12:00:00.000Z'),
    );

    expect(plan.intent).toBe('negotiation_recall');
    expect(plan.topic).toBe('ausgehandelt');
    expect(plan.detailDepth).toBe('high');
  });

  it('parses same-day daytime phrases', () => {
    const now = new Date('2026-02-15T18:30:00.000Z');
    const plan = planKnowledgeQuery('heute mittag sauna', now);

    expect(plan.intent).toBe('general_recall');
    expect(plan.topic).toBe('sauna');
    expect(plan.timeRange?.from).toBe('2026-02-15T11:00:00.000Z');
    expect(plan.timeRange?.to).toBe('2026-02-15T14:00:00.000Z');
    expect(plan.detailDepth).toBe('medium');
  });

  it('parses yesterday as explicit day range', () => {
    const now = new Date('2026-02-15T18:30:00.000Z');
    const plan = planKnowledgeQuery('wie war gestern sauna', now);

    expect(plan.intent).toBe('general_recall');
    expect(plan.topic).toBe('sauna');
    expect(plan.timeRange?.from).toBe('2026-02-14T00:00:00.000Z');
    expect(plan.timeRange?.to).toBe('2026-02-14T23:59:59.999Z');
    expect(plan.detailDepth).toBe('medium');
  });

  it('does not force topic from long location-style mention without topic cue', () => {
    const plan = planKnowledgeQuery(
      'Waren wir schon mal in der Sauna?',
      new Date('2026-02-15T18:30:00.000Z'),
    );

    expect(plan.intent).toBe('general_recall');
    expect(plan.topic).toBeNull();
  });
});
