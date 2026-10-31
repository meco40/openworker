//! Contract types for slice S4 (Model Hub).
//!
//! Three TypeScript sources are mirrored here, and they are re-exported through
//! each other, which is why one file covers all of them:
//!
//! - `src/shared/contracts/modelHub.ts` — the browser-safe catalog contract
//!   (`ProviderCatalogEntry`, `RateLimitWindow`, `RateLimitSnapshot`,
//!   `FetchedModel`) plus `ProviderAuthMethod`, `ProviderEndpointType` and
//!   `ProviderCapability`.
//! - `src/server/model-hub/Models/types.ts` — the gateway wire types
//!   (`GatewayRequest`, `GatewayResponse`, `GatewayMessage`, ...).
//! - `src/server/model-hub/repository.ts` — the persistence shapes
//!   (`ProviderAccountView`, `ProviderAccountRecord`, `PipelineModelEntry`,
//!   `PipelineReasoningEffort`).
//!
//! Field names and optionality are copied exactly, so `serde` can round-trip the
//! payloads the app/api routes exchange. The three contracts mix naming styles on
//! purpose — `GatewayRequest` keeps `max_tokens`/`temperature`/`reasoning_effort`
//! in snake_case while `systemInstruction`/`responseMimeType` are camelCase — so
//! every non-idiomatic name carries an explicit `rename` instead of a blanket
//! `rename_all`.
//!
//! `lastCheckMessage` is `string | null | undefined` in TypeScript, which is three
//! states; the Rust field is `Option<String>` and `None` serialises as `null`.

use serde::{Deserialize, Serialize};
use serde_json::Value;

use super::crypto::EncryptedSecretPayload;

// ─── src/shared/contracts/modelHub.ts ───────────────────────────────────────

/// `ProviderAuthMethod` from `contracts/modelHub.ts:1`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ProviderAuthMethod {
    None,
    ApiKey,
    Oauth,
}

impl ProviderAuthMethod {
    pub fn as_str(self) -> &'static str {
        match self {
            ProviderAuthMethod::None => "none",
            ProviderAuthMethod::ApiKey => "api_key",
            ProviderAuthMethod::Oauth => "oauth",
        }
    }

    /// Tolerant parse for the `auth_method` TEXT column. `CREATE TABLE` does not
    /// constrain the column, so a hand-edited database can hold anything.
    pub fn parse(value: &str) -> Option<Self> {
        match value {
            "none" => Some(ProviderAuthMethod::None),
            "api_key" => Some(ProviderAuthMethod::ApiKey),
            "oauth" => Some(ProviderAuthMethod::Oauth),
            _ => None,
        }
    }
}

/// `ProviderEndpointType` from `contracts/modelHub.ts:3-13`.
///
/// The TypeScript union lists both `'openai-compatible'` and `'openai_compatible'`
/// for the same transport. Nothing in `PROVIDER_CATALOG` uses the underscore
/// spelling — all seven OpenAI-compatible providers use the hyphen — so the
/// variant is kept for wire fidelity while [`ProviderEndpointType::parse`]
/// normalises both spellings onto the hyphen form.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum ProviderEndpointType {
    #[serde(rename = "gemini-native")]
    GeminiNative,
    #[serde(rename = "openai-compatible")]
    OpenAiCompatible,
    #[serde(rename = "openai_compatible")]
    OpenAiCompatibleUnderscore,
    #[serde(rename = "openai-native")]
    OpenAiNative,
    #[serde(rename = "anthropic-native")]
    AnthropicNative,
    #[serde(rename = "xai-native")]
    XaiNative,
    #[serde(rename = "mistral-native")]
    MistralNative,
    #[serde(rename = "cohere-native")]
    CohereNative,
    #[serde(rename = "copilot-native")]
    CopilotNative,
    #[serde(rename = "github-native")]
    GithubNative,
}

