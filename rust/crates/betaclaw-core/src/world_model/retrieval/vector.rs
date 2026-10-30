//! Port of `src/server/world-model/retrieval/vector.ts` (146 lines) — the new
//! home of the seam types that `memory/postgres.rs` declared during S5.
//!
//! | TypeScript | Rust |
//! | --- | --- |
//! | `vector.ts:14-21` (`VectorHit`) | [`VectorHit`] |
//! | `vector.ts:33-116` (`vectorSearch`) | [`vector_search`] |
//! | `vector.ts:40-44` (`targetFilter`) | [`VectorTargetFilter`] |
//! | `vector.ts:52` (`JSON.stringify(queryEmbedding)`) | [`pgvector_text`] |
//! | `vector.ts:61-90` (statement) | [`SQL_VECTOR_SEARCH`] |
//! | `vector.ts:121-132` (`isVectorSearchAvailable`) | [`is_vector_search_available`] |
//! | `vector.ts:137-156` (`countEmbeddings`) | [`count_embeddings`] |
//! | `postgresMemoryClient.ts:276` (`vectorLimit`) | [`vector_limit`] |
//!
//! # This module moved the seam types
//!
//! `VectorHit`, `VectorTargetFilter`, `vector_limit` and the `vectorSearch`
//! statement were ported inside `memory/postgres.rs` during S5, because that
//! provider was the first caller of the pgvector statement. Their TypeScript
//! home has always been this file (and `postgresMemoryClient.ts:276` for the
//! `Math.max(20, Math.min(100, limit * 5))` helper), so S6 moved them here:
//! `memory::postgres` re-exports every name it used to declare and keeps its own
//! semantic-branch method over [`SQL_VECTOR_SEARCH`], [`VectorHit`] and
//! [`VectorTargetFilter`]. No ported behaviour changed with the move — this
//! module was written from the TypeScript original, and the duplicated
//! definitions in `memory/postgres.rs` are deleted by the parent when it wires
//! the re-export.
//!
//! # Verified TypeScript quirks
//!
//! * `vectorSearch` swallows a failing statement: `catch { console.error(…);
//!   return [] }` (`:112-115`). The port logs the message and answers an empty
//!   list, so the return type has no error channel. `isVectorSearchAvailable`
//!   and `countEmbeddings` swallow the same way (`:129-131`, `:153-155`).
//! * `include?.length ? [...include] : null` (`:98-99`) turns an **empty** array
//!   into `null`, which the `$7::text[] IS NULL OR …` predicates read as "no
//!   filter"; `activeMemoryOnly` is `=== true` (`:100`), so everything else
//!   (including `undefined`) is `false`.
//! * The nine parameters are bound in the order `embedding, userId, personaId,
//!   workspaceId, minSimilarity, limit, include, exclude, activeMemoryOnly`
//!   while the statement uses `$5`, `$6` and `$7`/`$8`/`$9` in a different
//!   textual order (`:61-101`) — positional binding only, so the order of the
//!   values is what matters.
//! * `countEmbeddings` reads `result.rows[0]?.count ?? 0` through `Number(…)`
//!   (`:152`), so a missing row, a `NULL` and a non-numeric text all become the
//!   JavaScript number the helper produces (`NaN` for the last one).
//! * `ORDER BY e.embedding <=> $1::vector` (`:89`) is ascending cosine
//!   *distance* while the projected `similarity` is `1 - distance` (`:65`), so a
//!   `NULL` embedding drops out of the `>= $5` comparison instead of sorting
//!   first.
//!
//! The `enabled`/`e2eEnabled` gate of `:46-47` (and `:122-123`, `:142-143`) runs
//! before the statement; the scope is an explicit parameter because
//! `AsyncLocalStorage` has no Rust counterpart (`.tmp/s6s7-plan.md`, rule 7).

use crate::world_model::config::WorldModelConfig;
use crate::world_model::db::{
    scoped_query, NormalizedScope, PgError, PgExecutor, PgStatement, PgValue,
};

use super::{row_number, row_string};

/// `VectorHit` from `vector.ts:14-21`.
#[derive(Debug, Clone, PartialEq)]
pub struct VectorHit {
    pub target_type: String,
    pub target_id: String,
    /// `e.target_content AS text`.
    pub text: String,
    /// `1 - (embedding <=> query)`, higher is closer.
    pub similarity: f64,
    pub model: String,
    pub model_version: String,
}

