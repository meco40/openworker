import { describe, expect, it } from 'vitest';
import { planKnowledgeQuery } from '../../../src/server/knowledge/queryPlanner';

describe('count_recall intent', () => {
  it('detects "wie viele tage" as count_recall', () => {
    const plan = planKnowledgeQuery(
      'Wie viele Tage hat Nata insgesamt mit Max geschlafen?',
      new Date('2026-02-16T14:00:00Z'),
    );

    expect(plan.intent).toBe('count_recall');
    expect(plan.counterpart).toBe('max');
  });

  it('detects "wie oft" as count_recall', () => {
    const plan = planKnowledgeQuery(
      'Wie oft hat Nata mit Max uebernachtet?',
      new Date('2026-02-16T14:00:00Z'),
    );

    expect(plan.intent).toBe('count_recall');
    expect(plan.counterpart).toBe('max');
  });

  it('detects "insgesamt" as count_recall', () => {
    const plan = planKnowledgeQuery('Wie viele Tage insgesamt?', new Date('2026-02-16T14:00:00Z'));

    expect(plan.intent).toBe('count_recall');
  });

  it('populates eventFilter.eventType from "geschlafen"', () => {
    const plan = planKnowledgeQuery(
      'Wie viele Tage hat Nata mit Max geschlafen?',
      new Date('2026-02-16T14:00:00Z'),
    );

    expect(plan.eventFilter).toBeDefined();
    expect(plan.eventFilter?.eventType).toBe('shared_sleep');
    expect(plan.eventFilter?.counterpartEntity).toBe('max');
  });

  it('populates eventFilter.eventType from "besucht"', () => {
    const plan = planKnowledgeQuery(
      'Wie oft hat Nata mit Max uebernachtet?',
      new Date('2026-02-16T14:00:00Z'),
    );

    expect(plan.eventFilter).toBeDefined();
    expect(plan.eventFilter?.eventType).toBe('shared_sleep');
  });

  it('leaves eventFilter undefined for non-count queries', () => {
    const plan = planKnowledgeQuery(
      'Was haben wir gestern besprochen?',
      new Date('2026-02-16T14:00:00Z'),
    );

    expect(plan.intent).not.toBe('count_recall');
    expect(plan.eventFilter).toBeUndefined();
  });
});
