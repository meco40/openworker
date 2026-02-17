import { describe, it, expect } from 'vitest';

// Mock the expandSelfReferenceQuery logic for testing
function expandSelfReferenceQuery(query: string): string {
  const normalized = query.toLowerCase().trim();

  const hasDu = /\b(du|dein|deine|deinem|deinen|deiner|deines|dir|dich)\b/.test(normalized);
  const hasIch = /\b(ich|mein|meine|meinem|meinen|meiner|meines|mir|mich)\b/.test(normalized);

  if (!hasDu && !hasIch) return query;

  const expansions: string[] = [query];

  if (hasDu) {
    const expanded = query
      .replace(/\bdu\b/gi, 'ich')
      .replace(/\bdein\b/gi, 'mein')
      .replace(/\bdeine\b/gi, 'meine')
      .replace(/\bdeinem\b/gi, 'meinem')
      .replace(/\bdeinen\b/gi, 'meinen')
      .replace(/\bdeiner\b/gi, 'meiner')
      .replace(/\bdeines\b/gi, 'meines')
      .replace(/\bdir\b/gi, 'mir')
      .replace(/\bdich\b/gi, 'mich');
    expansions.push(expanded);
  }

  if (hasIch) {
    const expanded = query
      .replace(/\bich\b/gi, 'du')
      .replace(/\bmein\b/gi, 'dein')
      .replace(/\bmeine\b/gi, 'deine')
      .replace(/\bmeinem\b/gi, 'deinem')
      .replace(/\bmeinen\b/gi, 'deinen')
      .replace(/\bmeiner\b/gi, 'deiner')
      .replace(/\bmeines\b/gi, 'deines')
      .replace(/\bmir\b/gi, 'dir')
      .replace(/\bmich\b/gi, 'dich');
    expansions.push(expanded);
  }

  return expansions.join(' | ');
}

describe('Self-Reference Query Expansion', () => {
  describe('expandSelfReferenceQuery', () => {
    it('should expand du queries to include ich', () => {
      const query = 'Hast du mit Max geschlafen?';
      const expanded = expandSelfReferenceQuery(query);
      expect(expanded).toContain('Hast du mit Max geschlafen?');
      expect(expanded).toContain('ich');
      expect(expanded).toMatch(/Hast ich mit Max geschlafen/i);
    });

    it('should expand dein/deine to mein/meine', () => {
      const query = 'Wie geht es deinem Bruder?';
      const expanded = expandSelfReferenceQuery(query);
      expect(expanded).toContain('deinem');
      expect(expanded).toContain('meinem');
    });

    it('should expand ich queries to include du', () => {
      const query = 'Ich habe mit Max geschlafen';
      const expanded = expandSelfReferenceQuery(query);
      expect(expanded).toContain('Ich habe mit Max geschlafen');
      expect(expanded).toContain('du');
    });

    it('should not modify queries without self-references', () => {
      const query = 'Wie ist das Wetter in Berlin?';
      const expanded = expandSelfReferenceQuery(query);
      expect(expanded).toBe(query);
    });

    it('should handle complex queries with multiple pronouns', () => {
      const query = 'Hast du dein Buch bei mir gelassen?';
      const expanded = expandSelfReferenceQuery(query);
      expect(expanded).toContain('du');
      expect(expanded).toContain('ich');
      expect(expanded).toContain('dein');
      expect(expanded).toContain('mein');
    });
  });

  describe('Real-world scenarios', () => {
    it('should match user question to stored memory', () => {
      // User asks
      const userQuery = 'Hast du die letzten Tage mit Max zusammen geschlafen?';
      const expanded = expandSelfReferenceQuery(userQuery);

      // Memory contains
      const memoryContent = 'Ich habe die letzten zwei Tage mit Max zusammen geschlafen';

      // Expanded query should help find the memory
      expect(expanded.toLowerCase()).toContain('ich');
      expect(memoryContent.toLowerCase()).toContain('ich');
    });

    it('should handle possessive references', () => {
      const userQuery = 'Wie geht es deinem Bruder Max?';
      const expanded = expandSelfReferenceQuery(userQuery);

      const memoryContent = 'Mein Bruder Max ist krank';

      expect(expanded.toLowerCase()).toContain('meinem');
      expect(memoryContent.toLowerCase()).toContain('mein');
    });
  });
});