impl ProviderEndpointType {
    pub fn as_str(self) -> &'static str {
        match self {
            ProviderEndpointType::GeminiNative => "gemini-native",
            ProviderEndpointType::OpenAiCompatible => "openai-compatible",
            ProviderEndpointType::OpenAiCompatibleUnderscore => "openai_compatible",
            ProviderEndpointType::OpenAiNative => "openai-native",
            ProviderEndpointType::AnthropicNative => "anthropic-native",
            ProviderEndpointType::XaiNative => "xai-native",
            ProviderEndpointType::MistralNative => "mistral-native",
            ProviderEndpointType::CohereNative => "cohere-native",
            ProviderEndpointType::CopilotNative => "copilot-native",
            ProviderEndpointType::GithubNative => "github-native",
        }
    }

    /// Accepts both spellings of the OpenAI-compatible transport.
    pub fn parse(value: &str) -> Option<Self> {
        match value {
            "gemini-native" => Some(ProviderEndpointType::GeminiNative),
            "openai-compatible" | "openai_compatible" => {
                Some(ProviderEndpointType::OpenAiCompatible)
            }
            "openai-native" => Some(ProviderEndpointType::OpenAiNative),
            "anthropic-native" => Some(ProviderEndpointType::AnthropicNative),
            "xai-native" => Some(ProviderEndpointType::XaiNative),
            "mistral-native" => Some(ProviderEndpointType::MistralNative),
            "cohere-native" => Some(ProviderEndpointType::CohereNative),
            "copilot-native" => Some(ProviderEndpointType::CopilotNative),
            "github-native" => Some(ProviderEndpointType::GithubNative),
            _ => None,
        }
    }

    /// `true` only for the hyphen spelling, i.e. what `PROVIDER_CATALOG` stores.
    pub fn is_canonical_openai_compatible(self) -> bool {
        self == ProviderEndpointType::OpenAiCompatible
    }
}

/// `ProviderCapability` from `contracts/modelHub.ts:15-21`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ProviderCapability {
    Chat,
    Tools,
    Vision,
    Audio,
    Embeddings,
    CodePairing,
}

impl ProviderCapability {
    pub fn as_str(self) -> &'static str {
        match self {
            ProviderCapability::Chat => "chat",
            ProviderCapability::Tools => "tools",
            ProviderCapability::Vision => "vision",
            ProviderCapability::Audio => "audio",
            ProviderCapability::Embeddings => "embeddings",
            ProviderCapability::CodePairing => "code_pairing",
        }
    }
}

/// `ProviderCatalogEntry` from `contracts/modelHub.ts:23-34`.
///
/// `oauthConfigured`, `apiBaseUrl` and `docsUrl` are optional in TypeScript and are
/// omitted from the JSON when absent, matching `JSON.stringify` of the literal in
/// `providerCatalog.ts`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderCatalogEntry {
    pub id: String,
    pub name: String,
    pub icon: String,
    pub auth_methods: Vec<ProviderAuthMethod>,
    pub endpoint_type: ProviderEndpointType,
    pub capabilities: Vec<ProviderCapability>,
    pub default_models: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub oauth_configured: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub api_base_url: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub docs_url: Option<String>,
}

impl ProviderCatalogEntry {
    /// `PROVIDER_CATALOG.find((provider) => provider.id === providerId)` — the
    /// first match wins, and the catalog has no duplicate ids.
    pub fn has_auth_method(&self, method: ProviderAuthMethod) -> bool {
        self.auth_methods.contains(&method)
    }
}

/// `RateLimitWindow` from `contracts/modelHub.ts:36-43`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct RateLimitWindow {
    pub window: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub limit: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub remaining: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub used_percent: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub remaining_percent: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reset: Option<String>,
}

/// `RateLimitSnapshot` from `contracts/modelHub.ts:45-47`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Default)]
pub struct RateLimitSnapshot {
    pub windows: Vec<RateLimitWindow>,
}

/// Billing tag of `FetchedModel` (`contracts/modelHub.ts:56`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ModelBilling {
    Free,
    Paid,
}

/// `FetchedModel` from `contracts/modelHub.ts:49-57`.
///
/// The optional keys are snake_case in the contract (`owned_by`, `context_window`)
/// even though the surrounding app prefers camelCase.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct FetchedModel {
    pub id: String,
    pub name: String,
    pub provider: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub owned_by: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub context_window: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub created: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub billing: Option<ModelBilling>,
}

// ─── src/server/model-hub/Models/types.ts ──────────────────────────────────

/// `ConnectivityResult` from `Models/types.ts:6-10`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnectivityResult {
    pub ok: bool,
    pub message: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub rate_limits: Option<RateLimitSnapshot>,
}

impl ConnectivityResult {
    pub fn ok(message: impl Into<String>) -> Self {
        Self {
            ok: true,
            message: message.into(),
            rate_limits: None,
        }
    }

