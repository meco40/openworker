//! Port of `src/server/world-model/dataLifecycle.ts:1-438` — export, restore,
//! deletion and retention of a canonical scope.
//!
//! | TypeScript | Rust |
//! | --- | --- |
//! | `dataLifecycle.ts:9-23` (`RetentionPolicy`, `DEFAULT_RETENTION`) | [`RetentionPolicy`] |
//! | `dataLifecycle.ts:25-29` (`ScopeSelector`) | [`ScopeSelector`] |
//! | `dataLifecycle.ts:31-55` (the result interfaces) | [`WorldModelExport`], [`WorldModelRestoreResult`], [`WorldModelDeletionResult`], [`WorldModelRetentionResult`] |
//! | `dataLifecycle.ts:57-65` (`assertDestructiveScope`) | [`assert_destructive_scope`] |
//! | `dataLifecycle.ts:67-69` (`scopedQuery`) | [`scoped_query`] |
//! | `dataLifecycle.ts:71-86` (`canonicalJson`) | [`canonical_json`] |
//! | `dataLifecycle.ts:88-93` (`hashWorldModelExport`) | [`hash_world_model_export`] |
//! | `dataLifecycle.ts:100-176` (`exportWorldModelScope`) | [`export_world_model_scope`] |
//! | `dataLifecycle.ts:178-247` (`restoreWorldModelScope`) | [`restore_world_model_scope`] |
//! | `dataLifecycle.ts:254-342` (`deleteWorldModelScope`) | [`delete_world_model_scope`] |
//! | `dataLifecycle.ts:349-403` (`purgeWorldModelRetention`) | [`purge_world_model_retention`] |
//! | `dataLifecycle.ts:411-434` (`buildScopeWhere`) | [`build_scope_where`] |
//! | `dataLifecycle.ts:436-438` (`retentionCutoffDays`) | [`retention_cutoff_days`] |
//!
//! # Deviations
//!
//! 1. **The ambient scope is a parameter / synthesised from the selector.**
//!    `runWithWorldModelScope` and `withWorldModelTransaction` read
//!    `getWorldModelScope()`; `exportWorldModelScope` synthesises the scope from
//!    the selector (`:104-109`) and the port passes it to the statements.
//! 2. **`new Date().toISOString()` is supplied as `now`** (`:171`, `:356`).
//! 3. **`createHash('sha256')` is `sha2::Sha256`** and the digest is hex-encoded
//!    without a helper crate.
//! 4. **The restore insert maps JSON values to the seam's [`PgValue`].** `pg`
//!    serialises an object/array parameter to its JSON text; the mapping below
//!    does the same, and every other scalar keeps its JSON form. This is only
//!    exercised against a live database; the unit tests cover the pure helpers.

use std::collections::BTreeMap;

use serde_json::{json, Map, Value};
use sha2::{Digest, Sha256};

use crate::world_model::db::{
    BoxFuture, PgError, PgExecutor, PgQueryResult, PgSession, PgStatement, PgValue,
};
use crate::world_model::repositories::{ambient_query, ambient_transaction};
use crate::world_model::scope::WorldModelScope;

/// `RetentionPolicy` from `dataLifecycle.ts:9-15`.
///
/// The days are `f64` because the TypeScript does not round them
/// (`retentionCutoffDays` returns `Math.max(0, policy[kind])`).
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct RetentionPolicy {
    pub observations_days: f64,
    pub assertions_days: f64,
    pub events_days: f64,
    pub open_loops_days: f64,
    pub outbox_days: f64,
}

/// `DEFAULT_RETENTION` from `dataLifecycle.ts:17-23`.
pub const DEFAULT_RETENTION: RetentionPolicy = RetentionPolicy {
    observations_days: 365.0,
    assertions_days: 1095.0,
    events_days: 365.0,
    open_loops_days: 90.0,
    outbox_days: 30.0,
};

