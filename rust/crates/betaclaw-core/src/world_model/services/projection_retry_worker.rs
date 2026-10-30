//! Port of `src/server/world-model/services/projectionRetryWorker.ts:1-236` —
//! the retry loop of the projection queue.
//!
//! | TypeScript | Rust |
//! | --- | --- |
//! | `projectionRetryWorker.ts:21-25` (`ProjectionRetryResult`) | [`ProjectionRetryResult`] |
//! | `projectionRetryWorker.ts:27` (`ProjectionRetryHandler`) | [`ProjectionRetryHandler`] |
//! | `projectionRetryWorker.ts:36-57` (`clearMemoryPendingIfSettled`) | [`clear_memory_pending_if_settled`] |
//! | `projectionRetryWorker.ts:196-220` (`runProjectionRetryOnce`) | [`run_projection_retry_once`] |
//! | `projectionRetryWorker.ts:222-236` (`startProjectionRetryWorker`) | [`ProjectionRetryWorker`] |
//!
//! # Deviations
//!
//! 1. **The ambient scope is a parameter.** `:200` calls `listDueProjectionPending`
//!    without a scope and `:227` wraps `runProjectionRetryOnce` in
//!    `runWithWorldModelScope`; the port hands `Option<&WorldModelScope>` to every
//!    repository call, the documented replacement for the `AsyncLocalStorage`
//!    (`db.ts:11`).
//! 2. **The handler map and the message flagger are parameters.** `:198` already
//!    takes `handlers = defaultHandlers` as its second argument, so the
//!    caller-supplied map is the source's own seam. The knowledge repository call
//!    of `:56` (`getKnowledgeMessageRepository().markMessagesMemoryPending?`) is
//!    the same kind of injected seam: `None` is the absent `?.` method, `Some`
//!    the provided one.
//! 3. **The default handlers are built here; their cross-slice writes are ports.**
//!    [`default_projection_retry_handlers`] builds the map of `:190-194`.
//!    `retryWorldModelWindow` (`:59-90`) runs in full: the JSON payload becomes a
//!    [`KnowledgeExtraction`] ([`extraction_from_json`]), then `normalizeExtraction`
//!    and `projectWindow` run as in the source. `retryMem0Facts` (`:92-127`) and
//!    `retrySqliteKnowledge` (`:160-188`) keep their payload reshaping and their
//!    error paths here. The memory write is [`MemoryFactSink`] (S5), and the
//!    knowledge write, including `processFacts`/`processMeetingLedger`, is
//!    [`KnowledgeRetrySink`] (S7).
//!    A missing `meetingLedger` or list fails with `projection retry payload has no
//!    <field>`, where the source throws a `TypeError`. The record fails the same way
//!    (`:213-216`), only the message differs.
//! 4. **`startProjectionRetryWorker` is a struct plus a spawn.** `:222-236`
//!    returns `{ stop }` over a `setInterval` that has no overlap guard; Rust
//!    models the interval body as [`ProjectionRetryWorker::run_tick`] and
//!    [`ProjectionRetryWorker::start`] spawns the same `tokio` loop.

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use serde_json::{json, Map, Value};

use crate::js::js_number_str;
use crate::world_model::config::RuntimeRole;
use crate::world_model::db::{BoxFuture, PgError, PgExecutor, PgStatement, PgValue};
use crate::world_model::projector::normalize_extraction::{
    normalize_extraction, ExtractionEntity, ExtractionEvent, ExtractionRelation,
    KnowledgeExtraction, NormalizeExtractionInput,
};
use crate::world_model::projector::project_window::{project_window, ProjectWindowInput};
use crate::world_model::repositories::event_repository::now_iso;
use crate::world_model::repositories::projection_pending_repository::{
    list_due_projection_pending, mark_projection_pending_failed, mark_projection_pending_succeeded,
    ProjectionPendingRecord,
};
use crate::world_model::repositories::{ambient_query, row_text};
use crate::world_model::runtime::scope_discovery::list_runtime_world_model_scopes;
use crate::world_model::scope::WorldModelScope;
use crate::world_model::types::{ObservationInput, ObservationSourceType};

/// `ProjectionRetryResult` from `projectionRetryWorker.ts:21-25`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct ProjectionRetryResult {
    pub selected: usize,
    pub succeeded: usize,
    pub failed: usize,
}

/// `ProjectionRetryHandler` from `projectionRetryWorker.ts:27`.
///
/// The source handler takes the record by value; the port keeps the owned record
/// instead of a borrow so the boxed future can be `'static`, which is the same
/// observation the source's async closure makes.
pub type ProjectionRetryHandler =
    Arc<dyn Fn(ProjectionPendingRecord) -> BoxFuture<'static, Result<(), String>> + Send + Sync>;

/// `handlers: Record<string, ProjectionRetryHandler>` of `:198`.
pub type ProjectionRetryHandlers = HashMap<String, ProjectionRetryHandler>;

/// `getKnowledgeMessageRepository().markMessagesMemoryPending?.(ids, false)` of
/// `:56`.
pub type MarkMessagesMemoryPending = dyn Fn(&[String], bool) + Send + Sync;

/// The `runProjectionRetryOnce()` default limit of `:197`.
pub const DEFAULT_RETRY_LIMIT: i64 = 25;

/// The `:38-40` count statement of `clearMemoryPendingIfSettled`.
pub const SQL_COUNT_SETTLED_PENDING: &str =
    "SELECT COUNT(*) AS count FROM world_model_projection_pending\n     WHERE user_id = $1 AND persona_id = $2 AND workspace_id = $3\n       AND source_window_id = $4 AND status IN ('pending', 'failed')";

