import { describe, expect, it } from 'vitest';
import { detectCorrection } from '../../../src/server/knowledge/correctionDetector';

describe('correctionDetector', () => {
  describe('detectCorrection', () => {
    it('detects "Nein, das war nicht X sondern Y"', () => {
      const result = detectCorrection('Nein, das war nicht Lisa, sondern Maria');
      expect(result.isCorrection).toBe(true);
      expect(result.oldValue).toBe('Lisa');
      expect(result.newValue).toBe('Maria');
      expect(result.correctionType).toBe('value_change');
    });

    it('detects "nicht X sondern Y"', () => {
      const result = detectCorrection('Es war nicht der Montag sondern der Dienstag');
      expect(result.isCorrection).toBe(true);
      expect(result.oldValue).toBe('Montag');
      expect(result.newValue).toBe('Dienstag');
    });

    it('detects "Falsch, es ist/war..."', () => {
      const result = detectCorrection('Falsch, es war der 15. nicht der 12.');
      expect(result.isCorrection).toBe(true);
    });

    it('detects "stimmt nicht"', () => {
      const result = detectCorrection('Das stimmt nicht, es war Tom');
      expect(result.isCorrection).toBe(true);
    });

    it('detects "Korrektur:" prefix', () => {
      const result = detectCorrection('Korrektur: Max ist 29 nicht 28');
      expect(result.isCorrection).toBe(true);
    });

    it('returns isCorrection=false for normal text', () => {
      const result = detectCorrection('Lisa war gestern hier');
      expect(result.isCorrection).toBe(false);
      expect(result.correctionType).toBe('none');
    });

    it('returns isCorrection=false for greeting', () => {
      const result = detectCorrection('Hallo, wie geht es dir');
      expect(result.isCorrection).toBe(false);
    });
  });
});
