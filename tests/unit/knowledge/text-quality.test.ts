import { describe, expect, it } from 'vitest';
import {
  isNoiseMemoryFact,
  sanitizeKnowledgeFacts,
  classifyTextReliability,
  detectTemporalStatus,
} from '@/server/knowledge/textQuality';

describe('knowledge text quality', () => {
  it('classifies command and greeting artifacts as noise', () => {
    expect(isNoiseMemoryFact('/new')).toBe(true);
    expect(isNoiseMemoryFact('Neue Konversation erstellt.')).toBe(true);
    expect(isNoiseMemoryFact('Hallo')).toBe(true);
  });

  it('keeps concrete statements and splits numbered rule lists', () => {
    expect(isNoiseMemoryFact('1. Niemals zu spät kommen.')).toBe(false);
    expect(
      sanitizeKnowledgeFacts([
        '/new',
        'Regeln: 1. Niemals zu spät kommen. 2. Bei Meetings bleibst du in meiner Nähe.',
        'Hallo',
      ]),
    ).toEqual(['1. Niemals zu spät kommen.', '2. Bei Meetings bleibst du in meiner Nähe.']);
  });

  describe('classifyTextReliability', () => {
    it('detects negation', () => {
      const result = classifyTextReliability('Ich war nicht beim Arzt');
      expect(result.isNegated).toBe(true);
      expect(result.factualConfidence).toBeLessThan(1.0);
    });

    it('detects conditional (Konjunktiv)', () => {
      const result = classifyTextReliability('Wenn ich morgen Zeit habe gehe ich schwimmen');
      expect(result.isConditional).toBe(true);
      expect(result.factualConfidence).toBeLessThanOrEqual(0.4);
    });

    it('detects hypothetical', () => {
      const result = classifyTextReliability('Ich wuerde gerne nach Berlin fliegen');
      expect(result.isHypothetical).toBe(true);
      expect(result.factualConfidence).toBeLessThanOrEqual(0.2);
    });

    it('classifies clear fact as real with full confidence', () => {
      const result = classifyTextReliability('Ich war gestern beim Arzt');
      expect(result.isNegated).toBe(false);
      expect(result.isConditional).toBe(false);
      expect(result.factScope).toBe('real');
      expect(result.factualConfidence).toBe(1.0);
    });

    it('classifies roleplay text', () => {
      const result = classifyTextReliability('Stell dir vor ich haette einen Bruder');
      expect(result.factScope).toBe('roleplay');
      expect(result.factualConfidence).toBeLessThanOrEqual(0.1);
    });

    it('classifies quoted text', () => {
      const result = classifyTextReliability('Er hat gesagt dass er morgen kommt');
      expect(result.factScope).toBe('quoted');
      expect(result.factualConfidence).toBeLessThanOrEqual(0.5);
    });

    it('prioritizes roleplay over hypothetical', () => {
      const result = classifyTextReliability('Stell dir vor ich wuerde fliegen');
      expect(result.factScope).toBe('roleplay');
    });
  });

  describe('detectTemporalStatus', () => {
    it('detects present tense as current', () => {
      expect(detectTemporalStatus('Ich arbeite bei BMW')).toBe('current');
    });

    it('detects explicit past marker', () => {
      expect(detectTemporalStatus('Ich habe frueher bei Siemens gearbeitet')).toBe('past');
    });

    it('detects future/planned', () => {
      expect(detectTemporalStatus('Naechste Woche fliege ich nach Berlin')).toBe('planned');
    });

    it('returns unknown for ambiguous text', () => {
      expect(detectTemporalStatus('Das klingt interessant')).toBe('unknown');
    });
  });
});