/// `String(value ?? '')`.
fn js_string(value: Option<&Value>) -> String {
    match value {
        None | Some(Value::Null) => String::new(),
        Some(Value::String(text)) => text.clone(),
        Some(Value::Bool(flag)) => flag.to_string(),
        Some(Value::Number(number)) => number.to_string(),
        Some(Value::Array(_)) | Some(Value::Object(_)) => {
            serde_json::to_string(value.expect("checked Some")).unwrap_or_default()
        }
    }
}

/// The `messageIds`/`messages[].id` extraction of `:49-55`.
fn message_ids(record: &ProjectionPendingRecord) -> Vec<String> {
    let collect = |values: &[Value]| -> Vec<String> {
        values
            .iter()
            .map(|value| js_string(Some(value)))
            .filter(|value| !value.is_empty())
            .collect()
    };
    match record.payload.get("messageIds") {
        Some(Value::Array(items)) => collect(items),
        _ => match record.payload.get("messages") {
            Some(Value::Array(items)) => items
                .iter()
                .map(|value| js_string(value.get("id")))
                .filter(|value| !value.is_empty())
                .collect(),
            _ => Vec::new(),
        },
    }
}

/// `clearMemoryPendingIfSettled(record)` — `projectionRetryWorker.ts:36-57`.
pub async fn clear_memory_pending_if_settled(
    executor: &dyn PgExecutor,
    scope: Option<&WorldModelScope>,
    record: &ProjectionPendingRecord,
    mark_messages_memory_pending: Option<&MarkMessagesMemoryPending>,
) -> Result<(), PgError> {
    let result = ambient_query::<PgError>(
        executor,
        scope,
        PgStatement::with_params(
            SQL_COUNT_SETTLED_PENDING,
            vec![
                PgValue::text(record.scope.user_id.as_str()),
                PgValue::text(record.scope.persona_id.as_str()),
                PgValue::text(record.scope.workspace_id.clone().unwrap_or_default()),
                PgValue::text(record.source_window_id.as_str()),
            ],
        ),
    )
    .await?;
    let count = result
        .first()
        .map(|row| js_number_str(&row_text(row, "count")))
        .unwrap_or(0.0);
    if count > 0.0 {
        return Ok(());
    }
    if let Some(mark) = mark_messages_memory_pending {
        mark(&message_ids(record), false);
    }
    Ok(())
}

/// The memory write of `retryMem0Facts` (`:107-124`). S5 implements it over
/// `getMemoryService()`, including the choice between `storeMemory` and `store`.
#[derive(Debug, Clone, PartialEq)]
pub struct RetryMemoryFact {
    pub persona_id: String,
    pub user_id: String,
    pub content: String,
    pub importance: i64,
    pub metadata: Map<String, Value>,
}

/// The memory port of `retryMem0Facts` (S5, `memory/runtime.ts`).
pub trait MemoryFactSink: Send + Sync {
    /// `getMemoryProviderKind() === 'mem0' && isMem0FactualWriteBlocked()` throws
    /// (`:93-95`). `Err` carries the source's message. The default allows the write.
    fn factual_write_guard(&self) -> Result<(), String> {
        Ok(())
    }

    /// `memoryService.storeMemory({...})`, or `store(...)` (`:107-124`).
    fn store_fact<'a>(&'a self, fact: RetryMemoryFact) -> BoxFuture<'a, Result<(), String>>;
}

/// One message of the `asWindow` reshaping (`projectionRetryWorker.ts:131-146`).
#[derive(Debug, Clone, PartialEq)]
pub struct RetryMessage {
    pub id: String,
    pub conversation_id: String,
    pub seq: i64,
    pub role: String,
    pub content: String,
    pub platform: String,
    pub external_msg_id: Option<String>,
    pub sender_name: Option<String>,
    pub metadata: Option<String>,
    pub created_at: String,
}

/// The `IngestionWindow` shape of `asWindow` (`:149-157`), before the knowledge slice
/// maps it onto its own type.
#[derive(Debug, Clone, PartialEq)]
pub struct RetryWindow {
    pub conversation_id: String,
    pub user_id: String,
    pub persona_id: String,
    pub workspace_id: String,
    pub from_seq_exclusive: i64,
    pub to_seq_inclusive: i64,
    pub messages: Vec<RetryMessage>,
}

/// The arguments of the knowledge retry after the S6 reshaping (`:160-188`).
#[derive(Debug, Clone, PartialEq)]
pub struct SqliteKnowledgeRetry {
    pub window: RetryWindow,
    /// `record.payload.rawExtraction`, as stored.
    pub raw_extraction: Value,
    /// `record.payload.facts` when it is an array (`:168-170`). `None` lets the sink
    /// derive the facts with `processFacts`.
    pub payload_facts: Option<Vec<String>>,
    /// `record.payload.memoryIds` (`:178-181`).
    pub memory_ids: Vec<String>,
    /// `String(record.payload.personaName ?? window.personaId)` (`:172`).
    pub persona_name: String,
}

/// The knowledge port of `retrySqliteKnowledge` (S7).
pub trait KnowledgeRetrySink: Send + Sync {
    /// `upsertEpisodeAndLedger`, `storeEvents` and `storeEntities` (`:174-187`). The
    /// sink runs `processMeetingLedger` (`:171`) itself, and `processFacts` (`:170`)
    /// when `payload_facts` is `None`.
    fn retry_sqlite_knowledge<'a>(
        &'a self,
        retry: SqliteKnowledgeRetry,
    ) -> BoxFuture<'a, Result<(), String>>;
}

