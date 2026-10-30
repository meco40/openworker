//! Port of `src/server/world-model/embeddings/embeddingWorker.ts:1-468` — the
//! asynchronous embedding worker of the semantic recall branch.
//!
//! | TypeScript | Rust |
//! | --- | --- |
//! | `embeddingWorker.ts:22-28` (`EmbeddingTarget`) | [`EmbeddingTarget`] |
//! | `embeddingWorker.ts:30-37` (`EmbeddingResult`) | [`EmbeddingResult`] |
//! | `embeddingWorker.ts:39-45` (`EmbeddingWorkerDeps`) | [`EmbeddingWorkerDeps`] |
//! | `embeddingWorker.ts:47-48` (defaults) | [`DEFAULT_MODEL`], [`DEFAULT_MODEL_VERSION`] |
//! | `embeddingWorker.ts:55-62` (`collectEmbeddingTargets`) | [`collect_embedding_targets`] |
//! | `embeddingWorker.ts:64-264` (`collectEmbeddingTargetsInScope`) | [`collect_embedding_targets_in_scope`] |
//! | `embeddingWorker.ts:269-307` (`processEmbeddingBatch`) | [`process_embedding_batch`] |
//! | `embeddingWorker.ts:309-386` (`processEmbeddingTarget`) | [`process_embedding_target`] |
//! | `embeddingWorker.ts:392-412` (`runEmbeddingWorkerOnce`) | [`run_embedding_worker_once`] |
//! | `embeddingWorker.ts:417-468` (`startEmbeddingWorker`) | [`EmbeddingWorker`], [`EmbeddingWorkerHandle`] |
//!
//! # Deviations
//!
//! 1. **The ambient scope is a parameter.** `:60` wraps the collection and
//!    `:293` wraps each target in `runWithWorldModelScope`; the port hands the
//!    same `Option<&WorldModelScope>` to `ambient_query` and [`process_embedding_target`],
//!    the documented replacement for the `AsyncLocalStorage` (`db.ts:11`).
//! 2. **The environment and the config are parameters.** `:273`, `:283` read
//!    `getWorldModelConfig()` and `process.env.EMBEDDING_CONCURRENCY`; the port
//!    takes the resolved [`WorldModelConfig`] and the environment map, so a test
//!    never mutates the process.
//! 3. **The configured provider is injected.** `:276` calls
//!    `getConfiguredEmbeddingProvider()`; the port takes
//!    `Option<Arc<dyn EmbeddingProvider>>` — `None` is the unconfigured
//!    installation whose target is skipped (`:341-348`).
//! 4. **`collectEmbeddingTargetsInScope` keeps the source's one `try`/`catch`.**
//!    `:75-261` wraps six queries and their row loops in a single block; a failing
//!    statement skips the statements and loops after it. The port models that as a
//!    sequential abort on the first `Err`, so the partial list is returned
//!    exactly like the source returns `targets.slice(0, limit)`.
//! 5. **The batch limiter is a chunked `join_all`.** `:286-304` runs
//!    `min(concurrency, targets.length)` pull-workers over a shared `nextIndex`;
//!    the port keeps the same `concurrency` bound and the same output order by
//!    resolving each `chunks(concurrency)` window with `join_all`. The
//!    concurrency limit and the ordering are identical, only the dynamic
//!    scheduling differs.
//! 6. **`startEmbeddingWorker` is a struct plus a spawn.** `:417-468` returns
//!    `{ stop }` over a `setInterval`; Rust models the same state as
//!    [`EmbeddingWorker::run_tick`] (the interval body, including the
//!    `tickInFlight` overlap guard and the scope fan-out) plus
//!    [`EmbeddingWorker::start`], which spawns a `tokio` interval task and returns
//!    an [`EmbeddingWorkerHandle`].
//! 7. **The embedding vector is serialised with JavaScript number formatting.**
//!    `:370` writes `JSON.stringify(embedding)`; `serde_json` renders `1.0` as
//!    `1.0` while JavaScript renders `1`, so [`embedding_json`] builds the array
//!    one [`f64::to_string`] at a time.
//! 8. **A rejected `generateEmbedding` skips the target.** `:296-301` catches the
//!    rejection and logs; the port logs the same line and answers `None` from
//!    [`process_embedding_target`], which the batch then drops.

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use futures_util::future::join_all;
use serde_json::Value;

use crate::js::js_number_str;
use crate::world_model::config::WorldModelConfig;
use crate::world_model::db::{BoxFuture, PgError, PgExecutor, PgRow, PgStatement, PgValue};
use crate::world_model::embeddings::embedding_text::{
    build_embedding_text, hash_text, EmbeddingTargetType,
};
use crate::world_model::embeddings::provider::EmbeddingProvider;
use crate::world_model::repositories::{ambient_query, row_optional_text, row_text};
use crate::world_model::scope::WorldModelScope;

/// `DEFAULT_MODEL` from `embeddingWorker.ts:47`.
pub const DEFAULT_MODEL: &str = "text-embedding-3-small";
/// `DEFAULT_MODEL_VERSION` from `embeddingWorker.ts:48`.
pub const DEFAULT_MODEL_VERSION: &str = "1";

/// `EMBEDDING_CONCURRENCY` from `embeddingWorker.ts:283`.
pub const EMBEDDING_CONCURRENCY_ENV: &str = "EMBEDDING_CONCURRENCY";

/// `generateEmbedding?: (text: string) => Promise<number[]>`
/// (`embeddingWorker.ts:41`).
///
/// Rust has no rejection channel on a `Promise`, so the [`Result`]'s `Err` is
/// the rejection the surrounding `try`/`catch` of `:292-301` swallows.
pub type GenerateEmbedding =
    Arc<dyn Fn(String) -> BoxFuture<'static, Result<Vec<f64>, String>> + Send + Sync>;