    pub fn failed(message: impl Into<String>) -> Self {
        Self {
            ok: false,
            message: message.into(),
            rate_limits: None,
        }
    }
}

/// `GatewayMessage['role']` from `Models/types.ts:13`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum GatewayRole {
    System,
    User,
    Assistant,
}

impl GatewayRole {
    pub fn as_str(self) -> &'static str {
        match self {
            GatewayRole::System => "system",
            GatewayRole::User => "user",
            GatewayRole::Assistant => "assistant",
        }
    }
}

/// `GatewayMessageAttachment` from `Models/types.ts:18-24`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GatewayMessageAttachment {
    pub name: String,
    pub mime_type: String,
    pub size: i64,
    pub storage_path: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sha256: Option<String>,
}

/// `GatewayMessage` from `Models/types.ts:12-16`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GatewayMessage {
    pub role: GatewayRole,
    pub content: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub attachments: Option<Vec<GatewayMessageAttachment>>,
}

impl GatewayMessage {
    pub fn new(role: GatewayRole, content: impl Into<String>) -> Self {
        Self {
            role,
            content: content.into(),
            attachments: None,
        }
    }

    pub fn user(content: impl Into<String>) -> Self {
        Self::new(GatewayRole::User, content)
    }

    /// `message.attachments || []` from `request/build.ts:52`.
    pub fn attachments(&self) -> &[GatewayMessageAttachment] {
        self.attachments.as_deref().unwrap_or(&[])
    }
}

/// `GatewayAuditKind` from `Models/types.ts:26-34`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum GatewayAuditKind {
    #[serde(rename = "chat")]
    Chat,
    #[serde(rename = "summary")]
    Summary,
    #[serde(rename = "worker_planner")]
    WorkerPlanner,
    #[serde(rename = "worker_executor")]
    WorkerExecutor,
    #[serde(rename = "api_gateway")]
    ApiGateway,
    #[serde(rename = "orchestra_routing")]
    OrchestraRouting,
    #[serde(rename = "room")]
    Room,
    #[serde(rename = "knowledge-extraction")]
    KnowledgeExtraction,
}

impl GatewayAuditKind {
    pub fn as_str(self) -> &'static str {
        match self {
            GatewayAuditKind::Chat => "chat",
            GatewayAuditKind::Summary => "summary",
            GatewayAuditKind::WorkerPlanner => "worker_planner",
            GatewayAuditKind::WorkerExecutor => "worker_executor",
            GatewayAuditKind::ApiGateway => "api_gateway",
            GatewayAuditKind::OrchestraRouting => "orchestra_routing",
            GatewayAuditKind::Room => "room",
            GatewayAuditKind::KnowledgeExtraction => "knowledge-extraction",
        }
    }
}

/// `GatewayAuditContext` from `Models/types.ts:36-46`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GatewayAuditContext {
    pub kind: GatewayAuditKind,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub conversation_id: Option<String>,
    /// Sequence number of the user message that triggered this dispatch.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub turn_seq: Option<i64>,
    /// Fused recall context injected this turn — stored truncated (500 chars max).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub memory_context: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub task_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub step_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub node_id: Option<String>,
}

/// `GatewayRequest['reasoning_effort']` from `Models/types.ts:53`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum GatewayReasoningEffort {
    None,
    Low,
    Medium,
    High,
}

impl GatewayReasoningEffort {
    pub fn as_str(self) -> &'static str {
        match self {
            GatewayReasoningEffort::None => "none",
            GatewayReasoningEffort::Low => "low",
            GatewayReasoningEffort::Medium => "medium",
            GatewayReasoningEffort::High => "high",
        }
    }
}

/// `GatewayRequest` from `Models/types.ts:48-61`.
///
/// `tools` is `unknown[]` and `responseFormat` is `unknown`, so both stay
/// `serde_json::Value`. The TypeScript object is never serialised as-is — the
/// provider adapters build their own wire body from it — but the app/api routes
/// receive it as JSON, so the field names are pinned here.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct GatewayRequest {
    pub model: String,
    pub messages: Vec<GatewayMessage>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub max_tokens: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub temperature: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reasoning_effort: Option<GatewayReasoningEffort>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub stream: Option<bool>,
    #[serde(
        default,
        rename = "systemInstruction",
        skip_serializing_if = "Option::is_none"
    )]
    pub system_instruction: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tools: Option<Vec<Value>>,
    #[serde(
        default,
        rename = "responseMimeType",
        skip_serializing_if = "Option::is_none"
    )]
    pub response_mime_type: Option<String>,
    /// Provider-native structured output format, when the caller supplies one.
    #[serde(
        default,
        rename = "responseFormat",
        skip_serializing_if = "Option::is_none"
    )]
    pub response_format: Option<Value>,
    #[serde(
        default,
        rename = "auditContext",
        skip_serializing_if = "Option::is_none"
    )]
    pub audit_context: Option<GatewayAuditContext>,
}

