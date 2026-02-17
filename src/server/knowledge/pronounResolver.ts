/**
 * Pronoun Resolution for Knowledge Extraction
 *
 * Resolves reference pronouns (er/ihm/sein) to named entities
 * while leaving perspective pronouns (ich/mein/du/dein) untouched.
 */

export interface PronounContext {
  lastMentionedPerson: string | null;
  lastMentionedProject: string | null;
  speakerPersonaName: string;
  speakerUserId: string;
}

/**
 * Masculine reference pronouns that should be resolved when context is available.
 * Feminine/neutral pronouns (sie/ihr/es) are intentionally left ambiguous —
 * "sie" can mean "she" or "they", so we keep it rather than risk wrong resolution.
 */
const MASCULINE_REFERENCE = /\b(er|ihm|sein|seinen|seinem|seiner)\b/gi;

/**
 * Resolves reference pronouns in a fact to named entities.
 * Perspective pronouns (ich/mein/du/dein) remain UNCHANGED.
 *
 * Strategy:
 * - Only masculine reference pronouns (er/ihm/sein…) are resolved
 * - Resolution only happens when lastMentionedPerson is available
 * - Feminine/neutral pronouns are left as-is (too ambiguous)
 */
export function resolvePronouns(fact: string, context: PronounContext): string {
  if (!context.lastMentionedPerson) return fact;
  if (!MASCULINE_REFERENCE.test(fact)) return fact;

  // Reset lastIndex after test()
  MASCULINE_REFERENCE.lastIndex = 0;

  return fact.replace(MASCULINE_REFERENCE, () => context.lastMentionedPerson!);
}
