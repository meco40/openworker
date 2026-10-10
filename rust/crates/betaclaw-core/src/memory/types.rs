//! Types of the memory store: the domain node, the provider contract and the
//! storage-facing value objects.
//!
//! | TypeScript                                        | Rust                                  |
//! | ------------------------------------------------- | ------------------------------------- |
//! | `src/core/memory/types.ts`                         | [`MemoryType`], [`MemoryNode`]         |
//! | `src/server/memory/types.ts`                       | [`MemorySubject`], [`MemoryFeedbackSignal`], [`MemoryRecallMatch`], [`MemoryRecallResult`], [`MemoryHistoryRecord`] |
//! | `src/server/memory/mem0/types.ts`                  | [`MemoryProviderKind`], [`Mem0Scope`], [`Mem0MemoryInput`], [`Mem0SearchInput`], [`Mem0ListInput`], [`Mem0MemoryRecord`], [`Mem0SearchHit`], [`Mem0ListMemoryResult`], [`Mem0HistoryEntry`] |
//! | `src/server/memory/repository.ts`                  | [`MemoryListPageInput`], [`MemoryListPageResult`] |
//! | `src/server/memory/sqliteMemoryRepository.ts`      | [`MemoryNodeWithScope`], [`MemoryStorageSnapshot`] |
//!
//! # The metadata bag
//!
//! `MemoryNode.metadata` is `Record<string, unknown>` in TypeScript, and the
//! port keeps it open for exactly that reason: the memory service merges caller
//! metadata, poisoning flags, lifecycle status, version counters and provider
//! stamps into the same bag, and the postgres provider (S6) round-trips a fully
//! free-form object. The known keys are read through
//! [`metadata_text`], [`metadata_number`], [`metadata_flag`] and
//! [`metadata_value`], which reproduce the JavaScript coercions
//! (`String(x || '')`, `Number(x)`, `x === true`) rather than rejecting an
//! unexpected shape.
//!
//! `embedding` is a plain `Vec<f64>`: every ported producer writes `[]`, so the
//! TypeScript `embedding?: number[]` optionality collapses into an empty vector
//! without losing information.

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

/// `LEGACY_LOCAL_USER_ID` from `src/server/auth/constants.ts:1`.
///
/// Same rule as `crate::messages_store::types::LEGACY_LOCAL_USER_ID`: the value
/// belongs to the SQLite schema default and to `resolveUserId`, so it is
/// duplicated instead of importing the `auth` constant that carries a different
/// string.
pub const LEGACY_LOCAL_USER_ID: &str = "legacy-local-user";

/// The free-form metadata bag of a [`MemoryNode`].
pub type MemoryMetadata = Map<String, Value>;

/// `MemoryType` from `src/core/memory/types.ts:1-7`.
///
/// Hand-written `as_str`/`parse` rather than a derived `Deserialize`, because
/// the tolerant coercions live on top of it: [`as_memory_type`] falls back to
/// `fact`, and the API layer needs the closed catalogue ([`MemoryType::ALL`]).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum MemoryType {
    Fact,
    Preference,
    Avoidance,
    Lesson,
    PersonalityTrait,
    WorkflowPattern,
}

impl MemoryType {
    /// Every variant in declaration order — the order the TypeScript arrays use.
    pub const ALL: [MemoryType; 6] = [
        MemoryType::Fact,
        MemoryType::Preference,
        MemoryType::Avoidance,
        MemoryType::Lesson,
        MemoryType::PersonalityTrait,
        MemoryType::WorkflowPattern,
    ];

    pub fn as_str(self) -> &'static str {
        match self {
            MemoryType::Fact => "fact",
            MemoryType::Preference => "preference",
            MemoryType::Avoidance => "avoidance",
            MemoryType::Lesson => "lesson",
            MemoryType::PersonalityTrait => "personality_trait",
            MemoryType::WorkflowPattern => "workflow_pattern",
        }
    }

    /// `MemoryType[] includes(text)` — the membership test the API validators use.
    pub fn parse(value: &str) -> Option<Self> {
        MemoryType::ALL.into_iter().find(|kind| kind.as_str() == value)
    }
}