/// The `throw new Error(...)` of `:351`.
pub const INVALID_VECTOR_MESSAGE: &str = "embedding provider returned an invalid vector";

/// `EmbeddingTarget` from `embeddingWorker.ts:22-28`.
///
/// `targetType` is the source union; the SQL column is `text`, so the port keeps
/// a `String` and never rejects a value the database would store.
#[derive(Debug, Clone, PartialEq)]
pub struct EmbeddingTarget {
    pub target_type: String,
    pub target_id: String,
    pub scope: WorldModelScope,
    pub text: String,
    pub text_hash: String,
}

/// `EmbeddingResult` from `embeddingWorker.ts:30-37`.
#[derive(Debug, Clone, PartialEq)]
pub struct EmbeddingResult {
    pub target_type: String,
    pub target_id: String,
    pub embedding: Vec<f64>,
    pub model: String,
    pub model_version: String,
    pub created: bool,
}

/// `EmbeddingWorkerDeps` from `embeddingWorker.ts:39-45`.
///
/// The optional `generateEmbedding` callback is `Option<Arc<…>>`: `None` is the
/// absent property, `Some` the provided one. The callback's `Promise<number[]>`
/// rejection is the `Result`'s `Err`.
#[derive(Clone, Default)]
pub struct EmbeddingWorkerDeps {
    pub generate_embedding: Option<GenerateEmbedding>,
    pub model: Option<String>,
    pub model_version: Option<String>,
}

/// The `{ collected, processed, created }` answer of `:392-412`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct EmbeddingWorkerStats {
    pub collected: usize,
    pub processed: usize,
    pub created: usize,
}

// ─── Collection ─────────────────────────────────────────────────────────────

/// `scopeFilter` fragments of `:76-82` and the per-table aliases.
fn scope_filter(alias: &str, scoped: bool) -> String {
    if scoped {
        format!(
            " AND {alias}.user_id = $1 AND {alias}.persona_id = $2 AND {alias}.workspace_id = $3"
        )
    } else {
        String::new()
    }
}

/// `limitParam` of `:82` — `$4` when scoped, `$1` otherwise.
fn limit_placeholder(scoped: bool) -> &'static str {
    if scoped {
        "$4"
    } else {
        "$1"
    }
}

/// `scope ? [scope.userId, scope.personaId, scope.workspaceId ?? '', perTypeLimit] : [perTypeLimit]`.
fn limit_params(scope: Option<&WorldModelScope>, limit: i64) -> Vec<PgValue> {
    match scope {
        Some(scope) => vec![
            PgValue::text(scope.user_id.as_str()),
            PgValue::text(scope.persona_id.as_str()),
            PgValue::text(scope.workspace_id.clone().unwrap_or_default()),
            PgValue::int(limit),
        ],
        None => vec![PgValue::int(limit)],
    }
}

/// `Math.max(1, Math.ceil(Math.max(1, limit) / 6))` — `:73`.
fn per_type_limit(limit: f64) -> i64 {
    (limit.max(1.0) / 6.0).ceil().max(1.0) as i64
}

/// `typeof row.payload === 'object' ? JSON.stringify(row.payload) : String(row.payload ?? '')`
/// — `:101-102`.
///
/// JavaScript's `typeof null` is `'object'`, so `null` stringifies to `"null"`
/// like the source; `undefined` is the `?? ''` empty string.
fn payload_text(value: Option<&Value>) -> String {
    match value {
        Some(Value::Object(_)) | Some(Value::Array(_)) | Some(Value::Null) => {
            serde_json::to_string(value.expect("checked Some")).unwrap_or_default()
        }
        Some(Value::String(text)) => text.clone(),
        Some(Value::Bool(flag)) => flag.to_string(),
        Some(Value::Number(number)) => number.to_string(),
        None => String::new(),
    }
}

/// The `JSON.stringify(number[])` that `:370` writes, one
/// `Number.prototype.toString` element at a time.
///
/// Rust's `f64` `Display` prints an integral value without the `.0` (`1.0` →
/// `1`), which is what JavaScript does; only the exponential spelling of very
/// large or very small magnitudes (`1e+21`) differs, and an embedding never
/// carries those.
fn embedding_json(embedding: &[f64]) -> String {
    let parts: Vec<String> = embedding.iter().map(|value| value.to_string()).collect();
    format!("[{}]", parts.join(","))
}

/// `targets.slice(0, limit)` of `:263`.
fn truncate(mut targets: Vec<EmbeddingTarget>, limit: f64) -> Vec<EmbeddingTarget> {
    let bound = if limit.is_finite() && limit >= 0.0 {
        limit as usize
    } else {
        0
    };
    targets.truncate(bound);
    targets
}

/// The `catch` of `:259-261`: log, then return the partial list.
fn collect_failed(
    targets: Vec<EmbeddingTarget>,
    limit: f64,
    error: &PgError,
) -> Vec<EmbeddingTarget> {
    tracing::error!(
        "[world-model:embeddings] failed to collect targets: {}",
        crate::safe_error_message(error)
    );
    truncate(targets, limit)
}

/// The row shape pushed by `:108-114` and its siblings.
fn target_from_row(
    target_type: &str,
    row: &PgRow,
    text: String,
    text_hash: String,
) -> EmbeddingTarget {
    EmbeddingTarget {
        target_type: target_type.to_string(),
        target_id: row_text(row, "id"),
        scope: WorldModelScope::new(
            row_text(row, "user_id"),
            row_text(row, "persona_id"),
            Some(row_text(row, "workspace_id")),
        ),
        text,
        text_hash,
    }
}

