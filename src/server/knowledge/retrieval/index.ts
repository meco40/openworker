// Main exports from the retrieval module
export { KnowledgeRetrievalService } from './service/index';

export type {
  KnowledgeRetrievalInput,
  KnowledgeRecallProbeInput,
  KnowledgeRetrievalSections,
  KnowledgeRetrievalResult,
  KnowledgeRetrievalServiceOptions,
  MemoryRecallLike,
  MessageLookupRepository,
  RetrievalKnowledgeRepository,
} from './types';

// Utility exports (optional - can be used by other modules)
export { uniqueStrings } from './utils/arrayUtils';

export {
  normalizeLookupText,
  isRulesIntentQuery,
  containsRulesWord,
  detectMentionedCounterpart,
  isCounterpartMatch,
} from './query/intentDetector';

export { isRuleLikeStatement, extractRuleFragments } from './query/rulesExtractor';

export { tokenizeQueryForRanking } from './query/queryParser';

export { computeEpisodeAge, rankEpisodesByQuery } from './ranking/episodeRanker';

export { rankLedgerByQuery } from './ranking/ledgerRanker';

export { computeTokenOverlapScore, detectEmotionalToneInText } from './ranking/scoring';

export { buildSemanticContextForQuery, formatProjectGraph } from './formatters/contextFormatter';

export { buildEvidence } from './formatters/evidenceBuilder';

export { toDisplayName, selectConversationId } from './formatters/displayUtils';

export {
  buildAnswerDraft,
  filterListsForRulesIntent,
  extractCounterpartAndLists,
} from './formatters/answerDraftBuilder';

export { calculateAndApplyBudget } from './formatters/budgetCalculator';

export type { AnswerDraftInput } from './formatters/answerDraftBuilder';

export type { BudgetContext, BudgetResult } from './formatters/budgetCalculator';
