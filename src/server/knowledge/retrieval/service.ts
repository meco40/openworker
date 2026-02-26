// @deprecated This file has been modularized. Import from ./service/ instead.
// This file is kept for backward compatibility.

export {
  KnowledgeRetrievalService,
  // Types
  type KnowledgeRetrievalInput,
  type KnowledgeRecallProbeInput,
  type KnowledgeRetrievalSections,
  type KnowledgeRetrievalResult,
  type KnowledgeRetrievalServiceOptions,
  type RuleEvidenceEntry,
  // Constants
  BINARY_RECALL_QUERY_PATTERN,
  NEGATION_SIGNAL_PATTERN,
  GENERIC_QUERY_TOKENS,
  COUNTERPART_CACHE_TTL_MS,
  // Query processing
  normalizeRuleText,
  tokenizeRuleText,
  parseEventSeqs,
  isBinaryRecallQuery,
  extractQueryEvidenceTokens,
  hasEvidenceTokenOverlap,
  detectBinaryRecallConflict,
  normalizeLookupText,
  detectMentionedCounterpart,
  hasMeaningfulOverlap,
  hasValidSourceRefs,
  hasRuleLikeFragments,
  isRuleLikeStatement,
  extractRuleFragments,
  // Ranking
  rankEpisodesByQuery,
  rankLedgerByQuery,
  computeEpisodeAge,
  computeTokenOverlapScore,
  detectEmotionalToneInText,
  // Formatters
  buildSemanticContextForQuery,
  formatProjectGraph,
  buildEvidence,
  type EvidenceSourceRef,
  buildAnswerDraft,
  filterListsForRulesIntent,
  extractCounterpartAndLists,
  isCounterpartMatch,
  selectConversationId,
  calculateAndApplyBudget,
} from './service/';
