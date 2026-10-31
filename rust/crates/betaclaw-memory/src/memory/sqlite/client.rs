//! Port of `src/server/memory/sqliteMemoryClient.ts` — the SQLite provider of
//! the `Mem0Client` contract.
//!
//! | TypeScript                                              | Rust |
//! | ------------------------------------------------------- | ---- |
//! | `sqliteMemoryClient.ts:17-20` (`resolveUserId`)          | [`resolve_user_id`](crate::memory::validators::resolve_user_id) |
//! | `sqliteMemoryClient.ts:22-41` (`toRecord`)               | [`to_record`] |
//! | `sqliteMemoryClient.ts:43-46` (`matchesWorkspace`)       | [`matches_workspace`] |
//! | `sqliteMemoryClient.ts:48-70` (`nodeFromInput`)          | [`node_from_input`], [`last_verified_text`] |
//! | `sqliteMemoryClient.ts:72-81` (`scoreContent`)           | [`score_content`], [`query_terms`] |
//! | `sqliteMemoryClient.ts:83-92` (class, `provider`)        | [`SqliteMemoryClient`], [`SqliteMemoryClient::new`] |
//! | `sqliteMemoryClient.ts:93-97` (`addMemory`)              | [`SqliteMemoryClient::add_memory`] |
//! | `sqliteMemoryClient.ts:99-116` (`searchMemories`)        | [`SqliteMemoryClient::search_memories`] |
//! | `sqliteMemoryClient.ts:118-171` (`listMemories`)         | [`SqliteMemoryClient::list_memories`] |
//! | `sqliteMemoryClient.ts:173-188` (`getMemory`)            | [`SqliteMemoryClient::get_memory`] |
//! | `sqliteMemoryClient.ts:190-198` (`getMemoryHistory`)     | [`SqliteMemoryClient::get_memory_history`] |
//! | `sqliteMemoryClient.ts:200-211` (`updateMemory`)         | [`SqliteMemoryClient::update_memory`] |
//! | `sqliteMemoryClient.ts:213-228` (`deleteMemory`)         | [`SqliteMemoryClient::delete_memory`] |
//! | `sqliteMemoryClient.ts:230-245` (`deleteMemoriesByFilter`)| [`SqliteMemoryClient::delete_memories_by_filter`] |
//! | `mem0/types.ts:90-108` (`Mem0Client`)                    | [`Mem0Client`] |
//! | `sqliteMemoryRepository.ts:54-55` (database path)        | [`default_memory_db_path`] (re-exported for [`super`]) |
//!
//! The client is the only place in this slice that resolves the tenant scope: the
//! repository trusts the `user_id` it is handed, the client never forwards a raw
//! caller id (see
//! [`resolve_user_id`](crate::memory::validators::resolve_user_id), the same
//! `String(userId || '').trim() || LEGACY_LOCAL_USER_ID` rule the local helper of
//! the source file implements).
//!
//! # Why the trait is synchronous
//!
//! Every method of the TypeScript `Mem0Client` returns a `Promise`, because the
//! HTTP provider awaits `fetch`. The SQLite provider only ever walks an
//! in-process database, so the port declares the trait synchronously and leaves
//! `tokio::task::spawn_blocking` to the caller; an `async` trait method without
//! an executor would not put that decision back.
//!
//! # Deviations
//!
//! 1. **Search hits lose their stamps.** `searchMemories` is declared as
//!    `Promise<Mem0SearchHit[]>` but its runtime objects are `toRecord(…)`
//!    results, i.e. they *also* carry `createdAt` and `updatedAt`.
//!    [`Mem0SearchHit`](crate::memory::types::Mem0SearchHit) has no such fields
//!    and the port keeps the declared type so the trait stays substitutable for
//!    the HTTP and postgres providers. Nothing observable is lost in this slice:
//!    [`to_memory_node_from_hit`](crate::memory::mappers::to_memory_node_from_hit)
//!    reads only `id`, `content`, `score` and `metadata`, so the recall path sees
//!    the same values as the TypeScript.
//! 2. **An unknown type filter yields an empty page.** In the persona-without-
//!    workspace branch the TypeScript hands `input.type` to SQL as `type = ?`
//!    after casting it to `MemoryType`, and an arbitrary string simply matches no
//!    row. [`MemoryListPageInput::node_type`] is a closed
//!    [`MemoryType`](crate::memory::types::MemoryType), so
//!    [`SqliteMemoryClient::list_memories`] returns
//!    `{ memories: [], total: 0, page, page_size }` for a spelling the enum does
//!    not know — the same result that statement would produce.
//! 3. **Type coercion in `nodeFromInput`.** `String(metadata.type || 'fact') as
//!    MemoryType` is an unchecked cast through which any text survives;
//!    [`as_memory_type`](crate::memory::validators::as_memory_type) trims and
//!    falls back to `fact`, so `"   "` becomes `fact` instead of the four-space
//!    string the TypeScript would store. `importance` and `confidence` are **not**
//!    rounded or clamped here, exactly like the source
//!    (`Number.isFinite(x) ? x : fallback`).
//! 4. **`||` truthiness.** The `String(x || '')`, `x || fallback` and
//!    `x === undefined` guards are reproduced with [`truthy`], which follows
//!    JavaScript for `null`, `undefined`, `""`, `0`, `false`, `NaN`, arrays and
//!    objects. A stored `metadata.lastVerified` of `0` or `false` therefore falls
//!    back to the node timestamp, like it does in the browser.
//! 5. **Collation and case folding.** `localeCompare` becomes a code-point
//!    comparison (identical for the ISO timestamps this sort sees) and
//!    `toLocaleLowerCase` becomes `str::to_lowercase` (identical except for
//!    locale-specific rules such as the Turkish dotted I). `term.length >= 2`
//!    counts UTF-16 code units in JavaScript and characters here, so a query term
//!    that is a single astral character (an emoji) is dropped by the port and
//!    kept by the browser.
//! 6. **UUIDs and stamps.** `randomUUID()` is [`uuid::Uuid::new_v4`] and
//!    `new Date().toISOString()` is [`crate::memory::utils::now_iso`] —
//!    millisecond precision, UTC.
//! 7. **Scope parameters.** The class implements `getMemoryHistory(id)` and
//!    `updateMemory(id, input)` with fewer arguments than the interface declares.
//!    Rust cannot overload, so the trait keeps the `scope` parameter and the
//!    SQLite implementation ignores it, like the source does.
//! 8. **`addMemory` returns [`Mem0AddResult`].** The TypeScript returns
//!    `{ id: string }`; the shared crate type also carries `created`, which this
//!    provider always reports as `true` (it inserts unconditionally, the
//!    idempotency key lives in the memory service).

