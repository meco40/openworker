import {
  enforceSectionBudgets,
  estimateTokenCount,
  trimToTokenBudget,
} from '@/server/knowledge/tokenBudget';
import { assessAnswerSafety, buildSafetyInstruction } from '@/server/knowledge/answerSafetyPolicy';
import type { EvidenceAssessment } from '@/server/knowledge/answerSafetyPolicy';
import {
  detectQueryComplexity,
  calculateRecallBudget,
} from '@/server/knowledge/recallBudgetCalculator';
import type { KnowledgeRetrievalSections } from '../types';

export interface BudgetContext {
  query: string;
  counterpartAliasesLength: number;
  stageStats: Record<string, number>;
  computedAnswerText: string | null;
  maxContextTokens: number;
}

export interface BudgetResult {
  effectiveMaxTokens: number;
  budgetedSections: KnowledgeRetrievalSections;
  safetyInstruction: string | null;
  context: string;
  tokenCount: number;
}

export function calculateAndApplyBudget(
  rawSections: KnowledgeRetrievalSections,
  context: BudgetContext,
): BudgetResult {
  const { query, counterpartAliasesLength, stageStats, computedAnswerText, maxContextTokens } =
    context;

  // ── Dynamic recall budget ──────────────────────────────
  const queryComplexity = detectQueryComplexity(query);
  const recallBudget = calculateRecallBudget({
    queryComplexity,
    entityCount: counterpartAliasesLength,
    availableSourceCount: stageStats.ledger + stageStats.episodes + stageStats.semantic,
  });

  // Dynamic budget can scale up from base, but never exceeds 3x the configured max.
  const dynamicTokens = Math.round(recallBudget.total / 4); // rough chars-to-tokens
  const effectiveMaxTokens = Math.min(
    maxContextTokens * 3,
    Math.max(maxContextTokens, dynamicTokens),
  );

  const budgetedSections = enforceSectionBudgets(rawSections, effectiveMaxTokens, {
    answerDraft: 0.4,
    keyDecisions: 0.25,
    openPoints: 0.15,
    evidence: 0.2,
  });

  // ── Answer Safety Policy ───────────────────────────────
  const evidenceAssessment: EvidenceAssessment = {
    totalSources: stageStats.ledger + stageStats.episodes + stageStats.semantic,
    avgConfidence:
      stageStats.ledger + stageStats.episodes > 0 ? 0.7 : stageStats.semantic > 0 ? 0.5 : 0,
    hasComputedAnswer: !!computedAnswerText,
    hasContradiction: false,
  };
  const safetyLevel = assessAnswerSafety(evidenceAssessment);
  const safetyInstruction = buildSafetyInstruction(safetyLevel);

  let fullContext = [
    ...(safetyInstruction ? [safetyInstruction] : []),
    `AnswerDraft:\n${budgetedSections.answerDraft}`,
    `KeyDecisions:\n${budgetedSections.keyDecisions}`,
    `OpenPoints:\n${budgetedSections.openPoints}`,
    `Evidence:\n${budgetedSections.evidence}`,
  ].join('\n\n');

  if (estimateTokenCount(fullContext) > effectiveMaxTokens) {
    fullContext = trimToTokenBudget(fullContext, effectiveMaxTokens);
  }

  const tokenCount = estimateTokenCount(fullContext);

  return {
    effectiveMaxTokens,
    budgetedSections,
    safetyInstruction,
    context: fullContext,
    tokenCount,
  };
}