/// `getWorldModelDb().query(text, values)` for one of the six collection
/// statements.
async fn query_rows(
    executor: &dyn PgExecutor,
    scope: Option<&WorldModelScope>,
    sql: String,
    params: Vec<PgValue>,
) -> Result<Vec<PgRow>, PgError> {
    let result =
        ambient_query::<PgError>(executor, scope, PgStatement::with_params(sql, params)).await?;
    Ok(result.rows)
}

/// `collectEmbeddingTargets(limit, scope)` — `embeddingWorker.ts:55-62`.
pub async fn collect_embedding_targets(
    executor: &dyn PgExecutor,
    scope: Option<&WorldModelScope>,
    limit: f64,
) -> Vec<EmbeddingTarget> {
    collect_embedding_targets_in_scope(executor, scope, limit).await
}

/// `collectEmbeddingTargetsInScope(limit, scope)` — `embeddingWorker.ts:64-264`.
///
/// The six statements and their row loops run in source order. A failing
/// statement ends the collection, exactly like the single `try`/`catch` of the
/// source (`:75-261`) which returns the partial list.
pub async fn collect_embedding_targets_in_scope(
    executor: &dyn PgExecutor,
    scope: Option<&WorldModelScope>,
    limit: f64,
) -> Vec<EmbeddingTarget> {
    let per_type_limit = per_type_limit(limit);
    let scoped = scope.is_some();
    let mut targets: Vec<EmbeddingTarget> = Vec::new();

    // Observations (`:87-99`).
    let obs_sql = format!(
        "SELECT o.id, o.user_id, o.persona_id, o.workspace_id, o.payload\n       FROM world_model_observations o\n       WHERE 1=1 {}\n       ORDER BY o.received_at DESC LIMIT {}",
        scope_filter("o", scoped),
        limit_placeholder(scoped)
    );
    let obs_rows = match query_rows(
        executor,
        scope,
        obs_sql,
        limit_params(scope, per_type_limit),
    )
    .await
    {
        Ok(rows) => rows,
        Err(error) => return collect_failed(targets, limit, &error),
    };
    for row in &obs_rows {
        let text = payload_text(row.get("payload"));
        let built = build_embedding_text(EmbeddingTargetType::Episode, &[text], None);
        if !built.text.is_empty() {
            targets.push(target_from_row(
                "observation",
                row,
                built.text,
                built.text_hash,
            ));
        }
    }

    // Memory items (`:118-133`).
    let memory_sql = format!(
        "SELECT m.id, m.user_id, m.persona_id, m.workspace_id, m.content\n       FROM world_model_memory_items m\n       WHERE m.deleted_at IS NULL\n       {}\n       ORDER BY m.updated_at DESC LIMIT {}",
        if scoped { "AND m.user_id = $1 AND m.persona_id = $2 AND m.workspace_id = $3" } else { "" },
        limit_placeholder(scoped)
    );
    let memory_rows = match query_rows(
        executor,
        scope,
        memory_sql,
        limit_params(scope, per_type_limit),
    )
    .await
    {
        Ok(rows) => rows,
        Err(error) => return collect_failed(targets, limit, &error),
    };
    for row in &memory_rows {
        let built = build_embedding_text(
            EmbeddingTargetType::Memory,
            &[row_text(row, "content")],
            None,
        );
        if !built.text.is_empty() {
            targets.push(target_from_row("memory", row, built.text, built.text_hash));
        }
    }

    // Assertions (`:148-164`).
    let assertion_sql = format!(
        "SELECT a.id, a.user_id, a.persona_id, a.workspace_id, a.predicate, a.object_value\n       FROM world_model_assertions a\n       WHERE a.status = 'active' AND a.known_to IS NULL\n       {}\n       ORDER BY a.known_from DESC LIMIT {}",
        if scoped { "AND a.user_id = $1 AND a.persona_id = $2 AND a.workspace_id = $3" } else { "" },
        limit_placeholder(scoped)
    );
    let assertion_rows = match query_rows(
        executor,
        scope,
        assertion_sql,
        limit_params(scope, per_type_limit),
    )
    .await
    {
        Ok(rows) => rows,
        Err(error) => return collect_failed(targets, limit, &error),
    };
    for row in &assertion_rows {
        let text = format!(
            "{}: {}",
            row_text(row, "predicate"),
            row_optional_text(row, "object_value").unwrap_or_default()
        )
        .trim()
        .to_string();
        if !text.is_empty() {
            let text_hash = hash_text(&text);
            targets.push(target_from_row("assertion", row, text, text_hash));
        }
    }

    // Entities (`:178-193`).
    let entity_sql = format!(
        "SELECT e.id, e.user_id, e.persona_id, e.workspace_id, e.canonical_name, e.category\n       FROM world_model_entities e\n       WHERE 1=1 {}\n       ORDER BY e.created_at ASC LIMIT {}",
        scope_filter("e", scoped),
        limit_placeholder(scoped)
    );
    let entity_rows = match query_rows(
        executor,
        scope,
        entity_sql,
        limit_params(scope, per_type_limit),
    )
    .await
    {
        Ok(rows) => rows,
        Err(error) => return collect_failed(targets, limit, &error),
    };
    for row in &entity_rows {
        let text = format!(
            "{} ({})",
            row_text(row, "canonical_name"),
            row_text(row, "category")
        );
        let text_hash = hash_text(&text);
        targets.push(target_from_row("entity", row, text, text_hash));
    }

    // Events (`:205-221`).
    let event_sql = format!(
        "SELECT e.id, e.user_id, e.persona_id, e.workspace_id, e.title, e.event_type, e.status\n       FROM world_model_events e\n       WHERE 1=1 {}\n       ORDER BY e.updated_at DESC LIMIT {}",
        scope_filter("e", scoped),
        limit_placeholder(scoped)
    );
    let event_rows = match query_rows(
        executor,
        scope,
        event_sql,
        limit_params(scope, per_type_limit),
    )
    .await
    {
        Ok(rows) => rows,
        Err(error) => return collect_failed(targets, limit, &error),
    };
    for row in &event_rows {
        let text = format!(
            "{} ({}) status={}",
            row_text(row, "title"),
            row_text(row, "event_type"),
            row_text(row, "status")
        );
        let text_hash = hash_text(&text);
        targets.push(target_from_row("event", row, text, text_hash));
    }

    // Tasks (`:233-248`).
    let task_sql = format!(
        "SELECT t.id, t.user_id, t.persona_id, t.workspace_id, t.title, t.status\n       FROM world_model_tasks t\n       WHERE 1=1 {}\n       ORDER BY t.updated_at DESC LIMIT {}",
        scope_filter("t", scoped),
        limit_placeholder(scoped)
    );
    let task_rows = match query_rows(
        executor,
        scope,
        task_sql,
        limit_params(scope, per_type_limit),
    )
    .await
    {
        Ok(rows) => rows,
        Err(error) => return collect_failed(targets, limit, &error),
    };
    for row in &task_rows {
        let text = format!(
            "{} status={}",
            row_text(row, "title"),
            row_text(row, "status")
        );
        let text_hash = hash_text(&text);
        targets.push(target_from_row("task", row, text, text_hash));
    }

    truncate(targets, limit)
}