/// `MemoryNode` from `src/core/memory/types.ts:9-28`.
///
/// The field is `node_type`, not `type`, because `type` is a Rust keyword; the
/// JSON name stays `type` through `rename_all`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MemoryNode {
    pub id: String,
    pub node_type: MemoryType,
    pub content: String,
    #[serde(default)]
    pub embedding: Vec<f64>,
    pub importance: f64,
    pub confidence: f64,
    pub timestamp: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub metadata: Option<MemoryMetadata>,
}

impl MemoryNode {
    /// `node.metadata?.[key]`.
    pub fn metadata_value(&self, key: &str) -> Option<&Value> {
        self.metadata.as_ref().and_then(|metadata| metadata.get(key))
    }

    /// `String(node.metadata?.[key] || '')` — the coercion used for every
    /// string read of the bag in the TypeScript sources.
    pub fn metadata_text(&self, key: &str) -> String {
        js_string(self.metadata_value(key))
    }

    /// `Number(node.metadata?.[key])` — `NaN` when the key is absent or the
    /// value is not numeric, which is what `Number.isFinite` then tests.
    pub fn metadata_number(&self, key: &str) -> f64 {
        js_number(self.metadata_value(key))
    }

    /// `node.metadata?.[key] === true`.
    pub fn metadata_flag(&self, key: &str) -> bool {
        matches!(self.metadata_value(key), Some(Value::Bool(true)))
    }
}

/// `String(value)` for a JSON value, with the `|| ''` fallback the callers use.
///
/// `String(null)` and `String(undefined)` are `"null"` and `"undefined"` in
/// JavaScript, but every call site in this slice pairs the coercion with
/// `|| ''`, so the port folds the two together. A non-string JSON scalar is
/// stringified, not rejected, because `metadata.importance` is read as text in
/// more than one place.
pub fn js_string(value: Option<&Value>) -> String {
    match value {
        None | Some(Value::Null) => String::new(),
        Some(Value::String(text)) => text.clone(),
        Some(Value::Bool(flag)) => flag.to_string(),
        Some(Value::Number(number)) => number.to_string(),
        // `String({})` is `"[object Object]"` in JavaScript. No call site in
        // this slice stringifies an object, so the compact JSON form is used
        // and the divergence is documented instead of emulated.
        Some(other) => other.to_string(),
    }
}

/// `Number(value)` for a JSON value.
///
/// `Number(null)` is `0`, `Number('')` is `0`, `Number('abc')` is `NaN`, and
/// `Number({})` is `NaN`. The port reproduces those four cases because
/// `asImportance`, `asConfidence` and `asVersion` branch on `Number.isFinite`.
pub fn js_number(value: Option<&Value>) -> f64 {
    match value {
        None => f64::NAN,
        Some(Value::Null) => 0.0,
        Some(Value::Number(number)) => number.as_f64().unwrap_or(f64::NAN),
        Some(Value::Bool(flag)) => {
            if *flag {
                1.0
            } else {
                0.0
            }
        }
        Some(Value::String(text)) => {
            let trimmed = text.trim();
            if trimmed.is_empty() {
                return 0.0;
            }
            trimmed.parse::<f64>().unwrap_or(f64::NAN)
        }
        Some(_) => f64::NAN,
    }
}

/// `MemorySubject` from `src/server/memory/types.ts:27`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MemorySubject {
    User,
    Assistant,
    Conversation,
}

impl MemorySubject {
    pub fn as_str(self) -> &'static str {
        match self {
            MemorySubject::User => "user",
            MemorySubject::Assistant => "assistant",
            MemorySubject::Conversation => "conversation",
        }
    }
}

/// `MemoryFeedbackSignal` from `src/server/memory/types.ts:3`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MemoryFeedbackSignal {
    Positive,
    Negative,
}

impl MemoryFeedbackSignal {
    pub fn as_str(self) -> &'static str {
        match self {
            MemoryFeedbackSignal::Positive => "positive",
            MemoryFeedbackSignal::Negative => "negative",
        }
    }

    /// `signal === 'positive'` as used by the confidence and importance deltas.
    pub fn is_positive(self) -> bool {
        self == MemoryFeedbackSignal::Positive
    }
}