/// The `targetFilter` parameter of `vectorSearch` — `vector.ts:40-44`.
///
/// The three knobs travel as the `$7`, `$8` and `$9` parameters of the
/// statement; `None` and an empty slice both become `null`, like
/// `include?.length ? [...] : null`.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct VectorTargetFilter<'a> {
    pub include: Option<&'a [&'a str]>,
    pub exclude: Option<&'a [&'a str]>,
    pub active_memory_only: bool,
}

/// `vectorSearch` — `vector.ts:61-90`, token for token.
///
/// `$1::vector` parses the pgvector text form of the query embedding
/// ([`pgvector_text`]) and `e.embedding <=> $1::vector` is the cosine distance.
/// Public because `memory::postgres` re-exports it: the memory provider's
/// semantic branch issues the same statement.
pub const SQL_VECTOR_SEARCH: &str = "\
SELECT
e.target_type,
e.target_id,
e.target_content AS text,
1 - (e.embedding <=> $1::vector) AS similarity,
e.model,
e.model_version
FROM world_model_embeddings e
WHERE e.user_id = $2
AND e.persona_id = $3
AND e.workspace_id = $4
AND 1 - (e.embedding <=> $1::vector) >= $5
AND ($7::text[] IS NULL OR e.target_type = ANY($7::text[]))
AND ($8::text[] IS NULL OR NOT (e.target_type = ANY($8::text[])))
AND (
$9::boolean = false
OR e.target_type <> 'memory'
OR EXISTS (
SELECT 1
FROM world_model_memory_items m
WHERE m.id::text = e.target_id
AND m.user_id = e.user_id
AND m.persona_id = e.persona_id
AND m.workspace_id = e.workspace_id
AND m.deleted_at IS NULL
AND m.lifecycle_status IN ('new', 'confirmed')
)
)
ORDER BY e.embedding <=> $1::vector
LIMIT $6";

/// `Math.max(20, Math.min(100, limit * 5))` — `postgresMemoryClient.ts:276`.
///
/// The helper belongs to the memory provider's semantic branch, but it is the
/// `LIMIT` of the same pgvector query, so S6 moved it next to the statement.
pub fn vector_limit(limit: i64) -> i64 {
    20_i64.max(100_i64.min(limit * 5))
}

/// `JSON.stringify(queryEmbedding)` — `vector.ts:52`.
///
/// The pgvector text form is the JSON array of the coordinates, parsed by the
/// `$1::vector` cast of the statement. The coordinates go through the
/// `JSON.stringify` number rendering, so an integral coordinate loses the `.0`
/// that `serde_json` would write and a non-finite one becomes `null`
/// (`JSON.stringify(NaN)`), which `pgvector` rejects at the cast — the same
/// failure the source would see.
///
/// Known formatting difference: JavaScript writes magnitudes from `1e21` on as
/// `1e+21`, `ryu` writes `1e21`. The cast parses both identically and no
/// embedding model of this project emits such a coordinate (OP).
pub fn pgvector_text(values: &[f64]) -> String {
    let encoded: Vec<serde_json::Value> = values.iter().map(|value| json_number(*value)).collect();
    serde_json::Value::Array(encoded).to_string()
}

/// `Number` rendered the way `JSON.stringify` renders it.
fn json_number(value: f64) -> serde_json::Value {
    use serde_json::{Number, Value};
    if !value.is_finite() {
        return Value::Null;
    }
    if value.fract() == 0.0 && value.abs() <= 9_007_199_254_740_992.0 {
        return Value::Number(Number::from(value as i64));
    }
    Number::from_f64(value)
        .map(Value::Number)
        .unwrap_or(Value::Null)
}

