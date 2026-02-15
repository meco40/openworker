export interface KnowledgeTimeRange {
  from: string;
  to: string;
}

export interface KnowledgeQueryPlan {
  normalizedQuery: string;
  topic: string | null;
  counterpart: string | null;
  timeRange: KnowledgeTimeRange | null;
  detailDepth: 'low' | 'medium' | 'high';
}

function isoDate(input: Date): string {
  return input.toISOString().slice(0, 10);
}

function shiftMonths(input: Date, months: number): Date {
  const next = new Date(input.getTime());
  next.setUTCMonth(next.getUTCMonth() - months);
  return next;
}

function shiftDays(input: Date, days: number): Date {
  const next = new Date(input.getTime());
  next.setUTCDate(next.getUTCDate() - days);
  return next;
}

function extractTopic(normalizedQuery: string): string | null {
  const explicit = /\b(?:über|ueber|about)\s+([a-z0-9äöüß_-]{2,})\b/i.exec(normalizedQuery);
  if (explicit?.[1]) return explicit[1].toLowerCase();

  if (/\bmeeting\b/i.test(normalizedQuery)) return 'meeting';
  if (/\bsauna\b/i.test(normalizedQuery)) return 'sauna';
  return null;
}

function extractCounterpart(normalizedQuery: string): string | null {
  const match = /\bmit\s+([a-zäöüß][a-z0-9äöüß_-]{1,})\b/i.exec(normalizedQuery);
  if (!match?.[1]) return null;
  return match[1].toLowerCase();
}

function extractTimeRange(normalizedQuery: string, now: Date): KnowledgeTimeRange | null {
  const monthsMatch = /\bvor\s+(\d+)\s+monaten?\b/i.exec(normalizedQuery);
  if (monthsMatch?.[1]) {
    const months = Number.parseInt(monthsMatch[1], 10);
    if (Number.isFinite(months) && months > 0) {
      return {
        from: isoDate(shiftMonths(now, months)),
        to: isoDate(now),
      };
    }
  }

  const daysMatch = /\bvor\s+(\d+)\s+tagen?\b/i.exec(normalizedQuery);
  if (daysMatch?.[1]) {
    const days = Number.parseInt(daysMatch[1], 10);
    if (Number.isFinite(days) && days > 0) {
      return {
        from: isoDate(shiftDays(now, days)),
        to: isoDate(now),
      };
    }
  }

  if (/\b(letzte[nrsm]?|last)\b/i.test(normalizedQuery)) {
    return {
      from: isoDate(shiftDays(now, 7)),
      to: isoDate(now),
    };
  }

  if (/\bheute\b/i.test(normalizedQuery)) {
    return {
      from: isoDate(now),
      to: isoDate(now),
    };
  }

  return null;
}

function resolveDetailDepth(normalizedQuery: string): 'low' | 'medium' | 'high' {
  if (
    /\b(was haben wir|ausgehandelt|details?|genau|warum|wie war)\b/i.test(normalizedQuery)
  ) {
    return 'high';
  }
  if (/\b(wann|wo|wer)\b/i.test(normalizedQuery)) return 'medium';
  return 'low';
}

export function planKnowledgeQuery(query: string, now = new Date()): KnowledgeQueryPlan {
  const normalizedQuery = query.trim().toLowerCase();
  return {
    normalizedQuery,
    topic: extractTopic(normalizedQuery),
    counterpart: extractCounterpart(normalizedQuery),
    timeRange: extractTimeRange(normalizedQuery, now),
    detailDepth: resolveDetailDepth(normalizedQuery),
  };
}