impl Default for RetentionPolicy {
    fn default() -> Self {
        DEFAULT_RETENTION
    }
}

/// `ScopeSelector` from `dataLifecycle.ts:25-29`.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct ScopeSelector {
    pub user_id: Option<String>,
    pub persona_id: Option<String>,
    pub workspace_id: Option<String>,
}

/// The three scope columns an export/restore runs under (`:32`, `:40`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ResolvedScope {
    pub user_id: String,
    pub persona_id: String,
    pub workspace_id: String,
}

/// `WorldModelExport` from `dataLifecycle.ts:31-37`.
#[derive(Debug, Clone, PartialEq)]
pub struct WorldModelExport {
    pub scope: ResolvedScope,
    pub exported_at: String,
    pub schema_version: u8,
    pub manifest_hash: String,
    pub tables: BTreeMap<String, Vec<Map<String, Value>>>,
}

/// `WorldModelRestoreResult` from `dataLifecycle.ts:39-43`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WorldModelRestoreResult {
    pub scope: ResolvedScope,
    pub restored: BTreeMap<String, i64>,
    pub manifest_hash: String,
}

/// `WorldModelDeletionResult` from `dataLifecycle.ts:45-49`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WorldModelDeletionResult {
    pub scope: ScopeSelector,
    pub deleted: BTreeMap<String, i64>,
    pub external_projection_cleanup_required: Vec<String>,
}

/// `WorldModelRetentionResult` from `dataLifecycle.ts:51-55`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WorldModelRetentionResult {
    pub scope: ScopeSelector,
    pub deleted: BTreeMap<String, i64>,
    pub cutoff: BTreeMap<String, String>,
}

/// `assertDestructiveScope(scope)` — `dataLifecycle.ts:57-65`.
pub fn assert_destructive_scope(scope: &ScopeSelector) -> Result<ResolvedScope, PgError> {
    match (
        scope.user_id.as_deref(),
        scope.persona_id.as_deref(),
        scope.workspace_id.as_deref(),
    ) {
        (Some(user_id), Some(persona_id), Some(workspace_id))
            if !user_id.is_empty() && !persona_id.is_empty() =>
        {
            Ok(ResolvedScope {
                user_id: user_id.to_string(),
                persona_id: persona_id.to_string(),
                workspace_id: workspace_id.to_string(),
            })
        }
        _ => Err(PgError::new(
            "[world-model:lifecycle] destructive operations require userId, personaId and workspaceId",
        )),
    }
}

/// The `{ clause, values }` of `buildScopeWhere` — `:415-418`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ScopeWhere {
    pub clause: String,
    pub values: Vec<String>,
}

/// `buildScopeWhere(scope, startIndex, tableAlias)` — `dataLifecycle.ts:411-434`.
pub fn build_scope_where(
    scope: &ScopeSelector,
    start_index: usize,
    table_alias: Option<&str>,
) -> ScopeWhere {
    let pairs: [(&str, &Option<String>); 3] = [
        ("user_id", &scope.user_id),
        ("persona_id", &scope.persona_id),
        ("workspace_id", &scope.workspace_id),
    ];
    let mut clauses: Vec<String> = Vec::new();
    let mut values: Vec<String> = Vec::new();
    let mut index = start_index;
    for (column, value) in pairs {
        let Some(value) = value else { continue };
        let prefix = table_alias
            .map(|alias| format!("{alias}."))
            .unwrap_or_default();
        clauses.push(format!("{prefix}{column} = ${index}"));
        values.push(value.clone());
        index += 1;
    }
    ScopeWhere {
        clause: clauses.join(" AND "),
        values,
    }
}

/// `scopedQuery(scope, alias)` — `dataLifecycle.ts:67-69`.
fn scoped_query(scope: &ScopeSelector, alias: &str) -> ScopeWhere {
    build_scope_where(scope, 1, Some(alias))
}

