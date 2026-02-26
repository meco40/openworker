/**
 * Constants for recall service
 */

/** TTL for empty Mem0 scope cache (5 minutes) */
export const MEM0_EMPTY_SCOPE_TTL_MS = 5 * 60 * 1000;

/** Stop words to filter out from recall queries */
export const RECALL_QUERY_STOP_WORDS = new Set([
  'erinner',
  'erinnere',
  'dich',
  'welche',
  'welcher',
  'welches',
  'welchen',
  'was',
  'wie',
  'wann',
  'wo',
  'warum',
  'wieso',
  'du',
  'ich',
  'mir',
  'mich',
  'dein',
  'deine',
  'heute',
  'gestern',
  'vorgestern',
  'nochmal',
  'machen',
  'machst',
  'willst',
  'wolltest',
  'wollen',
  'will',
  'remember',
  'recall',
  'bitte',
  'denn',
  'mal',
]);

/** Time-related tokens for strict recall */
export const TIME_TOKENS = new Set(['heute', 'gestern', 'vorgestern', 'abend', 'morgen', 'nacht']);

/** Commitment-related tokens for strict recall scoring */
export const COMMITMENT_TOKENS = new Set([
  'will',
  'werde',
  'mache',
  'mach',
  'mochte',
  'möchte',
  'plane',
  'vor',
  'nehme',
]);