use std::cmp::Ordering;
use std::sync::OnceLock;

use regex::Regex;
use serde_json::Value;

use crate::memory::errors::MemoryError;
use crate::memory::types::{
    js_number, js_string, Mem0AddResult, Mem0DeleteByFilterInput, Mem0HistoryEntry, Mem0ListInput,
    Mem0ListMemoryResult, Mem0MemoryInput, Mem0MemoryRecord, Mem0Scope, Mem0SearchHit,
    Mem0SearchInput, MemoryListPageInput, MemoryMetadata, MemoryNode, MemoryNodeWithScope,
    MemoryProviderKind, MemoryType,
};
use crate::memory::utils::now_iso;
use crate::memory::validators::{as_memory_type, resolve_user_id};

use super::repository::SqliteMemoryRepository;

/// Re-exported so the module tree of [`super`] can reach the database-path
/// resolver, which belongs to the constructor of the repository it opens
/// (`sqliteMemoryRepository.ts:54-55`).
pub use super::repository::default_memory_db_path;

// The `Mem0Client` contract lives in `crate::memory::types` (open point OP-15).
// It is re-exported here under its original path so existing callers and
// `crate::memory::sqlite::client` imports keep working unchanged.
pub use crate::memory::types::Mem0Client;

/// `SqliteMemoryClient` from `sqliteMemoryClient.ts:88-91`.
pub struct SqliteMemoryClient {
    repository: SqliteMemoryRepository,
}

impl SqliteMemoryClient {
    /// `new SqliteMemoryClient(repository = new SqliteMemoryRepository())`.
    pub fn new() -> Result<Self, MemoryError> {
        Ok(Self {
            repository: SqliteMemoryRepository::open_default()?,
        })
    }

    /// `new SqliteMemoryClient(repository)`.
    pub fn with_repository(repository: SqliteMemoryRepository) -> Self {
        Self { repository }
    }

    /// `new SqliteMemoryClient(new SqliteMemoryRepository(dbPath))`.
    pub fn open(db_path: &str) -> Result<Self, MemoryError> {
        Ok(Self::with_repository(SqliteMemoryRepository::open(
            db_path,
        )?))
    }

    pub fn repository(&self) -> &SqliteMemoryRepository {
        &self.repository
    }

    pub fn db_path(&self) -> &str {
        self.repository.db_path()
    }
}

/// JavaScript truthiness for a JSON value, as the `||` and `&&` guards use it.
///
/// `NaN` is falsy, `0` and `""` are falsy, and `{}`/`[]` are truthy — the last
/// two are the cases a `serde_json`-shaped test would get wrong.
fn truthy(value: Option<&Value>) -> bool {
    match value {
        None | Some(Value::Null) => false,
        Some(Value::Bool(flag)) => *flag,
        Some(Value::Number(number)) => number.as_f64().map(|value| value != 0.0).unwrap_or(false),
        Some(Value::String(text)) => !text.is_empty(),
        Some(Value::Array(_)) | Some(Value::Object(_)) => true,
    }
}

/// `String(node.metadata?.[key] || '')` — the coercion the source pairs with
/// every `||` fallback.
fn truthy_text(node: &MemoryNode, key: &str) -> String {
    let value = node.metadata_value(key);
    if truthy(value) {
        js_string(value)
    } else {
        String::new()
    }
}

/// `String(scoped.node.metadata?.lastVerified || '')` — `sqliteMemoryClient.ts:23`
/// and the search tie-breaker at `:109-111`.
fn last_verified_text(node: &MemoryNode) -> String {
    truthy_text(node, "lastVerified")
}

/// `JSON.stringify(number)` for a number the metadata bag carries.
fn json_f64(value: f64) -> Value {
    serde_json::Number::from_f64(value)
        .map(Value::Number)
        .unwrap_or(Value::Null)
}

/// `toRecord(scoped, score = null)` — `sqliteMemoryClient.ts:22-41`.
///
/// The stamped keys are inserted in the source order `type`, `importance`,
/// `confidence`, `source`, `memoryProvider`, `mem0Id`; a key that was already in
/// the bag keeps its position and takes the new value, which is what
/// `{ ...metadata, key: value }` does.
fn to_record(scoped: &MemoryNodeWithScope, score: Option<f64>) -> Mem0MemoryRecord {
    let verified = last_verified_text(&scoped.node).trim().to_string();
    let updated_at = if !verified.is_empty() {
        verified
    } else if !scoped.node.timestamp.is_empty() {
        scoped.node.timestamp.clone()
    } else {
        now_iso()
    };

    let mut metadata = scoped.node.metadata.clone().unwrap_or_default();
    metadata.insert(
        "type".to_string(),
        Value::String(scoped.node.node_type.as_str().to_string()),
    );
    metadata.insert("importance".to_string(), json_f64(scoped.node.importance));
    metadata.insert("confidence".to_string(), json_f64(scoped.node.confidence));
    metadata.insert("source".to_string(), Value::String("sqlite".to_string()));
    metadata.insert(
        "memoryProvider".to_string(),
        Value::String("sqlite".to_string()),
    );
    metadata.insert("mem0Id".to_string(), Value::String(scoped.node.id.clone()));

    Mem0MemoryRecord {
        id: scoped.node.id.clone(),
        content: scoped.node.content.clone(),
        score,
        metadata,
        created_at: Some(updated_at.clone()),
        updated_at: Some(updated_at),
    }
}

/// `matchesWorkspace(entry, workspaceId?)` — `sqliteMemoryClient.ts:43-46`.
///
/// `undefined` accepts every node; otherwise the *stored* `workspaceId` text must
/// equal the requested one, so a node without that key never matches.
fn matches_workspace(entry: &MemoryNodeWithScope, workspace_id: Option<&str>) -> bool {
    match workspace_id {
        None => true,
        Some(workspace_id) => truthy_text(&entry.node, "workspaceId") == workspace_id,
    }
}

/// `nodeFromInput(id, input)` — `sqliteMemoryClient.ts:48-70`.
fn node_from_input(id: &str, input: &Mem0MemoryInput) -> MemoryNode {
    let mut metadata = input.metadata.clone();
    let node_type = as_memory_type(metadata.get("type"));
    let raw_importance = js_number(metadata.get("importance"));
    let importance = if raw_importance.is_finite() {
        raw_importance
    } else {
        3.0
    };
    let raw_confidence = js_number(metadata.get("confidence"));
    let confidence = if raw_confidence.is_finite() {
        raw_confidence
    } else {
        0.3
    };
    let last_verified = metadata.get("lastVerified");
    let timestamp = if truthy(last_verified) {
        js_string(last_verified)
    } else {
        now_iso()
    };

    if let Some(workspace_id) = input.workspace_id.as_deref() {
        metadata.insert(
            "workspaceId".to_string(),
            Value::String(workspace_id.to_string()),
        );
    }
    metadata.insert("source".to_string(), Value::String("sqlite".to_string()));
    metadata.insert(
        "memoryProvider".to_string(),
        Value::String("sqlite".to_string()),
    );
    metadata.insert("mem0Id".to_string(), Value::String(id.to_string()));

    MemoryNode {
        id: id.to_string(),
        node_type,
        content: input.content.clone(),
        embedding: Vec::new(),
        importance,
        confidence,
        timestamp,
        metadata: Some(metadata),
    }
}

