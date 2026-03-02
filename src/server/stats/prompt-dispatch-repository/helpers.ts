import type {
  PromptDispatchEntry,
  PromptDispatchFilter,
  PromptDispatchKind,
  PromptDispatchRiskLevel,
  PromptDispatchStatus,
  PromptTokensSource,
} from './types';

export function toPositiveInt(input: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(input || '', 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return parsed;
}

function toNullableNumber(value: unknown): number | null {
  return value === null || value === undefined ? null : Number(value);
}

export function toEntry(row: Record<string, unknown>): PromptDispatchEntry {
  return {
    id: String(row.id),
    providerId: String(row.provider_id),
    modelName: String(row.model_name),
    accountId: row.account_id ? String(row.account_id) : null,
    dispatchKind: String(row.dispatch_kind) as PromptDispatchKind,
    promptTokens: Number(row.prompt_tokens),
    promptTokensSource: String(row.prompt_tokens_source) as PromptTokensSource,
    completionTokens: Number(row.completion_tokens),
    totalTokens: Number(row.total_tokens),
    status: String(row.status) as PromptDispatchStatus,
    errorMessage: row.error_message ? String(row.error_message) : null,
    riskLevel: String(row.risk_level) as PromptDispatchRiskLevel,
    riskScore: Number(row.risk_score),
    riskReasons: row.risk_reasons_json
      ? (JSON.parse(String(row.risk_reasons_json)) as string[])
      : [],
    promptPreview: String(row.prompt_preview),
    promptPayloadJson: String(row.prompt_payload_json),
    promptCostUsd: toNullableNumber(row.prompt_cost_usd),
    completionCostUsd: toNullableNumber(row.completion_cost_usd),
    totalCostUsd: toNullableNumber(row.total_cost_usd),
    createdAt: String(row.created_at),
    conversationId: row.conversation_id ? String(row.conversation_id) : null,
    turnSeq: row.turn_seq != null ? Number(row.turn_seq) : null,
    latencyMs: row.latency_ms != null ? Number(row.latency_ms) : null,
    toolCallsJson: String(row.tool_calls_json ?? '[]'),
    memoryContextJson: row.memory_context_json ? String(row.memory_context_json) : null,
  };
}

export function buildWhere(filter: PromptDispatchFilter): {
  where: string;
  params: Array<string | number>;
} {
  const conditions: string[] = [];
  const params: Array<string | number> = [];

  if (filter.from) {
    conditions.push('created_at >= ?');
    params.push(filter.from);
  }
  if (filter.to) {
    conditions.push('created_at <= ?');
    params.push(filter.to);
  }
  if (filter.before) {
    conditions.push('created_at < ?');
    params.push(filter.before);
  }
  if (filter.beforeTurnSeq != null && Number.isFinite(filter.beforeTurnSeq)) {
    conditions.push('turn_seq < ?');
    params.push(Math.floor(filter.beforeTurnSeq));
  }
  if (filter.provider) {
    conditions.push('provider_id = ?');
    params.push(filter.provider);
  }
  if (filter.model) {
    conditions.push('model_name = ?');
    params.push(filter.model);
  }
  if (filter.risk) {
    if (filter.risk === 'flagged') {
      conditions.push("risk_level IN ('medium', 'high')");
    } else {
      conditions.push('risk_level = ?');
      params.push(filter.risk);
    }
  }
  if (filter.search) {
    conditions.push(
      "(prompt_preview LIKE ? OR prompt_payload_json LIKE ? OR COALESCE(error_message, '') LIKE ?)",
    );
    const like = `%${filter.search}%`;
    params.push(like, like, like);
  }
  if (filter.conversationId) {
    conditions.push('conversation_id = ?');
    params.push(filter.conversationId);
  }

  return {
    where: conditions.length ? `WHERE ${conditions.join(' AND ')}` : '',
    params,
  };
}
