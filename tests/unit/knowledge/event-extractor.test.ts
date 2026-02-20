import { describe, expect, it } from 'vitest';
import { EventExtractor, type ExtractedEvent } from '@/server/knowledge/eventExtractor';

interface MinimalMessage {
  seq: number;
  role: 'user' | 'agent' | 'system';
  content: string;
}

function makeRawEvent(overrides: Partial<ExtractedEvent> = {}): ExtractedEvent {
  return {
    eventType: 'shared_sleep',
    speakerRole: 'assistant',
    subject: 'Nata',
    counterpart: 'Max',
    relationLabel: 'Bruder',
    timeExpression: 'die letzten zwei Tage',
    startDate: '',
    endDate: '',
    dayCount: 2,
    isConfirmation: false,
    confirmationSignals: [],
    sourceSeq: [10],
    ...overrides,
  };
}

describe('EventExtractor', () => {
  const extractor = new EventExtractor();

  describe('resolveAbsoluteDates', () => {
    const ref = new Date('2026-02-16T14:00:00Z');

    it('resolves "die letzten zwei Tage" correctly', () => {
      const result = extractor.resolveAbsoluteDates('die letzten zwei Tage', 2, ref);
      expect(result.startDate).toBe('2026-02-15');
      expect(result.endDate).toBe('2026-02-16');
      expect(result.dayCount).toBe(2);
    });

    it('resolves "die letzten 3 Tage"', () => {
      const result = extractor.resolveAbsoluteDates('die letzten 3 Tage', 3, ref);
      expect(result.startDate).toBe('2026-02-14');
      expect(result.endDate).toBe('2026-02-16');
      expect(result.dayCount).toBe(3);
    });

    it('resolves "gestern" correctly', () => {
      const ref24 = new Date('2026-02-24T20:00:00Z');
      const result = extractor.resolveAbsoluteDates('gestern', 1, ref24);
      expect(result.startDate).toBe('2026-02-23');
      expect(result.endDate).toBe('2026-02-23');
      expect(result.dayCount).toBe(1);
    });

    it('resolves "vorgestern" correctly', () => {
      const result = extractor.resolveAbsoluteDates('vorgestern', 1, ref);
      expect(result.startDate).toBe('2026-02-14');
      expect(result.endDate).toBe('2026-02-14');
      expect(result.dayCount).toBe(1);
    });

    it('falls back to dayCount when expression is not recognized', () => {
      const result = extractor.resolveAbsoluteDates('irgendwann letzte Woche', 3, ref);
      expect(result.dayCount).toBe(3);
      expect(result.startDate).toBe('2026-02-14');
      expect(result.endDate).toBe('2026-02-16');
    });

    it('handles dayCount=0 gracefully', () => {
      const result = extractor.resolveAbsoluteDates('unbekannt', 0, ref);
      expect(result.dayCount).toBe(1);
      expect(result.startDate).toBe('2026-02-16');
      expect(result.endDate).toBe('2026-02-16');
    });
  });

  describe('validateSpeakerRole', () => {
    it('corrects LLM speakerRole based on message.role', () => {
      const event = makeRawEvent({
        speakerRole: 'assistant', // LLM said assistant
        sourceSeq: [11],
      });

      const messages: MinimalMessage[] = [
        { seq: 11, role: 'user', content: 'Ich habe auch mit meinem Bruder geschlafen' },
      ];

      const corrected = extractor.validateSpeakerRole(event, messages);
      expect(corrected.speakerRole).toBe('user'); // Corrected from message.role
    });

    it('keeps correct LLM speakerRole when it matches', () => {
      const event = makeRawEvent({
        speakerRole: 'assistant',
        sourceSeq: [10],
      });

      const messages: MinimalMessage[] = [
        { seq: 10, role: 'agent', content: 'Ich habe mit Max geschlafen' },
      ];

      const corrected = extractor.validateSpeakerRole(event, messages);
      expect(corrected.speakerRole).toBe('assistant'); // Correct, kept as-is
    });

    it('keeps LLM role when no sourceSeq is present', () => {
      const event = makeRawEvent({
        speakerRole: 'assistant',
        sourceSeq: [],
      });

      const corrected = extractor.validateSpeakerRole(event, []);
      expect(corrected.speakerRole).toBe('assistant');
    });

    it('keeps LLM role when source message is not found', () => {
      const event = makeRawEvent({
        speakerRole: 'assistant',
        sourceSeq: [999],
      });

      const messages: MinimalMessage[] = [{ seq: 10, role: 'agent', content: 'Something else' }];

      const corrected = extractor.validateSpeakerRole(event, messages);
      expect(corrected.speakerRole).toBe('assistant');
    });
  });

  describe('normalizeEvents', () => {
    it('resolves dates and validates speaker for all events', () => {
      const rawEvents = [
        makeRawEvent({
          timeExpression: 'die letzten zwei Tage',
          dayCount: 2,
          speakerRole: 'assistant',
          sourceSeq: [10],
        }),
      ];

      const messages: MinimalMessage[] = [
        { seq: 10, role: 'agent', content: 'Ich habe mit Max geschlafen' },
      ];

      const ref = new Date('2026-02-16T14:00:00Z');
      const normalized = extractor.normalizeEvents(rawEvents, messages, ref);

      expect(normalized).toHaveLength(1);
      expect(normalized[0].startDate).toBe('2026-02-15');
      expect(normalized[0].endDate).toBe('2026-02-16');
      expect(normalized[0].speakerRole).toBe('assistant');
    });

    it('filters out events with invalid eventType', () => {
      const rawEvents = [
        makeRawEvent({ eventType: '' }),
        makeRawEvent({ eventType: 'visit', sourceSeq: [11] }),
      ];

      const messages: MinimalMessage[] = [
        { seq: 10, role: 'agent', content: 'x' },
        { seq: 11, role: 'agent', content: 'y' },
      ];

      const ref = new Date('2026-02-16T14:00:00Z');
      const normalized = extractor.normalizeEvents(rawEvents, messages, ref);

      expect(normalized).toHaveLength(1);
      expect(normalized[0].eventType).toBe('visit');
    });
  });
});
