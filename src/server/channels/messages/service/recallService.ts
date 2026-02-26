/**
 * @deprecated This file is kept for backward compatibility.
 * Please import from '@/server/channels/messages/service/recall' instead.
 */

export {
  RecallService,
  type StrictRecallCandidate,
  MEM0_EMPTY_SCOPE_TTL_MS,
  normalizeForMatch,
  tokenizeNormalized,
  countHits,
  hasAnyToken,
  applyRecencyBoost,
  dedupeCandidates,
  RECALL_QUERY_STOP_WORDS,
  TIME_TOKENS,
  COMMITMENT_TOKENS,
} from './recall';

// Default export for compatibility
export { RecallService as default } from './recall';