impl GatewayRequest {
    pub fn new(model: impl Into<String>, messages: Vec<GatewayMessage>) -> Self {
        Self {
            model: model.into(),
            messages,
            max_tokens: None,
            temperature: None,
            reasoning_effort: None,
            stream: None,
            system_instruction: None,
            tools: None,
            response_mime_type: None,
            response_format: None,
            audit_context: None,
        }
    }
}

/// `GatewayResponse['usage']` from `Models/types.ts:68-72`. The three keys are
/// snake_case in TypeScript and stay that way.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
pub struct GatewayUsage {
    pub prompt_tokens: i64,
    pub completion_tokens: i64,
    pub total_tokens: i64,
}

/// `GatewayResponse['functionCalls']` element from `Models/types.ts:73`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct GatewayFunctionCall {
    pub name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub args: Option<Value>,
}

/// `GatewayResponse` from `Models/types.ts:63-76`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GatewayResponse {
    pub ok: bool,
    pub text: String,
    pub model: String,
    pub provider: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub usage: Option<GatewayUsage>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub function_calls: Option<Vec<GatewayFunctionCall>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub rate_limits: Option<RateLimitSnapshot>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

impl GatewayResponse {
    pub fn success(
        text: impl Into<String>,
        model: impl Into<String>,
        provider: impl Into<String>,
    ) -> Self {
        Self {
            ok: true,
            text: text.into(),
            model: model.into(),
            provider: provider.into(),
            usage: None,
            function_calls: None,
            rate_limits: None,
            error: None,
        }
    }

    pub fn failure(
        model: impl Into<String>,
        provider: impl Into<String>,
        error: impl Into<String>,
    ) -> Self {
        Self {
            ok: false,
            text: String::new(),
            model: model.into(),
            provider: provider.into(),
            usage: None,
            function_calls: None,
            rate_limits: None,
            error: Some(error.into()),
        }
    }
}

/// `ProviderExecutionContext` from `Models/types.ts:78-82`.
#[derive(Debug, Clone, PartialEq)]
pub struct ProviderExecutionContext {
    pub provider: ProviderCatalogEntry,
    pub account: ProviderAccountRecord,
    pub secret: String,
}

// ─── src/server/model-hub/repository.ts ────────────────────────────────────

/// Serialisable mirror of `EncryptedSecretPayload` from `crypto.ts:3`.
///
/// `crypto.rs` already exists with verified Node vectors and must not change, and
/// `EncryptedSecretPayload` deliberately carries no `serde` derives. The
/// repository stores the payload with `JSON.stringify` and reads it back with
/// `JSON.parse`, so this mirror reproduces the exact key order of the TypeScript
/// object literal: `alg`, `keyId`, `iv`, `ciphertext`, `tag`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct EncryptedSecretPayloadJson {
    pub alg: String,
    #[serde(rename = "keyId")]
    pub key_id: String,
    pub iv: String,
    pub ciphertext: String,
    pub tag: String,
}

impl EncryptedSecretPayloadJson {
    /// `JSON.stringify(payload)` in `sqliteModelHubRepository.ts:160`.
    pub fn from_payload(payload: &EncryptedSecretPayload) -> Self {
        Self {
            alg: payload.alg.clone(),
            key_id: payload.key_id.clone(),
            iv: payload.iv.clone(),
            ciphertext: payload.ciphertext.clone(),
            tag: payload.tag.clone(),
        }
    }

    /// `JSON.parse(row.encrypted_secret)` in `sqliteModelHubRepository.ts:191`.
    pub fn to_payload(&self) -> EncryptedSecretPayload {
        EncryptedSecretPayload {
            alg: self.alg.clone(),
            key_id: self.key_id.clone(),
            iv: self.iv.clone(),
            ciphertext: self.ciphertext.clone(),
            tag: self.tag.clone(),
        }
    }
}