/// `retentionCutoffDays(policy, kind)` — `dataLifecycle.ts:436-438`.
pub fn retention_cutoff_days(policy: &RetentionPolicy, kind: &str) -> f64 {
    let value = match kind {
        "observationsDays" => policy.observations_days,
        "assertionsDays" => policy.assertions_days,
        "eventsDays" => policy.events_days,
        "openLoopsDays" => policy.open_loops_days,
        "outboxDays" => policy.outbox_days,
        _ => 0.0,
    };
    value.max(0.0)
}

/// `canonicalJson(value)` — `dataLifecycle.ts:71-86`.
///
/// `Date` and `toJSON` do not exist on `serde_json::Value`; sorted object keys
/// and compact arrays are the parts the source guarantees.
pub fn canonical_json(value: &Value) -> String {
    match value {
        Value::Array(items) => {
            let rendered: Vec<String> = items.iter().map(canonical_json).collect();
            format!("[{}]", rendered.join(","))
        }
        Value::Object(map) => {
            let mut keys: Vec<&String> = map.keys().collect();
            keys.sort();
            let rendered: Vec<String> = keys
                .into_iter()
                .map(|key| {
                    let key_json =
                        serde_json::to_string(key).unwrap_or_else(|_| "null".to_string());
                    format!("{}:{}", key_json, canonical_json(&map[key]))
                })
                .collect();
            format!("{{{}}}", rendered.join(","))
        }
        other => serde_json::to_string(other).unwrap_or_else(|_| "null".to_string()),
    }
}

/// `hashWorldModelExport(input)` — `dataLifecycle.ts:88-93`.
pub fn hash_world_model_export(
    scope: &ResolvedScope,
    tables: &BTreeMap<String, Vec<Map<String, Value>>>,
) -> String {
    let tables_value = serde_json::to_value(tables).unwrap_or(Value::Object(Map::new()));
    let input = json!({
        "scope": {
            "userId": scope.user_id,
            "personaId": scope.persona_id,
            "workspaceId": scope.workspace_id,
        },
        "tables": tables_value,
    });
    let mut hasher = Sha256::new();
    hasher.update(canonical_json(&input).as_bytes());
    let digest = hasher.finalize();
    let mut hex = String::with_capacity(digest.len() * 2);
    for byte in digest {
        hex.push_str(&format!("{byte:02x}"));
    }
    hex
}

/// The `pg` parameter form of a JSON value (deviation 4).
fn pg_value(value: &Value) -> PgValue {
    match value {
        Value::Null => PgValue::Null,
        Value::Bool(flag) => PgValue::Bool(*flag),
        Value::Number(number) => match number.as_i64() {
            Some(integer) => PgValue::Int64(integer),
            None => PgValue::Float64(number.as_f64().unwrap_or(f64::NAN)),
        },
        Value::String(text) => PgValue::Text(text.clone()),
        other => PgValue::Text(other.to_string()),
    }
}

/// The transaction executor the restore/delete writers receive.
struct SessionExecutor(std::sync::Arc<dyn PgSession>);

impl PgExecutor for SessionExecutor {
    fn connect<'a>(&'a self) -> BoxFuture<'a, Result<std::sync::Arc<dyn PgSession>, PgError>> {
        Box::pin(async { Err(PgError::new("[world-model] nested transaction")) })
    }

    fn query<'a>(
        &'a self,
        statement: PgStatement,
    ) -> BoxFuture<'a, Result<PgQueryResult, PgError>> {
        self.0.query(statement)
    }
}

/// The scope `exportWorldModelScope` synthesises (`:104-109`).
fn ambient_scope(scope: &ScopeSelector) -> WorldModelScope {
    WorldModelScope::new(
        scope.user_id.clone().unwrap_or_default(),
        scope.persona_id.clone().unwrap_or_default(),
        Some(scope.workspace_id.clone().unwrap_or_default()),
    )
}