/// The terms of `query.split(/[^\p{L}\p{N}]+/u)` after the length filter.
fn query_terms(query: &str) -> Vec<String> {
    static SPLIT: OnceLock<Regex> = OnceLock::new();
    let split = SPLIT.get_or_init(|| Regex::new(r"[^\p{L}\p{N}]+").expect("static regex"));
    split
        .split(&query.to_lowercase())
        .filter(|term| term.chars().count() >= 2)
        .map(str::to_string)
        .collect()
}

/// `scoreContent(content, query)` — `sqliteMemoryClient.ts:72-81`.
///
/// The share of query terms that occur in the content: `0` when the query has no
/// term of at least two characters, otherwise `matches / terms`.
fn score_content(content: &str, query: &str) -> f64 {
    let terms = query_terms(query);
    if terms.is_empty() {
        return 0.0;
    }
    let normalized = content.to_lowercase();
    let matches = terms
        .iter()
        .filter(|term| normalized.contains(term.as_str()))
        .count();
    matches as f64 / terms.len() as f64
}

impl Mem0Client for SqliteMemoryClient {
    /// `readonly provider = 'sqlite' as const` — `sqliteMemoryClient.ts:89`.
    fn provider(&self) -> Option<MemoryProviderKind> {
        Some(MemoryProviderKind::Sqlite)
    }

    /// `addMemory(input)` — `sqliteMemoryClient.ts:93-97`.
    ///
    /// The id is a fresh UUID; the node is built from the input and inserted
    /// under the caller's persona and user, both resolved by the repository.
    fn add_memory(&self, input: &Mem0MemoryInput) -> Result<Mem0AddResult, MemoryError> {
        let id = uuid::Uuid::new_v4().to_string();
        self.repository.insert_node(
            &input.persona_id,
            &node_from_input(&id, input),
            Some(&input.user_id),
        )?;
        Ok(Mem0AddResult::created(id))
    }

    /// `searchMemories(input)` — `sqliteMemoryClient.ts:99-116`.
    ///
    /// Deterministic lexical scoring, no embeddings: the result is filtered to the
    /// user's, the persona's and (when given) the workspace's nodes, scored by
    /// [`score_content`], and sorted by score descending with the `lastVerified`
    /// text descending as the tie-breaker. The limit is clamped to `1..=200`, so a
    /// `limit` of `0` still returns the best hit.
    fn search_memories(&self, input: &Mem0SearchInput) -> Result<Vec<Mem0SearchHit>, MemoryError> {
        let resolved_user_id = resolve_user_id(Some(&input.user_id));
        let mut scored: Vec<(MemoryNodeWithScope, f64, String)> = self
            .repository
            .list_all_nodes_with_scope(Some(&resolved_user_id))?
            .into_iter()
            .filter(|entry| entry.persona_id == input.persona_id)
            .filter(|entry| matches_workspace(entry, input.workspace_id.as_deref()))
            .map(|entry| {
                let score = score_content(&entry.node.content, &input.query);
                let verified = last_verified_text(&entry.node);
                (entry, score, verified)
            })
            .filter(|(_, score, _)| *score > 0.0)
            .collect();

        // `b.score - a.score || b.lastVerified.localeCompare(a.lastVerified)`
        // with a stable sort, matching `Array.prototype.sort`.
        scored.sort_by(|left, right| {
            right
                .1
                .partial_cmp(&left.1)
                .unwrap_or(Ordering::Equal)
                .then_with(|| right.2.cmp(&left.2))
        });

        let limit = input.limit.clamp(1, 200) as usize;
        Ok(scored
            .into_iter()
            .take(limit)
            .map(|(entry, score, _)| {
                let record = to_record(&entry, Some(score));
                Mem0SearchHit {
                    id: record.id,
                    content: record.content,
                    score: record.score,
                    metadata: record.metadata,
                }
            })
            .collect())
    }

    /// `listMemories(input)` — `sqliteMemoryClient.ts:118-171`.
    ///
    /// Three branches, in the source order:
    ///
    /// 1. persona **and** workspace: every node of the user is filtered in memory,
    ///    then sliced with the clamped page bounds.
    /// 2. persona, no workspace: the repository's `listNodesPage` runs the filter
    ///    in SQL, and the *requested* page bounds are echoed back unclamped.
    /// 3. no persona: the user's nodes (workspace filtered) are sliced with the
    ///    clamped page bounds.
    fn list_memories(&self, input: &Mem0ListInput) -> Result<Mem0ListMemoryResult, MemoryError> {
        let resolved_user_id = resolve_user_id(Some(&input.user_id));

        if let Some(persona_id) = input
            .persona_id
            .as_deref()
            .filter(|persona_id| !persona_id.is_empty())
        {
            if let Some(workspace_id) = input.workspace_id.as_deref() {
                let all: Vec<MemoryNodeWithScope> = self
                    .repository
                    .list_all_nodes_with_scope(Some(&resolved_user_id))?
                    .into_iter()
                    .filter(|entry| entry.persona_id == persona_id)
                    .filter(|entry| matches_workspace(entry, Some(workspace_id)))
                    .filter(|entry| match input.node_type.as_deref() {
                        Some(node_type) if !node_type.is_empty() => {
                            entry.node.node_type.as_str() == node_type
                        }
                        _ => true,
                    })
                    .filter(|entry| match input.query.as_deref() {
                        Some(query) if !query.is_empty() => entry
                            .node
                            .content
                            .to_lowercase()
                            .contains(&query.to_lowercase()),
                        _ => true,
                    })
                    .collect();

                let page = input.page.max(1);
                let page_size = input.page_size.clamp(1, 200);
                let start = ((page - 1) * page_size) as usize;
                return Ok(Mem0ListMemoryResult {
                    memories: all
                        .iter()
                        .skip(start)
                        .take(page_size as usize)
                        .map(|entry| to_record(entry, None))
                        .collect(),
                    total: all.len() as i64,
                    page,
                    page_size,
                });
            }

            let node_type = match input.node_type.as_deref() {
                Some(node_type) if !node_type.is_empty() => match MemoryType::parse(node_type) {
                    Some(node_type) => Some(node_type),
                    None => {
                        // `type = ?` with a spelling the enum cannot express matches
                        // no row, so the page is empty with a zero total.
                        return Ok(Mem0ListMemoryResult {
                            memories: Vec::new(),
                            total: 0,
                            page: input.page,
                            page_size: input.page_size,
                        });
                    }
                },
                _ => None,
            };
            let page = self.repository.list_nodes_page(
                persona_id,
                &MemoryListPageInput {
                    page: input.page,
                    page_size: input.page_size,
                    query: input.query.clone(),
                    node_type,
                },
                Some(&resolved_user_id),
            )?;
            return Ok(Mem0ListMemoryResult {
                memories: page
                    .nodes
                    .iter()
                    .map(|node| {
                        to_record(
                            &MemoryNodeWithScope {
                                node: node.clone(),
                                user_id: resolved_user_id.clone(),
                                persona_id: persona_id.to_string(),
                            },
                            None,
                        )
                    })
                    .collect(),
                total: page.total,
                page: input.page,
                page_size: input.page_size,
            });
        }

        let all: Vec<MemoryNodeWithScope> = self
            .repository
            .list_all_nodes_with_scope(Some(&resolved_user_id))?
            .into_iter()
            .filter(|entry| matches_workspace(entry, input.workspace_id.as_deref()))
            .collect();

        let page = input.page.max(1);
        let page_size = input.page_size.clamp(1, 200);
        let start = ((page - 1) * page_size) as usize;
        Ok(Mem0ListMemoryResult {
            memories: all
                .iter()
                .skip(start)
                .take(page_size as usize)
                .map(|entry| to_record(entry, None))
                .collect(),
            total: all.len() as i64,
            page,
            page_size,
        })
    }