const NO_RAW_EXTRACTION: &str = "projection retry payload has no raw extraction";

/// `asExtraction(record.payload.rawExtraction)` — `projectionRetryWorker.ts:29-34`.
fn raw_extraction(record: &ProjectionPendingRecord) -> Result<&Value, String> {
    match record.payload.get("rawExtraction") {
        Some(value @ Value::Object(_)) => Ok(value),
        _ => Err(NO_RAW_EXTRACTION.to_string()),
    }
}

fn missing(field: &str) -> String {
    format!("projection retry payload has no {field}")
}

/// `String(value ?? fallback)` for a text field of the payload.
fn text_or(value: Option<&Value>, fallback: &str) -> String {
    match value {
        None | Some(Value::Null) => fallback.to_string(),
        other => js_string(other),
    }
}

/// `value ? String(value) : null` (`:141-144`), with the JavaScript truthiness.
fn truthy_text(value: Option<&Value>) -> Option<String> {
    let value = value?;
    let truthy = match value {
        Value::Null => false,
        Value::Bool(flag) => *flag,
        Value::Number(number) => number.as_f64().is_some_and(|number| number != 0.0),
        Value::String(text) => !text.is_empty(),
        Value::Array(_) | Value::Object(_) => true,
    };
    truthy.then(|| js_string(Some(value)))
}

/// `Number(value ?? fallback)` for the integer fields of the payload.
fn number_or(value: Option<&Value>, fallback: i64) -> i64 {
    match value {
        None | Some(Value::Null) => fallback,
        Some(Value::Number(number)) => number.as_f64().map_or(fallback, |number| number as i64),
        Some(other) => js_number_str(&js_string(Some(other))) as i64,
    }
}

/// The non-empty strings of an array field (`:169`, `:179-180`).
fn non_empty_strings(value: Option<&Value>) -> Option<Vec<String>> {
    value.and_then(Value::as_array).map(|items| {
        items
            .iter()
            .map(|item| js_string(Some(item)))
            .filter(|item| !item.is_empty())
            .collect()
    })
}

fn string_list(value: Option<&Value>) -> Option<Vec<String>> {
    value
        .and_then(Value::as_array)
        .map(|items| items.iter().map(|item| js_string(Some(item))).collect())
}

fn i64_list(value: Option<&Value>) -> Vec<i64> {
    value
        .and_then(Value::as_array)
        .map(|items| items.iter().filter_map(Value::as_i64).collect())
        .unwrap_or_default()
}

fn event_from_json(event: &Value) -> ExtractionEvent {
    ExtractionEvent {
        event_type: js_string(event.get("eventType")),
        subject: js_string(event.get("subject")),
        start_date: js_string(event.get("startDate")),
        end_date: js_string(event.get("endDate")),
        source_seq: i64_list(event.get("sourceSeq")),
        confirmation_signals: string_list(event.get("confirmationSignals")).unwrap_or_default(),
        is_confirmation: event
            .get("isConfirmation")
            .and_then(Value::as_bool)
            .unwrap_or(false),
    }
}

fn entity_from_json(entity: &Value) -> ExtractionEntity {
    ExtractionEntity {
        name: js_string(entity.get("name")),
        category: js_string(entity.get("category")),
        owner: js_string(entity.get("owner")),
        aliases: string_list(entity.get("aliases")),
        relations: entity
            .get("relations")
            .and_then(Value::as_array)
            .map(|relations| {
                relations
                    .iter()
                    .map(|relation| ExtractionRelation {
                        target_name: js_string(relation.get("targetName")),
                        relation_type: js_string(relation.get("relationType")),
                    })
                    .collect()
            })
            .unwrap_or_default(),
        source_seq: i64_list(entity.get("sourceSeq")),
    }
}

/// The fields `normalizeExtraction` reads (`normalizeExtraction.ts:24-81`), flattened into
/// the projector's [`KnowledgeExtraction`]: the ledger's `confidence`, `actionItems` and
/// `openPoints` move up one level.
pub fn extraction_from_json(value: &Value) -> Result<KnowledgeExtraction, String> {
    let ledger = value
        .get("meetingLedger")
        .filter(|ledger| ledger.is_object())
        .ok_or_else(|| missing("meeting ledger"))?;
    Ok(KnowledgeExtraction {
        facts: string_list(value.get("facts")).ok_or_else(|| missing("facts"))?,
        events: value
            .get("events")
            .and_then(Value::as_array)
            .ok_or_else(|| missing("events"))?
            .iter()
            .map(event_from_json)
            .collect(),
        entities: value
            .get("entities")
            .and_then(Value::as_array)
            .ok_or_else(|| missing("entities"))?
            .iter()
            .map(entity_from_json)
            .collect(),
        action_items: string_list(ledger.get("actionItems"))
            .ok_or_else(|| missing("action items"))?,
        open_points: string_list(ledger.get("openPoints")).ok_or_else(|| missing("open points"))?,
        // `result.meetingLedger.confidence || 0.7` (`normalizeExtraction.ts:34`): a zero
        // or absent value is replaced by `normalize_extraction`, as in the source.
        confidence: ledger
            .get("confidence")
            .and_then(Value::as_f64)
            .unwrap_or(0.0),
        episode: value
            .get("episode")
            .and_then(Value::as_str)
            .map(str::to_string),
    })
}

