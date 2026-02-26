import {
  isRuleLikeStatement,
  extractRuleFragments,
} from '@/server/knowledge/retrieval/query/rulesExtractor';
import { normalizeRuleText, tokenizeRuleText } from './parser';

export function hasMeaningfulOverlap(left: string, right: string): boolean {
  const leftNorm = normalizeRuleText(left);
  const rightNorm = normalizeRuleText(right);
  if (!leftNorm || !rightNorm) return false;
  if (leftNorm.includes(rightNorm) || rightNorm.includes(leftNorm)) return true;

  const leftTokens = new Set(tokenizeRuleText(leftNorm));
  const rightTokens = tokenizeRuleText(rightNorm);
  if (leftTokens.size === 0 || rightTokens.length === 0) return false;

  let overlap = 0;
  for (const token of rightTokens) {
    if (leftTokens.has(token)) overlap += 1;
  }

  return overlap >= 2;
}

export function hasValidSourceRefs(
  refs: Array<{ seq: number; quote: string }> | undefined | null,
): boolean {
  return (refs || []).some((ref) => Number(ref?.seq || 0) > 0);
}

export function hasRuleLikeFragments(values: string[]): boolean {
  const normalized = values
    .map((value) => String(value || '').trim())
    .filter((value) => value.length > 0);
  if (normalized.some((value) => isRuleLikeStatement(value))) return true;
  return extractRuleFragments(normalized.join('\n')).length > 0;
}

// Re-exports for convenience
export { isRuleLikeStatement, extractRuleFragments };
