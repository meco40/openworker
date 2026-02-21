export const CODEX_BASE_URL = 'https://chatgpt.com/backend-api';
export const CODEX_RESPONSES_PATH = '/codex/responses';
export const CODEX_REQUEST_TIMEOUT_MS = 60_000;
export const OPENAI_CODEX_AUTH_CLAIM_HINT = 'chatgpt_account_id';
export const DEFAULT_CODEX_INSTRUCTIONS = 'You are a helpful coding assistant.';

export const CODEX_MODEL_SEED = [
  'gpt-5.3-codex',
  'gpt-5.2-codex',
  'gpt-5.2',
  'gpt-5.1',
  'gpt-5.1-codex',
  'gpt-5.1-codex-mini',
  'gpt-5.1-codex-max',
] as const;