// ─── Batch processing ───────────────────────────────────────────────────────

/// `processEmbeddingBatch(targets, deps)` — `embeddingWorker.ts:269-307`.
pub async fn process_embedding_batch(
    executor: &dyn PgExecutor,
    targets: &[EmbeddingTarget],
    config: &WorldModelConfig,
    provider: Option<Arc<dyn EmbeddingProvider>>,
    deps: &EmbeddingWorkerDeps,
    env: &HashMap<String, String>,
) -> Vec<EmbeddingResult> {
    if !config.enabled && !config.e2e_enabled {
        return Vec::new();
    }

    let model = deps
        .model
        .clone()
        .or_else(|| {
            provider
                .as_ref()
                .map(|provider| provider.model().to_string())
        })
        .unwrap_or_else(|| DEFAULT_MODEL.to_string());
    let model_version = deps
        .model_version
        .clone()
        .or_else(|| {
            provider
                .as_ref()
                .map(|provider| provider.model_version().to_string())
        })
        .unwrap_or_else(|| DEFAULT_MODEL_VERSION.to_string());

    let concurrency = js_concurrency(env);
    let provider_ref = provider.as_deref();
    let mut results: Vec<EmbeddingResult> = Vec::new();
    for chunk in targets.chunks(concurrency) {
        let futures = chunk.iter().map(|target| {
            process_embedding_target(executor, target, &model, &model_version, provider_ref, deps)
        });
        for result in join_all(futures).await.into_iter().flatten() {
            results.push(result);
        }
    }
    results
}

/// `Math.max(1, Math.min(8, Math.floor(Number(process.env.EMBEDDING_CONCURRENCY) || 4)))`
/// — `:281-284`.
///
/// The `|| 4` replaces `0` and `NaN`; `Math.floor` precedes the clamp, exactly
/// like the source.
fn js_concurrency(env: &HashMap<String, String>) -> usize {
    let raw = env
        .get(EMBEDDING_CONCURRENCY_ENV)
        .map(String::as_str)
        .unwrap_or("");
    let parsed = js_number_str(raw);
    // `Number(x) || 4` replaces the two falsy numbers (`0` and `NaN`); an
    // infinity stays and clamps to 8.
    let effective = if parsed == 0.0 || parsed.is_nan() {
        4.0
    } else {
        parsed
    };
    effective.floor().clamp(1.0, 8.0) as usize
}

/// `processEmbeddingTarget(target, model, modelVersion, configuredProvider, deps)`
/// — `embeddingWorker.ts:309-386`.
///
/// The caller supplies the scope of `target` (`:293`), which the port forwards to
/// every statement. The `undefined` returns of `:332`, `:347` and the thrown
/// invalid vector of `:350-352` are all `None`: the batch of `:296-301` drops
/// them identically.
pub async fn process_embedding_target(
    executor: &dyn PgExecutor,
    target: &EmbeddingTarget,
    model: &str,
    model_version: &str,
    provider: Option<&dyn EmbeddingProvider>,
    deps: &EmbeddingWorkerDeps,
) -> Option<EmbeddingResult> {
    match try_process_embedding_target(executor, target, model, model_version, provider, deps).await
    {
        Ok(result) => result,
        Err(message) => {
            // `console.error(`[world-model:embeddings] failed for ${type}:${id}:`, error)` — `:297-300`.
            tracing::error!(
                "[world-model:embeddings] failed for {}:{}: {}",
                target.target_type,
                target.target_id,
                message
            );
            None
        }
    }
}