/// One message of `asWindow` (`projectionRetryWorker.ts:131-146`).
fn retry_message(record: &ProjectionPendingRecord, item: &Value) -> RetryMessage {
    RetryMessage {
        id: match item.get("id") {
            Some(value) if !value.is_null() => js_string(Some(value)),
            _ => format!("{}:{}", record.source_window_id, js_string(item.get("seq"))),
        },
        conversation_id: match item.get("conversationId") {
            Some(value) if !value.is_null() => js_string(Some(value)),
            _ => js_string(record.payload.get("conversationId")),
        },
        seq: number_or(item.get("seq"), 0),
        role: text_or(item.get("role"), "user"),
        content: text_or(item.get("content"), ""),
        platform: text_or(item.get("platform"), "webchat"),
        external_msg_id: truthy_text(item.get("externalMsgId")),
        sender_name: truthy_text(item.get("senderName")),
        metadata: truthy_text(item.get("metadata")),
        created_at: text_or(item.get("createdAt"), &now_iso()),
    }
}

/// `asWindow(record)` — `projectionRetryWorker.ts:129-158`.
fn retry_window(record: &ProjectionPendingRecord) -> RetryWindow {
    let messages: Vec<RetryMessage> = record
        .payload
        .get("messages")
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .map(|item| retry_message(record, item))
                .collect()
        })
        .unwrap_or_default();
    let conversation_id = match record.payload.get("conversationId") {
        Some(value) if !value.is_null() => js_string(Some(value)),
        _ => messages
            .first()
            .map(|message| message.conversation_id.clone())
            .unwrap_or_default(),
    };
    let to_seq_inclusive = number_or(
        record.payload.get("toSeqInclusive"),
        messages.last().map_or(0, |message| message.seq),
    );
    RetryWindow {
        conversation_id,
        user_id: record.scope.user_id.clone(),
        persona_id: record.scope.persona_id.clone(),
        workspace_id: record.scope.workspace_id.clone().unwrap_or_default(),
        from_seq_exclusive: number_or(record.payload.get("fromSeqExclusive"), 0),
        to_seq_inclusive,
        messages,
    }
}

/// `retryWorldModelWindow(record)` — `projectionRetryWorker.ts:59-90`.
async fn retry_world_model_window(
    executor: &dyn PgExecutor,
    record: &ProjectionPendingRecord,
) -> Result<(), String> {
    let raw = raw_extraction(record)?;
    let extraction = extraction_from_json(raw)?;
    let from_seq_exclusive = number_or(record.payload.get("fromSeqExclusive"), 0);
    let to_seq_inclusive = number_or(record.payload.get("toSeqInclusive"), from_seq_exclusive);
    let conversation_id = js_string(record.payload.get("conversationId"));
    let workspace_id = record.scope.workspace_id.clone().unwrap_or_default();
    let projection = normalize_extraction(&NormalizeExtractionInput {
        result: extraction.clone(),
        workspace_id: workspace_id.clone(),
        user_id: record.scope.user_id.clone(),
        persona_id: record.scope.persona_id.clone(),
    });
    project_window(
        executor,
        ProjectWindowInput {
            scope: record.scope.clone(),
            projection,
            observation: ObservationInput {
                user_id: record.scope.user_id.clone(),
                persona_id: record.scope.persona_id.clone(),
                workspace_id: Some(workspace_id),
                source_type: ObservationSourceType::Automation,
                source_id: record.source_window_id.clone(),
                occurred_at: now_iso(),
                payload: Map::from_iter([
                    ("conversationId".to_string(), json!(conversation_id)),
                    ("fromSeq".to_string(), json!(from_seq_exclusive + 1)),
                    ("toSeq".to_string(), json!(to_seq_inclusive)),
                    ("windowId".to_string(), json!(record.source_window_id)),
                    ("rawExtraction".to_string(), raw.clone()),
                ]),
                source_authority: Some("persona".to_string()),
            },
            extraction: Some(extraction),
            completed_task_evidence: Vec::new(),
        },
    )
    .await
    .map(|_| ())
    .map_err(|error| error.message)
}

/// `retryMem0Facts(record)` — `projectionRetryWorker.ts:92-127`.
async fn retry_mem0_facts(
    memory: &dyn MemoryFactSink,
    record: &ProjectionPendingRecord,
) -> Result<(), String> {
    memory.factual_write_guard()?;
    let facts = record
        .payload
        .get("facts")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    for (index, value) in facts.iter().enumerate() {
        let content = js_string(Some(value)).trim().to_string();
        if content.is_empty() {
            continue;
        }
        memory
            .store_fact(RetryMemoryFact {
                persona_id: record.scope.persona_id.clone(),
                user_id: record.scope.user_id.clone(),
                content,
                importance: 3,
                metadata: Map::from_iter([
                    (
                        "sourceType".to_string(),
                        json!("world_model_projection_retry"),
                    ),
                    (
                        "sourceObservationId".to_string(),
                        json!(record.source_observation_id),
                    ),
                    ("projectionPendingId".to_string(), json!(record.id)),
                    (
                        "idempotencyKey".to_string(),
                        json!(format!("world-model-retry:{}:{index}", record.id)),
                    ),
                ]),
            })
            .await?;
    }
    Ok(())
}

/// `retrySqliteKnowledge(record)` — `projectionRetryWorker.ts:160-188`.
async fn retry_sqlite_knowledge(
    knowledge: &dyn KnowledgeRetrySink,
    record: &ProjectionPendingRecord,
) -> Result<(), String> {
    let raw = raw_extraction(record)?;
    let window = retry_window(record);
    if window.messages.is_empty() {
        return Err("sqlite knowledge retry payload has no source messages".to_string());
    }
    let persona_name = match record.payload.get("personaName") {
        Some(value) if !value.is_null() => js_string(Some(value)),
        _ => window.persona_id.clone(),
    };
    knowledge
        .retry_sqlite_knowledge(SqliteKnowledgeRetry {
            payload_facts: non_empty_strings(record.payload.get("facts")),
            memory_ids: non_empty_strings(record.payload.get("memoryIds")).unwrap_or_default(),
            raw_extraction: raw.clone(),
            persona_name,
            window,
        })
        .await
}

