import { describe, expect, it } from 'vitest';

import {
  classifyEventUtterance,
  outcomeForUtterance,
  pickEventCandidate,
  type EventCandidateHit,
} from '@/server/world-model/services/eventLinker';
import { resolveCorrection } from '@/server/world-model/services/correctionResolver';

describe('classifyEventUtterance', () => {
  it('classifies a plan', () => {
    expect(classifyEventUtterance('Ich gehe um 17 Uhr ins Kino.')).toBe('plan');
  });

  it('classifies a cancellation', () => {
    expect(classifyEventUtterance('Ich gehe doch nicht ins Kino.')).toBe('cancellation');
  });

  it('classifies cinema cancellation plus dinner as a replacement', () => {
    expect(
      classifyEventUtterance('Ich gehe doch nicht ins Kino. Ich gehe stattdessen essen.'),
    ).toBe('change');
  });

  it('classifies an outcome confirmation (past tense food)', () => {
    expect(classifyEventUtterance('Ja, ich war essen.')).toBe('outcome_confirmation');
  });

  it('classifies history / lookback', () => {
    expect(classifyEventUtterance('Was habe ich letzte Woche gemacht?')).toBe('history');
  });
});

describe('outcomeForUtterance', () => {
  it('maps outcome confirmation to completed', () => {
    expect(outcomeForUtterance('outcome_confirmation')).toBe('completed');
  });
  it('maps cancellation to cancelled', () => {
    expect(outcomeForUtterance('cancellation')).toBe('cancelled');
  });
  it('returns null for non-outcome kinds', () => {
    expect(outcomeForUtterance('plan')).toBeNull();
  });
});

describe('pickEventCandidate', () => {
  const planned: EventCandidateHit = {
    eventId: 'e1',
    title: 'Kino',
    confidence: 0.9,
    status: 'planned',
  };
  const cancelled: EventCandidateHit = {
    eventId: 'e2',
    title: 'Altes',
    confidence: 0.9,
    status: 'cancelled',
  };

  it('picks the single active planned event for confirmation', () => {
    const picked = pickEventCandidate('outcome_confirmation', [planned, cancelled]);
    expect(picked?.eventId).toBe('e1');
  });

  it('returns null when multiple active planned events (ambiguous)', () => {
    const other = { ...planned, eventId: 'e3' };
    expect(pickEventCandidate('outcome_confirmation', [planned, other])).toBeNull();
  });
});

describe('resolveCorrection', () => {
  it('replaces a planned event with a new plan (cancel old, keep new planned)', () => {
    const res = resolveCorrection({
      oldEventStatus: 'planned',
      oldEventId: 'kino',
      newEventProposed: true,
      kind: 'change',
    });
    expect(res.action).toBe('replace');
    expect(res.replacedEventId).toBe('kino');
  });

  it('cancellation closes the old event without a replacement flag', () => {
    const res = resolveCorrection({
      oldEventStatus: 'planned',
      oldEventId: 'kino',
      newEventProposed: false,
      kind: 'cancellation',
    });
    expect(res.action).toBe('cancel_old');
  });

  it('does not replace a completed/cancelled event', () => {
    const res = resolveCorrection({
      oldEventStatus: 'completed',
      oldEventId: 'kino',
      newEventProposed: true,
      kind: 'change',
    });
    expect(res.action).toBe('none');
  });
});