/// The statement of one search: [`SQL_VECTOR_SEARCH`] with the nine positional
/// parameters in source order (`vector.ts:91-101`).
///
/// Rust-only helper so the memory provider and this module cannot drift apart;
/// the source builds the array inline at the call site.
pub fn vector_search_statement(
    query_embedding: &[f64],
    scope: &NormalizedScope,
    limit: i64,
    min_similarity: f64,
    filter: VectorTargetFilter<'_>,
) -> PgStatement {
    // `include?.length ? [...include] : null` — an empty array is `null`.
    let include = filter
        .include
        .filter(|values| !values.is_empty())
        .map(|values| {
            values
                .iter()
                .map(|value| (*value).to_string())
                .collect::<Vec<String>>()
        });
    let exclude = filter
        .exclude
        .filter(|values| !values.is_empty())
        .map(|values| {
            values
                .iter()
                .map(|value| (*value).to_string())
                .collect::<Vec<String>>()
        });

    PgStatement::with_params(
        SQL_VECTOR_SEARCH,
        vec![
            PgValue::text(pgvector_text(query_embedding)),
            PgValue::text(scope.user_id.as_str()),
            PgValue::text(scope.persona_id.as_str()),
            PgValue::text(scope.workspace_id.as_str()),
            PgValue::float(min_similarity),
            PgValue::int(limit),
            PgValue::nullable_text_array(include),
            PgValue::nullable_text_array(exclude),
            PgValue::boolean(filter.active_memory_only),
        ],
    )
}

/// `vectorSearch(queryEmbedding, userId, personaId, workspaceId, limit,
/// minSimilarity, targetFilter)` — `vector.ts:33-116`.
///
/// The `try`/`catch` of `:112-115` is part of the behaviour: a failing statement
/// is logged and answers an empty list, so this function has no error channel.
pub async fn vector_search(
    executor: &dyn PgExecutor,
    config: &WorldModelConfig,
    scope: &NormalizedScope,
    query_embedding: &[f64],
    limit: i64,
    min_similarity: f64,
    filter: VectorTargetFilter<'_>,
) -> Vec<VectorHit> {
    if !config.enabled && !config.e2e_enabled {
        return Vec::new();
    }

    let statement = vector_search_statement(query_embedding, scope, limit, min_similarity, filter);
    match scoped_query::<PgError>(executor, scope, statement).await {
        Ok(result) => result
            .rows
            .iter()
            .map(|row| VectorHit {
                target_type: row_string(row, "target_type"),
                target_id: row_string(row, "target_id"),
                text: row_string(row, "text"),
                similarity: row_number(row, "similarity"),
                model: row_string(row, "model"),
                model_version: row_string(row, "model_version"),
            })
            .collect(),
        Err(error) => {
            tracing::error!(
                target: "world_model::retrieval::vector",
                "[world-model:vector] search failed: {}",
                crate::safe_error_message(&error)
            );
            Vec::new()
        }
    }
}

/// `isVectorSearchAvailable()` — `vector.ts:121-132`.
///
/// The probe statement has no parameters and is scoped like every other
/// statement of the slice (see the module header).
pub async fn is_vector_search_available(
    executor: &dyn PgExecutor,
    config: &WorldModelConfig,
    scope: &NormalizedScope,
) -> bool {
    if !config.enabled && !config.e2e_enabled {
        return false;
    }
    scoped_query::<PgError>(
        executor,
        scope,
        PgStatement::new("SELECT 1 FROM world_model_embeddings LIMIT 0"),
    )
    .await
    .is_ok()
}

/// `countEmbeddings(userId, personaId, workspaceId)` — `vector.ts:137-156`.
///
/// `Number(result.rows[0]?.count ?? 0)`: a missing row and a `NULL` count are
/// both `0`, an unparsable text is `NaN` (like `Number('abc')`), and a failing
/// statement answers `0` (`:153-155`).
pub async fn count_embeddings(
    executor: &dyn PgExecutor,
    config: &WorldModelConfig,
    scope: &NormalizedScope,
) -> f64 {
    if !config.enabled && !config.e2e_enabled {
        return 0.0;
    }

    let statement = PgStatement::with_params(
        "SELECT COUNT(*) as count FROM world_model_embeddings\n       WHERE user_id = $1 AND persona_id = $2 AND workspace_id = $3",
        vec![
            PgValue::text(scope.user_id.as_str()),
            PgValue::text(scope.persona_id.as_str()),
            PgValue::text(scope.workspace_id.as_str()),
        ],
    );
    match scoped_query::<PgError>(executor, scope, statement).await {
        Ok(result) => match result.rows.first() {
            // `result.rows[0]?.count ?? 0` — absent and `NULL` are both `0`.
            Some(row) => match row.get("count") {
                None | Some(serde_json::Value::Null) => 0.0,
                Some(_) => row_number(row, "count"),
            },
            None => 0.0,
        },
        Err(_) => 0.0,
    }
}