async fn try_process_embedding_target(
    executor: &dyn PgExecutor,
    target: &EmbeddingTarget,
    model: &str,
    model_version: &str,
    provider: Option<&dyn EmbeddingProvider>,
    deps: &EmbeddingWorkerDeps,
) -> Result<Option<EmbeddingResult>, String> {
    let scope = Some(&target.scope);
    let existing = ambient_query::<PgError>(
        executor,
        scope,
        PgStatement::with_params(
            "SELECT id FROM world_model_embeddings\n     WHERE target_type = $1 AND target_id = $2\n       AND model = $3 AND model_version = $4\n       AND text_hash = $5 LIMIT 1",
            vec![
                PgValue::text(target.target_type.as_str()),
                PgValue::text(target.target_id.as_str()),
                PgValue::text(model),
                PgValue::text(model_version),
                PgValue::text(target.text_hash.as_str()),
            ],
        ),
    )
    .await
    .map_err(|error| crate::safe_error_message(&error))?;
    if !existing.rows.is_empty() {
        return Ok(Some(EmbeddingResult {
            target_type: target.target_type.clone(),
            target_id: target.target_id.clone(),
            embedding: Vec::new(),
            model: model.to_string(),
            model_version: model_version.to_string(),
            created: false,
        }));
    }

    let embedding = if let Some(generate) = &deps.generate_embedding {
        generate(target.text.clone()).await?
    } else if let Some(provider) = provider {
        provider
            .generate_embedding(&target.text)
            .await
            .map_err(|error| crate::safe_error_message(&error))?
    } else {
        // Never persist random vectors (`:341-348`).
        tracing::error!(
            "[world-model:embeddings] no generateEmbedding provider configured; target skipped"
        );
        return Ok(None);
    };

    if embedding.is_empty() || embedding.iter().any(|value| !value.is_finite()) {
        return Err(INVALID_VECTOR_MESSAGE.to_string());
    }

    ambient_query::<PgError>(
        executor,
        scope,
        PgStatement::with_params(
            "INSERT INTO world_model_embeddings\n     (user_id, persona_id, workspace_id, target_type, target_id,\n      embedding, model, model_version, text_hash, target_content)\n     VALUES ($1,$2,$3,$4,$5,$6::vector,$7,$8,$9,$10)\n     ON CONFLICT (user_id, persona_id, workspace_id, target_type, target_id, model, model_version)\n     DO UPDATE SET\n       embedding = EXCLUDED.embedding,\n       text_hash = EXCLUDED.text_hash,\n       target_content = EXCLUDED.target_content",
            vec![
                PgValue::text(target.scope.user_id.as_str()),
                PgValue::text(target.scope.persona_id.as_str()),
                PgValue::text(target.scope.workspace_id.clone().unwrap_or_default()),
                PgValue::text(target.target_type.as_str()),
                PgValue::text(target.target_id.as_str()),
                PgValue::text(embedding_json(&embedding)),
                PgValue::text(model),
                PgValue::text(model_version),
                PgValue::text(target.text_hash.as_str()),
                PgValue::text(target.text.as_str()),
            ],
        ),
    )
    .await
    .map_err(|error| crate::safe_error_message(&error))?;

    Ok(Some(EmbeddingResult {
        target_type: target.target_type.clone(),
        target_id: target.target_id.clone(),
        embedding,
        model: model.to_string(),
        model_version: model_version.to_string(),
        created: true,
    }))
}

// ─── Worker loop ────────────────────────────────────────────────────────────

/// `runEmbeddingWorkerOnce(deps, scope)` — `embeddingWorker.ts:392-412`.
pub async fn run_embedding_worker_once(
    executor: &dyn PgExecutor,
    config: &WorldModelConfig,
    env: &HashMap<String, String>,
    provider: Option<Arc<dyn EmbeddingProvider>>,
    deps: &EmbeddingWorkerDeps,
    scope: Option<&WorldModelScope>,
) -> EmbeddingWorkerStats {
    if !config.enabled && !config.e2e_enabled {
        return EmbeddingWorkerStats::default();
    }

    let targets = collect_embedding_targets(executor, scope, 50.0).await;
    if targets.is_empty() {
        return EmbeddingWorkerStats::default();
    }

    let results = process_embedding_batch(executor, &targets, config, provider, deps, env).await;
    EmbeddingWorkerStats {
        collected: targets.len(),
        processed: results.len(),
        created: results.iter().filter(|result| result.created).count(),
    }
}

/// `scopeProvider?: () => WorldModelScope[] | Promise<WorldModelScope[]>` — `:420`.
pub type ScopeProvider = Arc<dyn Fn() -> BoxFuture<'static, Vec<WorldModelScope>> + Send + Sync>;

/// `startEmbeddingWorker(deps, intervalMs, scopeProvider)` — `embeddingWorker.ts:417-468`.
///
/// The `setInterval` callback of `:449-462` is [`run_tick`](Self::run_tick) guarded
/// by [`try_begin_tick`](Self::try_begin_tick); [`start`](Self::start) drives it.
pub struct EmbeddingWorker {
    executor: Arc<dyn PgExecutor>,
    config: WorldModelConfig,
    env: HashMap<String, String>,
    provider: Option<Arc<dyn EmbeddingProvider>>,
    deps: EmbeddingWorkerDeps,
    scope_provider: Option<ScopeProvider>,
    tick_in_flight: AtomicBool,
    stop: Arc<AtomicBool>,
}

impl EmbeddingWorker {
    pub fn new(
        executor: Arc<dyn PgExecutor>,
        config: WorldModelConfig,
        env: HashMap<String, String>,
        provider: Option<Arc<dyn EmbeddingProvider>>,
        deps: EmbeddingWorkerDeps,
        scope_provider: Option<ScopeProvider>,
    ) -> Self {
        Self {
            executor,
            config,
            env,
            provider,
            deps,
            scope_provider,
            tick_in_flight: AtomicBool::new(false),
            stop: Arc::new(AtomicBool::new(false)),
        }
    }

    /// The `if (tickInFlight) return; tickInFlight = true;` guard of `:450-454`.
    pub fn try_begin_tick(&self) -> bool {
        !self.tick_in_flight.swap(true, Ordering::AcqRel)
    }

    /// The `finally { tickInFlight = false; }` of `:459-461`.
    pub fn end_tick(&self) {
        self.tick_in_flight.store(false, Ordering::Release);
    }

