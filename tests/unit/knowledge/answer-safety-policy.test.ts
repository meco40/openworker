import { describe, expect, it } from 'vitest';
import {
  assessAnswerSafety,
  buildSafetyInstruction,
  type EvidenceAssessment,
} from '../../../src/server/knowledge/answerSafetyPolicy';

describe('answerSafetyPolicy', () => {
  describe('assessAnswerSafety', () => {
    it('returns confident for strong evidence', () => {
      const evidence: EvidenceAssessment = {
        totalSources: 5,
        avgConfidence: 0.85,
        hasComputedAnswer: false,
        hasContradiction: false,
      };
      expect(assessAnswerSafety(evidence)).toBe('confident');
    });

    it('returns confident for computed answer without contradiction', () => {
      const evidence: EvidenceAssessment = {
        totalSources: 1,
        avgConfidence: 0.5,
        hasComputedAnswer: true,
        hasContradiction: false,
      };
      expect(assessAnswerSafety(evidence)).toBe('confident');
    });

    it('returns hedged for moderate evidence', () => {
      const evidence: EvidenceAssessment = {
        totalSources: 2,
        avgConfidence: 0.6,
        hasComputedAnswer: false,
        hasContradiction: false,
      };
      expect(assessAnswerSafety(evidence)).toBe('hedged');
    });

    it('returns caveat for weak evidence', () => {
      const evidence: EvidenceAssessment = {
        totalSources: 1,
        avgConfidence: 0.3,
        hasComputedAnswer: false,
        hasContradiction: false,
      };
      expect(assessAnswerSafety(evidence)).toBe('caveat');
    });

    it('returns decline for no evidence', () => {
      const evidence: EvidenceAssessment = {
        totalSources: 0,
        avgConfidence: 0,
        hasComputedAnswer: false,
        hasContradiction: false,
      };
      expect(assessAnswerSafety(evidence)).toBe('decline');
    });
  });

  describe('buildSafetyInstruction', () => {
    it('returns null for confident', () => {
      expect(buildSafetyInstruction('confident')).toBeNull();
    });

    it('returns hedging text for hedged', () => {
      const result = buildSafetyInstruction('hedged');
      expect(result).toBeTruthy();
      expect(result).toContain('erinnere');
    });

    it('returns caveat text for caveat', () => {
      const result = buildSafetyInstruction('caveat');
      expect(result).toBeTruthy();
      expect(result).toContain('nicht');
    });

    it('returns decline text for decline', () => {
      const result = buildSafetyInstruction('decline');
      expect(result).toBeTruthy();
      expect(result).toContain('keine');
    });
  });
});