/// `dataLifecycle.ts:120-138` — the sixteen flat tables of the export.
const EXPORT_TABLES: [&str; 16] = [
    "world_model_observations",
    "world_model_entities",
    "world_model_entity_relations",
    "world_model_assertions",
    "world_model_events",
    "world_model_tasks",
    "world_model_action_attempts",
    "world_model_open_loops",
    "world_model_standing_intents",
    "world_model_outbox_events",
    "world_model_embeddings",
    "world_model_ingestion_checkpoints",
    "world_model_projection_pending",
    "world_model_delivery_receipts",
    "world_model_rebuild_checkpoints",
    "world_model_graphiti_shadow",
];

/// `exportWorldModelScope(scope)` — `dataLifecycle.ts:100-112`.
pub async fn export_world_model_scope(
    executor: &dyn PgExecutor,
    scope: &ScopeSelector,
    exported_at: &str,
) -> Result<WorldModelExport, PgError> {
    export_world_model_scope_in_scope(executor, scope, exported_at).await
}

/// `exportWorldModelScopeInScope(scope, db)` — `dataLifecycle.ts:114-176`.
async fn export_world_model_scope_in_scope(
    executor: &dyn PgExecutor,
    scope: &ScopeSelector,
    exported_at: &str,
) -> Result<WorldModelExport, PgError> {
    let resolved = assert_destructive_scope(scope)?;
    let ambient = ambient_scope(scope);
    let scoped = scoped_query(scope, "row");

    let mut table_queries: Vec<(String, String)> = EXPORT_TABLES
        .iter()
        .map(|table| (table.to_string(), format!("SELECT row.* FROM {table} row")))
        .collect();
    table_queries.push((
        "world_model_event_transitions".to_string(),
        "SELECT transition.* FROM world_model_event_transitions transition JOIN world_model_events parent ON parent.id = transition.event_id".to_string(),
    ));
    table_queries.push((
        "world_model_task_transitions".to_string(),
        "SELECT transition.* FROM world_model_task_transitions transition JOIN world_model_tasks parent ON parent.id = transition.task_id".to_string(),
    ));

    let params: Vec<PgValue> = scoped.values.iter().map(PgValue::text).collect();
    let mut tables: BTreeMap<String, Vec<Map<String, Value>>> = BTreeMap::new();
    for (name, query) in &table_queries {
        let clause =
            if name == "world_model_event_transitions" || name == "world_model_task_transitions" {
                scoped.clause.replace("row.", "parent.")
            } else {
                scoped.clause.clone()
            };
        let result = ambient_query::<PgError>(
            executor,
            Some(&ambient),
            PgStatement::with_params(format!("{query} WHERE {clause}"), params.clone()),
        )
        .await?;
        tables.insert(name.clone(), result.rows);
    }
    let manifest_hash = hash_world_model_export(&resolved, &tables);
    Ok(WorldModelExport {
        scope: resolved,
        exported_at: exported_at.to_string(),
        schema_version: 1,
        manifest_hash,
        tables,
    })
}

/// `RESTORE_TABLE_ORDER` from `dataLifecycle.ts:178-197`.
const RESTORE_TABLE_ORDER: [&str; 18] = [
    "world_model_observations",
    "world_model_entities",
    "world_model_entity_relations",
    "world_model_assertions",
    "world_model_events",
    "world_model_tasks",
    "world_model_action_attempts",
    "world_model_open_loops",
    "world_model_standing_intents",
    "world_model_outbox_events",
    "world_model_embeddings",
    "world_model_ingestion_checkpoints",
    "world_model_projection_pending",
    "world_model_delivery_receipts",
    "world_model_rebuild_checkpoints",
    "world_model_graphiti_shadow",
    "world_model_event_transitions",
    "world_model_task_transitions",
];

