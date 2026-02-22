import { extractCodexAccountId } from '@/server/model-hub/codexAuth';
import { CODEX_BASE_URL, CODEX_RESPONSES_PATH, OPENAI_CODEX_AUTH_CLAIM_HINT } from '../constants';
import type { CodexReasoningEffort } from '../types';

export function resolveCodexProbeModel(
  preferredModel: string | undefined,
  defaultModels: string[],
): string {
  const normalizedPreferred = preferredModel?.trim();
  if (normalizedPreferred) return normalizedPreferred;
  const normalizedDefault = defaultModels.find((model) => model.trim().length > 0)?.trim();
  if (normalizedDefault) return normalizedDefault;
  return 'gpt-5.3-codex';
}

export function resolveCodexEndpoint(baseUrl = CODEX_BASE_URL): string {
  const normalized = (baseUrl || CODEX_BASE_URL).trim().replace(/\/+$/, '');
  if (normalized.endsWith('/codex/responses')) return normalized;
  if (normalized.endsWith('/codex')) return `${normalized}/responses`;
  return `${normalized}${CODEX_RESPONSES_PATH}`;
}

export function buildCodexHeaders(secret: string): Record<string, string> {
  const accountId = extractCodexAccountId(secret);
  if (!accountId) {
    throw new Error(
      `OpenAI Codex access token is missing ${OPENAI_CODEX_AUTH_CLAIM_HINT} in JWT claims.`,
    );
  }

  return {
    Authorization: `Bearer ${secret}`,
    'chatgpt-account-id': accountId,
    'OpenAI-Beta': 'responses=experimental',
    originator: 'pi',
    Accept: 'text/event-stream',
    'Content-Type': 'application/json',
    'User-Agent': 'clawtest-model-hub',
  };
}

export function clampCodexReasoningEffort(
  modelId: string,
  effort: CodexReasoningEffort,
): CodexReasoningEffort {
  const normalizedModelId = modelId.trim().toLowerCase();
  if (
    (normalizedModelId.startsWith('gpt-5.2') || normalizedModelId.startsWith('gpt-5.3')) &&
    effort === 'minimal'
  ) {
    return 'low';
  }
  if (normalizedModelId === 'gpt-5.1' && effort === 'xhigh') {
    return 'high';
  }
  if (normalizedModelId === 'gpt-5.1-codex-mini') {
    if (effort === 'high' || effort === 'xhigh') return 'high';
    if (effort === 'minimal') return 'medium';
  }
  return effort;
}
