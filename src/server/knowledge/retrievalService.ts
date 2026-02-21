/**
 * @deprecated This file is kept for backward compatibility.
 * Please import from '@/server/knowledge/retrieval' instead.
 */

// Re-export everything from the new modular structure
export {
  KnowledgeRetrievalService,
  uniqueStrings,
  normalizeLookupText,
  isRulesIntentQuery,
  containsRulesWord,
  detectMentionedCounterpart,
  isRuleLikeStatement,
  extractRuleFragments,
  tokenizeQueryForRanking,
  computeEpisodeAge,
  rankEpisodesByQuery,
  rankLedgerByQuery,
  computeTokenOverlapScore,
  detectEmotionalToneInText,
  buildSemanticContextForQuery,
  formatProjectGraph,
  buildEvidence,
  toDisplayName,
  selectConversationId,
  isCounterpartMatch,
  buildAnswerDraft,
  filterListsForRulesIntent,
  extractCounterpartAndLists,
  calculateAndApplyBudget,
} from './retrieval';

export type {
  KnowledgeRetrievalInput,
  KnowledgeRecallProbeInput,
  KnowledgeRetrievalSections,
  KnowledgeRetrievalResult,
  KnowledgeRetrievalServiceOptions,
  MemoryRecallLike,
  MessageLookupRepository,
  RetrievalKnowledgeRepository,
  AnswerDraftInput,
  BudgetContext,
  BudgetResult,
} from './retrieval';