/// `assertExportScope(exported, scope)` — `dataLifecycle.ts:199-215`.
pub fn assert_export_scope(
    exported: &WorldModelExport,
    scope: &ResolvedScope,
) -> Result<(), PgError> {
    if exported.schema_version != 1 {
        return Err(PgError::new("Unsupported World Model export schema."));
    }
    if exported.scope != *scope {
        return Err(PgError::new(
            "World Model export scope does not match the requested restore scope.",
        ));
    }
    let expected = hash_world_model_export(scope, &exported.tables);
    if expected != exported.manifest_hash {
        return Err(PgError::new(
            "World Model export manifest hash does not match its table contents.",
        ));
    }
    Ok(())
}

/// `restoreWorldModelScope(scope, exported)` — `dataLifecycle.ts:218-247`.
pub async fn restore_world_model_scope(
    executor: &dyn PgExecutor,
    scope: &ScopeSelector,
    exported: &WorldModelExport,
) -> Result<WorldModelRestoreResult, PgError> {
    let resolved = assert_destructive_scope(scope)?;
    assert_export_scope(exported, &resolved)?;
    let ambient = ambient_scope(scope);
    let tables = exported.tables.clone();
    let manifest_hash = exported.manifest_hash.clone();
    let resolved_for_body = resolved.clone();
    ambient_transaction::<WorldModelRestoreResult, PgError>(
        executor,
        Some(&ambient),
        Box::new(move |session| {
            Box::pin(async move {
                let transaction_executor = SessionExecutor(session);
                let mut restored: BTreeMap<String, i64> = BTreeMap::new();
                for table in RESTORE_TABLE_ORDER {
                    let rows = tables.get(table).cloned().unwrap_or_default();
                    let mut count = 0i64;
                    for row in rows {
                        if row.is_empty() {
                            continue;
                        }
                        let keys: Vec<&String> = row.keys().collect();
                        let columns: Vec<String> = keys
                            .iter()
                            .map(|key| format!("\"{}\"", key.replace('"', "\"\"")))
                            .collect();
                        let placeholders: Vec<String> = (0..keys.len())
                            .map(|index| format!("${}", index + 1))
                            .collect();
                        let values: Vec<PgValue> =
                            keys.iter().map(|key| pg_value(&row[*key])).collect();
                        let result = transaction_executor
                            .query(PgStatement::with_params(
                                format!(
                                    "INSERT INTO {table} ({}) VALUES ({}) ON CONFLICT DO NOTHING",
                                    columns.join(", "),
                                    placeholders.join(", ")
                                ),
                                values,
                            ))
                            .await?;
                        count += result.row_count;
                    }
                    restored.insert(table.to_string(), count);
                }
                Ok(WorldModelRestoreResult {
                    scope: resolved_for_body,
                    restored,
                    manifest_hash,
                })
            })
        }),
    )
    .await
}

/// The delete order of `dataLifecycle.ts:261-326`.
const DELETE_STATEMENTS: [(&str, &str); 16] = [
    ("world_model_delivery_receipts", "DELETE FROM world_model_delivery_receipts WHERE user_id = $1 AND persona_id = $2 AND workspace_id = $3"),
    ("world_model_projection_pending", "DELETE FROM world_model_projection_pending WHERE user_id = $1 AND persona_id = $2 AND workspace_id = $3"),
    ("world_model_outbox_events", "DELETE FROM world_model_outbox_events WHERE user_id = $1 AND persona_id = $2 AND workspace_id = $3"),
    ("world_model_graphiti_shadow", "DELETE FROM world_model_graphiti_shadow WHERE user_id = $1 AND persona_id = $2 AND workspace_id = $3"),
    ("world_model_rebuild_checkpoints", "DELETE FROM world_model_rebuild_checkpoints WHERE user_id = $1 AND persona_id = $2 AND workspace_id = $3"),
    ("world_model_ingestion_checkpoints", "DELETE FROM world_model_ingestion_checkpoints WHERE user_id = $1 AND persona_id = $2 AND workspace_id = $3"),
    ("world_model_action_attempts", "DELETE FROM world_model_action_attempts WHERE user_id = $1 AND persona_id = $2 AND workspace_id = $3"),
    ("world_model_open_loops", "DELETE FROM world_model_open_loops WHERE user_id = $1 AND persona_id = $2 AND workspace_id = $3"),
    ("world_model_standing_intents", "DELETE FROM world_model_standing_intents WHERE user_id = $1 AND persona_id = $2 AND workspace_id = $3"),
    ("world_model_assertions", "DELETE FROM world_model_assertions WHERE user_id = $1 AND persona_id = $2 AND workspace_id = $3"),
    ("world_model_events", "DELETE FROM world_model_events WHERE user_id = $1 AND persona_id = $2 AND workspace_id = $3"),
    ("world_model_tasks", "DELETE FROM world_model_tasks WHERE user_id = $1 AND persona_id = $2 AND workspace_id = $3"),
    ("world_model_entity_relations", "DELETE FROM world_model_entity_relations WHERE user_id = $1 AND persona_id = $2 AND workspace_id = $3"),
    ("world_model_embeddings", "DELETE FROM world_model_embeddings WHERE user_id = $1 AND persona_id = $2 AND workspace_id = $3"),
    ("world_model_entities", "DELETE FROM world_model_entities WHERE user_id = $1 AND persona_id = $2 AND workspace_id = $3"),
    ("world_model_observations", "DELETE FROM world_model_observations WHERE user_id = $1 AND persona_id = $2 AND workspace_id = $3"),
];