/// `MemoryRecallMatch` from `src/server/memory/types.ts:5-9`.
#[derive(Debug, Clone, PartialEq)]
pub struct MemoryRecallMatch {
    pub node: MemoryNode,
    pub similarity: f64,
    pub score: f64,
}

/// `MemoryRecallResult` from `src/server/memory/types.ts:11-14`.
#[derive(Debug, Clone, PartialEq)]
pub struct MemoryRecallResult {
    pub context: String,
    pub matches: Vec<MemoryRecallMatch>,
}

/// `MemoryHistoryRecord` from `src/server/memory/types.ts:16-25`.
#[derive(Debug, Clone, PartialEq)]
pub struct MemoryHistoryRecord {
    pub index: i64,
    pub action: String,
    pub timestamp: String,
    pub content: Option<String>,
    pub node_type: Option<MemoryType>,
    pub importance: Option<f64>,
    pub version: Option<i64>,
    pub metadata: MemoryMetadata,
}

/// `MemoryProviderKind` from `mem0/types.ts:88`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum MemoryProviderKind {
    Postgres,
    /// `client.provider ?? 'mem0'` — the default when a client does not declare
    /// itself, which is what `HttpMem0Client` does.
    #[default]
    Mem0,
    Sqlite,
}

impl MemoryProviderKind {
    pub fn as_str(self) -> &'static str {
        match self {
            MemoryProviderKind::Postgres => "postgres",
            MemoryProviderKind::Mem0 => "mem0",
            MemoryProviderKind::Sqlite => "sqlite",
        }
    }

    pub fn parse(value: &str) -> Option<Self> {
        match value {
            "postgres" => Some(MemoryProviderKind::Postgres),
            "mem0" => Some(MemoryProviderKind::Mem0),
            "sqlite" => Some(MemoryProviderKind::Sqlite),
            _ => None,
        }
    }
}

// ─── The provider contract ──────────────────────────────────────────────────

/// `Mem0Scope` from `mem0/types.ts:82-86`.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct Mem0Scope {
    pub user_id: String,
    pub persona_id: String,
    pub workspace_id: Option<String>,
}

impl Mem0Scope {
    pub fn new(user_id: impl Into<String>, persona_id: impl Into<String>) -> Self {
        Self {
            user_id: user_id.into(),
            persona_id: persona_id.into(),
            workspace_id: None,
        }
    }

    pub fn with_workspace(mut self, workspace_id: Option<impl Into<String>>) -> Self {
        self.workspace_id = workspace_id.map(Into::into);
        self
    }
}

/// `Mem0MemoryInput` from `mem0/types.ts:23-29`.
#[derive(Debug, Clone, PartialEq)]
pub struct Mem0MemoryInput {
    pub user_id: String,
    pub persona_id: String,
    pub workspace_id: Option<String>,
    pub content: String,
    pub metadata: MemoryMetadata,
}

/// `Mem0SearchInput` from `mem0/types.ts:31-39`.
#[derive(Debug, Clone, PartialEq)]
pub struct Mem0SearchInput {
    pub user_id: String,
    pub persona_id: String,
    pub workspace_id: Option<String>,
    pub query: String,
    pub limit: i64,
    pub filters: Option<MemoryMetadata>,
}

/// `Mem0ListInput` from `mem0/types.ts:41-49`.
#[derive(Debug, Clone, PartialEq)]
pub struct Mem0ListInput {
    pub user_id: String,
    pub persona_id: Option<String>,
    pub workspace_id: Option<String>,
    pub page: i64,
    pub page_size: i64,
    pub query: Option<String>,
    /// `Mem0ListInput['type']` is a plain `string`, not a `MemoryType`, and the
    /// v1 fallback compares it against `metadata.type` verbatim.
    pub node_type: Option<String>,
}

/// `Mem0MemoryRecord` from `mem0/types.ts:51-58`.
#[derive(Debug, Clone, PartialEq)]
pub struct Mem0MemoryRecord {
    pub id: String,
    pub content: String,
    pub score: Option<f64>,
    pub metadata: MemoryMetadata,
    pub created_at: Option<String>,
    pub updated_at: Option<String>,
}

