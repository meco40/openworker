/**
 * Pure contradiction signal detection between two facts.
 *
 * Detects whether a new fact contradicts an existing fact by analyzing
 * structural patterns: negation, value changes, and direct overrides.
 */

export type ContradictionType = 'direct_override' | 'value_change' | 'negation' | 'none';

export interface ContradictionSignal {
  hasContradiction: boolean;
  contradictionType: ContradictionType;
  confidence: number;
}

/**
 * Structural patterns that indicate the same "slot" is being filled:
 * "X ist mein Y" — relationship slot
 * "Ich arbeite bei Y" — employer slot
 * "Ich wohne in Y" — location slot
 */
const SLOT_PATTERNS: Array<{ pattern: RegExp; slotName: string }> = [
  { pattern: /\bist\s+mein[e]?\s+(\w+)/i, slotName: 'relationship' },
  { pattern: /\barbeite\s+bei\s+(\w+)/i, slotName: 'employer' },
  { pattern: /\bwohne\s+in\s+(\w+)/i, slotName: 'location' },
  { pattern: /\bbin\s+(\d+)\s+jahre/i, slotName: 'age' },
  { pattern: /\bheisse\s+(\w+)/i, slotName: 'name' },
  { pattern: /\bstudiere\s+(\w+)/i, slotName: 'study' },
];

const NEGATION_WORDS = /\b(nicht|kein|keine|keinen|keinem|nie|niemals|never)\b/i;
const NEGATION_WORDS_GLOBAL = /\b(nicht|kein|keine|keinen|keinem|nie|niemals|never)\b/gi;

/**
 * Extract the subject (first named entity or pronoun) from a fact.
 */
function extractSubject(text: string): string | null {
  // Try to find a capitalized name at the start or after common patterns
  const nameMatch = /^([A-ZÄÖÜ]\w+)\b/.exec(text.trim());
  if (nameMatch) return nameMatch[1].toLowerCase();

  // "Ich" as subject
  if (/^ich\b/i.test(text.trim())) return 'ich';

  return null;
}

/**
 * Extract the slot and value from a fact using slot patterns.
 */
function extractSlot(text: string): { slotName: string; value: string } | null {
  for (const { pattern, slotName } of SLOT_PATTERNS) {
    const match = pattern.exec(text);
    if (match) {
      return { slotName, value: match[1].toLowerCase() };
    }
  }
  return null;
}

/**
 * Check if one fact is a negation of the other.
 * E.g., "Max hat keine Freundin" vs "Max hat eine Freundin"
 */
function detectNegation(newFact: string, existingFact: string): boolean {
  const newHasNeg = NEGATION_WORDS.test(newFact);
  const existHasNeg = NEGATION_WORDS.test(existingFact);

  // One has negation and the other doesn't
  if (newHasNeg === existHasNeg) return false;

  // Strip negation words and compare remaining content
  const stripNeg = (t: string) =>
    t
      .replace(NEGATION_WORDS_GLOBAL, ' ')
      .replace(/[^\p{L}\p{N}\s]/gu, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .toLowerCase();

  const strippedNew = stripNeg(newFact);
  const strippedExist = stripNeg(existingFact);

  // Calculate word overlap after stripping negation
  const newWords = new Set(
    strippedNew
      .split(' ')
      .map((w) => w.trim())
      .filter((w) => w.length > 2),
  );
  const existWords = new Set(
    strippedExist
      .split(' ')
      .map((w) => w.trim())
      .filter((w) => w.length > 2),
  );

  if (newWords.size === 0 || existWords.size === 0) return false;

  let overlap = 0;
  for (const w of newWords) {
    if (existWords.has(w)) overlap++;
  }

  const overlapRatio = overlap / Math.max(newWords.size, existWords.size);
  return overlapRatio >= 0.5;
}

/**
 * Detect whether a new fact contradicts an existing fact.
 * Pure function — no async, no service dependencies.
 *
 * Returns a signal with contradiction type and confidence.
 */
export function detectContradictionSignal(
  newFact: string,
  existingFact: string,
): ContradictionSignal {
  // 1. Check negation contradiction
  if (detectNegation(newFact, existingFact)) {
    return {
      hasContradiction: true,
      contradictionType: 'negation',
      confidence: 0.85,
    };
  }

  // 2. Check slot-based contradictions (same subject + same slot + different value)
  const newSubject = extractSubject(newFact);
  const existSubject = extractSubject(existingFact);

  const newSlot = extractSlot(newFact);
  const existSlot = extractSlot(existingFact);

  if (newSubject && existSubject && newSubject === existSubject) {
    if (newSlot && existSlot && newSlot.slotName === existSlot.slotName) {
      if (newSlot.value !== existSlot.value) {
        // Same subject, same slot, different value
        const type: ContradictionType =
          newSlot.slotName === 'relationship' ? 'value_change' : 'direct_override';
        return {
          hasContradiction: true,
          contradictionType: type,
          confidence: 0.8,
        };
      }
    }
  }

  // 3. No contradiction detected
  return {
    hasContradiction: false,
    contradictionType: 'none',
    confidence: 0.1,
  };
}
