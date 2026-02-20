import { describe, expect, it } from 'vitest';
import { expandMultilingualAliases } from '@/server/knowledge/multilingualAliases';

describe('multilingualAliases', () => {
  describe('expandMultilingualAliases', () => {
    it('expands "brother" to include "Bruder" and "bro"', () => {
      const result = expandMultilingualAliases('brother');
      expect(result).toContain('brother');
      expect(result).toContain('bruder');
      expect(result).toContain('bro');
    });

    it('expands "Bruder" to include English equivalents', () => {
      const result = expandMultilingualAliases('Bruder');
      expect(result).toContain('bruder');
      expect(result).toContain('brother');
      expect(result).toContain('bro');
    });

    it('expands "mama" to include "Mutter" and "mother"', () => {
      const result = expandMultilingualAliases('mama');
      expect(result).toContain('mama');
      expect(result).toContain('mutter');
      expect(result).toContain('mother');
      expect(result).toContain('mom');
    });

    it('returns only self for unknown words', () => {
      const result = expandMultilingualAliases('Zylinder');
      expect(result).toEqual(['Zylinder']);
    });

    it('is case-insensitive for lookup', () => {
      const result = expandMultilingualAliases('BROTHER');
      expect(result).toContain('bruder');
    });

    it('deduplicates results', () => {
      const result = expandMultilingualAliases('bruder');
      const unique = new Set(result);
      expect(result.length).toBe(unique.size);
    });

    it('expands "projekt" to include "project"', () => {
      const result = expandMultilingualAliases('project');
      expect(result).toContain('projekt');
    });

    it('expands "schwester" to include "sister"', () => {
      const result = expandMultilingualAliases('schwester');
      expect(result).toContain('sister');
      expect(result).toContain('sis');
    });
  });
});
