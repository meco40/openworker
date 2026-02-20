import { describe, expect, it } from 'vitest';
import {
  calculateRecallBudget,
  detectQueryComplexity,
} from '@/server/knowledge/recallBudgetCalculator';

describe('recallBudgetCalculator', () => {
  describe('detectQueryComplexity', () => {
    it('detects comprehensive query', () => {
      expect(detectQueryComplexity('Was weisst du ueber mich?')).toBe('comprehensive');
    });

    it('detects comprehensive with "erzaehl"', () => {
      expect(detectQueryComplexity('Erzaehl mir alles ueber Max')).toBe('comprehensive');
    });

    it('detects complex count query', () => {
      expect(detectQueryComplexity('Wie viele Tage waren wir zusammen?')).toBe('complex');
    });

    it('detects medium query with time reference', () => {
      expect(detectQueryComplexity('Was hast du letzte Woche gemacht?')).toBe('medium');
    });

    it('detects simple query', () => {
      expect(detectQueryComplexity('Wie heisst mein Bruder?')).toBe('simple');
    });
  });

  describe('calculateRecallBudget', () => {
    it('returns comprehensive budget for comprehensive queries', () => {
      const budget = calculateRecallBudget({
        queryComplexity: 'comprehensive',
        entityCount: 5,
        availableSourceCount: 10,
      });
      expect(budget.total).toBeGreaterThanOrEqual(15000);
      expect(budget.summary).toBeGreaterThan(0);
    });

    it('returns simple budget for simple queries', () => {
      const budget = calculateRecallBudget({
        queryComplexity: 'simple',
        entityCount: 1,
        availableSourceCount: 3,
      });
      expect(budget.total).toBeLessThanOrEqual(5000);
    });

    it('scales entityContext with entity count', () => {
      const low = calculateRecallBudget({
        queryComplexity: 'medium',
        entityCount: 1,
        availableSourceCount: 5,
      });
      const high = calculateRecallBudget({
        queryComplexity: 'medium',
        entityCount: 10,
        availableSourceCount: 5,
      });
      expect(high.entityContext).toBeGreaterThan(low.entityContext);
    });

    it('caps entity scaling at 2.0x', () => {
      const budget = calculateRecallBudget({
        queryComplexity: 'medium',
        entityCount: 100,
        availableSourceCount: 5,
      });
      const baseBudget = calculateRecallBudget({
        queryComplexity: 'medium',
        entityCount: 0,
        availableSourceCount: 5,
      });
      // entityContext should be at most 2x the base
      expect(budget.entityContext).toBeLessThanOrEqual(baseBudget.entityContext * 2.1);
    });

    it('includes all budget sections in total', () => {
      const budget = calculateRecallBudget({
        queryComplexity: 'complex',
        entityCount: 3,
        availableSourceCount: 5,
      });
      const sum =
        budget.knowledge +
        budget.memory +
        budget.chat +
        budget.entityContext +
        budget.computedAnswer +
        budget.summary;
      expect(budget.total).toBe(sum);
    });
  });
});