    /// The `tick` body of `:428-448`.
    pub async fn run_tick(&self) {
        let scopes = match &self.scope_provider {
            Some(provider) => provider().await,
            None => Vec::new(),
        };
        if self.scope_provider.is_some() && scopes.is_empty() {
            tracing::warn!(
                "[world-model:embeddings] no runtime scopes discovered; skipping unscoped tick"
            );
            return;
        }
        if self.scope_provider.is_some() {
            for scope in scopes {
                let _ = run_embedding_worker_once(
                    self.executor.as_ref(),
                    &self.config,
                    &self.env,
                    self.provider.clone(),
                    &self.deps,
                    Some(&scope),
                )
                .await;
            }
            return;
        }
        let _ = run_embedding_worker_once(
            self.executor.as_ref(),
            &self.config,
            &self.env,
            self.provider.clone(),
            &self.deps,
            None,
        )
        .await;
    }

    /// The `setInterval(...)` of `:449-463`; the `timer.unref()` of `:463` has no
    /// Rust counterpart, and the returned handle's [`stop`](EmbeddingWorkerHandle::stop)
    /// replaces `clearInterval`.
    ///
    /// A disabled worker (neither `enabled` nor `e2eEnabled`, `:423`) spawns
    /// nothing and returns a handle whose `stop` is already a no-op.
    pub fn start(self: Arc<Self>, interval_ms: u64) -> EmbeddingWorkerHandle {
        let stop = Arc::clone(&self.stop);
        if !self.config.enabled && !self.config.e2e_enabled {
            return EmbeddingWorkerHandle { stop };
        }
        let worker = Arc::clone(&self);
        let task_stop = Arc::clone(&stop);
        tokio::spawn(async move {
            let interval = std::time::Duration::from_millis(interval_ms);
            loop {
                tokio::time::sleep(interval).await;
                if task_stop.load(Ordering::Acquire) {
                    break;
                }
                if !worker.try_begin_tick() {
                    continue;
                }
                worker.run_tick().await;
                worker.end_tick();
            }
        });
        EmbeddingWorkerHandle { stop }
    }
}

/// The `{ stop }` of `:425` and `:465-467`.
pub struct EmbeddingWorkerHandle {
    stop: Arc<AtomicBool>,
}

impl EmbeddingWorkerHandle {
    /// `stop: () => clearInterval(timer)` (`:466`).
    pub fn stop(&self) {
        self.stop.store(true, Ordering::Release);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::world_model::db::drive_sync;
    use crate::world_model::db::testing::{Recorded, RecordingExecutor};
    use crate::world_model::db::{PgQueryResult, SQL_BEGIN, SQL_COMMIT, SQL_SET_SCOPE};
    use crate::world_model::embeddings::provider::EmbeddingError;
    use serde_json::json;
    use std::sync::Mutex;

    fn scope() -> WorldModelScope {
        WorldModelScope::new("u1", "p1", Some("w1".to_string()))
    }

    fn empty() -> Result<PgQueryResult, PgError> {
        Ok(PgQueryResult::empty())
    }

    fn rows(values: Vec<Value>) -> Result<PgQueryResult, PgError> {
        Ok(PgQueryResult::from_rows(
            values
                .into_iter()
                .map(|value| value.as_object().expect("row").clone())
                .collect(),
        ))
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

    fn find<'a>(statements: &'a [PgStatement], needle: &str) -> &'a PgStatement {
        statements
            .iter()
            .find(|statement| statement.sql.contains(needle))
            .unwrap_or_else(|| panic!("no statement contains {needle}"))
    }

    fn target() -> EmbeddingTarget {
        EmbeddingTarget {
            target_type: "observation".to_string(),
            target_id: "o1".to_string(),
            scope: scope(),
            text: "hello".to_string(),
            text_hash: "hash1".to_string(),
        }
    }

    fn deps_with(vector: Vec<f64>) -> EmbeddingWorkerDeps {
        EmbeddingWorkerDeps {
            generate_embedding: Some(Arc::new(move |_text: String| {
                let vector = vector.clone();
                Box::pin(async move { Ok(vector) })
            })),
            model: None,
            model_version: None,
        }
    }

    struct FixedProvider {
        model: String,
        version: String,
        vector: Vec<f64>,
    }

