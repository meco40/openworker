import { describe, it, expect } from 'vitest';
import { detectContradictionSignal } from '@/server/knowledge/contradictionDetector';

describe('detectContradictionSignal', () => {
  it('detects value_change when same entity has different property values', () => {
    const result = detectContradictionSignal('Max ist mein Cousin', 'Max ist mein Bruder');
    expect(result.hasContradiction).toBe(true);
    expect(result.contradictionType).toBe('value_change');
  });

  it('detects negation contradiction', () => {
    const result = detectContradictionSignal('Max hat keine Freundin', 'Max hat eine Freundin');
    expect(result.hasContradiction).toBe(true);
    expect(result.contradictionType).toBe('negation');
  });

  it('detects direct_override for same-structure different-value facts', () => {
    const result = detectContradictionSignal('Ich arbeite bei BMW', 'Ich arbeite bei Siemens');
    expect(result.hasContradiction).toBe(true);
    expect(result.contradictionType).toBe('direct_override');
  });

  it('returns none for unrelated facts about same entity', () => {
    const result = detectContradictionSignal('Max ist nett', 'Max ist gross');
    expect(result.hasContradiction).toBe(false);
    expect(result.contradictionType).toBe('none');
  });

  it('returns none for completely different facts', () => {
    const result = detectContradictionSignal('Ich mag Pizza', 'Lisa wohnt in Berlin');
    expect(result.hasContradiction).toBe(false);
    expect(result.contradictionType).toBe('none');
  });

  it('detects status change at same location pattern', () => {
    const result = detectContradictionSignal('Ich wohne in Berlin', 'Ich wohne in Hamburg');
    expect(result.hasContradiction).toBe(true);
    expect(result.contradictionType).toBe('direct_override');
  });

  it('returns confidence score for contradictions', () => {
    const result = detectContradictionSignal('Max ist mein Cousin', 'Max ist mein Bruder');
    expect(result.confidence).toBeGreaterThan(0.5);
  });

  it('returns low confidence for non-contradictions', () => {
    const result = detectContradictionSignal('Ich mag Pizza', 'Ich mag Pasta');
    expect(result.confidence).toBeLessThan(0.5);
  });

  it('handles negation with kein/keine/keinen', () => {
    const result = detectContradictionSignal('Max hat keinen Hund', 'Max hat einen Hund');
    expect(result.hasContradiction).toBe(true);
    expect(result.contradictionType).toBe('negation');
  });

  it('detects nicht vs positive contradiction', () => {
    const result = detectContradictionSignal('Max ist nicht verheiratet', 'Max ist verheiratet');
    expect(result.hasContradiction).toBe(true);
    expect(result.contradictionType).toBe('negation');
  });

  it('detects nie vs positive contradiction', () => {
    const result = detectContradictionSignal(
      'Wir waren nie zusammen in der Sauna',
      'Wir waren schon mal zusammen in der Sauna',
    );
    expect(result.hasContradiction).toBe(true);
    expect(result.contradictionType).toBe('negation');
  });
});
