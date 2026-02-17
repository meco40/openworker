/**
 * Cleanup detection functions for entity drift and stale data.
 *
 * Pure functions that detect placeholder patterns, stale relative times,
 * and low-relevance content in stored facts.
 */

const PLACEHOLDER_PATTERNS = [
  /\b(die figur|der protagonist|die protagonistin|the character|the figure)\b/i,
  /\b(die person|das wesen|das individuum)\b/i,
];

const STALE_RELATIVE_TIME =
  /\b(morgen|in \w+ tagen?|naechste woche|nächste woche|bald|demnaechst|demnächst)\b/i;

/** Threshold for considering a relative time fact "stale" — 2 days */
const STALE_THRESHOLD_MS = 2 * 24 * 60 * 60 * 1000;

const LOW_RELEVANCE_PATTERNS = [
  /^(guten morgen|guten abend|guten tag|hallo|hi|hey|moin|servus|tschuess|bye)/i,
  /^(ok|okay|ja|nein|danke|bitte|alles klar|gut|super|cool|nice)$/i,
];

/** Minimum content length to be considered substantive */
const MIN_SUBSTANTIVE_LENGTH = 10;

/**
 * Detect if content contains placeholder entity references instead of real names.
 * E.g., "Die Protagonistin" instead of "Nata"
 */
export function detectPlaceholder(content: string): boolean {
  return PLACEHOLDER_PATTERNS.some((p) => p.test(content));
}

/**
 * Detect if content contains relative time expressions that have become stale.
 * A relative time is "stale" if the fact was created more than 2 days ago.
 */
export function detectStaleRelativeTime(content: string, createdAt: string): boolean {
  if (!STALE_RELATIVE_TIME.test(content)) return false;

  const age = Date.now() - new Date(createdAt).getTime();
  return age > STALE_THRESHOLD_MS;
}

/**
 * Detect low-relevance content like greetings and very short messages.
 */
export function detectLowRelevance(content: string): boolean {
  if (content.trim().length < MIN_SUBSTANTIVE_LENGTH) return true;
  return LOW_RELEVANCE_PATTERNS.some((p) => p.test(content.trim()));
}
