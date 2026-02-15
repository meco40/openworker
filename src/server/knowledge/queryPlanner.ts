export type KnowledgeQueryIntent = 'meeting_recall' | 'negotiation_recall' | 'general_recall';
export type KnowledgeDetailDepth = 'low' | 'medium' | 'high';

export interface KnowledgeTimeRange {
  from: string;
  to: string;
}

export interface KnowledgeQueryPlan {
  intent: KnowledgeQueryIntent;
  timeRange: KnowledgeTimeRange | null;
  counterpart: string | null;
  topic: string | null;
  detailDepth: KnowledgeDetailDepth;
}

function toIsoUtc(
  year: number,
  month: number,
  day: number,
  hours: number,
  minutes = 0,
  seconds = 0,
): string {
  return new Date(Date.UTC(year, month, day, hours, minutes, seconds)).toISOString();
}

function startOfUtcDay(base: Date): string {
  return toIsoUtc(base.getUTCFullYear(), base.getUTCMonth(), base.getUTCDate(), 0, 0, 0);
}

function endOfUtcDay(base: Date): string {
  return new Date(
    Date.UTC(
      base.getUTCFullYear(),
      base.getUTCMonth(),
      base.getUTCDate(),
      23,
      59,
      59,
      999,
    ),
  ).toISOString();
}

function subtractMonthsUtc(base: Date, months: number): Date {
  const output = new Date(base.getTime());
  output.setUTCMonth(output.getUTCMonth() - months);
  return output;
}

function shiftDaysUtc(base: Date, days: number): Date {
  const output = new Date(base.getTime());
  output.setUTCDate(output.getUTCDate() + days);
  return output;
}

function parseTimeRange(query: string, now: Date): KnowledgeTimeRange | null {
  const monthsMatch = /vor\s+(\d+)\s+monat(?:en)?/i.exec(query);
  if (monthsMatch) {
    const months = Math.max(0, Math.floor(Number(monthsMatch[1])));
    const from = subtractMonthsUtc(now, months).toISOString();
    return {
      from,
      to: now.toISOString(),
    };
  }

  if (/\bvorgestern\b/i.test(query)) {
    const day = shiftDaysUtc(now, -2);
    return {
      from: startOfUtcDay(day),
      to: endOfUtcDay(day),
    };
  }

  if (/\bgestern\b/i.test(query)) {
    const day = shiftDaysUtc(now, -1);
    return {
      from: startOfUtcDay(day),
      to: endOfUtcDay(day),
    };
  }

  if (/\bheute\b/i.test(query) && /\bmittag\b/i.test(query)) {
    const y = now.getUTCFullYear();
    const m = now.getUTCMonth();
    const d = now.getUTCDate();
    return {
      from: toIsoUtc(y, m, d, 11, 0, 0),
      to: toIsoUtc(y, m, d, 14, 0, 0),
    };
  }

  return null;
}

function parseCounterpart(query: string): string | null {
  const match = /\bmit\s+([a-zA-Z\u00C0-\u017F][\w\-\u00C0-\u017F]*)/i.exec(query);
  if (!match?.[1]) return null;
  return match[1].trim().toLowerCase();
}

function parseTopic(query: string): string | null {
  const lowered = query.toLowerCase();
  if (lowered.includes('ausgehandelt')) return 'ausgehandelt';

  const candidates = ['sauna', 'meeting', 'vertrag', 'rabatt', 'sla', 'preis'];
  for (const candidate of candidates) {
    if (lowered.includes(candidate)) return candidate;
  }

  return null;
}

function resolveIntent(query: string): KnowledgeQueryIntent {
  const lowered = query.toLowerCase();
  if (/\b(ausgehandelt|verhandelt|deal|vereinbart)\b/i.test(lowered)) {
    return 'negotiation_recall';
  }
  if (/\b(meeting|besprech|termin)\b/i.test(lowered)) {
    return 'meeting_recall';
  }
  return 'general_recall';
}

function resolveDetailDepth(query: string, intent: KnowledgeQueryIntent): KnowledgeDetailDepth {
  const lowered = query.toLowerCase();
  if (intent === 'negotiation_recall') return 'high';
  if (/\b(exakt|detail|warum|wieso|wie genau|vollstaendig|komplett)\b/i.test(lowered)) {
    return 'high';
  }
  if (/\b(was|wie|wann|heute|gestern|vor)\b/i.test(lowered)) {
    return 'medium';
  }
  return 'low';
}

export function planKnowledgeQuery(query: string, now = new Date()): KnowledgeQueryPlan {
  const normalized = String(query || '').trim();
  const intent = resolveIntent(normalized);

  return {
    intent,
    timeRange: parseTimeRange(normalized, now),
    counterpart: parseCounterpart(normalized),
    topic: parseTopic(normalized),
    detailDepth: resolveDetailDepth(normalized, intent),
  };
}
