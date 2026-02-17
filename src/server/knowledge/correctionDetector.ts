/**
 * Correction Detector — recognizes user corrections in chat messages.
 *
 * Patterns like "Nein, das war nicht Lisa, sondern Maria" trigger
 * a correction that supersedes the old fact.
 */

export interface CorrectionResult {
  isCorrection: boolean;
  oldValue?: string;
  newValue?: string;
  correctionType: 'name_change' | 'value_change' | 'fact_reversal' | 'none';
  targetFact?: string;
}

const CORRECTION_SIGNALS = [
  /\bnein\b.{0,30}\bsondern\b/i,
  /\bnicht\b.{0,30}\bsondern\b/i,
  /\bfalsch\b/i,
  /\bstimmt\s+nicht/i,
  /\b(?:korrektur|richtigstellung|berichtigung)\s*:/i,
];

/**
 * Extracts the "nicht X sondern Y" pair from a correction sentence.
 */
function extractOldNewPair(text: string): { oldValue: string; newValue: string } | null {
  // "nicht (article?) X sondern (article?) Y"
  const nichtSondern = text.match(
    /\bnicht\b\s+(?:den|der|die|das|dem)?\s*(\w+)\s*,?\s*sondern\s+(?:den|der|die|das|dem)?\s*(\w+)/i,
  );
  if (nichtSondern) {
    return { oldValue: nichtSondern[1], newValue: nichtSondern[2] };
  }

  return null;
}

/**
 * Detects whether a text contains a user correction.
 */
export function detectCorrection(text: string): CorrectionResult {
  const isCorrection = CORRECTION_SIGNALS.some((pattern) => pattern.test(text));

  if (!isCorrection) {
    return { isCorrection: false, correctionType: 'none' };
  }

  const pair = extractOldNewPair(text);

  return {
    isCorrection: true,
    oldValue: pair?.oldValue,
    newValue: pair?.newValue,
    correctionType: pair ? 'value_change' : 'fact_reversal',
  };
}
