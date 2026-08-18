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
  return {
    timeWindow: detectTimeWindow(text, now),
    intent: detectIntent(text.toLowerCase()),
  };
}

export function extractEntityMention(text: string): string | undefined {
  // Heuristik: erster Nomen-artiger Bestandteil nach Kleinschreibung.
  const match = text.match(/(?:mit|wegen|fuer|zu|von)\s+([A-ZÄÖÜ][a-zäöü]+)/);
  return match?.[1];
}
