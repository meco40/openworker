/**
 * Recurrence pattern detection for memory classification.
 *
 * Detects recurring patterns in German text like "jeden Montag",
 * "taeglich", "woechentlich", "monatlich", "immer", "normalerweise".
 */

export type RecurrenceType = 'daily' | 'weekly' | 'monthly' | 'recurring';

export interface RecurrenceInfo {
  type: RecurrenceType;
  day?: string;
}

/**
 * Detect recurring patterns in German text.
 * Returns recurrence type and optional day, or null if no pattern found.
 */
export function detectRecurrence(text: string): RecurrenceInfo | null {
  const lower = text.toLowerCase();

  // Daily patterns
  if (/\b(taeglich|täglich|jeden\s+tag)\b/i.test(lower)) {
    return { type: 'daily' };
  }

  // Weekly with specific day: "Jeden Montag"
  const weekdayMatch =
    /\bjeden\s+(montag|dienstag|mittwoch|donnerstag|freitag|samstag|sonntag)\b/i.exec(lower);
  if (weekdayMatch) {
    return { type: 'weekly', day: weekdayMatch[1].toLowerCase() };
  }

  // Weekly without day: "woechentlich"
  if (/\b(woechentlich|wöchentlich)\b/i.test(lower)) {
    return { type: 'weekly' };
  }

  // Monthly patterns
  if (/\b(monatlich|jeden\s+monat)\b/i.test(lower)) {
    return { type: 'monthly' };
  }

  // Generic recurring patterns
  if (
    /\b(immer|regelmaessig|regelmäßig|normalerweise|gewoehnlich|gewöhnlich|ueblicherweise|üblicherweise)\b/i.test(
      lower,
    )
  ) {
    return { type: 'recurring' };
  }

  return null;
}
