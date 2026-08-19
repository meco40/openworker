export interface TimeWindow {
  after?: string;
  before?: string;
  label?: string;
}

export interface PlannedQuery {
  timeWindow?: TimeWindow;
  intent:
    | 'what_done'
    | 'what_planned'
    | 'what_cancelled'
    | 'who_involved'
    | 'what_open'
    | 'what_promised'
    | 'generic';
  entity?: string;
  asOfValidTime?: string;
  asOfKnownTime?: string;
}

export interface QueryPlanInput {
  text: string;
  now?: string;
}

const PATTERNS: Array<{
  re: RegExp;
  label: string;
  builder: (m: RegExpMatchArray, now: Date) => TimeWindow;
}> = [
  {
    re: /letzte woche/i,
    label: 'last_week',
    builder: (_m, now) => {
      const end = new Date(now);
      end.setUTCDate(end.getUTCDate() - 7);
      return { after: end.toISOString(), before: now.toISOString(), label: 'last_week' };
    },
  },
  {
    re: /gestern/i,
    label: 'yesterday',
    builder: (_m, now) => {
      const start = new Date(now);
      start.setUTCDate(start.getUTCDate() - 1);
      return { after: start.toISOString(), before: now.toISOString(), label: 'yesterday' };
    },
  },
  {
    re: /heute/i,
    label: 'today',
    builder: (_m, now) => {
      const start = new Date(now);
      start.setUTCHours(0, 0, 0, 0);
      return { after: start.toISOString(), before: now.toISOString(), label: 'today' };
    },
  },
  {
    re: /vor\s+(\d+)\s+(monaten?|wochen?)/i,
    label: 'relative_duration',
    builder: (m, now) => {
      const n = Number(m[1] ?? 1);
      const unitRaw = String(m[2] ?? 'woche').toLowerCase();
      const unit = unitRaw.replace(/en?$/, '') + 'en';
      const end = new Date(now);
      const multiplier = unit.startsWith('monat') ? 30 : 7;
      end.setUTCDate(end.getUTCDate() - n * multiplier);
      return { after: end.toISOString(), before: now.toISOString(), label: `last_${n}_${unit}` };
    },
  },
];

function detectTimeWindow(text: string, now: Date): TimeWindow | undefined {
  for (const pattern of PATTERNS) {
    const m = text.match(pattern.re);
    if (m) return pattern.builder(m, now);
  }
  return undefined;
}

function isTwoDigitTimePart(part: string): boolean {
  return part.length === 2 && [...part].every((character) => character >= '0' && character <= '9');
}

function detectAsOf(text: string, now: Date): { valid?: string; known?: string } {
  const marker = /(?:as\s+of|zum\s+zeitpunkt|stand)\s+/i.exec(text);
  if (marker) {
    const remainder = text.slice(marker.index + marker[0].length);
    const datePart = remainder.slice(0, 10);
    let isoValue = /^[0-9]{4}-[0-9]{2}-[0-9]{2}$/.test(datePart) ? datePart : '';
    const separator = remainder[10];
    if (isoValue && (separator === 'T' || separator === 't' || separator === ' ')) {
      const timePart = remainder.slice(11).split(/\s+/)[0] ?? '';
      const timeParts = timePart.split(':');
      if (
        (timeParts.length === 2 || timeParts.length === 3) &&
        timeParts.every(isTwoDigitTimePart)
      ) {
        isoValue = `${datePart}T${timePart}`;
      }
    }
    const parsed = new Date(isoValue);
    if (!Number.isNaN(parsed.getTime()))
      return { valid: parsed.toISOString(), known: parsed.toISOString() };
  }
  if (/damals|zu dem zeitpunkt|damaliger wissensstand/i.test(text)) {
    return { known: now.toISOString() };
  }
  return {};
}

function detectIntent(text: string): PlannedQuery['intent'] {
  if (
    /was (habe ich|hab ich|habe|wurde|ist) .*(gemacht|getan|passiert|geworden|essen|war)/.test(text)
  )
    return 'what_done';
  if (/was (ist|war) .*(geplant|vor|ausgemacht|terminal)/.test(text)) return 'what_planned';
  if (/was (ist|wurde) .*(abgesagt|storniert|cancelled)/.test(text)) return 'what_cancelled';
  if (/wer (war|ist|dabei|beteiligt)|mit wem/.test(text)) return 'who_involved';
  if (/was (ist|steht) (noch )?(offen|ausstehend)|offene (punkte|fragen)/.test(text))
    return 'what_open';
  if (/was (habe ich|hab ich) (versprochen|zugesagt)/.test(text)) return 'what_promised';
  return 'generic';
}

/**
 * Phase 10: Uebersetzt eine freie Frage in strukturierte Zeit-/Intent-/
 * Entitaets-Kriterien. Ausgabe-Typisierte Results fuer spätere Abfragen.
 */
export function planQuery(input: QueryPlanInput): PlannedQuery {
  const now = input.now ? new Date(input.now) : new Date();
  const text = input.text.trim();
  const asOf = detectAsOf(text, now);
  return {
    timeWindow: detectTimeWindow(text, now),
    intent: detectIntent(text.toLowerCase()),
    asOfValidTime: asOf.valid,
    asOfKnownTime: asOf.known,
    entity: extractEntityMention(text),
  };
}

export function extractEntityMention(text: string): string | undefined {
  // Heuristik: erster Nomen-artiger Bestandteil nach Kleinschreibung.
  const match = text.match(/(?:mit|wegen|fuer|zu|von)\s+([A-ZÄÖÜ][a-zäöü]+)/);
  return match?.[1];
}