/// The `defaultHandlers` map of `projectionRetryWorker.ts:190-194`. The three handlers
/// keep their payload reshaping and their error paths; the S5 and S7 writes come in
/// through [`MemoryFactSink`] and [`KnowledgeRetrySink`].
pub fn default_projection_retry_handlers(
    executor: Arc<dyn PgExecutor>,
    memory: Arc<dyn MemoryFactSink>,
    knowledge: Arc<dyn KnowledgeRetrySink>,
) -> ProjectionRetryHandlers {
    let mut handlers = ProjectionRetryHandlers::new();
    handlers.insert(
        "world_model_window".to_string(),
        Arc::new(move |record: ProjectionPendingRecord| {
            let executor = Arc::clone(&executor);
            Box::pin(async move { retry_world_model_window(executor.as_ref(), &record).await })
        }),
    );
    handlers.insert(
        "mem0_fact".to_string(),
        Arc::new(move |record: ProjectionPendingRecord| {
            let memory = Arc::clone(&memory);
            Box::pin(async move { retry_mem0_facts(memory.as_ref(), &record).await })
        }),
    );
    handlers.insert(
        "sqlite_knowledge".to_string(),
        Arc::new(move |record: ProjectionPendingRecord| {
            let knowledge = Arc::clone(&knowledge);
            Box::pin(async move { retry_sqlite_knowledge(knowledge.as_ref(), &record).await })
        }),
    );
    handlers
}

/// `runProjectionRetryOnce(limit, handlers)` — `projectionRetryWorker.ts:196-220`.
///
/// The loop, the missing-handler failure, the success marking, the settled-memory
/// clearing and the failure back-off are the source's. `mark_messages_memory_pending`
/// is the `:56` seam (see deviation 2).
pub async fn run_projection_retry_once(
    executor: &dyn PgExecutor,
    scope: Option<&WorldModelScope>,
    limit: i64,
    handlers: &ProjectionRetryHandlers,
    mark_messages_memory_pending: Option<&MarkMessagesMemoryPending>,
) -> Result<ProjectionRetryResult, PgError> {
    let records = list_due_projection_pending::<PgError>(executor, scope, Some(limit)).await?;
    let selected = records.len();
    let mut succeeded = 0usize;
    let mut failed = 0usize;

    for record in records {
        let outcome: Result<(), String> = match handlers.get(&record.projection_type) {
            None => Err(format!("no retry handler for {}", record.projection_type)),
            Some(handler) => {
                let handler = Arc::clone(handler);
                let attempt = async {
                    handler(record.clone()).await?;
                    mark_projection_pending_succeeded::<PgError>(executor, scope, &record.id)
                        .await
                        .map_err(|error| error.message)?;
                    clear_memory_pending_if_settled(
                        executor,
                        scope,
                        &record,
                        mark_messages_memory_pending,
                    )
                    .await
                    .map_err(|error| error.message)?;
                    Ok(())
                }
                .await;
                attempt
            }
        };

        match outcome {
            Ok(()) => succeeded += 1,
            Err(message) => {
                failed += 1;
                mark_projection_pending_failed::<PgError>(executor, scope, &record.id, &message)
                    .await?;
            }
        }
    }

    Ok(ProjectionRetryResult {
        selected,
        succeeded,
        failed,
    })
}

/// `startProjectionRetryWorker(intervalMs)` — `projectionRetryWorker.ts:222-236`.
///
/// The `setInterval` callback of `:223-233` is [`run_tick`](Self::run_tick);
/// [`start`](Self::start) drives it.
pub struct ProjectionRetryWorker {
    executor: Arc<dyn PgExecutor>,
    env: HashMap<String, String>,
    runtime_role: RuntimeRole,
    handlers: ProjectionRetryHandlers,
    mark_messages_memory_pending: Option<Arc<MarkMessagesMemoryPending>>,
    stop: Arc<AtomicBool>,
}

impl ProjectionRetryWorker {
    pub fn new(
        executor: Arc<dyn PgExecutor>,
        env: HashMap<String, String>,
        runtime_role: RuntimeRole,
        handlers: ProjectionRetryHandlers,
        mark_messages_memory_pending: Option<Arc<MarkMessagesMemoryPending>>,
    ) -> Self {
        Self {
            executor,
            env,
            runtime_role,
            handlers,
            mark_messages_memory_pending,
            stop: Arc::new(AtomicBool::new(false)),
        }
    }

    /// The `setInterval` body of `:224-233`.
    pub async fn run_tick(&self) {
        let scopes = list_runtime_world_model_scopes(
            &self.env,
            Some(self.executor.as_ref()),
            self.runtime_role,
        )
        .await;
        for scope in scopes {
            let _ = run_projection_retry_once(
                self.executor.as_ref(),
                Some(&scope),
                DEFAULT_RETRY_LIMIT,
                &self.handlers,
                self.mark_messages_memory_pending.as_deref(),
            )
            .await;
        }
    }

