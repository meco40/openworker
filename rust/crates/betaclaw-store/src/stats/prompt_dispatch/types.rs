//! Port of `src/server/stats/prompt-dispatch-repository/types.ts`.

use serde::Serialize;

string_enum!(DispatchKind {
    Chat = "chat",
    Summary = "summary",
    WorkerPlanner = "worker_planner",
    WorkerExecutor = "worker_executor",
    ApiGateway = "api_gateway",
    OrchestraRouting = "orchestra_routing",
    Room = "room",
    KnowledgeExtraction = "knowledge-extraction",
});

string_enum!(TokensSource {
    Exact = "exact",
    Estimated = "estimated",
});

string_enum!(DispatchStatus {
    Success = "success",
    Error = "error",
});

string_enum!(RiskLevel {
    Low = "low",
    Medium = "medium",
    High = "high",
});

/// The `risk` filter: one level, or the `flagged` shorthand for medium and high.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RiskFilter {
    Level(RiskLevel),
    Flagged,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PromptDispatchEntry {
    pub id: String,
    pub provider_id: String,
    pub model_name: String,
    pub account_id: Option<String>,
    pub dispatch_kind: DispatchKind,
    pub prompt_tokens: i64,
    pub prompt_tokens_source: TokensSource,
    pub completion_tokens: i64,
    pub total_tokens: i64,
    pub status: DispatchStatus,
    pub error_message: Option<String>,
    pub risk_level: RiskLevel,
    pub risk_score: i64,
    pub risk_reasons: Vec<String>,
    pub prompt_preview: String,
    pub prompt_payload_json: String,
    pub prompt_cost_usd: Option<f64>,
    pub completion_cost_usd: Option<f64>,
    pub total_cost_usd: Option<f64>,
    pub created_at: String,
    pub conversation_id: Option<String>,
    pub turn_seq: Option<i64>,
    pub latency_ms: Option<i64>,
    pub tool_calls_json: String,
    pub memory_context_json: Option<String>,
}

/// `RecordPromptDispatchInput`. `created_at` defaults to now when absent or
/// empty, `tool_calls_json` to `"[]"`.
#[derive(Debug, Clone, PartialEq)]
pub struct RecordPromptDispatchInput {
    pub provider_id: String,
    pub model_name: String,
    pub account_id: Option<String>,
    pub dispatch_kind: DispatchKind,
    pub prompt_tokens: i64,
    pub prompt_tokens_source: TokensSource,
    pub completion_tokens: i64,
    pub total_tokens: i64,
    pub status: DispatchStatus,
    pub error_message: Option<String>,
    pub risk_level: RiskLevel,
    pub risk_score: i64,
    pub risk_reasons: Vec<String>,
    pub prompt_preview: String,
    pub prompt_payload_json: String,
    pub prompt_cost_usd: Option<f64>,
    pub completion_cost_usd: Option<f64>,
    pub total_cost_usd: Option<f64>,
    pub created_at: Option<String>,
    pub conversation_id: Option<String>,
    pub turn_seq: Option<i64>,
    pub latency_ms: Option<i64>,
    pub tool_calls_json: Option<String>,
    pub memory_context_json: Option<String>,
}

/// `PromptDispatchFilter`. Empty strings count as absent, as in the TypeScript
/// truthiness checks.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct PromptDispatchFilter {
    pub from: Option<String>,
    pub to: Option<String>,
    pub search: Option<String>,
    pub provider: Option<String>,
    pub model: Option<String>,
    pub risk: Option<RiskFilter>,
    pub limit: Option<i64>,
    pub before: Option<String>,
    pub before_turn_seq: Option<i64>,
    pub conversation_id: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PromptDispatchSummary {
    pub total_entries: i64,
    pub flagged_entries: i64,
    pub prompt_tokens_total: i64,
    pub prompt_tokens_exact_count: i64,
    pub prompt_tokens_estimated_count: i64,
    pub total_cost_usd: f64,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PromptDispatchConversationSummary {
    pub conversation_id: String,
    pub turn_count: i64,
    pub total_tokens: i64,
    pub total_cost_usd: f64,
    pub last_activity: String,
    pub model_name: String,
}