/// `deleteWorldModelScope(scope)` — `dataLifecycle.ts:254-342`.
pub async fn delete_world_model_scope(
    executor: &dyn PgExecutor,
    scope: &ScopeSelector,
) -> Result<WorldModelDeletionResult, PgError> {
    let resolved = assert_destructive_scope(scope)?;
    let ambient = ambient_scope(scope);
    let scope_for_result = scope.clone();
    ambient_transaction::<WorldModelDeletionResult, PgError>(
        executor,
        Some(&ambient),
        Box::new(move |session| {
            Box::pin(async move {
                let transaction_executor = SessionExecutor(session);
                let params = vec![
                    PgValue::text(resolved.user_id.as_str()),
                    PgValue::text(resolved.persona_id.as_str()),
                    PgValue::text(resolved.workspace_id.as_str()),
                ];
                let mut deleted: BTreeMap<String, i64> = BTreeMap::new();
                for (table, query) in DELETE_STATEMENTS {
                    let result = transaction_executor
                        .query(PgStatement::with_params(query, params.clone()))
                        .await?;
                    deleted.insert(table.to_string(), result.row_count);
                }
                Ok(WorldModelDeletionResult {
                    scope: scope_for_result,
                    deleted,
                    external_projection_cleanup_required: vec![
                        "mem0".to_string(),
                        "graphiti".to_string(),
                    ],
                })
            })
        }),
    )
    .await
}

/// The `now` - `days * 86_400_000` cutoff of `dataLifecycle.ts:356-362`.
fn cutoff_iso(now_ms: i64, days: f64) -> String {
    let millis = now_ms - (days * 86_400_000.0) as i64;
    chrono::DateTime::from_timestamp_millis(millis)
        .map(|instant| instant.to_rfc3339_opts(chrono::SecondsFormat::Millis, true))
        .unwrap_or_default()
}