/// `Mem0SearchHit` from `mem0/types.ts:60-65`.
#[derive(Debug, Clone, PartialEq)]
pub struct Mem0SearchHit {
    pub id: String,
    pub content: String,
    pub score: Option<f64>,
    pub metadata: MemoryMetadata,
}

/// `Mem0ListMemoryResult` from `mem0/types.ts:67-72`.
#[derive(Debug, Clone, PartialEq)]
pub struct Mem0ListMemoryResult {
    pub memories: Vec<Mem0MemoryRecord>,
    pub total: i64,
    pub page: i64,
    pub page_size: i64,
}

/// `Mem0HistoryEntry` from `mem0/types.ts:74-80`.
#[derive(Debug, Clone, PartialEq)]
pub struct Mem0HistoryEntry {
    pub action: String,
    pub timestamp: Option<String>,
    pub content: Option<String>,
    pub metadata: MemoryMetadata,
    pub raw: MemoryMetadata,
}

/// `{ id, created }` — the two shapes `addMemory` returns across providers.
///
/// `HttpMem0Client` returns `{ id: string | null }`, the sqlite client returns
/// `{ id: string }` and the postgres client (S6) returns `{ id, created }`.
#[derive(Debug, Clone, PartialEq)]
pub struct Mem0AddResult {
    pub id: Option<String>,
    pub created: bool,
}

impl Mem0AddResult {
    pub fn from_id(id: Option<String>) -> Self {
        Self { id, created: true }
    }

    pub fn created(id: impl Into<String>) -> Self {
        Self {
            id: Some(id.into()),
            created: true,
        }
    }

    pub fn existing(id: impl Into<String>) -> Self {
        Self {
            id: Some(id.into()),
            created: false,
        }
    }
}

/// `deleteMemoriesByFilter`'s argument, `mem0/types.ts:103-107`.
#[derive(Debug, Clone, PartialEq)]
pub struct Mem0DeleteByFilterInput {
    pub user_id: String,
    pub persona_id: String,
    pub workspace_id: Option<String>,
}

/// `countMemories`'s argument, `postgresMemoryClient.ts:632-637`.
#[derive(Debug, Clone, PartialEq, Default)]
pub struct Mem0CountInput {
    pub user_id: Option<String>,
    pub persona_id: Option<String>,
    pub workspace_id: Option<String>,
}

// ─── Repository-facing shapes ───────────────────────────────────────────────

/// `MemoryListPageInput` from `src/server/memory/repository.ts:3-8`.
#[derive(Debug, Clone, PartialEq, Default)]
pub struct MemoryListPageInput {
    pub page: i64,
    pub page_size: i64,
    pub query: Option<String>,
    pub node_type: Option<MemoryType>,
}

/// `MemoryListPageResult` from `src/server/memory/repository.ts:10-13`.
#[derive(Debug, Clone, PartialEq)]
pub struct MemoryListPageResult {
    pub nodes: Vec<MemoryNode>,
    pub total: i64,
}

/// `MemoryNodeWithScope` from `sqliteMemoryRepository.ts:23-27`.
#[derive(Debug, Clone, PartialEq)]
pub struct MemoryNodeWithScope {
    pub node: MemoryNode,
    pub user_id: String,
    pub persona_id: String,
}

/// `MemoryNodeHistoryRow` from `sqliteMemoryRepository.ts:29-34`.
#[derive(Debug, Clone, PartialEq)]
pub struct MemoryNodeHistoryRow {
    pub action: String,
    pub timestamp: String,
    pub content: String,
    pub metadata: MemoryMetadata,
}

/// `MemoryStorageSummary` from `sqliteMemoryRepository.ts:506-512`.
#[derive(Debug, Clone, Copy, PartialEq, Default)]
pub struct MemoryStorageSummary {
    pub total_nodes: i64,
    pub total_bytes: i64,
    pub content_bytes: i64,
    pub embedding_bytes: i64,
    pub metadata_bytes: i64,
}