    /// `getMemory(id, scope?)` — `sqliteMemoryClient.ts:173-188`.
    ///
    /// A present scope turns a foreign node into `None` (`null`) instead of an
    /// error; the scope's user id runs through `resolveUserId` first, so an empty
    /// scope id matches the legacy-local nodes.
    fn get_memory(
        &self,
        id: &str,
        scope: Option<&Mem0Scope>,
    ) -> Result<Option<Mem0MemoryRecord>, MemoryError> {
        let found = self.repository.get_node_by_id(id)?;
        if let (Some(entry), Some(scope)) = (found.as_ref(), scope) {
            if entry.user_id != resolve_user_id(Some(&scope.user_id))
                || entry.persona_id != scope.persona_id
                || !matches_workspace(entry, scope.workspace_id.as_deref())
            {
                return Ok(None);
            }
        }
        Ok(found.map(|entry| to_record(&entry, None)))
    }

    /// `getMemoryHistory(id)` — `sqliteMemoryClient.ts:190-198`.
    ///
    /// The interface declares a `scope`, the implementation ignores it and so does
    /// the port. `raw` is always the empty object the source hard-codes.
    fn get_memory_history(
        &self,
        id: &str,
        _scope: Option<&Mem0Scope>,
    ) -> Result<Vec<Mem0HistoryEntry>, MemoryError> {
        Ok(self
            .repository
            .list_node_history(id)?
            .into_iter()
            .map(|entry| Mem0HistoryEntry {
                action: entry.action,
                timestamp: Some(entry.timestamp),
                content: Some(entry.content),
                metadata: entry.metadata,
                raw: MemoryMetadata::new(),
            })
            .collect())
    }

    /// `updateMemory(id, input)` — `sqliteMemoryClient.ts:200-211`.
    ///
    /// The scope is taken from `input`, not from the third parameter, exactly like
    /// the source; a mismatch is `Memory node scope mismatch.` and a missing node
    /// is `Memory node not found: <id>` before any write happens.
    fn update_memory(
        &self,
        id: &str,
        input: &Mem0MemoryInput,
        _scope: Option<&Mem0Scope>,
    ) -> Result<(), MemoryError> {
        let found = self
            .repository
            .get_node_by_id(id)?
            .ok_or_else(|| MemoryError::message(format!("Memory node not found: {id}")))?;
        if found.user_id != resolve_user_id(Some(&input.user_id))
            || found.persona_id != input.persona_id
            || !matches_workspace(&found, input.workspace_id.as_deref())
        {
            return Err(MemoryError::message("Memory node scope mismatch."));
        }
        self.repository.update_node(
            &input.persona_id,
            &node_from_input(id, input),
            Some(&input.user_id),
        )
    }

    /// `deleteMemory(id, scope?)` — `sqliteMemoryClient.ts:213-228`.
    ///
    /// Without a scope every node may be deleted; with one, a foreign node raises
    /// instead of disappearing. The delete runs on the *stored* scope, so a node
    /// inserted under the legacy id is removed even when the caller passed a
    /// blank user id.
    fn delete_memory(&self, id: &str, scope: Option<&Mem0Scope>) -> Result<(), MemoryError> {
        let found = self
            .repository
            .get_node_by_id(id)?
            .ok_or_else(|| MemoryError::message(format!("Memory node not found: {id}")))?;
        if let Some(scope) = scope {
            if found.user_id != resolve_user_id(Some(&scope.user_id))
                || found.persona_id != scope.persona_id
                || !matches_workspace(&found, scope.workspace_id.as_deref())
            {
                return Err(MemoryError::message("Memory node scope mismatch."));
            }
        }
        self.repository
            .delete_node(&found.persona_id, id, Some(&found.user_id))?;
        Ok(())
    }