/// `ProviderAccountView` from `repository.ts:12-24`.
///
/// `lastCheckMessage` is declared `string | null | undefined`; `Option<String>`
/// covers both, and `skip_serializing_if` keeps `undefined` and `null`
/// indistinguishable, exactly as the TypeScript column is.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderAccountView {
    pub id: String,
    pub provider_id: String,
    pub label: String,
    pub auth_method: ProviderAuthMethod,
    pub secret_masked: String,
    pub has_refresh_token: bool,
    pub created_at: String,
    pub updated_at: String,
    pub last_check_at: Option<String>,
    pub last_check_ok: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_check_message: Option<String>,
}

/// `ProviderAccountRecord` from `repository.ts:26-28`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderAccountRecord {
    pub id: String,
    pub provider_id: String,
    pub label: String,
    pub auth_method: ProviderAuthMethod,
    pub secret_masked: String,
    pub has_refresh_token: bool,
    pub created_at: String,
    pub updated_at: String,
    pub last_check_at: Option<String>,
    pub last_check_ok: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_check_message: Option<String>,
    pub encrypted_secret: EncryptedSecretPayloadJson,
    pub encrypted_refresh_token: Option<EncryptedSecretPayloadJson>,
}

impl ProviderAccountRecord {
    /// `toView(row)` spread into a record — the view half is a field-for-field
    /// copy of the same row (`sqliteModelHubRepository.ts:188-196`).
    pub fn view(&self) -> ProviderAccountView {
        ProviderAccountView {
            id: self.id.clone(),
            provider_id: self.provider_id.clone(),
            label: self.label.clone(),
            auth_method: self.auth_method,
            secret_masked: self.secret_masked.clone(),
            has_refresh_token: self.has_refresh_token,
            created_at: self.created_at.clone(),
            updated_at: self.updated_at.clone(),
            last_check_at: self.last_check_at.clone(),
            last_check_ok: self.last_check_ok,
            last_check_message: self.last_check_message.clone(),
        }
    }

    pub fn encrypted_secret_payload(&self) -> EncryptedSecretPayload {
        self.encrypted_secret.to_payload()
    }
}

/// `CreateProviderAccountInput` from `repository.ts:3-10`.
#[derive(Debug, Clone, PartialEq)]
pub struct CreateProviderAccountInput {
    pub provider_id: String,
    pub label: String,
    pub auth_method: ProviderAuthMethod,
    pub encrypted_secret: EncryptedSecretPayloadJson,
    pub encrypted_refresh_token: Option<EncryptedSecretPayloadJson>,
    pub secret_masked: String,
}

/// `updateAccountCredentials` argument from `repository.ts:59-64`.
#[derive(Debug, Clone, PartialEq)]
pub struct UpdateAccountCredentialsInput {
    pub id: String,
    pub encrypted_secret: EncryptedSecretPayloadJson,
    pub encrypted_refresh_token: Option<EncryptedSecretPayloadJson>,
    pub secret_masked: String,
}

/// `PipelineModelEntry['status']` from `repository.ts:39`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum PipelineStatus {
    Active,
    RateLimited,
    Offline,
}

impl PipelineStatus {
    pub fn as_str(self) -> &'static str {
        match self {
            PipelineStatus::Active => "active",
            PipelineStatus::RateLimited => "rate-limited",
            PipelineStatus::Offline => "offline",
        }
    }

    /// The `status` column is unconstrained TEXT, so an unknown value is kept
    /// verbatim instead of being dropped. `dispatchWithFallback` compares with
    /// `=== 'active'`, so an unknown value behaves like a non-active entry in
    /// TypeScript as well.
    pub fn parse(value: &str) -> Option<Self> {
        match value {
            "active" => Some(PipelineStatus::Active),
            "rate-limited" => Some(PipelineStatus::RateLimited),
            "offline" => Some(PipelineStatus::Offline),
            _ => None,
        }
    }
}

/// `PipelineReasoningEffort` from `repository.ts:44`.
///
/// The union is closed in TypeScript, but the column is plain TEXT and
/// `toPipelineEntry` copies it without validation, so [`PipelineReasoningEffort::Other`]
/// keeps unknown values intact for the round-trip.
///
/// `Serialize`/`Deserialize` are hand-written because the wire form is the bare
/// string. A derived enum is externally tagged, which would put
/// `{"other":"turbo"}` into `PipelineModelEntry.reasoning_effort` — but the
/// TypeScript route hands the raw TEXT column straight to the client.
/// Deserializing therefore runs [`PipelineReasoningEffort::parse`], which is
/// what `toPipelineEntry` effectively does on the way out of the database.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PipelineReasoningEffort {
    Off,
    Minimal,
    Low,
    Medium,
    High,
    Xhigh,
    /// A value present in the column but outside the TypeScript union.
    Other(String),
}

