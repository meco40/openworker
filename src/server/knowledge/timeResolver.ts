/**
 * Time Resolver — resolves relative German time expressions to absolute dates.
 * Uses user timezone for correct day boundary calculations.
 */

export interface TimeResolutionContext {
  messageTimestamp: string; // ISO — when the message was written
  userTimezone: string | null; // e.g. "Europe/Berlin"
}

export interface ResolvedTime {
  absoluteDate: string; // YYYY-MM-DD
  absoluteDateEnd: string | null; // For date ranges
  resolutionConfidence: number; // 0.0–1.0
  wasRelative: boolean;
  originalText: string;
}

const GERMAN_NUMBERS: Record<string, number> = {
  ein: 1,
  eins: 1,
  einem: 1,
  einer: 1,
  zwei: 2,
  drei: 3,
  vier: 4,
  fuenf: 5,
  fünf: 5,
  sechs: 6,
  sieben: 7,
  acht: 8,
  neun: 9,
  zehn: 10,
  elf: 11,
  zwoelf: 12,
  zwölf: 12,
};

function parseGermanNumber(word: string): number {
  const lower = word.toLowerCase();
  if (GERMAN_NUMBERS[lower] !== undefined) return GERMAN_NUMBERS[lower];
  const n = parseInt(lower, 10);
  return isNaN(n) ? 1 : n;
}

function toUserLocalDate(isoTimestamp: string, timezone: string | null): Date {
  const utcDate = new Date(isoTimestamp);
  if (!timezone) return utcDate;

  // Use Intl.DateTimeFormat to get local date parts in the user's timezone
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
  const parts = formatter.formatToParts(utcDate);
  const year = parseInt(parts.find((p) => p.type === 'year')!.value, 10);
  const month = parseInt(parts.find((p) => p.type === 'month')!.value, 10) - 1;
  const day = parseInt(parts.find((p) => p.type === 'day')!.value, 10);

  return new Date(year, month, day);
}

function formatDate(date: Date): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function addDays(date: Date, days: number): Date {
  const result = new Date(date);
  result.setDate(result.getDate() + days);
  return result;
}

/**
 * Resolves relative German time expressions to absolute dates.
 * Takes user timezone into account for correct day boundaries.
 */
export function resolveRelativeTime(
  text: string,
  context: TimeResolutionContext,
): ResolvedTime | null {
  const refDate = toUserLocalDate(context.messageTimestamp, context.userTimezone);

  // "heute"
  if (/\bheute\b/i.test(text)) {
    return {
      absoluteDate: formatDate(refDate),
      absoluteDateEnd: null,
      resolutionConfidence: 0.95,
      wasRelative: true,
      originalText: text,
    };
  }

  // "gestern"
  if (/\bgestern\b/i.test(text)) {
    return {
      absoluteDate: formatDate(addDays(refDate, -1)),
      absoluteDateEnd: null,
      resolutionConfidence: 0.95,
      wasRelative: true,
      originalText: text,
    };
  }

  // "vorgestern"
  if (/\bvorgestern\b/i.test(text)) {
    return {
      absoluteDate: formatDate(addDays(refDate, -2)),
      absoluteDateEnd: null,
      resolutionConfidence: 0.95,
      wasRelative: true,
      originalText: text,
    };
  }

  // "morgen"
  if (/\bmorgen\b/i.test(text) && !/\bguten\s+morgen\b/i.test(text)) {
    return {
      absoluteDate: formatDate(addDays(refDate, 1)),
      absoluteDateEnd: null,
      resolutionConfidence: 0.95,
      wasRelative: true,
      originalText: text,
    };
  }

  // "in N Tagen"
  const inNDays = text.match(/\bin\s+(\w+)\s+tagen?\b/i);
  if (inNDays) {
    const n = parseGermanNumber(inNDays[1]);
    return {
      absoluteDate: formatDate(addDays(refDate, n)),
      absoluteDateEnd: null,
      resolutionConfidence: 0.9,
      wasRelative: true,
      originalText: text,
    };
  }

  // "letzte Woche" → Monday to Sunday of previous week
  if (/\bletzte\s+woche\b/i.test(text)) {
    const dayOfWeek = refDate.getDay(); // 0=Sun, 1=Mon
    const mondayOffset = dayOfWeek === 0 ? -6 : -(dayOfWeek - 1);
    const thisMonday = addDays(refDate, mondayOffset);
    const lastMonday = addDays(thisMonday, -7);
    const lastSunday = addDays(lastMonday, 6);
    return {
      absoluteDate: formatDate(lastMonday),
      absoluteDateEnd: formatDate(lastSunday),
      resolutionConfidence: 0.85,
      wasRelative: true,
      originalText: text,
    };
  }

  // Absolute German date: "am 15.02.2026" or "15.02." or "15.2."
  const fullDateMatch = text.match(/(\d{1,2})\.(\d{1,2})\.(\d{4})/);
  if (fullDateMatch) {
    const day = parseInt(fullDateMatch[1], 10);
    const month = parseInt(fullDateMatch[2], 10);
    const year = parseInt(fullDateMatch[3], 10);
    const resolved = new Date(year, month - 1, day);
    return {
      absoluteDate: formatDate(resolved),
      absoluteDateEnd: null,
      resolutionConfidence: 1.0,
      wasRelative: false,
      originalText: text,
    };
  }

  const shortDateMatch = text.match(/(\d{1,2})\.(\d{1,2})\./);
  if (shortDateMatch) {
    const day = parseInt(shortDateMatch[1], 10);
    const month = parseInt(shortDateMatch[2], 10);
    const year = refDate.getFullYear();
    const resolved = new Date(year, month - 1, day);
    return {
      absoluteDate: formatDate(resolved),
      absoluteDateEnd: null,
      resolutionConfidence: 1.0,
      wasRelative: false,
      originalText: text,
    };
  }

  return null;
}
