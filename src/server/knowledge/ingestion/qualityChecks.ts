import { isRuleLikeStatement } from '@/server/knowledge/retrieval/query/rulesExtractor';
import type { IngestionWindow } from '@/server/knowledge/ingestionCursor';

/**
 * Infer the starting sequence number from an ingestion window.
 */
export function inferSourceStart(window: IngestionWindow): number {
  const firstSeq = Number(window.messages[0]?.seq || window.fromSeqExclusive || 0);
  return Math.max(0, Math.floor(firstSeq));
}

/**
 * Infer the ending sequence number from an ingestion window.
 */
export function inferSourceEnd(window: IngestionWindow): number {
  const lastSeq = Number(
    window.messages[window.messages.length - 1]?.seq ||
      window.toSeqInclusive ||
      window.fromSeqExclusive,
  );
  return Math.max(0, Math.floor(lastSeq));
}

/**
 * Normalize rule evidence text for comparison.
 */
export function normalizeRuleEvidenceText(value: string): string {
  return String(value || '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Tokenize rule evidence text into searchable tokens.
 */
export function tokenizeRuleEvidence(value: string): string[] {
  return normalizeRuleEvidenceText(value)
    .split(/[^a-z0-9äöüß]+/i)
    .map((token) => token.trim())
    .filter((token) => token.length >= 4);
}

/**
 * Check if a rule fact has matching evidence in the provided texts.
 */
export function hasRuleEvidenceMatch(ruleFact: string, evidenceTexts: string[]): boolean {
  const normalizedRuleFact = normalizeRuleEvidenceText(ruleFact);
  if (!normalizedRuleFact) return false;

  const factTokens = new Set(tokenizeRuleEvidence(normalizedRuleFact));
  for (const evidenceText of evidenceTexts) {
    const normalizedEvidence = normalizeRuleEvidenceText(evidenceText);
    if (!normalizedEvidence) continue;
    if (
      normalizedEvidence.includes(normalizedRuleFact) ||
      normalizedRuleFact.includes(normalizedEvidence)
    ) {
      return true;
    }

    const evidenceTokens = tokenizeRuleEvidence(normalizedEvidence);
    if (factTokens.size === 0 || evidenceTokens.length === 0) continue;
    let overlap = 0;
    for (const token of evidenceTokens) {
      if (factTokens.has(token)) overlap += 1;
    }
    if (overlap >= 2) return true;
  }

  return false;
}

/**
 * Collect user message texts and source quotes from the ingestion window.
 */
export function collectUserRuleEvidenceTexts(
  window: IngestionWindow,
  sourceRefs: Array<{ seq: number; quote: string }>,
): string[] {
  const seqToRole = new Map<number, string>();
  for (const message of window.messages) {
    const seq = Math.floor(Number(message.seq || 0));
    if (Number.isFinite(seq) && seq > 0) {
      seqToRole.set(seq, String(message.role || '').toLowerCase());
    }
  }

  const userMessages = window.messages
    .filter((message) => String(message.role || '').toLowerCase() === 'user')
    .map((message) => String(message.content || '').trim());

  const userSourceQuotes = sourceRefs
    .map((sourceRef) => {
      const seq = Math.floor(Number(sourceRef.seq || 0));
      return {
        seq,
        quote: String(sourceRef.quote || '').trim(),
        role: seqToRole.get(seq) || '',
      };
    })
    .filter((entry) => entry.role === 'user')
    .map((entry) => entry.quote);

  const unique = new Set<string>();
  for (const text of [...userMessages, ...userSourceQuotes]) {
    const normalized = normalizeRuleEvidenceText(text);
    if (!normalized) continue;
    unique.add(text.trim());
  }

  return [...unique];
}

/**
 * Filter out rule-like statements that don't have evidence backing.
 */
export function keepOnlyEvidenceBackedRuleStatements(
  values: string[],
  evidenceTexts: string[],
): string[] {
  const output: string[] = [];
  for (const value of values) {
    const statement = String(value || '').trim();
    if (!statement) continue;
    if (!isRuleLikeStatement(statement)) {
      output.push(statement);
      continue;
    }
    if (hasRuleEvidenceMatch(statement, evidenceTexts)) {
      output.push(statement);
    }
  }
  return output;
}
