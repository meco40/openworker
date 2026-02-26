import type { AgentV2EventEnvelope } from '@/server/agent-v2/types';

export function extractCommandCompletionText(event: AgentV2EventEnvelope): string {
  const payload = (event.payload || {}) as Record<string, unknown>;
  const result =
    payload.result && typeof payload.result === 'object'
      ? (payload.result as Record<string, unknown>)
      : null;

  const fromResultMessage = String(result?.message || '').trim();
  if (fromResultMessage) return fromResultMessage;

  const fromResultContent = String(result?.content || '').trim();
  if (fromResultContent) return fromResultContent;

  const fromMessage = String(payload.message || '').trim();
  if (fromMessage) return fromMessage;

  const fromContent = String(payload.content || '').trim();
  if (fromContent) return fromContent;

  return '';
}
