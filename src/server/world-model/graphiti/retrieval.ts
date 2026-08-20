import { searchGraphitiFacts, type GraphitiFact } from '@/server/world-model/graphiti/client';

export interface GraphitiQueryInput {
  text: string;
  terms?: readonly string[];
  aliases?: readonly string[];
}

export interface RankedGraphitiFact {
  fact: GraphitiFact;
  score: number;
  matchedTokens: string[];
  focusMatchedTokens: string[];
  provenanceMatch: boolean;
}

export interface GraphitiRerankOptions {
  maxCandidates?: number;
  maxResults?: number;
  maxQueryVariants?: number;
  expectedSourceNodeUuid?: string;
  expectedTargetNodeUuid?: string;
}

const STOP_WORDS = new Set([
  'and',
  'for',
  'the',
  'with',
  'from',
  'this',
  'that',
  'is',
  'are',
  'has',
  'have',
  'not',
  'von',
  'der',
  'die',
  'das',
  'den',
  'dem',
  'des',
  'und',
  'oder',
  'ist',
  'sind',
  'ein',
  'eine',
  'einer',
  'einem',
  'einen',
  'zu',
  'im',
  'in',
  'auf',
]);

function tokenize(value: string): string[] {
  return value
    .toLocaleLowerCase('de-DE')
    .normalize('NFKC')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .split(/\s+/)
    .filter((token) => token.length >= 3 && !STOP_WORDS.has(token));
}

function uniqueNonEmpty(values: readonly string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    const cleaned = value.trim();
    if (!cleaned) continue;
    const key = cleaned.toLocaleLowerCase('de-DE').normalize('NFKC');
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(cleaned);
  }
  return result;
}

function normalizeFactKey(fact: GraphitiFact): string {
  const content = fact.fact
    .trim()
    .replace(/\s+/g, ' ')
    .toLocaleLowerCase('de-DE')
    .normalize('NFKC');
  // Graphiti can return the same semantic fact once per extracted relation
  // UUID. For a recall/precision result set that is one fact, not several.
  return `content:${content}`;
}

function tokenMatches(queryToken: string, factToken: string): boolean {
  if (queryToken === factToken) return true;
  if (queryToken.length < 5 || factToken.length < 5) return false;
  const prefixLength = Math.min(5, queryToken.length, factToken.length);
  return queryToken.slice(0, prefixLength) === factToken.slice(0, prefixLength);
}

export function deduplicateGraphitiFacts(facts: GraphitiFact[]): GraphitiFact[] {
  const seen = new Set<string>();
  return facts.filter((fact) => {
    const key = normalizeFactKey(fact);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/**
 * Creates a small set of complementary queries. Graphiti performs the
 * semantic retrieval; the variants make canonical names, predicates, and
 * known aliases visible to its lexical/full-text branch as well.
 */
export function buildGraphitiQueryVariants(input: GraphitiQueryInput, maxVariants = 3): string[] {
  const base = input.text.trim().replace(/\s+/g, ' ');
  if (!base) return [];

  const terms = uniqueNonEmpty([...(input.terms ?? []), ...tokenize(base)]);
  const aliases = uniqueNonEmpty(input.aliases ?? []);
  const variants = [base, terms.join(' ')];
  if (aliases.length > 0) variants.push([...terms.slice(0, 8), ...aliases.slice(0, 8)].join(' '));

  return uniqueNonEmpty(variants).slice(0, Math.max(1, maxVariants));
}

export function rankGraphitiFacts(
  input: GraphitiQueryInput,
  facts: GraphitiFact[],
  options: Pick<GraphitiRerankOptions, 'expectedSourceNodeUuid' | 'expectedTargetNodeUuid'> = {},
): RankedGraphitiFact[] {
  const queryTokens = uniqueNonEmpty([
    ...(input.terms ?? []),
    ...(input.aliases ?? []),
    ...tokenize(input.text),
  ]).flatMap(tokenize);
  const uniqueQueryTokens = [...new Set(queryTokens)];
  if (uniqueQueryTokens.length === 0) return [];

  const normalizedQuery = input.text.trim().toLocaleLowerCase('de-DE').normalize('NFKC');
  return deduplicateGraphitiFacts(facts)
    .map((fact) => {
      const factTokens = tokenize(`${fact.name ?? ''} ${fact.fact}`);
      const matchedTokens = uniqueQueryTokens.filter((queryToken) =>
        factTokens.some((factToken) => tokenMatches(queryToken, factToken)),
      );
      const tokenCoverage = matchedTokens.length / uniqueQueryTokens.length;
      const focusTokens = uniqueNonEmpty(input.terms ?? []).flatMap(tokenize);
      const focusMatchedTokens = focusTokens.filter((queryToken) =>
        factTokens.some((factToken) => tokenMatches(queryToken, factToken)),
      );
      const focusCoverage =
        focusTokens.length > 0 ? focusMatchedTokens.length / focusTokens.length : tokenCoverage;
      const normalizedFact = fact.fact.toLocaleLowerCase('de-DE').normalize('NFKC');
      const phraseMatch = normalizedQuery.length >= 12 && normalizedFact.includes(normalizedQuery);
      const provenanceMatch = Boolean(
        (options.expectedSourceNodeUuid &&
          fact.sourceNodeUuid === options.expectedSourceNodeUuid) ||
        (options.expectedTargetNodeUuid && fact.targetNodeUuid === options.expectedTargetNodeUuid),
      );
      const score = Math.min(
        1,
        tokenCoverage * 0.45 +
          focusCoverage * 0.3 +
          (phraseMatch ? 0.15 : 0) +
          (provenanceMatch ? 0.1 : 0),
      );
      return { fact, score, matchedTokens, focusMatchedTokens, provenanceMatch };
    })
    .sort((left, right) => {
      if (right.score !== left.score) return right.score - left.score;
      return left.fact.fact.localeCompare(right.fact.fact);
    });
}

export function isRelevantRankedGraphitiFact(
  candidate: RankedGraphitiFact,
  minimumScore = 0.3,
): boolean {
  if (candidate.provenanceMatch) return true;
  if (candidate.focusMatchedTokens.length >= 2) return candidate.score >= minimumScore;
  return candidate.score >= Math.max(0.45, minimumScore);
}

export async function searchGraphitiFactsWithRerank(
  groupId: string,
  input: GraphitiQueryInput,
  options: GraphitiRerankOptions = {},
): Promise<GraphitiFact[]> {
  const maxCandidates = Math.max(
    5,
    Math.min(100, options.maxCandidates ?? (Number(process.env.GRAPHITI_SEARCH_CANDIDATES) || 20)),
  );
  const maxResults = Math.max(
    1,
    Math.min(50, options.maxResults ?? (Number(process.env.GRAPHITI_SEARCH_RESULTS) || 5)),
  );
  const maxVariants = Math.max(
    1,
    Math.min(5, options.maxQueryVariants ?? (Number(process.env.GRAPHITI_QUERY_VARIANTS) || 3)),
  );
  const variants = buildGraphitiQueryVariants(input, maxVariants);
  const candidates: GraphitiFact[] = [];
  for (const variant of variants) {
    candidates.push(...(await searchGraphitiFacts(groupId, variant, maxCandidates)));
  }

  // Never expose low-confidence semantic noise to the application context.
  // The evaluator uses the same gate, so the runtime and quality report share
  // one relevance contract.
  return rankGraphitiFacts(input, candidates, options)
    .filter((candidate) => isRelevantRankedGraphitiFact(candidate))
    .slice(0, maxResults)
    .map((candidate) => candidate.fact);
}
