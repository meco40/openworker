/**
 * Multilingual Alias Expansion — DE/EN equivalents for entity resolution.
 *
 * Allows "brother" to find entities aliased as "Bruder" and vice versa.
 */

const MULTILINGUAL_EQUIVALENTS: Record<string, string[]> = {
  bruder: ['brother', 'bro'],
  schwester: ['sister', 'sis'],
  mutter: ['mother', 'mom', 'mama'],
  vater: ['father', 'dad', 'papa'],
  freund: ['friend', 'buddy'],
  freundin: ['girlfriend', 'friend'],
  projekt: ['project'],
  aufgabe: ['task', 'todo'],
  familie: ['family'],
  arbeit: ['work', 'job'],
  kollege: ['colleague', 'coworker'],
};

/**
 * Expands an alias with multilingual equivalents.
 * "brother" → ["brother", "bruder", "bro"]
 * Unknown words return only themselves.
 */
export function expandMultilingualAliases(alias: string): string[] {
  const lower = alias.toLowerCase();
  const expanded = new Set<string>([alias]);

  for (const [de, enList] of Object.entries(MULTILINGUAL_EQUIVALENTS)) {
    if (lower === de || enList.some((en) => en === lower)) {
      expanded.add(de);
      for (const en of enList) {
        expanded.add(en);
      }
    }
  }

  return [...expanded];
}
