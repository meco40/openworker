export interface ExtractedEvent {
  eventType: string;
  speakerRole: 'assistant' | 'user';
  subject: string;
  counterpart: string;
  relationLabel: string | null;
  timeExpression: string;
  startDate: string;
  endDate: string;
  dayCount: number;
  isConfirmation: boolean;
  confirmationSignals: string[];
  sourceSeq: number[];
}

interface MinimalMessage {
  seq: number;
  role: string;
  content: string;
}

export class EventExtractor {
  /**
   * Validates and normalizes LLM-extracted events.
   * Resolves relative time expressions and validates speakerRole against message.role.
   */
  normalizeEvents(
    rawEvents: ExtractedEvent[],
    messages: MinimalMessage[],
    referenceTimestamp: Date,
  ): ExtractedEvent[] {
    const results: ExtractedEvent[] = [];

    for (const raw of rawEvents) {
      if (!raw.eventType || typeof raw.eventType !== 'string' || !raw.eventType.trim()) {
        continue;
      }

      const dates = this.resolveAbsoluteDates(raw.timeExpression, raw.dayCount, referenceTimestamp);

      const withDates: ExtractedEvent = {
        ...raw,
        startDate: dates.startDate,
        endDate: dates.endDate,
        dayCount: dates.dayCount,
      };

      const validated = this.validateSpeakerRole(withDates, messages);
      results.push(validated);
    }

    return results;
  }

  /**
   * Post-Extraction validation: message.role takes precedence over LLM-assigned speakerRole.
   */
  validateSpeakerRole(event: ExtractedEvent, messages: MinimalMessage[]): ExtractedEvent {
    if (event.sourceSeq.length === 0) return event;

    const sourceMsg = messages.find((m) => Number(m.seq) === event.sourceSeq[0]);
    if (!sourceMsg) return event;

    // message.role ALWAYS takes precedence
    const expectedRole = sourceMsg.role === 'agent' ? 'assistant' : sourceMsg.role;
    if (event.speakerRole !== expectedRole) {
      return { ...event, speakerRole: expectedRole as 'assistant' | 'user' };
    }
    return event;
  }

  /**
   * Resolves relative time expressions into absolute ISO dates.
   */
  resolveAbsoluteDates(
    timeExpression: string,
    dayCount: number,
    ref: Date,
  ): { startDate: string; endDate: string; dayCount: number } {
    const refDate = ref.toISOString().slice(0, 10);
    const refD = new Date(refDate + 'T00:00:00Z');

    // "gestern"
    if (/\bgestern\b/i.test(timeExpression)) {
      const d = new Date(refD);
      d.setUTCDate(d.getUTCDate() - 1);
      const iso = d.toISOString().slice(0, 10);
      return { startDate: iso, endDate: iso, dayCount: 1 };
    }

    // "vorgestern"
    if (/\bvorgestern\b/i.test(timeExpression)) {
      const d = new Date(refD);
      d.setUTCDate(d.getUTCDate() - 2);
      const iso = d.toISOString().slice(0, 10);
      return { startDate: iso, endDate: iso, dayCount: 1 };
    }

    // "die letzten N Tage" / "letzten N Tage"
    const lastN = timeExpression.match(/letzten?\s+(\w+)\s+tage?/i);
    if (lastN) {
      const n = parseGermanNumber(lastN[1]);
      if (n > 0) {
        const end = new Date(refD);
        const start = new Date(refD);
        start.setUTCDate(start.getUTCDate() - (n - 1));
        return {
          startDate: start.toISOString().slice(0, 10),
          endDate: end.toISOString().slice(0, 10),
          dayCount: n,
        };
      }
    }

    // Fallback: use dayCount from LLM, endDate = refDate
    if (dayCount > 0) {
      const end = new Date(refD);
      const start = new Date(refD);
      start.setUTCDate(start.getUTCDate() - (dayCount - 1));
      return {
        startDate: start.toISOString().slice(0, 10),
        endDate: end.toISOString().slice(0, 10),
        dayCount,
      };
    }

    return { startDate: refDate, endDate: refDate, dayCount: 1 };
  }
}

const GERMAN_NUMBERS: Record<string, number> = {
  ein: 1,
  eine: 1,
  eins: 1,
  zwei: 2,
  drei: 3,
  vier: 4,
  fünf: 5,
  fuenf: 5,
  sechs: 6,
  sieben: 7,
  acht: 8,
  neun: 9,
  zehn: 10,
};

function parseGermanNumber(text: string): number {
  const trimmed = text.trim().toLowerCase();
  const numeric = Number(trimmed);
  if (Number.isFinite(numeric) && numeric > 0) return numeric;
  return GERMAN_NUMBERS[trimmed] ?? 0;
}