impl Serialize for PipelineReasoningEffort {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: serde::Serializer,
    {
        serializer.serialize_str(self.as_str())
    }
}

impl<'de> Deserialize<'de> for PipelineReasoningEffort {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: serde::Deserializer<'de>,
    {
        let raw = String::deserialize(deserializer)?;
        Ok(PipelineReasoningEffort::parse(&raw))
    }
}

impl PipelineReasoningEffort {
    pub fn as_str(&self) -> &str {
        match self {
            PipelineReasoningEffort::Off => "off",
            PipelineReasoningEffort::Minimal => "minimal",
            PipelineReasoningEffort::Low => "low",
            PipelineReasoningEffort::Medium => "medium",
            PipelineReasoningEffort::High => "high",
            PipelineReasoningEffort::Xhigh => "xhigh",
            PipelineReasoningEffort::Other(raw) => raw.as_str(),
        }
    }

    pub fn parse(value: &str) -> Self {
        match value {
            "off" => PipelineReasoningEffort::Off,
            "minimal" => PipelineReasoningEffort::Minimal,
            "low" => PipelineReasoningEffort::Low,
            "medium" => PipelineReasoningEffort::Medium,
            "high" => PipelineReasoningEffort::High,
            "xhigh" => PipelineReasoningEffort::Xhigh,
            other => PipelineReasoningEffort::Other(other.to_string()),
        }
    }
}

/// `PipelineModelEntry` from `repository.ts:31-42`.
///
/// `reasoningEffort` is `row.reasoning_effort ?? undefined` in
/// `sqliteModelHubRepository.ts:70`, so a NULL column becomes an absent key.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PipelineModelEntry {
    pub id: String,
    pub profile_id: String,
    pub account_id: String,
    pub provider_id: String,
    pub model_name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reasoning_effort: Option<PipelineReasoningEffort>,
    pub priority: i64,
    pub status: PipelineStatus,
    pub created_at: String,
    pub updated_at: String,
}

/// `CreatePipelineModelInput` from `repository.ts:46-53`.
#[derive(Debug, Clone, PartialEq)]
pub struct CreatePipelineModelInput {
    pub profile_id: String,
    pub account_id: String,
    pub provider_id: String,
    pub model_name: String,
    pub reasoning_effort: Option<PipelineReasoningEffort>,
    pub priority: i64,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn provider_endpoint_type_accepts_both_spellings() {
        assert_eq!(
            ProviderEndpointType::parse("openai_compatible"),
            Some(ProviderEndpointType::OpenAiCompatible)
        );
        assert_eq!(
            ProviderEndpointType::parse("openai-compatible"),
            Some(ProviderEndpointType::OpenAiCompatible)
        );
        assert_eq!(
            ProviderEndpointType::OpenAiCompatibleUnderscore.as_str(),
            "openai_compatible"
        );
    }

    /// The TS union uses `'knowledge-extraction'` while its six siblings use
    /// snake_case; the rename must survive a round-trip.
    #[test]
    fn audit_kind_uses_the_typescript_literals() {
        for (kind, expected) in [
            (GatewayAuditKind::Chat, "chat"),
            (GatewayAuditKind::WorkerPlanner, "worker_planner"),
            (GatewayAuditKind::ApiGateway, "api_gateway"),
            (GatewayAuditKind::OrchestraRouting, "orchestra_routing"),
            (
                GatewayAuditKind::KnowledgeExtraction,
                "knowledge-extraction",
            ),
        ] {
            assert_eq!(kind.as_str(), expected);
            assert_eq!(
                serde_json::to_value(kind).expect("serialize"),
                serde_json::Value::String(expected.to_string())
            );
        }
    }