    impl EmbeddingProvider for FixedProvider {
        fn model(&self) -> &str {
            &self.model
        }
        fn model_version(&self) -> &str {
            &self.version
        }
        fn generate_embedding<'a>(
            &'a self,
            _text: &'a str,
        ) -> BoxFuture<'a, Result<Vec<f64>, EmbeddingError>> {
            let vector = self.vector.clone();
            Box::pin(async move { Ok(vector) })
        }
    }

    #[test]
    fn a_scoped_collection_binds_the_triple_and_the_per_type_limit() {
        // Six data statements: obs row, then five empty batches (`:87`, `:118`,
        // `:148`, `:178`, `:205`, `:233`).
        let executor = RecordingExecutor::new(vec![
            rows(vec![json!({
                "id": "o1", "user_id": "u1", "persona_id": "p1", "workspace_id": "w1",
                "payload": { "text": "hi" }
            })]),
            empty(),
            empty(),
            empty(),
            empty(),
            empty(),
        ]);
        let collected =
            drive_sync(collect_embedding_targets(&executor, Some(&scope()), 50.0)).expect("bridge");
        assert_eq!(collected.len(), 1);
        assert_eq!(collected[0].target_type, "observation");
        assert_eq!(collected[0].text, r#"{"text":"hi"}"#);
        assert_eq!(collected[0].text_hash, hash_text(r#"{"text":"hi"}"#));

        let statements = data_statements(&executor);
        assert_eq!(statements.len(), 6);
        let observations = find(&statements, "world_model_observations");
        assert!(observations.sql.contains("AND o.user_id = $1"));
        assert!(observations.sql.contains("LIMIT $4"));
        assert_eq!(
            observations.params,
            vec![
                PgValue::text("u1"),
                PgValue::text("p1"),
                PgValue::text("w1"),
                PgValue::int(9),
            ],
            "perTypeLimit = ceil(50 / 6) = 9"
        );
        assert_eq!(
            executor.calls()[0],
            Recorded::Statement(PgStatement::new(SQL_BEGIN))
        );
    }

    #[test]
    fn an_unscoped_collection_uses_the_plain_pool_query() {
        let executor =
            RecordingExecutor::new(vec![empty(), empty(), empty(), empty(), empty(), empty()]);
        let collected =
            drive_sync(collect_embedding_targets(&executor, None, 50.0)).expect("bridge");
        assert!(collected.is_empty());
        let statements = data_statements(&executor);
        let observations = find(&statements, "world_model_observations");
        assert!(!observations.sql.contains("$1 AND"));
        assert!(observations.sql.contains("LIMIT $1"));
        assert_eq!(observations.params, vec![PgValue::int(9)]);
        assert!(
            !executor
                .calls()
                .iter()
                .any(|call| matches!(call, Recorded::Release)),
            "the unscoped path issues no transaction"
        );
    }

    #[test]
    fn a_failing_statement_returns_the_partial_list() {
        // The observations statement succeeds, the memory statement fails; the
        // remaining four statements are never issued (`:259-263`).
        let executor = RecordingExecutor::new(vec![
            rows(vec![json!({
                "id": "o1", "user_id": "u1", "persona_id": "p1", "workspace_id": "w1",
                "payload": { "text": "hi" }
            })]),
            Err(PgError::new("boom")),
        ]);
        let collected =
            drive_sync(collect_embedding_targets(&executor, None, 50.0)).expect("bridge");
        assert_eq!(collected.len(), 1);
        assert_eq!(data_statements(&executor).len(), 2);
    }

    #[test]
    fn per_type_limit_and_embedding_json_follow_javascript() {
        assert_eq!(per_type_limit(50.0), 9);
        assert_eq!(per_type_limit(1.0), 1);
        assert_eq!(per_type_limit(6.0), 1);
        assert_eq!(per_type_limit(7.0), 2);
        assert_eq!(embedding_json(&[0.5, 1.0]), "[0.5,1]");
        assert_eq!(payload_text(Some(&json!(null))), "null");
        assert_eq!(payload_text(Some(&json!("s"))), "s");
        assert_eq!(payload_text(None), "");
    }

    #[test]
    fn js_concurrency_replaces_zero_and_clamps() {
        let env = |value: &str| {
            HashMap::from([(EMBEDDING_CONCURRENCY_ENV.to_string(), value.to_string())])
        };
        assert_eq!(js_concurrency(&HashMap::new()), 4, "`|| 4` default");
        assert_eq!(js_concurrency(&env("")), 4, "`Number('') || 4`");
        assert_eq!(js_concurrency(&env("0")), 4, "`0 || 4`");
        assert_eq!(js_concurrency(&env("abc")), 4, "`NaN || 4`");
        assert_eq!(js_concurrency(&env("2.9")), 2);
        assert_eq!(js_concurrency(&env("99")), 8);
        assert_eq!(js_concurrency(&env("-3")), 1);
    }

    #[test]
    fn a_new_target_generates_embeds_and_inserts() {
        let executor = RecordingExecutor::new(vec![empty(), Ok(PgQueryResult::affected(1))]);
        let result = drive_sync(process_embedding_target(
            &executor,
            &target(),
            "text-embedding-3-small",
            "1",
            None,
            &deps_with(vec![0.5, 1.0]),
        ))
        .expect("bridge")
        .expect("result");
        assert!(result.created);
        assert_eq!(result.embedding, vec![0.5, 1.0]);
        assert_eq!(result.model, "text-embedding-3-small");
        let statements = data_statements(&executor);
        assert!(find(&statements, "SELECT id FROM world_model_embeddings")
            .sql
            .contains("text_hash = $5"));
        let insert = find(&statements, "INSERT INTO world_model_embeddings");
        // sqlx binds text as `text`, so the vector column needs the cast `pg` infers.
        assert!(insert.sql.contains("$6::vector"));
        assert_eq!(insert.params[5], PgValue::text("[0.5,1]"));
        assert_eq!(insert.params[9], PgValue::text("hello"));
    }

    #[test]
    fn an_existing_embedding_is_not_regenerated() {
        let executor = RecordingExecutor::new(vec![rows(vec![json!({ "id": "e1" })])]);
        let result = drive_sync(process_embedding_target(
            &executor,
            &target(),
            "m",
            "1",
            None,
            &deps_with(vec![1.0]),
        ))
        .expect("bridge")
        .expect("result");
        assert!(!result.created);
        assert!(result.embedding.is_empty());
        assert_eq!(data_statements(&executor).len(), 1);
    }

    #[test]
    fn an_invalid_vector_is_skipped_without_an_insert() {
        let executor = RecordingExecutor::new(vec![empty()]);
        let result = drive_sync(process_embedding_target(
            &executor,
            &target(),
            "m",
            "1",
            None,
            &deps_with(vec![f64::NAN]),
        ))
        .expect("bridge");
        assert!(result.is_none());
        assert_eq!(data_statements(&executor).len(), 1);
    }

    #[test]
    fn a_missing_provider_skips_the_target() {
        let executor = RecordingExecutor::new(vec![empty()]);
        let result = drive_sync(process_embedding_target(
            &executor,
            &target(),
            "m",
            "1",
            None,
            &EmbeddingWorkerDeps::default(),
        ))
        .expect("bridge");
        assert!(result.is_none());
        assert_eq!(data_statements(&executor).len(), 1);
    }

    #[test]
    fn the_provider_supplies_the_model_when_deps_are_empty() {
        let provider: Arc<dyn EmbeddingProvider> = Arc::new(FixedProvider {
            model: "provider-model".to_string(),
            version: "v9".to_string(),
            vector: vec![2.0],
        });
        let executor = RecordingExecutor::new(vec![empty(), Ok(PgQueryResult::affected(1))]);
        let results = drive_sync(process_embedding_batch(
            &executor,
            &[target()],
            &WorldModelConfig {
                enabled: true,
                ..Default::default()
            },
            Some(provider),
            &EmbeddingWorkerDeps::default(),
            &HashMap::new(),
        ))
        .expect("bridge");
        assert_eq!(results.len(), 1);
        assert_eq!(results[0].model, "provider-model");
        assert_eq!(results[0].model_version, "v9");
    }

    #[test]
    fn a_disabled_config_processes_nothing() {
        let executor = RecordingExecutor::new(vec![]);
        let results = drive_sync(process_embedding_batch(
            &executor,
            &[target()],
            &WorldModelConfig::default(),
            None,
            &EmbeddingWorkerDeps::default(),
            &HashMap::new(),
        ))
        .expect("bridge");
        assert!(results.is_empty());
        assert!(executor.calls().is_empty());

        let stats = drive_sync(run_embedding_worker_once(
            &executor,
            &WorldModelConfig::default(),
            &HashMap::new(),
            None,
            &EmbeddingWorkerDeps::default(),
            None,
        ))
        .expect("bridge");
        assert_eq!(stats, EmbeddingWorkerStats::default());
    }

    #[test]
    fn run_once_reports_collected_processed_and_created() {
        let executor = RecordingExecutor::new(vec![
            rows(vec![json!({
                "id": "o1", "user_id": "u1", "persona_id": "p1", "workspace_id": "w1",
                "payload": { "text": "hi" }
            })]),
            empty(),
            empty(),
            empty(),
            empty(),
            empty(),
            empty(),
            Ok(PgQueryResult::affected(1)),
        ]);
        let stats = drive_sync(run_embedding_worker_once(
            &executor,
            &WorldModelConfig {
                enabled: true,
                ..Default::default()
            },
            &HashMap::new(),
            None,
            &deps_with(vec![1.0]),
            Some(&scope()),
        ))
        .expect("bridge");
        assert_eq!(stats.collected, 1);
        assert_eq!(stats.processed, 1);
        assert_eq!(stats.created, 1);
    }

    #[test]
    fn the_overlap_guard_allows_one_tick_at_a_time() {
        let worker = EmbeddingWorker::new(
            Arc::new(RecordingExecutor::new(vec![])),
            WorldModelConfig::default(),
            HashMap::new(),
            None,
            EmbeddingWorkerDeps::default(),
            None,
        );
        assert!(worker.try_begin_tick());
        assert!(!worker.try_begin_tick(), "overlap is skipped");
        worker.end_tick();
        assert!(worker.try_begin_tick());
    }

    #[test]
    fn run_tick_fans_out_to_every_discovered_scope() {
        let scopes: Vec<WorldModelScope> = vec![
            WorldModelScope::new("u1", "p1", Some("w1".to_string())),
            WorldModelScope::new("u2", "p2", Some("w2".to_string())),
        ];
        let executor = Arc::new(RecordingExecutor::new(vec![
            empty(),
            empty(),
            empty(),
            empty(),
            empty(),
            empty(),
            empty(),
            empty(),
            empty(),
            empty(),
            empty(),
            empty(),
        ]));
        let list: ScopeProvider = {
            let scopes = Arc::new(Mutex::new(scopes));
            Arc::new(move || {
                let scopes = Arc::clone(&scopes);
                Box::pin(async move { scopes.lock().expect("scopes").clone() })
            })
        };
        let worker = Arc::new(EmbeddingWorker::new(
            executor.clone(),
            WorldModelConfig {
                enabled: true,
                ..Default::default()
            },
            HashMap::new(),
            None,
            EmbeddingWorkerDeps::default(),
            Some(list),
        ));
        drive_sync(worker.run_tick()).expect("bridge");

        // Every scoped statement of both ticks sets the scope, so the test reads
        // the distinct triples in the order they first appear.
        let mut scopes_set: Vec<Vec<PgValue>> = Vec::new();
        for call in executor.calls() {
            if let Recorded::Statement(statement) = call {
                if statement.sql == SQL_SET_SCOPE && !scopes_set.contains(&statement.params) {
                    scopes_set.push(statement.params);
                }
            }
        }
        assert_eq!(
            scopes_set,
            vec![
                vec![
                    PgValue::text("u1"),
                    PgValue::text("p1"),
                    PgValue::text("w1"),
                ],
                vec![
                    PgValue::text("u2"),
                    PgValue::text("p2"),
                    PgValue::text("w2"),
                ],
            ]
        );
    }

    #[test]
    fn run_tick_skips_the_unscoped_path_when_no_scope_is_discovered() {
        let executor = Arc::new(RecordingExecutor::new(vec![]));
        let list: ScopeProvider = Arc::new(|| Box::pin(async { Vec::<WorldModelScope>::new() }));
        let worker = Arc::new(EmbeddingWorker::new(
            executor.clone(),
            WorldModelConfig {
                enabled: true,
                ..Default::default()
            },
            HashMap::new(),
            None,
            EmbeddingWorkerDeps::default(),
            Some(list),
        ));
        drive_sync(worker.run_tick()).expect("bridge");
        assert!(
            executor.calls().is_empty(),
            "no scopes discovered: the unscoped tick is skipped (`:430-433`)"
        );
    }
}