/// `purgeWorldModelRetention(scope, policy)` — `dataLifecycle.ts:349-403`.
pub async fn purge_world_model_retention(
    executor: &dyn PgExecutor,
    scope: &ScopeSelector,
    policy: &RetentionPolicy,
    now_ms: i64,
) -> Result<WorldModelRetentionResult, PgError> {
    let resolved = assert_destructive_scope(scope)?;
    let ambient = ambient_scope(scope);
    let mut cutoff: BTreeMap<String, String> = BTreeMap::new();
    for kind in [
        "observationsDays",
        "assertionsDays",
        "eventsDays",
        "openLoopsDays",
        "outboxDays",
    ] {
        cutoff.insert(
            kind.to_string(),
            cutoff_iso(now_ms, retention_cutoff_days(policy, kind)),
        );
    }
    let statements: [(&str, &str); 5] = [
        (
            "world_model_assertions",
            "DELETE FROM world_model_assertions WHERE user_id = $1 AND persona_id = $2 AND workspace_id = $3 AND known_to IS NOT NULL AND known_to < $4",
        ),
        (
            "world_model_events",
            "DELETE FROM world_model_events WHERE user_id = $1 AND persona_id = $2 AND workspace_id = $3 AND status IN ('completed','cancelled','no_show') AND updated_at < $4",
        ),
        (
            "world_model_open_loops",
            "DELETE FROM world_model_open_loops WHERE user_id = $1 AND persona_id = $2 AND workspace_id = $3 AND status IN ('answered','resolved','cancelled','expired') AND updated_at < $4",
        ),
        (
            "world_model_outbox_events",
            "DELETE FROM world_model_outbox_events WHERE user_id = $1 AND persona_id = $2 AND workspace_id = $3 AND status IN ('dispatched','permanent_failure') AND created_at < $4",
        ),
        (
            "world_model_observations",
            "DELETE FROM world_model_observations WHERE user_id = $1 AND persona_id = $2 AND workspace_id = $3 AND received_at < $4",
        ),
    ];
    let scope_for_result = scope.clone();
    let cutoff_for_body = cutoff.clone();
    let resolved_for_body = resolved.clone();
    ambient_transaction::<WorldModelRetentionResult, PgError>(
        executor,
        Some(&ambient),
        Box::new(move |session| {
            Box::pin(async move {
                let transaction_executor = SessionExecutor(session);
                let mut deleted: BTreeMap<String, i64> = BTreeMap::new();
                for (table, query) in statements {
                    let cutoff_value = cutoff_for_body
                        .get(cutoff_key(table))
                        .cloned()
                        .unwrap_or_default();
                    let result = transaction_executor
                        .query(PgStatement::with_params(
                            query,
                            vec![
                                PgValue::text(resolved_for_body.user_id.as_str()),
                                PgValue::text(resolved_for_body.persona_id.as_str()),
                                PgValue::text(resolved_for_body.workspace_id.as_str()),
                                PgValue::text(cutoff_value),
                            ],
                        ))
                        .await?;
                    deleted.insert(table.to_string(), result.row_count);
                }
                Ok(WorldModelRetentionResult {
                    scope: scope_for_result,
                    deleted,
                    cutoff: cutoff_for_body,
                })
            })
        }),
    )
    .await
}