    /// `GatewayRequest` mixes snake_case and camelCase; a blanket `rename_all`
    /// would silently rename `max_tokens`.
    #[test]
    fn gateway_request_field_names_match_the_wire_format() {
        let request = GatewayRequest {
            system_instruction: Some("sys".to_string()),
            response_mime_type: Some("application/json".to_string()),
            response_format: Some(serde_json::json!({ "type": "json_object" })),
            audit_context: Some(GatewayAuditContext {
                kind: GatewayAuditKind::Chat,
                conversation_id: Some("c1".to_string()),
                turn_seq: Some(3),
                memory_context: None,
                task_id: None,
                step_id: None,
                node_id: None,
            }),
            ..GatewayRequest::new("gpt-4.1", vec![GatewayMessage::user("hi")])
        };
        let value = serde_json::to_value(&request).expect("serialize");

        assert_eq!(value["max_tokens"], serde_json::Value::Null);
        assert!(value.get("max_tokens").is_none());
        assert_eq!(value["systemInstruction"], "sys");
        assert_eq!(value["responseMimeType"], "application/json");
        assert_eq!(value["responseFormat"]["type"], "json_object");
        assert_eq!(value["auditContext"]["kind"], "chat");
        assert_eq!(value["auditContext"]["conversationId"], "c1");
        assert_eq!(value["auditContext"]["turnSeq"], 3);
        assert_eq!(value["messages"][0]["role"], "user");
    }

    /// `JSON.stringify` of `EncryptedSecretPayload` uses the literal key order
    /// `alg`, `keyId`, `iv`, `ciphertext`, `tag`.
    #[test]
    fn encrypted_secret_json_uses_the_typescript_key_order() {
        let payload = EncryptedSecretPayload {
            alg: "aes-256-gcm".to_string(),
            key_id: "default".to_string(),
            iv: "iv".to_string(),
            ciphertext: "cipher".to_string(),
            tag: "tag".to_string(),
        };
        let json = serde_json::to_string(&EncryptedSecretPayloadJson::from_payload(&payload))
            .expect("serialize");
        assert_eq!(
            json,
            r#"{"alg":"aes-256-gcm","keyId":"default","iv":"iv","ciphertext":"cipher","tag":"tag"}"#
        );

        let parsed: EncryptedSecretPayloadJson = serde_json::from_str(&json).expect("parse");
        assert_eq!(parsed.to_payload(), payload);
    }

    #[test]
    fn pipeline_reasoning_effort_round_trips_unknown_values() {
        assert_eq!(
            PipelineReasoningEffort::parse("xhigh"),
            PipelineReasoningEffort::Xhigh
        );
        let unknown = PipelineReasoningEffort::parse("turbo");
        assert_eq!(unknown.as_str(), "turbo");
        // The wire form is the bare string, not `{"other":"turbo"}`.
        assert_eq!(
            serde_json::to_value(&unknown).expect("serialize"),
            serde_json::Value::String("turbo".to_string())
        );
        assert_eq!(
            serde_json::from_value::<PipelineReasoningEffort>(serde_json::Value::String(
                "turbo".to_string()
            ))
            .expect("deserialize"),
            unknown
        );
    }

    /// The closed union values serialise to their spellings and parse back into
    /// the same variant, so `Other` is only ever reached from outside it.
    #[test]
    fn pipeline_reasoning_effort_uses_the_typescript_spellings() {
        for (effort, expected) in [
            (PipelineReasoningEffort::Off, "off"),
            (PipelineReasoningEffort::Minimal, "minimal"),
            (PipelineReasoningEffort::Low, "low"),
            (PipelineReasoningEffort::Medium, "medium"),
            (PipelineReasoningEffort::High, "high"),
            (PipelineReasoningEffort::Xhigh, "xhigh"),
        ] {
            assert_eq!(effort.as_str(), expected);
            assert_eq!(
                serde_json::to_value(&effort).expect("serialize"),
                serde_json::Value::String(expected.to_string())
            );
            assert_eq!(PipelineReasoningEffort::parse(expected), effort);
        }
    }

    #[test]
    fn fetched_model_keeps_snake_case_optional_keys() {
        let model = FetchedModel {
            id: "m".to_string(),
            name: "m".to_string(),
            provider: "openai".to_string(),
            owned_by: Some("openai".to_string()),
            context_window: Some(128_000.0),
            created: None,
            billing: Some(ModelBilling::Free),
        };
        let value = serde_json::to_value(&model).expect("serialize");
        assert_eq!(value["owned_by"], "openai");
        assert_eq!(value["context_window"], 128_000.0);
        assert_eq!(value["billing"], "free");
        assert!(value.get("created").is_none());
    }
}