/// `MemoryStorageByType` from `sqliteMemoryRepository.ts:514-521`.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct MemoryStorageByType {
    pub node_type: String,
    pub count: i64,
    pub total_bytes: i64,
    pub content_bytes: i64,
    pub embedding_bytes: i64,
    pub metadata_bytes: i64,
}

/// `MemoryStorageNodeSize` from `sqliteMemoryRepository.ts:523-530`.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct MemoryStorageNodeSize {
    pub id: String,
    pub node_type: String,
    pub total_bytes: i64,
    pub content_bytes: i64,
    pub embedding_bytes: i64,
    pub metadata_bytes: i64,
}

/// `MemoryStorageSnapshot` from `sqliteMemoryRepository.ts:532-536`.
#[derive(Debug, Clone, PartialEq)]
pub struct MemoryStorageSnapshot {
    pub summary: MemoryStorageSummary,
    pub by_type: Vec<MemoryStorageByType>,
    pub largest_nodes: Vec<MemoryStorageNodeSize>,
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn node() -> MemoryNode {
        MemoryNode {
            id: "n1".to_string(),
            node_type: MemoryType::Fact,
            content: "c".to_string(),
            embedding: Vec::new(),
            importance: 3.0,
            confidence: 0.3,
            timestamp: "t".to_string(),
            metadata: None,
        }
    }

    /// `metadata.importance` reaches the validators as an unconstrained JSON
    /// value, so the coercions must behave like `Number`/`String`.
    #[test]
    fn metadata_coercions_follow_javascript() {
        let mut node = node();
        node.metadata = Some(Map::from_iter([
            ("version".to_string(), json!(4)),
            ("versionText".to_string(), json!("7")),
            ("empty".to_string(), json!("")),
            ("flag".to_string(), json!(true)),
            ("nullified".to_string(), Value::Null),
        ]));

        assert_eq!(node.metadata_number("version"), 4.0);
        assert_eq!(node.metadata_number("versionText"), 7.0);
        assert!(node.metadata_number("missing").is_nan());
        assert_eq!(node.metadata_number("empty"), 0.0, "Number('') is 0");
        assert_eq!(node.metadata_number("nullified"), 0.0, "Number(null) is 0");
        assert_eq!(node.metadata_text("missing"), "");
        assert_eq!(node.metadata_text("nullified"), "");
        assert_eq!(node.metadata_text("empty"), "");
        assert!(node.metadata_flag("flag"));
        assert!(!node.metadata_flag("version"));
    }

    /// The `type` key keeps its JSON spelling while the Rust field cannot.
    #[test]
    fn the_node_serialises_with_the_typescript_field_names() {
        let encoded = serde_json::to_value(node()).expect("encode");
        assert_eq!(encoded["type"], "fact");
        assert_eq!(encoded["id"], "n1");
        assert!(encoded.get("nodeType").is_none(), "{encoded}");
    }

    #[test]
    fn an_absent_metadata_is_omitted_like_undefined() {
        let encoded = serde_json::to_string(&node()).expect("encode");
        assert!(!encoded.contains("metadata"), "{encoded}");
    }

    /// `asMemoryType` normalises, `MemoryType::parse` validates: the two
    /// coercions in `typeValidators.ts` and `api/shared.ts` are different tests.
    #[test]
    fn memory_type_has_two_distinct_coercions() {
        assert_eq!(MemoryType::parse("workflow_pattern"), Some(MemoryType::WorkflowPattern));
        assert_eq!(MemoryType::parse("nonsense"), None);
        assert_eq!(MemoryType::ALL.len(), 6);
        assert_eq!(MemoryType::PersonalityTrait.as_str(), "personality_trait");
    }

    #[test]
    fn the_default_provider_is_mem0_like_the_js_fallback() {
        assert_eq!(MemoryProviderKind::default(), MemoryProviderKind::Mem0);
        assert_eq!(
            MemoryProviderKind::parse("postgres"),
            Some(MemoryProviderKind::Postgres)
        );
        assert_eq!(MemoryProviderKind::parse("nonsense"), None);
    }
}
