export const CODEX_BASE_URL = 'https://chatgpt.com/backend-api';
export const CODEX_RESPONSES_PATH = '/codex/responses';
export const CODEX_REQUEST_TIMEOUT_MS = 60_000;
export const OPENAI_CODEX_AUTH_CLAIM_HINT = 'chatgpt_account_id';
export const DEFAULT_CODEX_INSTRUCTIONS = 'You are a helpful coding assistant.';

/**
 * Current text/code models used as the OAuth backend fallback.
 * Keep this list limited to models that are current in OpenAI's model catalog;
 * the Codex backend does not expose a reliable public model-list endpoint.
 */
export const CODEX_MODEL_SEED = [
  'gpt-5.6',
  'gpt-5.6-sol',
  'gpt-5.6-terra',
  'gpt-5.6-luna',
  'gpt-5.5',
  'gpt-5.5-pro',
  'gpt-5.4',
  'gpt-5.4-pro',
  'gpt-5.4-mini',
  'gpt-5.4-nano',
  'gpt-5.3-codex',
  'gpt-5.2',
  'gpt-5.2-pro',
  'gpt-5.1',
  'gpt-5',
  'gpt-5-mini',
  'gpt-5-nano',
  'gpt-5-pro',
  'gpt-4.1',
  'gpt-4.1-mini',
  'gpt-4o-mini',
] as const;