    /// `deleteMemoriesByFilter(input)` — `sqliteMemoryClient.ts:230-245`.
    ///
    /// Without a workspace the whole persona is deleted in one statement and its
    /// affected-row count is returned. With a workspace the matching nodes are
    /// deleted one by one and the number of *entries* is returned.
    fn delete_memories_by_filter(
        &self,
        input: &Mem0DeleteByFilterInput,
    ) -> Result<i64, MemoryError> {
        let Some(workspace_id) = input.workspace_id.as_deref() else {
            return self
                .repository
                .delete_by_persona(&input.persona_id, Some(&input.user_id));
        };

        let entries: Vec<MemoryNodeWithScope> = self
            .repository
            .list_all_nodes_with_scope(Some(&resolve_user_id(Some(&input.user_id))))?
            .into_iter()
            .filter(|entry| entry.persona_id == input.persona_id)
            .filter(|entry| matches_workspace(entry, Some(workspace_id)))
            .collect();
        for entry in &entries {
            self.repository
                .delete_node(&entry.persona_id, &entry.node.id, Some(&entry.user_id))?;
        }
        Ok(entries.len() as i64)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn client() -> SqliteMemoryClient {
        SqliteMemoryClient::open(":memory:").expect("open the in-memory client")
    }

    fn input(content: &str) -> Mem0MemoryInput {
        Mem0MemoryInput {
            user_id: "user-a".to_string(),
            persona_id: "persona-a".to_string(),
            workspace_id: None,
            content: content.to_string(),
            metadata: MemoryMetadata::new(),
        }
    }

    fn metadata(pairs: &[(&str, Value)]) -> MemoryMetadata {
        pairs
            .iter()
            .map(|(key, value)| ((*key).to_string(), value.clone()))
            .collect()
    }

    fn workspace(mut input: Mem0MemoryInput, workspace_id: &str) -> Mem0MemoryInput {
        input.workspace_id = Some(workspace_id.to_string());
        input
    }

    fn search(query: &str, limit: i64) -> Mem0SearchInput {
        Mem0SearchInput {
            user_id: "user-a".to_string(),
            persona_id: "persona-a".to_string(),
            workspace_id: None,
            query: query.to_string(),
            limit,
            filters: None,
        }
    }

    fn list(page: i64, page_size: i64) -> Mem0ListInput {
        Mem0ListInput {
            user_id: "user-a".to_string(),
            persona_id: None,
            workspace_id: None,
            page,
            page_size,
            query: None,
            node_type: None,
        }
    }

    fn record_metadata(record: &Mem0MemoryRecord, key: &str) -> Value {
        record.metadata.get(key).cloned().unwrap_or(Value::Null)
    }

    #[test]
    fn the_provider_declares_itself_as_sqlite() {
        let client = client();
        assert_eq!(client.provider(), Some(MemoryProviderKind::Sqlite));
        let contract: &dyn Mem0Client = &client;
        assert_eq!(contract.provider(), Some(MemoryProviderKind::Sqlite));
        assert_eq!(client.db_path(), ":memory:");
    }

    #[test]
    fn a_stored_memory_comes_back_in_the_provider_record_shape() {
        let client = client();
        let added = client
            .add_memory(&input("Legacy memory"))
            .expect("add memory");
        let id = added.id.clone().expect("an id is returned");
        assert!(added.created);
        assert!(
            uuid::Uuid::parse_str(&id).is_ok(),
            "the id is a fresh v4 UUID: {id}"
        );

        let record = client
            .get_memory(&id, None)
            .expect("get")
            .expect("the node exists");
        assert_eq!(record.id, id);
        assert_eq!(record.content, "Legacy memory");
        assert_eq!(record.score, None, "a read carries no score");
        assert_eq!(record_metadata(&record, "type"), json!("fact"));
        assert_eq!(record_metadata(&record, "importance"), json!(3.0));
        assert_eq!(record_metadata(&record, "confidence"), json!(0.3));
        assert_eq!(record_metadata(&record, "source"), json!("sqlite"));
        assert_eq!(record_metadata(&record, "memoryProvider"), json!("sqlite"));
        assert_eq!(record_metadata(&record, "mem0Id"), json!(id));
        assert!(record_metadata(&record, "workspaceId").is_null());
        assert_eq!(record.created_at, record.updated_at);
        assert!(record
            .created_at
            .as_deref()
            .is_some_and(|stamp| !stamp.is_empty()));
        assert!(
            record
                .created_at
                .as_deref()
                .is_some_and(|stamp| stamp.ends_with('Z')),
            "`new Date().toISOString()`"
        );

        // The metadata bag is carried through and the stamped keys win.
        let request = input("Scored memory");
        let request = Mem0MemoryInput {
            metadata: metadata(&[
                ("type", json!("preference")),
                ("importance", json!(4)),
                ("confidence", json!(0.9)),
                ("lastVerified", json!("2026-10-02T00:00:00.000Z")),
            ]),
            ..request
        };
        let added = client.add_memory(&request).expect("add memory");
        let id = added.id.expect("an id is returned");
        let record = client.get_memory(&id, None).expect("get").expect("found");
        assert_eq!(record_metadata(&record, "type"), json!("preference"));
        assert_eq!(record_metadata(&record, "importance"), json!(4.0));
        assert_eq!(record_metadata(&record, "confidence"), json!(0.9));
        assert_eq!(
            record.created_at.as_deref(),
            Some("2026-10-02T00:00:00.000Z"),
            "`lastVerified` wins over the node timestamp"
        );
    }

    #[test]
    fn the_workspace_scope_is_stored_and_matched_like_the_source() {
        let client = client();
        let scoped = client
            .add_memory(&workspace(input("Workspace-scoped memory"), "workspace-a"))
            .expect("add memory");
        let scoped_id = scoped.id.expect("id");
        let unscoped = client
            .add_memory(&input("Unscoped memory"))
            .expect("add memory");
        let unscoped_id = unscoped.id.expect("id");

        // The input's workspace id is stamped into the stored metadata.
        let record = client
            .get_memory(&scoped_id, None)
            .expect("get")
            .expect("found");
        assert_eq!(
            record_metadata(&record, "workspaceId"),
            json!("workspace-a")
        );

        let matching = Mem0Scope::new("user-a", "persona-a").with_workspace(Some("workspace-a"));
        assert!(client
            .get_memory(&scoped_id, Some(&matching))
            .expect("get")
            .is_some());
        let other = Mem0Scope::new("user-a", "persona-a").with_workspace(Some("workspace-b"));
        assert!(
            client
                .get_memory(&scoped_id, Some(&other))
                .expect("get")
                .is_none(),
            "a foreign workspace is invisible"
        );
        // `undefined` accepts everything, including a node without the key.
        assert!(client
            .get_memory(&unscoped_id, Some(&Mem0Scope::new("user-a", "persona-a")))
            .expect("get")
            .is_some());
        // A *requested* workspace never matches a node that has none.
        assert!(
            client
                .get_memory(&unscoped_id, Some(&matching))
                .expect("get")
                .is_none(),
            "String(undefined || '') === 'workspace-a' is false"
        );
    }

    #[test]
    fn every_read_enforces_the_tenant_scope() {
        let client = client();
        let added = client
            .add_memory(&workspace(input("Coffee for Alice"), "workspace-a"))
            .expect("add");
        let id = added.id.expect("id");

        // The other tenant sees nothing.
        let mut other_search = search("coffee", 10);
        other_search.user_id = "user-b".to_string();
        assert!(client
            .search_memories(&other_search)
            .expect("search")
            .is_empty());

        let mut other_list = list(1, 10);
        other_list.user_id = "user-b".to_string();
        assert_eq!(client.list_memories(&other_list).expect("list").total, 0);

        assert!(client
            .get_memory(&id, Some(&Mem0Scope::new("user-b", "persona-a")))
            .expect("get")
            .is_none());
        assert!(client
            .get_memory(&id, Some(&Mem0Scope::new("user-a", "persona-b")))
            .expect("get")
            .is_none());

        // A blank scope id resolves to the legacy local user, so a blank caller
        // reads a node that was stored under the legacy id.
        let blank = client
            .add_memory(&Mem0MemoryInput {
                user_id: "   ".to_string(),
                persona_id: "persona-legacy".to_string(),
                workspace_id: None,
                content: "Legacy memory".to_string(),
                metadata: MemoryMetadata::new(),
            })
            .expect("add");
        let blank_id = blank.id.expect("id");
        assert!(client
            .get_memory(&blank_id, Some(&Mem0Scope::new("", "persona-legacy")))
            .expect("get")
            .is_some());
        assert!(client
            .get_memory(&blank_id, Some(&Mem0Scope::new("user-a", "persona-legacy")))
            .expect("get")
            .is_none());
    }

    #[test]
    fn search_scores_orders_and_limits_the_lexical_matches() {
        let client = client();
        let verified = |content: &str, node_type: &str, stamp: &str| Mem0MemoryInput {
            metadata: metadata(&[("type", json!(node_type)), ("lastVerified", json!(stamp))]),
            ..workspace(input(content), "workspace-a")
        };

        let newer = client
            .add_memory(&verified(
                "Alice prefers coffee",
                "preference",
                "2026-10-02T00:00:00.000Z",
            ))
            .expect("add")
            .id
            .expect("id");
        let older = client
            .add_memory(&verified(
                "Coffee and tea",
                "fact",
                "2026-10-01T00:00:00.000Z",
            ))
            .expect("add")
            .id
            .expect("id");
        let unverified = client
            .add_memory(&workspace(
                input("Coffee without a verified date"),
                "workspace-a",
            ))
            .expect("add")
            .id
            .expect("id");
        let unverified_older = client
            .add_memory(&workspace(
                input("Another coffee without a verified date"),
                "workspace-a",
            ))
            .expect("add")
            .id
            .expect("id");
        client
            .add_memory(&verified("Tea is nice", "fact", "2026-10-03T00:00:00.000Z"))
            .expect("add");
        client
            .add_memory(&Mem0MemoryInput {
                persona_id: "persona-b".to_string(),
                ..input("Coffee in another persona")
            })
            .expect("add");
        client
            .add_memory(&Mem0MemoryInput {
                user_id: "user-b".to_string(),
                ..input("Coffee for another user")
            })
            .expect("add");

        let mut scoped = search("Coffee! a", 20);
        scoped.workspace_id = Some("workspace-a".to_string());
        let hits = client.search_memories(&scoped).expect("search");
        assert_eq!(hits.len(), 4);
        assert_eq!(
            (hits[0].id.as_str(), hits[1].id.as_str()),
            (newer.as_str(), older.as_str()),
            "equal scores fall back to lastVerified descending"
        );
        // The two nodes without `lastVerified` cannot be told apart by the
        // tie-breaker: their `updated_at` stamps are equal inside one
        // millisecond, and SQLite's order for equal sort keys is unspecified.
        // The TypeScript test asserts their order only because its inserts span
        // more than one millisecond; the port asserts their membership instead.
        let mut rest: Vec<String> = hits[2..].iter().map(|hit| hit.id.clone()).collect();
        rest.sort();
        let mut expected = vec![unverified.clone(), unverified_older.clone()];
        expected.sort();
        assert_eq!(rest, expected);
        assert_eq!(
            hits.iter().map(|hit| hit.score).collect::<Vec<_>>(),
            vec![Some(1.0), Some(1.0), Some(1.0), Some(1.0)]
        );

        // `limit: 0` is clamped to one, and only one of two terms matches.
        let limited = client
            .search_memories(&search("coffee missing", 0))
            .expect("search");
        assert_eq!(
            limited
                .iter()
                .map(|hit| (hit.id.clone(), hit.score))
                .collect::<Vec<_>>(),
            vec![(newer.clone(), Some(0.5))]
        );

        // A query without a term of two characters matches nothing.
        assert!(client
            .search_memories(&search("--- a", 10))
            .expect("search")
            .is_empty());

        // The user's persona carries four nodes that mention coffee; the tea
        // reminder and the persona-b and user-b rows stay invisible.
        assert_eq!(
            client
                .search_memories(&search("coffee", 200))
                .expect("search")
                .len(),
            4
        );
    }

    #[test]
    fn list_memories_filters_by_persona_workspace_type_and_query() {
        let client = client();
        let coffee = client
            .add_memory(&Mem0MemoryInput {
                metadata: metadata(&[("type", json!("preference"))]),
                ..workspace(input("Coffee for Alice"), "workspace-a")
            })
            .expect("add")
            .id
            .expect("id");
        client
            .add_memory(&Mem0MemoryInput {
                metadata: metadata(&[("type", json!("fact"))]),
                ..workspace(input("Coffee for Bob"), "workspace-a")
            })
            .expect("add");
        client
            .add_memory(&Mem0MemoryInput {
                metadata: metadata(&[("type", json!("preference"))]),
                ..workspace(input("Tea for Alice"), "workspace-b")
            })
            .expect("add");
        client
            .add_memory(&Mem0MemoryInput {
                persona_id: "persona-b".to_string(),
                ..input("Coffee elsewhere")
            })
            .expect("add");

        // Persona plus workspace: in-memory filters, clamped page bounds.
        let filtered = client
            .list_memories(&Mem0ListInput {
                persona_id: Some("persona-a".to_string()),
                workspace_id: Some("workspace-a".to_string()),
                page: 0,
                page_size: 500,
                query: Some("Alice".to_string()),
                node_type: Some("preference".to_string()),
                ..list(1, 10)
            })
            .expect("list");
        assert_eq!(filtered.total, 1);
        assert_eq!(
            filtered
                .memories
                .iter()
                .map(|record| record.id.clone())
                .collect::<Vec<_>>(),
            vec![coffee.clone()]
        );
        assert_eq!(filtered.page, 1, "a page of 0 is normalised to 1");
        assert_eq!(filtered.page_size, 200, "500 is clamped to 200");

        // Persona without workspace: the SQL page runs, the bounds are echoed.
        let page = client
            .list_memories(&Mem0ListInput {
                persona_id: Some("persona-a".to_string()),
                page: 1,
                page_size: 10,
                query: Some("Coffee".to_string()),
                node_type: Some("fact".to_string()),
                ..list(1, 10)
            })
            .expect("list");
        assert_eq!(page.total, 1);
        assert_eq!(page.memories[0].content, "Coffee for Bob");
        assert_eq!(page.page, 1);
        assert_eq!(page.page_size, 10, "the requested bound is kept");
        assert_eq!(
            record_metadata(&page.memories[0], "type"),
            json!("fact"),
            "the record carries the stamped type, not the raw column"
        );

        // A type spelling the enum cannot express matches no row, exactly like
        // the `type = ?` predicate it stands in for.
        let unknown_type = client
            .list_memories(&Mem0ListInput {
                persona_id: Some("persona-a".to_string()),
                page: 3,
                page_size: 7,
                node_type: Some("nonsense".to_string()),
                ..list(1, 10)
            })
            .expect("list");
        assert_eq!(unknown_type.total, 0);
        assert!(unknown_type.memories.is_empty());
        assert_eq!(unknown_type.page, 3);
        assert_eq!(unknown_type.page_size, 7);

        // No persona: the workspace filter is the only predicate.
        let all = client
            .list_memories(&Mem0ListInput {
                page: 0,
                page_size: 0,
                ..list(1, 10)
            })
            .expect("list");
        assert_eq!(all.total, 4);
        assert_eq!(all.page, 1);
        assert_eq!(all.page_size, 1);
        assert_eq!(all.memories.len(), 1);

        let by_workspace = client
            .list_memories(&Mem0ListInput {
                workspace_id: Some("workspace-a".to_string()),
                page: 1,
                page_size: 10,
                ..list(1, 10)
            })
            .expect("list");
        assert_eq!(by_workspace.total, 2);
        assert_eq!(by_workspace.page, 1);
        assert_eq!(by_workspace.page_size, 10);

        // A query that matches nothing in the persona page.
        let unmatched = client
            .list_memories(&Mem0ListInput {
                persona_id: Some("persona-a".to_string()),
                query: Some("missing".to_string()),
                ..list(1, 10)
            })
            .expect("list");
        assert_eq!(unmatched.total, 0);
        assert!(unmatched.memories.is_empty());
    }

    #[test]
    fn update_and_delete_reject_a_foreign_scope_with_the_typescript_messages() {
        let client = client();
        let added = client
            .add_memory(&Mem0MemoryInput {
                metadata: metadata(&[("lastVerified", json!("2026-10-01T00:00:00.000Z"))]),
                ..workspace(input("Initial memory"), "workspace-a")
            })
            .expect("add");
        let id = added.id.expect("id");

        let missing = client
            .update_memory("missing", &input("Missing update"), None)
            .expect_err("an unknown id is an error");
        assert_eq!(missing.to_string(), "Memory node not found: missing");

        let mismatches = [
            Mem0MemoryInput {
                user_id: "other-user".to_string(),
                ..workspace(input("Rejected update"), "workspace-a")
            },
            Mem0MemoryInput {
                persona_id: "other-persona".to_string(),
                ..workspace(input("Rejected update"), "workspace-a")
            },
            Mem0MemoryInput {
                workspace_id: Some("workspace-b".to_string()),
                ..input("Rejected update")
            },
        ];
        for rejected in &mismatches {
            let error = client
                .update_memory(&id, rejected, None)
                .expect_err("a foreign scope is rejected");
            assert_eq!(error.to_string(), "Memory node scope mismatch.");
        }
        // The verdict did not change the stored node.
        assert_eq!(
            client
                .get_memory(&id, None)
                .expect("get")
                .expect("found")
                .content,
            "Initial memory"
        );

        // The third parameter is ignored, like the TypeScript implementation.
        let accepted = Mem0MemoryInput {
            metadata: metadata(&[
                ("type", json!("preference")),
                ("lastVerified", json!("2026-10-02T00:00:00.000Z")),
            ]),
            ..workspace(input("Updated memory"), "workspace-a")
        };
        let ignored_scope = Mem0Scope::new("other-user", "other-persona");
        client
            .update_memory(&id, &accepted, Some(&ignored_scope))
            .expect("the input scope decides, not the parameter");

        let record = client.get_memory(&id, None).expect("get").expect("found");
        assert_eq!(record.content, "Updated memory");
        assert_eq!(record_metadata(&record, "type"), json!("preference"));
        assert_eq!(
            record.updated_at.as_deref(),
            Some("2026-10-02T00:00:00.000Z")
        );

        let history = client.get_memory_history(&id, None).expect("history");
        assert_eq!(
            history
                .iter()
                .map(|entry| (entry.action.clone(), entry.content.clone()))
                .collect::<Vec<_>>(),
            vec![
                ("add".to_string(), Some("Initial memory".to_string())),
                ("update".to_string(), Some("Updated memory".to_string()))
            ]
        );
        assert!(history.iter().all(|entry| entry.raw.is_empty()));
        assert!(history[0].timestamp.is_some());

        let delete_missing = client
            .delete_memory("missing", None)
            .expect_err("an unknown id is an error");
        assert_eq!(delete_missing.to_string(), "Memory node not found: missing");
        let delete_mismatch = client
            .delete_memory(
                &id,
                Some(&Mem0Scope::new("user-a", "persona-a").with_workspace(Some("workspace-b"))),
            )
            .expect_err("a foreign workspace is rejected");
        assert_eq!(delete_mismatch.to_string(), "Memory node scope mismatch.");

        client
            .delete_memory(&id, Some(&Mem0Scope::new("user-a", "persona-a")))
            .expect("the matching scope deletes");
        assert!(client.get_memory(&id, None).expect("get").is_none());
    }

    #[test]
    fn deleting_by_filter_handles_the_workspace_branch() {
        let client = client();
        client
            .add_memory(&workspace(input("Workspace A"), "workspace-a"))
            .expect("add");
        client
            .add_memory(&workspace(input("Workspace B"), "workspace-b"))
            .expect("add");
        client
            .add_memory(&Mem0MemoryInput {
                persona_id: "persona-b".to_string(),
                ..workspace(input("Another persona"), "workspace-a")
            })
            .expect("add");

        assert_eq!(
            client
                .delete_memories_by_filter(&Mem0DeleteByFilterInput {
                    user_id: "user-a".to_string(),
                    persona_id: "persona-a".to_string(),
                    workspace_id: Some("workspace-a".to_string()),
                })
                .expect("delete"),
            1
        );
        let remaining = client
            .list_memories(&Mem0ListInput {
                persona_id: Some("persona-a".to_string()),
                ..list(1, 10)
            })
            .expect("list");
        assert_eq!(remaining.total, 1);
        assert_eq!(remaining.memories[0].content, "Workspace B");

        // Without a workspace the whole persona goes, in one statement.
        assert_eq!(
            client
                .delete_memories_by_filter(&Mem0DeleteByFilterInput {
                    user_id: "user-a".to_string(),
                    persona_id: "persona-a".to_string(),
                    workspace_id: None,
                })
                .expect("delete"),
            1
        );
        let all = client.list_memories(&list(1, 10)).expect("list");
        assert_eq!(all.total, 1);
        assert_eq!(all.memories[0].content, "Another persona");
    }

    #[test]
    fn a_row_without_a_timestamp_still_reports_one() {
        let client = client();
        // A legacy row: empty timestamp, empty metadata.
        client
            .repository()
            .insert_node(
                "persona-legacy",
                &MemoryNode {
                    id: "empty-timestamp".to_string(),
                    node_type: MemoryType::Fact,
                    content: "Old row without a timestamp".to_string(),
                    embedding: Vec::new(),
                    importance: 3.0,
                    confidence: 0.3,
                    timestamp: String::new(),
                    metadata: Some(MemoryMetadata::new()),
                },
                Some("legacy-user"),
            )
            .expect("insert");

        let record = client
            .get_memory("empty-timestamp", None)
            .expect("get")
            .expect("found");
        let created = record.created_at.clone().expect("a stamp is synthesised");
        assert!(!created.is_empty());
        assert_eq!(record.updated_at.as_deref(), Some(created.as_str()));
        assert_eq!(record_metadata(&record, "type"), json!("fact"));
        assert_eq!(record_metadata(&record, "importance"), json!(3.0));
        assert_eq!(record_metadata(&record, "confidence"), json!(0.3));
    }

    #[test]
    fn the_javascript_coercion_helpers_follow_the_source() {
        // `String(x || '')`: the falsy scalars disappear, `{}`/`[]` do not.
        assert!(!truthy(None));
        assert!(!truthy(Some(&Value::Null)));
        assert!(!truthy(Some(&json!(false))));
        assert!(!truthy(Some(&json!(0))));
        assert!(!truthy(Some(&json!(0.0))));
        assert!(!truthy(Some(&json!(""))));
        assert!(truthy(Some(&json!(1))));
        assert!(truthy(Some(&json!("0"))));
        assert!(truthy(Some(&json!([]))));
        assert!(truthy(Some(&json!({}))));

        let mut node = MemoryNode {
            id: "n".to_string(),
            node_type: MemoryType::Fact,
            content: String::new(),
            embedding: Vec::new(),
            importance: 3.0,
            confidence: 0.3,
            timestamp: "t".to_string(),
            metadata: Some(metadata(&[
                ("lastVerified", json!(0)),
                ("workspaceId", json!(5)),
                ("other", json!("  x  ")),
            ])),
        };
        assert_eq!(last_verified_text(&node), "", "`0` is falsy");
        assert_eq!(truthy_text(&node, "workspaceId"), "5", "String(5)");
        assert_eq!(truthy_text(&node, "other"), "  x  ", "no trimming here");
        assert_eq!(truthy_text(&node, "missing"), "");

        node.metadata = None;
        assert_eq!(last_verified_text(&node), "");
    }

    #[test]
    fn the_workspace_match_uses_the_stored_text() {
        let entry = |workspace_id: Value| MemoryNodeWithScope {
            node: MemoryNode {
                id: "n".to_string(),
                node_type: MemoryType::Fact,
                content: "c".to_string(),
                embedding: Vec::new(),
                importance: 3.0,
                confidence: 0.3,
                timestamp: "t".to_string(),
                metadata: Some(metadata(&[("workspaceId", workspace_id)])),
            },
            user_id: "user-a".to_string(),
            persona_id: "persona-a".to_string(),
        };

        assert!(matches_workspace(&entry(json!("workspace-a")), None));
        assert!(matches_workspace(
            &entry(json!("workspace-a")),
            Some("workspace-a")
        ));
        assert!(!matches_workspace(
            &entry(json!("workspace-a")),
            Some("workspace-b")
        ));
        assert!(matches_workspace(&entry(json!(5)), Some("5")));
        assert!(
            !matches_workspace(&entry(Value::Null), Some("workspace-a")),
            "an absent key never matches a requested workspace"
        );
    }

    #[test]
    fn node_from_input_defaults_and_stamps_like_the_source() {
        let mut request = input("content");
        let node = node_from_input("id-1", &request);
        assert_eq!(node.id, "id-1");
        assert_eq!(node.node_type, MemoryType::Fact);
        assert_eq!(node.importance, 3.0);
        assert_eq!(node.confidence, 0.3);
        assert!(node.embedding.is_empty());
        assert!(!node.timestamp.is_empty());
        let stamped = node.metadata.as_ref().expect("metadata");
        assert_eq!(stamped["source"], json!("sqlite"));
        assert_eq!(stamped["memoryProvider"], json!("sqlite"));
        assert_eq!(stamped["mem0Id"], json!("id-1"));
        assert!(stamped.get("workspaceId").is_none());

        // The numbers are used verbatim: no rounding, no clamping.
        request.metadata = metadata(&[
            ("type", json!("lesson")),
            ("importance", json!(4.7)),
            ("confidence", json!(2)),
            ("lastVerified", json!(" 2026-01-02 ")),
        ]);
        request.workspace_id = Some("workspace-a".to_string());
        let node = node_from_input("id-2", &request);
        assert_eq!(node.node_type, MemoryType::Lesson);
        assert_eq!(node.importance, 4.7);
        assert_eq!(node.confidence, 2.0, "not clamped to 1.0");
        assert_eq!(node.timestamp, " 2026-01-02 ", "not trimmed");
        assert_eq!(
            node.metadata.as_ref().expect("metadata")["workspaceId"],
            json!("workspace-a")
        );

        // A non-numeric importance and a falsy `lastVerified` fall back.
        request.metadata = metadata(&[("importance", json!("abc")), ("lastVerified", json!(""))]);
        let node = node_from_input("id-3", &request);
        assert_eq!(node.importance, 3.0);
        assert_eq!(node.confidence, 0.3);
        assert!(!node.timestamp.is_empty());
    }

    #[test]
    fn score_content_splits_on_non_word_characters() {
        assert_eq!(score_content("Alice prefers coffee", "Coffee! a"), 1.0);
        assert_eq!(score_content("Coffee and tea", "coffee missing"), 0.5);
        assert_eq!(score_content("Tea is nice", "coffee"), 0.0);
        assert_eq!(score_content("anything", "--- a"), 0.0);
        assert_eq!(score_content("anything", ""), 0.0);
        assert_eq!(score_content("Café déjà vu", "café déjà"), 1.0);
        assert_eq!(
            query_terms("Café! déjà-vu 1x"),
            vec![
                "café".to_string(),
                "déjà".to_string(),
                "vu".to_string(),
                "1x".to_string()
            ]
        );
        // `term.length >= 2` counts UTF-16 units in JavaScript and characters
        // here, so a lone astral character is dropped by the port (module header,
        // deviation 5).
        assert_eq!(query_terms("🎉 party"), vec!["party".to_string()]);
    }
}