    /// The `setInterval(...)` of `:223`; the `timer.unref()` of `:234` has no Rust
    /// counterpart, and the returned handle's [`stop`](ProjectionRetryWorkerHandle::stop)
    /// replaces `clearInterval`.
    pub fn start(self: Arc<Self>, interval_ms: u64) -> ProjectionRetryWorkerHandle {
        let stop = Arc::clone(&self.stop);
        let worker = Arc::clone(&self);
        let task_stop = Arc::clone(&stop);
        tokio::spawn(async move {
            let interval = std::time::Duration::from_millis(interval_ms);
            loop {
                tokio::time::sleep(interval).await;
                if task_stop.load(Ordering::Acquire) {
                    break;
                }
                worker.run_tick().await;
            }
        });
        ProjectionRetryWorkerHandle { stop }
    }
}

/// The `{ stop }` of `:235`.
pub struct ProjectionRetryWorkerHandle {
    stop: Arc<AtomicBool>,
}

impl ProjectionRetryWorkerHandle {
    /// `stop: () => clearInterval(timer)` (`:235`).
    pub fn stop(&self) {
        self.stop.store(true, Ordering::Release);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::world_model::db::drive_sync;
    use crate::world_model::db::testing::{Recorded, RecordingExecutor};
    use crate::world_model::db::{PgQueryResult, PgRow, SQL_BEGIN, SQL_COMMIT, SQL_SET_SCOPE};
    use crate::world_model::repositories::projection_pending_repository::SQL_MARK_FAILED;
    use crate::world_model::runtime::scope_discovery::DISPATCH_SCOPES_ENV;
    use serde_json::json;
    use std::sync::atomic::AtomicUsize;

    fn pending_row(payload: Value) -> PgRow {
        json!({
            "id": "p1",
            "user_id": "u1",
            "persona_id": "p1",
            "workspace_id": "w1",
            "projection_type": "world_model_window",
            "source_observation_id": null,
            "source_window_id": "window-1",
            "payload": payload,
            "attempts": 1,
            "status": "failed",
            "error_message": "boom",
            "next_attempt_at": "2026-10-10T10:00:00.000Z",
            "created_at": "2026-10-10T09:00:00.000Z",
            "updated_at": "2026-10-10T09:30:00.000Z",
        })
        .as_object()
        .expect("object")
        .clone()
    }

    fn record(payload: Value) -> ProjectionPendingRecord {
        ProjectionPendingRecord {
            id: "p1".to_string(),
            scope: WorldModelScope::new("u1", "p1", Some("w1".to_string())),
            projection_type: "world_model_window".to_string(),
            source_observation_id: None,
            source_window_id: "window-1".to_string(),
            payload: payload.as_object().expect("payload").clone(),
            attempts: 1,
            status: crate::world_model::repositories::projection_pending_repository::ProjectionPendingStatus::Failed,
            error_message: Some("boom".to_string()),
            next_attempt_at: "2026-10-10T10:00:00.000Z".to_string(),
            created_at: "2026-10-10T09:00:00.000Z".to_string(),
            updated_at: "2026-10-10T09:30:00.000Z".to_string(),
        }
    }

    fn handlers_with(
        projection_type: &str,
        outcome: Result<(), String>,
        calls: Arc<AtomicUsize>,
    ) -> ProjectionRetryHandlers {
        let mut handlers: ProjectionRetryHandlers = HashMap::new();
        handlers.insert(
            projection_type.to_string(),
            Arc::new(move |_record: ProjectionPendingRecord| {
                let calls = Arc::clone(&calls);
                let outcome = outcome.clone();
                Box::pin(async move {
                    calls.fetch_add(1, Ordering::SeqCst);
                    outcome
                })
            }),
        );
        handlers
    }

    fn count_row(value: &str) -> Result<PgQueryResult, PgError> {
        Ok(PgQueryResult::from_rows(vec![json!({ "count": value })
            .as_object()
            .unwrap()
            .clone()]))
    }

    fn data_statements(executor: &RecordingExecutor) -> Vec<PgStatement> {
        executor
            .calls()
            .into_iter()
            .filter_map(|call| match call {
                Recorded::Statement(statement) => Some(statement),
                Recorded::Release => None,
            })
            .filter(|statement| {
                !matches!(
                    statement.sql.as_str(),
                    SQL_BEGIN | SQL_COMMIT | SQL_SET_SCOPE
                )
            })
            .collect()
    }

    #[test]
    fn a_missing_handler_is_recorded_as_a_failure_with_the_source_literal() {
        let executor = RecordingExecutor::new(vec![
            Ok(PgQueryResult::from_rows(vec![pending_row(json!({}))])),
            Ok(PgQueryResult::affected(1)),
        ]);
        let result = drive_sync(run_projection_retry_once(
            &executor,
            None,
            25,
            &ProjectionRetryHandlers::new(),
            None,
        ))
        .expect("bridge")
        .expect("retry");

        assert_eq!(
            result,
            ProjectionRetryResult {
                selected: 1,
                succeeded: 0,
                failed: 1
            }
        );
        let statements = data_statements(&executor);
        let mark_failed = statements
            .iter()
            .find(|statement| statement.sql == SQL_MARK_FAILED)
            .expect("failure mark");
        assert_eq!(
            mark_failed.params[1],
            PgValue::text("no retry handler for world_model_window")
        );
    }

    #[test]
    fn a_successful_retry_marks_success_and_clears_the_memory_flag() {
        let executor = RecordingExecutor::new(vec![
            Ok(PgQueryResult::from_rows(vec![pending_row(
                json!({ "messageIds": ["m1", "", "m2"] }),
            )])),
            Ok(PgQueryResult::affected(1)),
            count_row("0"),
        ]);
        let calls = Arc::new(AtomicUsize::new(0));
        let handlers = handlers_with("world_model_window", Ok(()), Arc::clone(&calls));
        let seen: Arc<std::sync::Mutex<Vec<String>>> = Arc::new(std::sync::Mutex::new(Vec::new()));
        let sink = Arc::clone(&seen);
        let mark: Arc<MarkMessagesMemoryPending> =
            Arc::new(move |ids: &[String], pending: bool| {
                assert!(!pending, "the settled path clears the flag");
                *sink.lock().expect("sink") = ids.to_vec();
            });

        let result = drive_sync(run_projection_retry_once(
            &executor,
            None,
            25,
            &handlers,
            Some(mark.as_ref()),
        ))
        .expect("bridge")
        .expect("retry");

        assert_eq!(result.succeeded, 1);
        assert_eq!(result.failed, 0);
        assert_eq!(calls.load(Ordering::SeqCst), 1);
        assert_eq!(
            seen.lock().expect("sink").clone(),
            vec!["m1".to_string(), "m2".to_string()]
        );
        let sqls: Vec<String> = data_statements(&executor)
            .into_iter()
            .map(|statement| statement.sql)
            .collect();
        assert!(sqls.iter().any(|sql| sql.contains("status = 'succeeded'")));
        assert!(sqls
            .iter()
            .any(|sql| sql.contains("FROM world_model_projection_pending")));
    }

    #[test]
    fn a_handler_error_is_recorded_with_its_message() {
        let executor = RecordingExecutor::new(vec![
            Ok(PgQueryResult::from_rows(vec![pending_row(json!({}))])),
            Ok(PgQueryResult::affected(1)),
        ]);
        let calls = Arc::new(AtomicUsize::new(0));
        let handlers = handlers_with("world_model_window", Err("kaboom".to_string()), calls);
        let result = drive_sync(run_projection_retry_once(
            &executor, None, 25, &handlers, None,
        ))
        .expect("bridge")
        .expect("retry");
        assert_eq!(result.failed, 1);
        let statements = data_statements(&executor);
        let mark_failed = statements
            .iter()
            .find(|statement| statement.sql == SQL_MARK_FAILED)
            .expect("failure mark");
        assert_eq!(mark_failed.params[1], PgValue::text("kaboom"));
    }

    #[test]
    fn a_still_pending_sibling_keeps_the_memory_flag_set() {
        let executor = RecordingExecutor::new(vec![count_row("2")]);
        let calls = Arc::new(AtomicUsize::new(0));
        let flag = Arc::clone(&calls);
        let mark: Arc<MarkMessagesMemoryPending> =
            Arc::new(move |_ids: &[String], _pending: bool| {
                flag.fetch_add(1, Ordering::SeqCst);
            });
        drive_sync(clear_memory_pending_if_settled(
            &executor,
            None,
            &record(json!({ "messageIds": ["m1"] })),
            Some(mark.as_ref()),
        ))
        .expect("bridge")
        .expect("clear");
        assert_eq!(
            calls.load(Ordering::SeqCst),
            0,
            "`return` before the repository call (`:48`)"
        );
    }

    #[test]
    fn message_ids_prefers_the_flat_list_and_falls_back_to_messages() {
        assert_eq!(
            message_ids(&record(json!({ "messageIds": ["a", "", "b"] }))),
            vec!["a".to_string(), "b".to_string()]
        );
        assert_eq!(
            message_ids(&record(
                json!({ "messages": [{ "id": "x" }, { "id": "" }] })
            )),
            vec!["x".to_string()]
        );
        assert!(message_ids(&record(json!({}))).is_empty());
    }

    #[test]
    fn run_tick_retries_every_discovered_scope_under_its_own_triple() {
        let executor = Arc::new(RecordingExecutor::new(vec![
            Ok(PgQueryResult::empty()),
            Ok(PgQueryResult::empty()),
        ]));
        let env = HashMap::from([
            (
                DISPATCH_SCOPES_ENV.to_string(),
                "u1:p1:w1,u2:p2:w2".to_string(),
            ),
            (
                crate::world_model::runtime::scope_discovery::MESSAGES_DB_PATH_ENV.to_string(),
                "/nonexistent/projection-retry/messages.db".to_string(),
            ),
        ]);
        let worker = Arc::new(ProjectionRetryWorker::new(
            executor.clone(),
            env,
            RuntimeRole::Worker,
            ProjectionRetryHandlers::new(),
            None,
        ));
        drive_sync(worker.run_tick()).expect("tick");

        let scopes_set: Vec<PgValue> = executor
            .calls()
            .into_iter()
            .filter_map(|call| match call {
                Recorded::Statement(statement) if statement.sql == SQL_SET_SCOPE => {
                    Some(statement.params)
                }
                _ => None,
            })
            .flatten()
            .collect();
        assert_eq!(
            scopes_set,
            vec![
                PgValue::text("u1"),
                PgValue::text("p1"),
                PgValue::text("w1"),
                PgValue::text("u2"),
                PgValue::text("p2"),
                PgValue::text("w2"),
            ]
        );
    }

    #[derive(Default)]
    struct FakeMemory {
        blocked: bool,
        stored: std::sync::Mutex<Vec<String>>,
    }

    impl MemoryFactSink for FakeMemory {
        fn factual_write_guard(&self) -> Result<(), String> {
            if self.blocked {
                Err("Mem0 factual projection is disabled in canonical mode".to_string())
            } else {
                Ok(())
            }
        }

        fn store_fact<'a>(&'a self, fact: RetryMemoryFact) -> BoxFuture<'a, Result<(), String>> {
            self.stored.lock().expect("stored").push(fact.content);
            Box::pin(async { Ok(()) })
        }
    }

    #[derive(Default)]
    struct FakeKnowledge {
        calls: AtomicUsize,
    }

    impl KnowledgeRetrySink for FakeKnowledge {
        fn retry_sqlite_knowledge<'a>(
            &'a self,
            _retry: SqliteKnowledgeRetry,
        ) -> BoxFuture<'a, Result<(), String>> {
            self.calls.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
            Box::pin(async { Ok(()) })
        }
    }

    fn retry_record(projection_type: &str, payload: Value) -> ProjectionPendingRecord {
        use crate::world_model::repositories::projection_pending_repository::ProjectionPendingStatus;
        ProjectionPendingRecord {
            id: "pending-1".to_string(),
            scope: WorldModelScope::new("u1", "p1", Some("w1".to_string())),
            projection_type: projection_type.to_string(),
            source_observation_id: Some("obs-1".to_string()),
            source_window_id: "win-1".to_string(),
            payload: payload.as_object().cloned().unwrap_or_default(),
            attempts: 0,
            status: ProjectionPendingStatus::Pending,
            error_message: None,
            next_attempt_at: "2026-10-11T12:00:00.000Z".to_string(),
            created_at: "2026-10-11T12:00:00.000Z".to_string(),
            updated_at: "2026-10-11T12:00:00.000Z".to_string(),
        }
    }

    #[test]
    fn the_mem0_retry_stops_at_the_factual_write_guard() {
        let memory = FakeMemory {
            blocked: true,
            ..Default::default()
        };
        let record = retry_record("mem0_fact", json!({ "facts": ["Mira moved to Berlin"] }));
        let error = drive_sync(retry_mem0_facts(&memory, &record))
            .expect("bridge")
            .expect_err("guarded");
        assert_eq!(
            error,
            "Mem0 factual projection is disabled in canonical mode"
        );
        assert!(memory.stored.lock().expect("stored").is_empty());
    }

    #[test]
    fn the_mem0_retry_stores_each_non_empty_fact() {
        let memory = FakeMemory::default();
        let record = retry_record(
            "mem0_fact",
            json!({ "facts": ["  Mira moved  ", "", "Lena likes tea"] }),
        );
        drive_sync(retry_mem0_facts(&memory, &record))
            .expect("bridge")
            .expect("stored");
        assert_eq!(
            *memory.stored.lock().expect("stored"),
            vec!["Mira moved".to_string(), "Lena likes tea".to_string()]
        );
    }

    #[test]
    fn a_knowledge_retry_without_source_messages_never_reaches_the_sink() {
        let knowledge = FakeKnowledge::default();
        let record = retry_record(
            "sqlite_knowledge",
            json!({ "rawExtraction": { "facts": [] }, "messages": [] }),
        );
        let error = drive_sync(retry_sqlite_knowledge(&knowledge, &record))
            .expect("bridge")
            .expect_err("no messages");
        assert_eq!(
            error,
            "sqlite knowledge retry payload has no source messages"
        );
        assert_eq!(knowledge.calls.load(std::sync::atomic::Ordering::SeqCst), 0);
    }

    #[test]
    fn a_missing_raw_extraction_fails_before_any_write() {
        let record = retry_record("world_model_window", json!({ "fromSeqExclusive": 1 }));
        assert_eq!(
            raw_extraction(&record).unwrap_err(),
            "projection retry payload has no raw extraction"
        );
    }

    #[test]
    fn the_extraction_reshaping_reads_the_ledger_and_the_event_fields() {
        let raw = json!({
            "facts": ["Mira moved"],
            "events": [{
                "eventType": "dinner", "subject": "Mira", "startDate": "2026-10-12",
                "endDate": "", "sourceSeq": [3, 4], "confirmationSignals": ["ok"],
                "isConfirmation": true
            }],
            "entities": [{
                "name": "Mira", "category": "person", "owner": "user", "sourceSeq": [3],
                "relations": [{ "targetName": "Lena", "relationType": "friend" }]
            }],
            "meetingLedger": { "confidence": 0.9, "actionItems": ["call"], "openPoints": ["where"] },
            "episode": "Mira called"
        });
        let extraction = extraction_from_json(&raw).expect("extraction");
        assert_eq!(extraction.action_items, vec!["call".to_string()]);
        assert_eq!(extraction.open_points, vec!["where".to_string()]);
        assert_eq!(extraction.confidence, 0.9);
        assert_eq!(extraction.events[0].source_seq, vec![3, 4]);
        assert!(extraction.events[0].is_confirmation);
        assert_eq!(extraction.entities[0].aliases, None);
        assert_eq!(extraction.entities[0].relations[0].target_name, "Lena");
        assert_eq!(extraction.episode.as_deref(), Some("Mira called"));
    }

    #[test]
    fn a_missing_meeting_ledger_fails_the_extraction() {
        let raw = json!({ "facts": [], "events": [], "entities": [] });
        assert_eq!(
            extraction_from_json(&raw).unwrap_err(),
            "projection retry payload has no meeting ledger"
        );
    }

    #[test]
    fn the_default_map_registers_the_three_source_handlers() {
        let handlers = default_projection_retry_handlers(
            Arc::new(RecordingExecutor::new(vec![])),
            Arc::new(FakeMemory::default()),
            Arc::new(FakeKnowledge::default()),
        );
        let mut keys: Vec<&str> = handlers.keys().map(String::as_str).collect();
        keys.sort_unstable();
        assert_eq!(
            keys,
            ["mem0_fact", "sqlite_knowledge", "world_model_window"]
        );
    }
}
