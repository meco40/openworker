export const BINARY_RECALL_QUERY_PATTERN =
  /\b(waren wir|haben wir|war das|stimmt das|did we|were we|have we)\b/i;

export const NEGATION_SIGNAL_PATTERN = /\b(nicht|kein|keine|keinen|keinem|nie|niemals|never|no)\b/i;

export const GENERIC_QUERY_TOKENS = new Set([
  'waren',
  'haben',
  'schon',
  'mal',
  'einmal',
  'zusammen',
  'wir',
  'with',
  'ever',
  'did',
  'were',
  'have',
]);

export const COUNTERPART_CACHE_TTL_MS = 5 * 60 * 1000;