/// The cutoff key a retention statement reads (`:368`, `:373`, `:378`, `:383`,
/// `:388`).
fn cutoff_key(table: &str) -> &'static str {
    match table {
        "world_model_assertions" => "assertionsDays",
        "world_model_events" => "eventsDays",
        "world_model_open_loops" => "openLoopsDays",
        "world_model_outbox_events" => "outboxDays",
        "world_model_observations" => "observationsDays",
        _ => "",
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::world_model::db::testing::Recorded;
    use crate::world_model::db::testing::RecordingExecutor;
    use crate::world_model::db::{drive_sync, PgQueryResult, SQL_BEGIN, SQL_COMMIT, SQL_SET_SCOPE};
    use serde_json::json;

    fn full_scope() -> ScopeSelector {
        ScopeSelector {
            user_id: Some("u1".into()),
            persona_id: Some("p1".into()),
            workspace_id: Some("w1".into()),
        }
    }

    #[test]
    fn build_scope_where_skips_absent_columns_and_numbers_placeholders() {
        let where_clause = build_scope_where(&full_scope(), 1, Some("row"));
        assert_eq!(
            where_clause.clause,
            "row.user_id = $1 AND row.persona_id = $2 AND row.workspace_id = $3"
        );
        assert_eq!(where_clause.values, vec!["u1", "p1", "w1"]);
        let partial = ScopeSelector {
            user_id: Some("u1".into()),
            persona_id: None,
            workspace_id: Some("w1".into()),
        };
        let where_clause = build_scope_where(&partial, 2, None);
        assert_eq!(where_clause.clause, "user_id = $2 AND workspace_id = $3");
        assert_eq!(where_clause.values, vec!["u1", "w1"]);
    }

    #[test]
    fn destructive_scope_requires_all_three_columns() {
        assert!(assert_destructive_scope(&full_scope()).is_ok());
        let error = assert_destructive_scope(&ScopeSelector {
            user_id: Some("u1".into()),
            persona_id: Some("".into()),
            workspace_id: Some("w1".into()),
        })
        .expect_err("empty persona");
        assert_eq!(
            error.message,
            "[world-model:lifecycle] destructive operations require userId, personaId and workspaceId"
        );
        assert!(assert_destructive_scope(&ScopeSelector {
            user_id: Some("u1".into()),
            persona_id: Some("p1".into()),
            workspace_id: None,
        })
        .is_err());
    }

    #[test]
    fn canonical_json_sorts_object_keys() {
        let a = json!({ "b": 1, "a": [2, 3] });
        let b = json!({ "a": [2, 3], "b": 1 });
        assert_eq!(canonical_json(&a), canonical_json(&b));
        assert_eq!(canonical_json(&a), "{\"a\":[2,3],\"b\":1}");
    }

    #[test]
    fn the_export_hash_is_stable_and_content_sensitive() {
        let scope = ResolvedScope {
            user_id: "u1".into(),
            persona_id: "p1".into(),
            workspace_id: "w1".into(),
        };
        let mut tables: BTreeMap<String, Vec<Map<String, Value>>> = BTreeMap::new();
        tables.insert(
            "world_model_events".to_string(),
            vec![json!({ "id": "e1", "status": "planned" })
                .as_object()
                .unwrap()
                .clone()],
        );
        let first = hash_world_model_export(&scope, &tables);
        let second = hash_world_model_export(&scope, &tables);
        assert_eq!(first, second);
        assert_eq!(first.len(), 64);
        let mut other: BTreeMap<String, Vec<Map<String, Value>>> = BTreeMap::new();
        other.insert("world_model_events".to_string(), vec![]);
        assert_ne!(first, hash_world_model_export(&scope, &other));
    }

    #[test]
    fn retention_cutoff_days_clamps_negative_and_cutoff_uses_millis() {
        let policy = RetentionPolicy {
            observations_days: -5.0,
            ..DEFAULT_RETENTION
        };
        assert_eq!(retention_cutoff_days(&policy, "observationsDays"), 0.0);
        assert_eq!(
            retention_cutoff_days(&DEFAULT_RETENTION, "outboxDays"),
            30.0
        );
        assert_eq!(cutoff_iso(0, 1.0), "1969-12-31T00:00:00.000Z");
    }

    #[test]
    fn deletion_runs_every_table_in_one_scoped_transaction() {
        let answers: Vec<Result<PgQueryResult, PgError>> =
            (0..16).map(|_| Ok(PgQueryResult::empty())).collect();
        let executor = RecordingExecutor::new(answers);
        let result = drive_sync(delete_world_model_scope(&executor, &full_scope()))
            .expect("bridge")
            .expect("delete");
        assert_eq!(result.deleted.len(), 16);
        assert_eq!(result.deleted.get("world_model_observations"), Some(&0));
        assert_eq!(
            result.external_projection_cleanup_required,
            vec!["mem0".to_string(), "graphiti".to_string()]
        );
        let calls = executor.calls();
        assert_eq!(calls[0].sql(), SQL_BEGIN);
        assert_eq!(calls[1].sql(), SQL_SET_SCOPE);
        assert_eq!(calls.len(), 20);
        assert_eq!(calls[calls.len() - 2].sql(), SQL_COMMIT);
        assert_eq!(calls.last(), Some(&Recorded::Release));
    }
}
