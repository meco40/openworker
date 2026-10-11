//! Port of `src/server/memory/postgresMemoryClient.ts` — the canonical
//! PostgreSQL/pgvector provider of the [`Mem0Client`] contract.
//!
//! The contract name is retained in Rust for the same reason the TypeScript
//! keeps it (`postgresMemoryClient.ts:147-153`): the API and knowledge callers
//! stay stable. No Mem0 request is made here either — rows, history and
//! embeddings all live in the canonical World Model database.
//!
//! | TypeScript                                                     | Rust |
//! | -------------------------------------------------------------- | ---- |
//! | `postgresMemoryClient.ts:29-54` (`CanonicalMemoryRow`, `CanonicalHistoryRow`) | [`PgRow`] and the `row_*` accessors |
//! | `postgresMemoryClient.ts:56-58` (`text`)                        | [`trimmed_text`](crate::memory::errors::trimmed_text) |
//! | `postgresMemoryClient.ts:60-64` (`timestamp`)                   | [`normalize_timestamp`](crate::memory::utils::normalize_timestamp) |
//! | `postgresMemoryClient.ts:66-70` (`metadata`)                    | [`pick_record`](crate::memory::errors::pick_record) |
//! | `postgresMemoryClient.ts:72-82` (`scopeFrom`)                   | [`scope_from`], [`NormalizedScope`] |
//! | `postgresMemoryClient.ts:84-91` (`scopeFromMemoryInput`)         | [`scope_from_memory_input`] |
//! | `postgresMemoryClient.ts:93-108` (`rowMetadata`)                | [`row_metadata`] |
//! | `postgresMemoryClient.ts:110-119` (`toRecord`)                  | [`to_record`] |
//! | `postgresMemoryClient.ts:121-137` (`historyEntry`)              | [`history_entry`] |
//! | `postgresMemoryClient.ts:139-145` (`safePage`, `safePageSize`)  | [`safe_page`], [`safe_page_size`] |
//! | `postgresMemoryClient.ts:147-155` (class, `provider`)           | [`PostgresMemoryClient`], [`PostgresMemoryClient::new`] |
//! | `postgresMemoryClient.ts:157-261` (`addMemory`)                 | [`PostgresMemoryClient::add_memory`] |
//! | `postgresMemoryClient.ts:263-330` (`searchMemories`)            | [`PostgresMemoryClient::search_memories`] |
//! | `postgresMemoryClient.ts:332-383` (`listMemories`)              | [`PostgresMemoryClient::list_memories`] |
//! | `postgresMemoryClient.ts:385-403` (`getMemory`)                 | [`PostgresMemoryClient::get_memory`] |
//! | `postgresMemoryClient.ts:405-421` (`getMemoryHistory`)          | [`PostgresMemoryClient::get_memory_history`] |
//! | `postgresMemoryClient.ts:423-501` (`updateMemory`)              | [`PostgresMemoryClient::update_memory`] |
//! | `postgresMemoryClient.ts:503-567` (`deleteMemory`)              | [`PostgresMemoryClient::delete_memory`] |
//! | `postgresMemoryClient.ts:569-630` (`deleteMemoriesByFilter`)    | [`PostgresMemoryClient::delete_memories_by_filter`] |
//! | `postgresMemoryClient.ts:632-650` (`countMemories`)             | [`PostgresMemoryClient::count_memories`] |
//! | `world-model/db.ts:30-48` (`normalizedScope`, `setDatabaseScope`) | [`NormalizedScope`], [`set_database_scope`] |
//! | `world-model/db.ts:51-85` (`runWithWorldModelScope`, `queryWithScope`) | [`scoped_query`] |
//! | `world-model/db.ts:204-229` (`withWorldModelTransaction`)       | [`run_scoped`] |
//! | `world-model/retrieval/vector.ts:33-116` (`vectorSearch`)       | [`PostgresMemoryClient::vector_search`], [`VectorHit`] |
//! | `world-model/embeddings/provider.ts:17-34,92-95`                | [`QueryEmbedder`] |
//! | `mem0/types.ts:90-108` (`Mem0Client`)                           | [`impl Mem0Client for PostgresMemoryClient`] |
//!
//! # What is a pure port
//!
//! Everything that does not touch a connection is ported statement by statement
//! and covered by the contract tests at the bottom of this file: the five
//! normalisation helpers, the two row mappers, the pagination clamps, the scope
//! resolution, the SQL texts (token for token, see [`MEMORY_ITEM_COLUMNS`]) and
//! the parameter order of every statement.
//!
//! # The injected-executor seam
//!
//! `betaclaw-core` owns no PostgreSQL driver: the PostgreSQL stack (sqlx 0.9,
//! `docs/RUST_MIGRATION.md:64`) arrives with slice S6 (World Model). The module
//! follows the pattern [`HttpTransport`](crate::model_hub::http::HttpTransport)
//! established for HTTP instead of adding a dependency to this crate:
//!
//! * [`PgExecutor`] is the pool (`pg`'s `Pool`: `connect()`/`query()`);
//! * [`PgSession`] is one checked-out connection (`pg`'s `PoolClient`);
//! * [`PgStatement`], [`PgValue`], [`PgRow`] and [`PgQueryResult`] are the four
//!   `pg`-shaped types the statements and the row mappers need — no more, so a
//!   driver implements the seam without a second query builder;
//! * [`QueryEmbedder`] is the single external capability of `searchMemories`
//!   (`getConfiguredEmbeddingProvider()` + `generateEmbeddingOnce`,
//!   `embeddings/provider.ts:17-34,92-95`).
//!
//! The seam is deliberately reversible: when S6 lands, [`PgExecutor`] and the
//! statement types move next to the world-model module, every other statement of
//! the slice implements them once, and this file keeps only the port. No ported
//! behaviour depends on who implements them.
//!
//! ## What the caller must supply to make it live
//!
//! * `PgExecutor::connect` is `pool.acquire()`; the returned [`PgSession`] is a
//!   `sqlx::pool::PoolConnection<Postgres>` — its `query` runs `sqlx::query(&sql)`
//!   with the [`PgValue`]s bound in order, `PgQueryResult::row_count` is
//!   `rows_affected` for a write and the row count for a read, and `release()`
//!   may be empty because dropping the connection returns it to the pool, which
//!   is what `client.release()` does at `db.ts:83` and `db.ts:225`.
//! * The pooled connection must run as `world_model_app`; the port never issues a
//!   `SET ROLE`, because the TypeScript relies on the role of the pool.
//! * [`QueryEmbedder`] is optional. Without it the provider is the lexical one the
//!   TypeScript falls back to whenever no embedding provider is configured
//!   (`postgresMemoryClient.ts:267-268`) — [`NoQueryEmbedder`] is exactly that.
//! * A [`PgRow`] carries the columns of the projection as JSON values
//!   (`Value::String` for text and timestamps, `Value::Number` for
//!   `importance`/`confidence`/`version`, `Value::Object` for the `jsonb`
//!   columns).
//!
//! ## Tenant scoping (RLS)
//!
//! `docs/RUST_MIGRATION.md:199-201` freezes the contract: every transaction is
//! `BEGIN` → `world_model_set_scope($1,$2,$3)` → work → `COMMIT`, and
//! `set_database_scope` must never be dropped. The port reproduces both
//! TypeScript wrappers instead of inventing a third shape:
//!
//! * [`scoped_query`] is `queryWithScope` (`db.ts:62-85`) — one statement in its
//!   own scoped transaction. Every statement a method issues while
//!   `runWithWorldModelScope` is active (`db.ts:51-56`) takes this shape, because
//!   the TypeScript calls `getWorldModelDb().query(...)` once per statement and
//!   `db.ts:107-110` wraps each of those calls individually.
//! * [`run_scoped`] is `withWorldModelTransaction` (`db.ts:204-229`) — the same
//!   prefix, then the statements of the method, then `COMMIT`; `ROLLBACK` and
//!   `release()` on every failure path.
//! * The one unscoped path is preserved as well: `countMemories` without a persona
//!   (`:639-649`) calls `pool.query` directly, so
//!   [`PostgresMemoryClient::count_memories`] uses [`PgExecutor::query`] and issues
//!   **no** `BEGIN` and **no** scope call.
//!
//! `AsyncLocalStorage` has no Rust counterpart, so the ambient scope is threaded
//! explicitly: every method computes the same `Required<Mem0Scope>` at the same
//! point as the source (`scopeFrom`, `scopeFromMemoryInput`) and hands it to the
//! helpers. The SQL, the order and the scoped/unscoped decision are unchanged.
//!
//! # Deviations
//!
//! 1. **No driver, an executor seam** (see above). The TypeScript imports
//!    `getWorldModelDb()`/`withWorldModelTransaction` from `world-model/db.ts`;
//!    the port receives [`PgExecutor`] and reproduces those two wrappers itself.
//!    The pool logging of `db.ts:79`, `db.ts:94-96` and `db.ts:221` and
//!    `closeWorldModelDb` (`db.ts:114-119`) belong to the pool the caller owns.
//! 2. **`listMemories` count parameters are snapshotted.**
//!    `postgresMemoryClient.ts:364` pushes the offset and the limit into the
//!    *same* array instance that already went to the count statement, and the
//!    golden test (`tests/unit/memory/postgres-memory-client.test.ts:251-268`)
//!    observes that instance after the mutation, so both recorded calls show
//!    seven parameters. A real `pg` client serialises the array when the
//!    statement is built and PostgreSQL rejects surplus bind parameters, so the
//!    port sends the five count parameters and the seven row parameters — the
//!    sequence the TypeScript produces against a real database.
//! 3. **Search hits lose their stamps**, exactly like the SQLite provider (see
//!    `crate::memory::sqlite::client`, deviation 1): `searchMemories` returns
//!    `toRecord(...)` objects carrying `createdAt`/`updatedAt`, while the declared
//!    [`Mem0SearchHit`] has no such fields. The port keeps the declared shape so it
//!    stays substitutable; [`crate::memory::mappers::to_memory_node_from_hit`]
//!    reads only `id`, `content`, `score` and `metadata` anyway.
//! 4. **The vector failure is reported once.** `vectorSearch` swallows its own
//!    error and returns `[]` (`vector.ts:112-115`), which makes `searchMemories`
//!    fall through to the lexical path. The port propagates the error out of
//!    [`PostgresMemoryClient::vector_search`] and lets the single `catch` of
//!    `searchMemories` (`:304-309`) log it and continue: same statements, same
//!    result, one warning instead of two. For the same reason the
//!    `WORLD_MODEL_ENABLED` gate of `vector.ts:47` and the in-flight
//!    deduplication of `generateEmbeddingOnce` (`provider.ts:10-34`) are not
//!    reproduced — an embedder that reports `Ok(None)` means "no semantic search",
//!    and deduplication belongs to the component that owns the HTTP embedding
//!    client.
//! 5. **A non-numeric count is `0`, not `NaN`.**
//!    `Number(result.rows[0]?.count ?? 0)` (`:378`, `:647`) can yield `NaN`; the
//!    port's `i64` cannot carry it. The SQL function only returns a count, so the
//!    case is unreachable.
//! 6. **Number spelling in JSON.** `Number(row.importance)` is stored back into
//!    the metadata bag; JavaScript writes `3` where `serde_json` would write
//!    `3.0`. [`js_json_number`] reproduces the JavaScript spelling and its `null`
//!    for a non-finite value, which is what `JSON.stringify` does.
//! 7. **`Math.round` vs `f64::round`.** The two differ for an exact negative half
//!    (`-1.5` → `-1` vs `-2`), but `importance` is clamped to `[1,5]` afterwards
//!    (`:166`, `:449-452`), so no input can observe the difference.
//! 8. **The synchronous bridge is repeated.** [`Mem0Client`] is synchronous (see
//!    `crate::memory::sqlite::client`, "Why the trait is synchronous"), so the
//!    async methods of this provider are bridged by [`drive_sync`] — the bridge
//!    `Mem0HttpClient` already uses. `mem0.rs` keeps its copy private and this
//!    slice may not edit it, so twenty lines exist twice; promoting them into a
//!    shared `memory::sync_bridge` is a follow-up, not a behaviour change.
//! 9. **SQL whitespace.** The statements reproduce the template literals token for
//!    token. The projection of `world_model_memory_items` is written once
//!    ([`MEMORY_ITEM_COLUMNS`]) instead of seven times with different
//!    continuation-line indentation, and the tests compare whitespace-collapsed
//!    SQL. PostgreSQL ignores that whitespace; every clause, every parameter and
//!    every order is unchanged.
//! 10. **Timestamps arrive as text.** `pg` parses `timestamptz` into a `Date` and
//!     `timestamp(value)` calls `toISOString()` on it (`:60-64`). A [`PgRow`]
//!     carries the column as text, and
//!     [`normalize_timestamp`](crate::memory::utils::normalize_timestamp) returns
//!     the identical millisecond-precision UTC string.

use std::collections::HashMap;
use std::sync::Arc;

use serde_json::{Map, Number, Value};
use uuid::Uuid;

use crate::memory::errors::{pick_record, trimmed_text, MemoryError};
use crate::memory::sqlite::client::Mem0Client;
use crate::memory::types::{
    js_number, js_string, Mem0AddResult, Mem0CountInput, Mem0DeleteByFilterInput, Mem0HistoryEntry,
    Mem0ListInput, Mem0ListMemoryResult, Mem0MemoryInput, Mem0MemoryRecord, Mem0Scope,
    Mem0SearchHit, Mem0SearchInput, MemoryMetadata, MemoryProviderKind,
};
use crate::memory::utils::normalize_timestamp;
use crate::model_hub::http::BoxFuture;

/// `readonly provider = 'postgres' as const` — `postgresMemoryClient.ts:155`.
const MEMORY_PROVIDER_LABEL: &str = "postgres";

/// The message of `throw new Error('Scoped canonical memory deletion requires
/// user, persona, and workspace.')` — `postgresMemoryClient.ts:506`.
const SCOPED_DELETION_REQUIRED: &str =
    "Scoped canonical memory deletion requires user, persona, and workspace.";

/// The message of `throw new Error('Canonical memory insert conflicted with an
/// unknown unique constraint.')` — `postgresMemoryClient.ts:241`.
const UNKNOWN_INSERT_CONFLICT: &str =
    "Canonical memory insert conflicted with an unknown unique constraint.";

/// The prefix of ``throw new Error(`Memory node not found: ${id}`)`` —
/// `postgresMemoryClient.ts:439` and `:522`.
const MEMORY_NOT_FOUND_PREFIX: &str = "Memory node not found: ";

/// Returned by [`drive_sync`] on a current-thread tokio runtime, which cannot be
/// blocked without dead-locking it.
const SYNC_BRIDGE_MESSAGE: &str = "PostgresMemoryClient cannot be driven synchronously from a \
current-thread tokio runtime; call the async methods instead.";

/// The failure of [`UnconfiguredPgExecutor`]: the caller handed over no pool.
pub const UNCONFIGURED_EXECUTOR_MESSAGE: &str =
    "No PostgreSQL executor is configured for the canonical memory provider.";

/// One positional parameter of a `pg` statement.
///
/// The variants mirror what the TypeScript passes (`values` of every
/// `db.query(text, values)` call in `postgresMemoryClient.ts:180-626`): `string`,
/// `number`, `boolean`, `null` and `string[]`. `pg` encodes every parameter as
/// text and leaves the type to the statement — the explicit casts (`$11::jsonb`,
/// `$1::vector`, `$4::text[]`, `$9::boolean`) are part of the SQL text, and the
/// rest is inferred from the column context. A driver binds the variants that
/// way; the distinction the contract tests assert is the JavaScript one, so an
/// integral number is [`PgValue::Int64`] and a fractional one
/// [`PgValue::Float64`] (see `postgresMemoryClient.ts:210-213` and `:465-475`).
#[derive(Debug, Clone, PartialEq)]
pub enum PgValue {
    /// `null` — `pg` sends it as a NULL of unknown type for the casts to fix.
    Null,
    Text(String),
    Int64(i64),
    Float64(f64),
    Bool(bool),
    /// `$4::text[]` / `ANY($1::text[])` parameters.
    TextArray(Vec<String>),
}

impl PgValue {
    pub fn text(value: impl Into<String>) -> Self {
        PgValue::Text(value.into())
    }

    pub fn int(value: i64) -> Self {
        PgValue::Int64(value)
    }

    pub fn float(value: f64) -> Self {
        PgValue::Float64(value)
    }

    pub fn boolean(value: bool) -> Self {
        PgValue::Bool(value)
    }

    pub fn text_array(values: Vec<String>) -> Self {
        PgValue::TextArray(values)
    }

    /// `value || null` — a `None` is the `null` the TypeScript forwards, not an
    /// omitted parameter, because positional binding requires every placeholder.
    pub fn nullable_text(value: Option<String>) -> Self {
        match value {
            Some(text) => PgValue::Text(text),
            None => PgValue::Null,
        }
    }

    /// `include?.length ? [...include] : null` — `retrieval/vector.ts:98-99`.
    pub fn nullable_text_array(values: Option<Vec<String>>) -> Self {
        match values {
            Some(values) => PgValue::TextArray(values),
            None => PgValue::Null,
        }
    }
}

/// One statement of the port: the SQL text and the positional parameters.
///
/// `pg` receives exactly this pair in `query(text, values)`; the port keeps them
/// together so a caller can log or replay a statement without reassembling it.
#[derive(Debug, Clone, PartialEq)]
pub struct PgStatement {
    pub sql: String,
    pub params: Vec<PgValue>,
}

impl PgStatement {
    /// A parameterless statement — `BEGIN`, `COMMIT`, `ROLLBACK`
    /// (`db.ts:70,73,77,212,215,219`) and the scope call's siblings.
    pub fn new(sql: impl Into<String>) -> Self {
        Self {
            sql: sql.into(),
            params: Vec::new(),
        }
    }

    pub fn with_params(sql: impl Into<String>, params: Vec<PgValue>) -> Self {
        Self {
            sql: sql.into(),
            params,
        }
    }
}

/// `QueryResultRow` from `pg` — the untyped column map of one row.
///
/// `CanonicalMemoryRow` (`postgresMemoryClient.ts:29-46`) and
/// `CanonicalHistoryRow` (`:48-54`) are the column contracts of the two shapes
/// the port reads; the accessors below read them by name, exactly like
/// TypeScript property access does.
pub type PgRow = Map<String, Value>;

/// `QueryResult` from `pg`, reduced to what the statements of the client read.
///
/// `rowCount` is the row count of a `SELECT` and the affected count of a write,
/// which is what `updateMemory` compares against `1`
/// (`postgresMemoryClient.ts:483`).
#[derive(Debug, Clone, Default, PartialEq)]
pub struct PgQueryResult {
    pub rows: Vec<PgRow>,
    pub row_count: i64,
}

impl PgQueryResult {
    pub fn empty() -> Self {
        Self::default()
    }

    /// A result whose `rowCount` is `rows.length`, like `pg` reports a `SELECT`.
    pub fn from_rows(rows: Vec<PgRow>) -> Self {
        Self {
            row_count: rows.len() as i64,
            rows,
        }
    }

    /// A result without rows — an `UPDATE`/`INSERT`/`DELETE` reply.
    pub fn affected(row_count: i64) -> Self {
        Self {
            rows: Vec::new(),
            row_count,
        }
    }

    /// `result.rows[0]`.
    pub fn first(&self) -> Option<&PgRow> {
        self.rows.first()
    }

    /// `result.rows[0]?.id` — `postgresMemoryClient.ts:182`, `:192`, `:221`, `:240`.
    pub fn first_id(&self) -> Option<String> {
        self.first()
            .and_then(|row| row.get("id"))
            .map(|value| js_string(Some(value)))
            .filter(|id| !id.is_empty())
    }
}

/// One checked-out connection — `pg`'s `PoolClient`.
///
/// The methods are async and take `&self`, so an implementation can hand out an
/// `Arc` of itself (`sqlx`'s `PoolConnection` works exactly like that).
pub trait PgSession: Send + Sync {
    /// `client.query(text, values)` of `db.ts:72`, `:214` and `:72`'s siblings.
    fn query<'a>(
        &'a self,
        statement: PgStatement,
    ) -> BoxFuture<'a, Result<PgQueryResult, MemoryError>>;

    /// `client.release()` in the `finally` block of `db.ts:83` and `db.ts:225`.
    ///
    /// An implementation that returns the connection to its pool when the
    /// [`Arc`] is dropped (the `sqlx` behaviour) answers with an empty body; the
    /// port calls it on every path, so a recording implementation can assert it.
    fn release(&self);
}

/// The seam between this port and a real PostgreSQL pool — `pg`'s `Pool`.
///
/// Two capabilities, because `db.ts` uses exactly two: `pool.connect()` inside
/// the scoped wrappers and `pool.query()` on the unscoped path of
/// `countMemories` (`db.ts:107-110`).
pub trait PgExecutor: Send + Sync {
    /// `pool.connect()` — `db.ts:68`, `:182`, `:210`.
    fn connect<'a>(&'a self) -> BoxFuture<'a, Result<Arc<dyn PgSession>, MemoryError>>;

    /// `pool.query(text, values)` — `db.ts:109`, the no-scope branch.
    fn query<'a>(
        &'a self,
        statement: PgStatement,
    ) -> BoxFuture<'a, Result<PgQueryResult, MemoryError>>;
}

/// An executor that fails every statement, mirroring
/// [`UnreachableTransport`](crate::model_hub::http::UnreachableTransport).
///
/// The PostgreSQL stack arrives with S6; until a caller injects a real pool this
/// keeps the failure explicit instead of silently returning rows.
#[derive(Debug, Clone, Copy, Default)]
pub struct UnconfiguredPgExecutor;

impl PgExecutor for UnconfiguredPgExecutor {
    fn connect<'a>(&'a self) -> BoxFuture<'a, Result<Arc<dyn PgSession>, MemoryError>> {
        Box::pin(async { Err(MemoryError::storage(UNCONFIGURED_EXECUTOR_MESSAGE)) })
    }

    fn query<'a>(
        &'a self,
        _statement: PgStatement,
    ) -> BoxFuture<'a, Result<PgQueryResult, MemoryError>> {
        Box::pin(async { Err(MemoryError::storage(UNCONFIGURED_EXECUTOR_MESSAGE)) })
    }
}

/// The embedding step of the semantic search branch of `searchMemories`.
///
/// `postgresMemoryClient.ts:267-270` reads
/// `getConfiguredEmbeddingProvider()` (sync, `provider.ts:92-95`) and then awaits
/// `generateEmbeddingOnce(provider, input.query)` (`provider.ts:17-34`). The port
/// folds the two into one call: `Ok(None)` is "no provider is configured" — the
/// `if (provider && …)` guard of `:268` — and `Err` is the throw the surrounding
/// `catch` of `:304-309` logs before the lexical fallback.
pub trait QueryEmbedder: Send + Sync {
    fn embed<'a>(&'a self, text: &'a str) -> BoxFuture<'a, Result<Option<Vec<f64>>, MemoryError>>;
}

/// The embedder of an installation without a configured provider: every query
/// takes the lexical path, like `getConfiguredEmbeddingProvider() === null`.
#[derive(Debug, Clone, Copy, Default)]
pub struct NoQueryEmbedder;

impl QueryEmbedder for NoQueryEmbedder {
    fn embed<'a>(&'a self, _text: &'a str) -> BoxFuture<'a, Result<Option<Vec<f64>>, MemoryError>> {
        Box::pin(async { Ok(None) })
    }
}

/// `VectorHit` from `world-model/retrieval/vector.ts:14-21`.
#[derive(Debug, Clone, PartialEq)]
pub struct VectorHit {
    pub target_type: String,
    pub target_id: String,
    pub text: String,
    /// `1 - (embedding <=> query)`, higher is closer.
    pub similarity: f64,
    pub model: String,
    pub model_version: String,
}

/// `targetFilter` of `vectorSearch` — `retrieval/vector.ts:40-44`.
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

// ─── SQL ────────────────────────────────────────────────────────────────────
//
// Every statement is the template literal of the named source lines, token for
// token. The projection of the memory rows is shared (deviation 9), which is the
// only difference to the TypeScript text: it repeats the column list at
// `:284-287`, `:314-317`, `:366-369`, `:392-395`, `:428-431`, `:511-514` and
// `:576-579`, once with the indentation of each call site.

/// The projection every canonical memory row is read with — see the note above.
const MEMORY_ITEM_COLUMNS: &str = "id, user_id, persona_id, workspace_id, memory_type, content,
importance, confidence, lifecycle_status, version, metadata,
idempotency_key, legacy_provider, legacy_provider_id,
created_at, updated_at";

/// `BEGIN` — `world-model/db.ts:70`, `:154`, `:212`.
const SQL_BEGIN: &str = "BEGIN";
/// `COMMIT` — `world-model/db.ts:73`, `:158`, `:215`.
const SQL_COMMIT: &str = "COMMIT";
/// `ROLLBACK` — `world-model/db.ts:77`, `:161`, `:219`.
const SQL_ROLLBACK: &str = "ROLLBACK";

/// `setDatabaseScope` — `world-model/db.ts:43-47`.
///
/// `docs/RUST_MIGRATION.md:199-201`: this statement must precede the work of
/// every scoped transaction, because the RLS policies read the session settings
/// it sets.
const SQL_SET_SCOPE: &str = "SELECT world_model_set_scope($1, $2, $3)";

/// `addMemory` idempotency pre-check — `postgresMemoryClient.ts:176-179`.
const SQL_ADD_MEMORY_IDEMPOTENCY: &str = "\
SELECT id FROM world_model_memory_items
WHERE user_id = $1 AND persona_id = $2 AND workspace_id = $3
AND idempotency_key = $4 AND deleted_at IS NULL
LIMIT 1";

/// `addMemory` legacy-provider pre-check — `postgresMemoryClient.ts:186-189`.
const SQL_ADD_MEMORY_LEGACY: &str = "\
SELECT id FROM world_model_memory_items
WHERE user_id = $1 AND persona_id = $2 AND workspace_id = $3
AND legacy_provider = $4 AND legacy_provider_id = $5
LIMIT 1";

/// `addMemory` insert — `postgresMemoryClient.ts:196-202`.
const SQL_ADD_MEMORY_INSERT: &str = "\
INSERT INTO world_model_memory_items
(id, user_id, persona_id, workspace_id, memory_type, content,
importance, confidence, lifecycle_status, version, metadata,
idempotency_key, legacy_provider, legacy_provider_id, source_observation_id)
VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb,$12,$13,$14,$15)
ON CONFLICT DO NOTHING
RETURNING id";

/// `addMemory` conflict resolution — `postgresMemoryClient.ts:223-230`.
const SQL_ADD_MEMORY_CONFLICT: &str = "\
SELECT id FROM world_model_memory_items
WHERE user_id = $1 AND persona_id = $2 AND workspace_id = $3
AND deleted_at IS NULL
AND (
($4::text IS NOT NULL AND idempotency_key = $4)
OR ($5::text IS NOT NULL AND legacy_provider = $5 AND legacy_provider_id = $6)
)
LIMIT 1";

/// `addMemory` history row — `postgresMemoryClient.ts:244-246`.
const SQL_INSERT_HISTORY_CREATE: &str = "\
INSERT INTO world_model_memory_item_history
(memory_id, user_id, persona_id, workspace_id, action, version, content, metadata)
VALUES ($1,$2,$3,$4,'create',$5,$6,$7::jsonb)";

/// `vectorSearch` — `world-model/retrieval/vector.ts:61-90`.
///
/// `$1::vector` parses the pgvector text form of the query embedding and
/// `e.embedding <=> $1::vector` is the cosine distance; a row whose `embedding`
/// is `NULL` yields a `NULL` distance, so the comparison drops it — the same rule
/// a `NULL` embedding has in TypeScript.
const SQL_VECTOR_SEARCH: &str = "\
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

/// The row lookup of the semantic branch — `postgresMemoryClient.ts:284-292`.
const SQL_SEARCH_BY_IDS: &str = "\
SELECT id, user_id, persona_id, workspace_id, memory_type, content,
importance, confidence, lifecycle_status, version, metadata,
idempotency_key, legacy_provider, legacy_provider_id,
created_at, updated_at
FROM world_model_memory_items
WHERE id::text = ANY($1::text[])
AND user_id = $2 AND persona_id = $3 AND workspace_id = $4
AND lifecycle_status IN ('new', 'confirmed')
AND deleted_at IS NULL";

/// The lexical branch — `postgresMemoryClient.ts:314-325`.
const SQL_SEARCH_LEXICAL: &str = "\
SELECT id, user_id, persona_id, workspace_id, memory_type, content,
importance, confidence, lifecycle_status, version, metadata,
idempotency_key, legacy_provider, legacy_provider_id,
created_at, updated_at
FROM world_model_memory_items
WHERE user_id = $1 AND persona_id = $2 AND workspace_id = $3
AND deleted_at IS NULL
AND lifecycle_status IN ('new', 'confirmed')
AND ($4 = '' OR content ILIKE '%' || $4 || '%'
OR to_tsvector('simple', content) @@ plainto_tsquery('simple', $4))
ORDER BY updated_at DESC
LIMIT $5";

/// `updateMemory`/`deleteMemory` row lock — `:428-435` and `:511-518`.
const SQL_SELECT_MEMORY_ITEM_FOR_UPDATE: &str = "\
SELECT id, user_id, persona_id, workspace_id, memory_type, content,
importance, confidence, lifecycle_status, version, metadata,
idempotency_key, legacy_provider, legacy_provider_id,
created_at, updated_at
FROM world_model_memory_items
WHERE id = $1 AND user_id = $2 AND persona_id = $3 AND workspace_id = $4
AND deleted_at IS NULL
FOR UPDATE";

/// `updateMemory` write — `postgresMemoryClient.ts:461-464`.
const SQL_UPDATE_MEMORY_ITEM: &str = "\
UPDATE world_model_memory_items
SET memory_type = $1, content = $2, importance = $3, confidence = $4,
lifecycle_status = $5, version = $6, metadata = $7::jsonb, updated_at = now()
WHERE id = $8 AND version = $9";

/// `updateMemory` optimistic verification — `postgresMemoryClient.ts:478-480`.
const SQL_VERIFY_MEMORY_VERSION: &str = "\
SELECT 1 FROM world_model_memory_items
WHERE id = $1 AND user_id = $2 AND persona_id = $3 AND workspace_id = $4
AND version = $5";

/// `updateMemory` history row — `postgresMemoryClient.ts:487-489`.
const SQL_INSERT_HISTORY_UPDATE: &str = "\
INSERT INTO world_model_memory_item_history
(memory_id, user_id, persona_id, workspace_id, action, version, content, metadata)
VALUES ($1,$2,$3,$4,'update',$5,$6,$7::jsonb)";

/// `deleteMemory` / `deleteMemoriesByFilter` write — `:531-534` and `:594-597`.
const SQL_SOFT_DELETE_MEMORY_ITEM: &str = "\
UPDATE world_model_memory_items
SET deleted_at = now(), lifecycle_status = 'deleted', version = $1,
metadata = $2::jsonb, updated_at = now()
WHERE id = $3 AND user_id = $4 AND persona_id = $5 AND workspace_id = $6";

/// The delete history row of both delete paths — `:545-547` and `:608-610`.
const SQL_INSERT_HISTORY_DELETE: &str = "\
INSERT INTO world_model_memory_item_history
(memory_id, user_id, persona_id, workspace_id, action, version, content, metadata)
VALUES ($1,$2,$3,$4,'delete',$5,$6,$7::jsonb)";

/// `deleteMemory` vector cleanup — `postgresMemoryClient.ts:559-561`.
const SQL_DELETE_EMBEDDING_BY_TARGET: &str = "\
DELETE FROM world_model_embeddings
WHERE target_type = 'memory' AND target_id = $1
AND user_id = $2 AND persona_id = $3 AND workspace_id = $4";

/// `deleteMemoriesByFilter` vector cleanup — `postgresMemoryClient.ts:624`.
const SQL_DELETE_EMBEDDINGS_IN_SCOPE: &str =
    "DELETE FROM world_model_embeddings WHERE target_type = 'memory' AND user_id = $1 AND \
persona_id = $2 AND workspace_id = $3";

/// `deleteMemoriesByFilter` row lock — `postgresMemoryClient.ts:576-583`.
const SQL_SELECT_MEMORY_ITEMS_IN_SCOPE_FOR_UPDATE: &str = "\
SELECT id, user_id, persona_id, workspace_id, memory_type, content,
importance, confidence, lifecycle_status, version, metadata,
idempotency_key, legacy_provider, legacy_provider_id,
created_at, updated_at
FROM world_model_memory_items
WHERE user_id = $1 AND persona_id = $2 AND workspace_id = $3 AND deleted_at IS NULL
FOR UPDATE";

/// `countMemories` — `postgresMemoryClient.ts:644`.
const SQL_COUNT_MEMORY_ITEMS: &str =
    "SELECT world_model_count_memory_items($1, $2, $3)::text AS count";

/// `getMemory` — `postgresMemoryClient.ts:392-397`, with `${scopeClause}`.
fn memory_item_by_id_sql(scope_clause: &str) -> String {
    format!(
        "SELECT {MEMORY_ITEM_COLUMNS}\n\
FROM world_model_memory_items\n\
WHERE id = $1 {scope_clause} AND deleted_at IS NULL LIMIT 1"
    )
}

/// `getMemoryHistory` — `postgresMemoryClient.ts:412-415`, with `${scopeClause}`.
fn memory_history_sql(scope_clause: &str) -> String {
    format!(
        "SELECT action, version, content, metadata, created_at\n\
FROM world_model_memory_item_history\n\
WHERE memory_id = $1 {scope_clause}\n\
ORDER BY version ASC, created_at ASC"
    )
}

/// `listMemories` count — `postgresMemoryClient.ts:361`, with `${where}`.
fn list_memories_count_sql(where_clause: &str) -> String {
    format!("SELECT count(*)::text AS count FROM world_model_memory_items WHERE {where_clause}")
}

/// `listMemories` page — `postgresMemoryClient.ts:366-373`, with `${where}`,
/// `$${next}` and `$${next + 1}`.
fn list_memories_page_sql(where_clause: &str, next: i64) -> String {
    let limit = next + 1;
    format!(
        "SELECT {MEMORY_ITEM_COLUMNS}\n\
FROM world_model_memory_items\n\
WHERE {where_clause}\n\
ORDER BY updated_at DESC, id ASC\n\
OFFSET ${next} LIMIT ${limit}"
    )
}

// ─── Scope ──────────────────────────────────────────────────────────────────

/// `Required<Mem0Scope>` — what `normalizedScope` produces (`db.ts:30-36`) and
/// what `scopeFrom` returns (`postgresMemoryClient.ts:72-82`).
///
/// The three fields are the three parameters of
/// `world_model_set_scope($1, $2, $3)` and therefore the tenant key of every RLS
/// policy: an empty `workspace_id` is still an explicit `''`, never a missing
/// parameter (see `normalizedScope`, which fills the optional workspace).
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct NormalizedScope {
    pub user_id: String,
    pub persona_id: String,
    pub workspace_id: String,
}

/// `scopeFrom({ userId, personaId, workspaceId })` —
/// `postgresMemoryClient.ts:72-82`.
///
/// `text()` trims, and `text(undefined)` is `''`, so an absent id becomes an
/// empty string instead of a `NULL` parameter.
pub(crate) fn scope_from_parts(
    user_id: &str,
    persona_id: &str,
    workspace_id: Option<&str>,
) -> NormalizedScope {
    NormalizedScope {
        user_id: user_id.trim().to_string(),
        persona_id: persona_id.trim().to_string(),
        workspace_id: workspace_id.unwrap_or("").trim().to_string(),
    }
}

/// `scopeFrom(input: Mem0Scope)`.
pub(crate) fn scope_from(scope: &Mem0Scope) -> NormalizedScope {
    scope_from_parts(
        &scope.user_id,
        &scope.persona_id,
        scope.workspace_id.as_deref(),
    )
}

/// `scopeFromMemoryInput(input, scope?)` — `postgresMemoryClient.ts:84-91`.
///
/// `scope?.workspaceId ?? text(input.workspaceId ?? inputMetadata.workspaceId)`:
/// the explicit scope wins when its `workspaceId` is present, and the `??` chain
/// only falls through on `null`/`undefined` — an empty string is kept.
fn scope_from_memory_input(input: &Mem0MemoryInput, scope: Option<&Mem0Scope>) -> NormalizedScope {
    let workspace_id = scope
        .and_then(|scope| scope.workspace_id.as_deref())
        .map(str::to_string)
        .unwrap_or_else(|| {
            let raw = match input.workspace_id.as_deref() {
                Some(value) => Value::String(value.to_string()),
                None => input
                    .metadata
                    .get("workspaceId")
                    .cloned()
                    .unwrap_or(Value::Null),
            };
            trimmed_text(Some(&raw))
        });
    scope_from_parts(&input.user_id, &input.persona_id, Some(&workspace_id))
}

/// `setDatabaseScope(client, scope)` — `world-model/db.ts:38-48`.
///
/// The single statement that makes the RLS policies of the following work see
/// this tenant (`docs/RUST_MIGRATION.md:199-201`).
async fn set_database_scope(
    session: &dyn PgSession,
    scope: &NormalizedScope,
) -> Result<(), MemoryError> {
    session
        .query(PgStatement::with_params(
            SQL_SET_SCOPE,
            vec![
                PgValue::text(scope.user_id.as_str()),
                PgValue::text(scope.persona_id.as_str()),
                PgValue::text(scope.workspace_id.as_str()),
            ],
        ))
        .await
        .map(|_| ())
}

// ─── Transactions ───────────────────────────────────────────────────────────

/// The `(db) => …` callback of `withWorldModelTransaction` (`db.ts:204-207`),
/// boxed so the port can hand the session over as an owned [`Arc`] — the
/// `db.ts` callback receives the `PoolClient` of the transaction in the same way.
type ScopedBody<T> =
    Box<dyn FnOnce(Arc<dyn PgSession>) -> BoxFuture<'static, Result<T, MemoryError>> + Send>;

/// `withWorldModelTransaction(callback, scope)` — `world-model/db.ts:204-229`.
///
/// Acquire a connection, run `BEGIN` → scope → work → `COMMIT`, roll back on
/// failure and always release, like the `try`/`catch`/`finally` of the source.
async fn run_scoped<T: Send + 'static>(
    executor: &dyn PgExecutor,
    scope: Option<&NormalizedScope>,
    body: ScopedBody<T>,
) -> Result<T, MemoryError> {
    let session = executor.connect().await?;
    let outcome = scoped_transaction(Arc::clone(&session), scope, body).await;
    if outcome.is_err() {
        // `catch (error) { try { await client.query('ROLLBACK') } catch … }` —
        // a failing rollback must not replace the original error (`db.ts:217-222`).
        let _ = session.query(PgStatement::new(SQL_ROLLBACK)).await;
    }
    session.release();
    outcome
}

/// The `try` block of [`run_scoped`], split out so the `?` chain stays readable.
async fn scoped_transaction<T: Send + 'static>(
    session: Arc<dyn PgSession>,
    scope: Option<&NormalizedScope>,
    body: ScopedBody<T>,
) -> Result<T, MemoryError> {
    session.query(PgStatement::new(SQL_BEGIN)).await?;
    if let Some(scope) = scope {
        set_database_scope(session.as_ref(), scope).await?;
    }
    let value = body(Arc::clone(&session)).await?;
    session.query(PgStatement::new(SQL_COMMIT)).await?;
    Ok(value)
}

/// `queryWithScope(pool, text, values, scope)` — `world-model/db.ts:62-85`.
///
/// The shape of every statement the client runs while
/// `runWithWorldModelScope` is active: one statement, its own scoped
/// transaction, because the TypeScript wraps each `getWorldModelDb().query(...)`
/// call individually (`db.ts:107-110`).
async fn scoped_query(
    executor: &dyn PgExecutor,
    scope: &NormalizedScope,
    statement: PgStatement,
) -> Result<PgQueryResult, MemoryError> {
    run_scoped(
        executor,
        Some(scope),
        Box::new(move |session| Box::pin(async move { session.query(statement).await })),
    )
    .await
}

// ─── Values ─────────────────────────────────────────────────────────────────

/// JavaScript truthiness, as the `||` and `?:` guards of the source use it.
///
/// [`crate::memory::sqlite::client`] has the same private helper; it is not
/// exported, so the four falsy cases are repeated here: `null`/`undefined`,
/// `false`, `0`/`NaN` and `""` are falsy, while `{}` and `[]` are truthy.
fn truthy(value: Option<&Value>) -> bool {
    match value {
        None | Some(Value::Null) => false,
        Some(Value::Bool(flag)) => *flag,
        Some(Value::Number(number)) => number.as_f64().map(|value| value != 0.0).unwrap_or(false),
        Some(Value::String(text)) => !text.is_empty(),
        Some(Value::Array(_)) | Some(Value::Object(_)) => true,
    }
}

/// The truthiness of a `string | undefined` — `countMemories` branches on
/// `input.personaId` (`postgresMemoryClient.ts:639`) *before* trimming it.
fn truthy_str(value: Option<&str>) -> bool {
    matches!(value, Some(text) if !text.is_empty())
}

/// `Number(a) || b` — the `||` form, where `NaN` and `0` select the fallback.
///
/// Used by `addMemory` (`:166-169`) and by `updateMemory`, where the fallback is
/// the stored column (`:451`, `:455`).
fn number_or(raw: f64, fallback: f64) -> f64 {
    if raw.is_nan() || raw == 0.0 {
        fallback
    } else {
        raw
    }
}

/// `text(value) || fallback`.
fn text_or(value: Option<&Value>, fallback: &str) -> String {
    let text = trimmed_text(value);
    if text.is_empty() {
        fallback.to_string()
    } else {
        text
    }
}

/// `text(value) || null`.
fn nullable_text(value: Option<&Value>) -> Option<String> {
    let text = trimmed_text(value);
    if text.is_empty() {
        None
    } else {
        Some(text)
    }
}

/// `text(metadata.a || metadata.b) || null` — the first *raw* truthy value wins.
///
/// `legacyMem0Id || legacyProviderId` (`:163`) and
/// `sourceObservationId || source_observation_id` (`:171`) pick the first value
/// that is not falsy, so a whitespace-only `legacyMem0Id` is selected and then
/// trimmed to `null` — the second key is never consulted.
fn first_truthy_text(metadata: &MemoryMetadata, keys: &[&str]) -> Option<String> {
    match keys
        .iter()
        .filter_map(|key| metadata.get(*key))
        .find(|value| truthy(Some(*value)))
    {
        Some(value) => nullable_text(Some(value)),
        None => None,
    }
}

/// `Number(x)` rendered the way `JSON.stringify` renders it.
///
/// `serde_json` writes the `f64` `3.0` where JavaScript writes `3`, and a
/// non-finite number becomes `null` (what `JSON.stringify(NaN)` does). `-0` is
/// `0` in both.
fn js_json_number(value: f64) -> Value {
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

/// `safePage(value)` — `postgresMemoryClient.ts:139-141`.
fn safe_page(value: f64) -> i64 {
    1_i64.max(if value.is_finite() { value } else { 1.0 }.floor() as i64)
}

/// `safePageSize(value)` — `postgresMemoryClient.ts:143-145`.
fn safe_page_size(value: f64) -> i64 {
    let base = if value.is_finite() { value } else { 50.0 };
    1_i64.max(200_i64.min(base.floor() as i64))
}

// ─── Row access ─────────────────────────────────────────────────────────────

/// `row.<column>` without a coercion — the source reads `content`,
/// `memory_type`, `lifecycle_status` and `id` directly (`:111-115`).
fn row_value(row: &PgRow, column: &str) -> String {
    js_string(row.get(column))
}

/// `text(row.<column>)`.
fn row_text(row: &PgRow, column: &str) -> String {
    trimmed_text(row.get(column))
}

/// `Number(row.<column>)`.
fn row_number(row: &PgRow, column: &str) -> f64 {
    js_number(row.get(column))
}

/// `timestamp(row.<column>)` — `postgresMemoryClient.ts:60-64`.
///
/// A `Date` becomes its ISO string and an unparsable or missing value becomes
/// *now*; [`normalize_timestamp`] is exactly that pair, and a driver hands the
/// `timestamptz` column over as text (deviation 10).
fn row_timestamp(row: &PgRow, column: &str) -> String {
    normalize_timestamp(Some(&row_text(row, column)))
}

/// `rowMetadata(row)` — `postgresMemoryClient.ts:93-108`.
///
/// The stored bag is the base, the derived keys are inserted in source order and
/// an existing key keeps its position (`serde_json` is built with
/// `preserve_order`, see `crate::memory::mappers`), which is what the object
/// spreads of the source do. `workspaceId` and `legacyProviderId` are
/// conditional because the source spreads `…(row.x ? { key: row.x } : {})`.
fn row_metadata(row: &PgRow) -> MemoryMetadata {
    let stored = pick_record(row.get("metadata"));
    let source = trimmed_text(stored.get("source"));
    let mut mapped = stored;
    mapped.insert(
        "type".to_string(),
        Value::String(row_value(row, "memory_type")),
    );
    mapped.insert(
        "importance".to_string(),
        js_json_number(row_number(row, "importance")),
    );
    mapped.insert(
        "confidence".to_string(),
        js_json_number(row_number(row, "confidence")),
    );
    mapped.insert(
        "lifecycleStatus".to_string(),
        Value::String(row_value(row, "lifecycle_status")),
    );
    mapped.insert(
        "version".to_string(),
        js_json_number(row_number(row, "version")),
    );
    mapped.insert(
        "source".to_string(),
        Value::String(if source.is_empty() {
            MEMORY_PROVIDER_LABEL.to_string()
        } else {
            source
        }),
    );
    mapped.insert(
        "memoryProvider".to_string(),
        Value::String(MEMORY_PROVIDER_LABEL.to_string()),
    );
    mapped.insert("memoryId".to_string(), Value::String(row_value(row, "id")));
    if truthy(row.get("workspace_id")) {
        mapped.insert(
            "workspaceId".to_string(),
            Value::String(row_value(row, "workspace_id")),
        );
    }
    if truthy(row.get("legacy_provider_id")) {
        mapped.insert(
            "legacyProviderId".to_string(),
            Value::String(row_value(row, "legacy_provider_id")),
        );
    }
    mapped.insert(
        "lastVerified".to_string(),
        Value::String(row_timestamp(row, "updated_at")),
    );
    mapped
}

/// `toRecord(row, score = null)` — `postgresMemoryClient.ts:110-119`.
fn to_record(row: &PgRow, score: Option<f64>) -> Mem0MemoryRecord {
    Mem0MemoryRecord {
        id: row_value(row, "id"),
        content: row_value(row, "content"),
        score,
        metadata: row_metadata(row),
        created_at: Some(row_timestamp(row, "created_at")),
        updated_at: Some(row_timestamp(row, "updated_at")),
    }
}

/// `historyEntry(row)` — `postgresMemoryClient.ts:121-137`.
fn history_entry(row: &PgRow) -> Mem0HistoryEntry {
    let stored = pick_record(row.get("metadata"));
    let version = row_number(row, "version");
    let mut metadata = stored.clone();
    metadata.insert("version".to_string(), js_json_number(version));

    let mut raw = MemoryMetadata::new();
    raw.insert(
        "action".to_string(),
        Value::String(row_value(row, "action")),
    );
    raw.insert("version".to_string(), js_json_number(version));
    raw.insert(
        "content".to_string(),
        Value::String(row_value(row, "content")),
    );
    raw.insert("metadata".to_string(), Value::Object(stored));

    Mem0HistoryEntry {
        action: row_value(row, "action"),
        timestamp: Some(row_timestamp(row, "created_at")),
        content: Some(row_value(row, "content")),
        metadata,
        raw,
    }
}

/// `Number(result.rows[0]?.count ?? 0)` — `:378`, `:647` (deviation 5).
fn counted(row: Option<&PgRow>) -> i64 {
    let number = js_number(row.and_then(|row| row.get("count")));
    if number.is_finite() {
        number.trunc() as i64
    } else {
        0
    }
}

/// `JSON.stringify(queryEmbedding)` — `retrieval/vector.ts:52`.
///
/// The pgvector text form is the JSON array of the coordinates, parsed by the
/// `$1::vector` cast of the statement. The coordinates go through
/// [`js_json_number`], so a non-finite one is written as `null` (what
/// `JSON.stringify` does) and an integral one without the `.0` that
/// `serde_json` would add. The dimension is not validated here either — the cast
/// is the only place that checks it against the column type, and a `NULL`
/// `embedding` column makes the distance `NULL`, which the `>= $5` comparison
/// then drops (the same rule for a `NULL` embedding in TypeScript).
///
/// Known formatting difference: JavaScript writes magnitudes from `1e21` on as
/// `1e+21`, `ryu` writes `1e21`. The cast parses both identically, and no
/// embedding model of this project emits such a coordinate.
fn pgvector_text(values: &[f64]) -> String {
    let encoded: Vec<Value> = values.iter().map(|value| js_json_number(*value)).collect();
    Value::Array(encoded).to_string()
}

/// `{ ...metadata(row.metadata), lifecycleStatus: 'deleted', version: nextVersion }`
/// followed by `JSON.stringify` — `:525-529` and `:588-592`.
fn deleted_metadata(row: &PgRow, next_version: i64) -> String {
    let mut next = pick_record(row.get("metadata"));
    next.insert(
        "lifecycleStatus".to_string(),
        Value::String("deleted".to_string()),
    );
    next.insert("version".to_string(), js_json_number(next_version as f64));
    Value::Object(next).to_string()
}

/// `Math.min(5, Math.max(1, Math.round(Number(x) || fallback)))` — `:166`.
///
/// `fallback` is the stored column in `updateMemory` (`:451`) and `3` in
/// `addMemory`, so a `NaN` cannot reach the clamp: the column is `NOT NULL`
/// (`migrations/016_canonical_memory.sql:17`) and `|| 3` covers the other case.
fn clamp_importance(value: Option<&Value>, fallback: f64) -> i64 {
    number_or(js_number(value), fallback)
        .round()
        .clamp(1.0, 5.0) as i64
}

/// `Math.min(1, Math.max(0.1, Number(x) || fallback))` — `:167`, `:453-456`.
fn clamp_confidence(value: Option<&Value>, fallback: f64) -> f64 {
    number_or(js_number(value), fallback).clamp(0.1, 1.0)
}

/// `Math.max(1, Math.floor(Number(x) || 1))` — `:169`.
fn safe_version(value: Option<&Value>) -> i64 {
    1_i64.max(number_or(js_number(value), 1.0).floor() as i64)
}

/// `Math.max(20, Math.min(100, limit * 5))` — `:276`.
fn vector_limit(limit: i64) -> i64 {
    20_i64.max(100_i64.min(limit * 5))
}

// ─── The client ─────────────────────────────────────────────────────────────

/// `PostgresMemoryClient` from `postgresMemoryClient.ts:147-155`.
///
/// Construct with [`PostgresMemoryClient::new`] for the lexical provider or with
/// [`PostgresMemoryClient::with_embedder`] for the semantic one.
pub struct PostgresMemoryClient {
    executor: Arc<dyn PgExecutor>,
    embedder: Arc<dyn QueryEmbedder>,
}

/// The three tenant parameters of a scope predicate, in the order every
/// statement of the source binds them (`:180`, `:190`, `:198`, `:232`, `:326`…).
fn scope_params(scope: &NormalizedScope) -> Vec<PgValue> {
    vec![
        PgValue::text(scope.user_id.as_str()),
        PgValue::text(scope.persona_id.as_str()),
        PgValue::text(scope.workspace_id.as_str()),
    ]
}

/// The values `addMemory` derives *before* it opens the transaction —
/// `postgresMemoryClient.ts:158-171`.
struct NewMemoryItem {
    id: String,
    content: String,
    memory_type: String,
    importance: i64,
    confidence: f64,
    lifecycle_status: String,
    version: i64,
    /// `JSON.stringify(inputMetadata)`.
    metadata_json: String,
    idempotency_key: Option<String>,
    legacy_provider: Option<String>,
    legacy_provider_id: Option<String>,
    source_observation_id: Option<String>,
}

impl PostgresMemoryClient {
    /// `new PostgresMemoryClient()` with a caller-supplied pool.
    pub fn new(executor: Arc<dyn PgExecutor>) -> Self {
        Self {
            executor,
            embedder: Arc::new(NoQueryEmbedder),
        }
    }

    /// The same client with the embedding capability of the semantic branch.
    pub fn with_embedder(executor: Arc<dyn PgExecutor>, embedder: Arc<dyn QueryEmbedder>) -> Self {
        Self { executor, embedder }
    }

    pub fn executor(&self) -> &Arc<dyn PgExecutor> {
        &self.executor
    }

    pub fn embedder(&self) -> &Arc<dyn QueryEmbedder> {
        &self.embedder
    }

    /// `addMemory(input)` — `postgresMemoryClient.ts:157-261`.
    ///
    /// The scope, the id and every normalised column value are computed before
    /// the transaction opens, exactly like the source; the insert, the two
    /// duplicate pre-checks and the history row run inside one scoped
    /// transaction (`withWorldModelTransaction(…, scope)` at `:173`/`:258`).
    pub async fn add_memory(&self, input: &Mem0MemoryInput) -> Result<Mem0AddResult, MemoryError> {
        let scope = scope_from_memory_input(input, None);
        let metadata = &input.metadata;
        let item = NewMemoryItem {
            // `randomUUID()` — `:164`.
            id: Uuid::new_v4().to_string(),
            content: input.content.clone(),
            memory_type: text_or(metadata.get("type"), "fact"),
            importance: clamp_importance(metadata.get("importance"), 3.0),
            confidence: clamp_confidence(metadata.get("confidence"), 0.3),
            lifecycle_status: text_or(metadata.get("lifecycleStatus"), "new"),
            version: safe_version(metadata.get("version")),
            metadata_json: Value::Object(metadata.clone()).to_string(),
            idempotency_key: nullable_text(metadata.get("idempotencyKey")),
            legacy_provider: nullable_text(metadata.get("legacyProvider")),
            legacy_provider_id: first_truthy_text(metadata, &["legacyMem0Id", "legacyProviderId"]),
            source_observation_id: first_truthy_text(
                metadata,
                &["sourceObservationId", "source_observation_id"],
            ),
        };
        let body_scope = scope.clone();
        run_scoped(
            self.executor.as_ref(),
            Some(&scope),
            Box::new(move |session| {
                Box::pin(async move { insert_new_memory(session, body_scope, item).await })
            }),
        )
        .await
    }

    /// `searchMemories(input)` — `postgresMemoryClient.ts:263-330`.
    ///
    /// The semantic branch runs first and returns early when it found relevant
    /// hits (even if the row lookup dropped all of them, `:296-302`); without an
    /// embedding provider, without a hit or after a failure the lexical
    /// statement runs. Every statement is wrapped in its own scoped transaction
    /// (`runWithWorldModelScope(scope, …)` at `:266`).
    pub async fn search_memories(
        &self,
        input: &Mem0SearchInput,
    ) -> Result<Vec<Mem0SearchHit>, MemoryError> {
        let scope = scope_from_parts(
            &input.user_id,
            &input.persona_id,
            input.workspace_id.as_deref(),
        );
        let limit = safe_page_size(input.limit as f64);

        if !input.query.trim().is_empty() {
            match self.semantic_hits(&scope, &input.query, limit).await {
                Ok(Some(hits)) => return Ok(hits),
                Ok(None) => {}
                Err(error) => {
                    // `console.warn('[memory:postgres] semantic search
                    // unavailable; using lexical search:', error)` — `:305-308`.
                    tracing::warn!(
                        error = %error,
                        "[memory:postgres] semantic search unavailable; using lexical search"
                    );
                }
            }
        }

        let query = input.query.trim().to_string();
        let mut params = scope_params(&scope);
        params.push(PgValue::text(query.as_str()));
        params.push(PgValue::int(limit));
        let result = scoped_query(
            self.executor.as_ref(),
            &scope,
            PgStatement::with_params(SQL_SEARCH_LEXICAL, params),
        )
        .await?;
        Ok(result
            .rows
            .iter()
            .map(|row| {
                // `toRecord(row, query ? 0.5 : null)` — `:328`.
                let score = if query.is_empty() { None } else { Some(0.5) };
                to_hit(to_record(row, score))
            })
            .collect())
    }

    /// The `try { … }` block of `searchMemories` — `postgresMemoryClient.ts:268-310`.
    ///
    /// `Ok(None)` is "no vector hit points at a memory row", which falls through
    /// to the lexical query; `Err` is the caught-and-warned case of `:304`.
    async fn semantic_hits(
        &self,
        scope: &NormalizedScope,
        query: &str,
        limit: i64,
    ) -> Result<Option<Vec<Mem0SearchHit>>, MemoryError> {
        // `if (provider && input.query.trim())` — the embedder reports the
        // provider; an absent provider is `Ok(None)`.
        let Some(embedding) = self.embedder.embed(query).await? else {
            return Ok(None);
        };

        let include = ["memory"];
        let hits = self
            .vector_search(
                &embedding,
                scope,
                vector_limit(limit),
                0.2,
                VectorTargetFilter {
                    include: Some(&include),
                    exclude: None,
                    active_memory_only: true,
                },
            )
            .await?;

        // `vectorHits.filter((hit) => hit.targetType === 'memory')`.
        let relevant: Vec<&VectorHit> = hits
            .iter()
            .filter(|hit| hit.target_type == "memory")
            .collect();
        if relevant.is_empty() {
            return Ok(None);
        }

        let ids: Vec<String> = relevant.iter().map(|hit| hit.target_id.clone()).collect();
        let mut params = vec![PgValue::text_array(ids)];
        params.extend(scope_params(scope));
        let rows = scoped_query(
            self.executor.as_ref(),
            scope,
            PgStatement::with_params(SQL_SEARCH_BY_IDS, params),
        )
        .await?;

        // `const byId = new Map(rows.rows.map((row) => [row.id, row]))`.
        let by_id: HashMap<String, &PgRow> = rows
            .rows
            .iter()
            .map(|row| (row_value(row, "id"), row))
            .collect();

        // `relevant.map(…).filter(Boolean).slice(0, limit)` — a hit without a row
        // is dropped and the remaining ones keep the vector order.
        Ok(Some(
            relevant
                .iter()
                .filter_map(|hit| {
                    by_id
                        .get(&hit.target_id)
                        .map(|row| to_hit(to_record(row, Some(hit.similarity))))
                })
                .take(limit as usize)
                .collect(),
        ))
    }

    /// `vectorSearch(queryEmbedding, userId, personaId, workspaceId, limit,
    /// minSimilarity, targetFilter)` — `world-model/retrieval/vector.ts:33-116`.
    ///
    /// The statement and its nine parameters are verbatim; the caller of S6 owns
    /// the public `retrieval::vector` module this copy will move into.
    async fn vector_search(
        &self,
        query_embedding: &[f64],
        scope: &NormalizedScope,
        limit: i64,
        min_similarity: f64,
        filter: VectorTargetFilter<'_>,
    ) -> Result<Vec<VectorHit>, MemoryError> {
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

        let params = vec![
            // `JSON.stringify(queryEmbedding)` — `vector.ts:52`.
            PgValue::text(pgvector_text(query_embedding)),
            PgValue::text(scope.user_id.as_str()),
            PgValue::text(scope.persona_id.as_str()),
            PgValue::text(scope.workspace_id.as_str()),
            PgValue::float(min_similarity),
            PgValue::int(limit),
            PgValue::nullable_text_array(include),
            PgValue::nullable_text_array(exclude),
            PgValue::boolean(filter.active_memory_only),
        ];
        let result = scoped_query(
            self.executor.as_ref(),
            scope,
            PgStatement::with_params(SQL_VECTOR_SEARCH, params),
        )
        .await?;

        Ok(result
            .rows
            .iter()
            .map(|row| VectorHit {
                target_type: row_value(row, "target_type"),
                target_id: row_value(row, "target_id"),
                text: row_value(row, "text"),
                similarity: row_number(row, "similarity"),
                model: row_value(row, "model"),
                model_version: row_value(row, "model_version"),
            })
            .collect())
    }

    /// `listMemories(input)` — `postgresMemoryClient.ts:332-383`.
    ///
    /// The filter list is built exactly like the source (`:341-359`), the count
    /// statement is sent with the parameters as they were at that moment
    /// (deviation 2) and the page statement then adds the offset and the limit.
    pub async fn list_memories(
        &self,
        input: &Mem0ListInput,
    ) -> Result<Mem0ListMemoryResult, MemoryError> {
        let page = safe_page(input.page as f64);
        let page_size = safe_page_size(input.page_size as f64);
        let scope = scope_from_parts(
            &input.user_id,
            input.persona_id.as_deref().unwrap_or(""),
            input.workspace_id.as_deref(),
        );

        let mut filters = vec![
            "user_id = $1".to_string(),
            "persona_id = $2".to_string(),
            "workspace_id = $3".to_string(),
            "deleted_at IS NULL".to_string(),
        ];
        let mut values = scope_params(&scope);
        let mut next = 4_i64;
        if let Some(query) = input
            .query
            .as_deref()
            .map(str::trim)
            .filter(|v| !v.is_empty())
        {
            filters.push(format!("content ILIKE '%' || ${next} || '%'"));
            values.push(PgValue::text(query));
            next += 1;
        }
        if let Some(node_type) = input
            .node_type
            .as_deref()
            .map(str::trim)
            .filter(|v| !v.is_empty())
        {
            filters.push(format!("memory_type = ${next}"));
            values.push(PgValue::text(node_type));
            next += 1;
        }
        let where_clause = filters.join(" AND ");

        let count = scoped_query(
            self.executor.as_ref(),
            &scope,
            PgStatement::with_params(list_memories_count_sql(&where_clause), values.clone()),
        )
        .await?;

        // `values.push((page - 1) * pageSize, pageSize)` — `:364`.
        values.push(PgValue::int((page - 1) * page_size));
        values.push(PgValue::int(page_size));
        let rows = scoped_query(
            self.executor.as_ref(),
            &scope,
            PgStatement::with_params(list_memories_page_sql(&where_clause, next), values),
        )
        .await?;

        Ok(Mem0ListMemoryResult {
            memories: rows.rows.iter().map(|row| to_record(row, None)).collect(),
            total: counted(count.first()),
            page,
            page_size,
        })
    }

    /// `getMemory(id, scope?)` — `postgresMemoryClient.ts:385-403`.
    ///
    /// Without a scope the statement drops the scope clause and runs unscoped on
    /// the pool (the `execute()` of `:402`); with one it moves into a scoped
    /// transaction.
    pub async fn get_memory(
        &self,
        id: &str,
        scope: Option<&Mem0Scope>,
    ) -> Result<Option<Mem0MemoryRecord>, MemoryError> {
        let resolved = scope.map(scope_from);
        let scope_clause = match &resolved {
            Some(_) => "AND user_id = $2 AND persona_id = $3 AND workspace_id = $4",
            None => "",
        };
        let mut params = vec![PgValue::text(id)];
        if let Some(scope) = &resolved {
            params.extend(scope_params(scope));
        }
        let statement = PgStatement::with_params(memory_item_by_id_sql(scope_clause), params);

        let result = match &resolved {
            Some(scope) => scoped_query(self.executor.as_ref(), scope, statement).await?,
            None => self.executor.query(statement).await?,
        };
        Ok(result.first().map(|row| to_record(row, None)))
    }

    /// `getMemoryHistory(id, scope?)` — `postgresMemoryClient.ts:405-421`.
    pub async fn get_memory_history(
        &self,
        id: &str,
        scope: Option<&Mem0Scope>,
    ) -> Result<Vec<Mem0HistoryEntry>, MemoryError> {
        let resolved = scope.map(scope_from);
        let scope_clause = match &resolved {
            Some(_) => "AND user_id = $2 AND persona_id = $3 AND workspace_id = $4",
            None => "",
        };
        let mut params = vec![PgValue::text(id)];
        if let Some(scope) = &resolved {
            params.extend(scope_params(scope));
        }
        let statement = PgStatement::with_params(memory_history_sql(scope_clause), params);

        let result = match &resolved {
            Some(scope) => scoped_query(self.executor.as_ref(), scope, statement).await?,
            None => self.executor.query(statement).await?,
        };
        Ok(result.rows.iter().map(history_entry).collect())
    }

    /// `updateMemory(id, input, scope?)` — `postgresMemoryClient.ts:423-501`.
    ///
    /// The scope comes from `scopeFromMemoryInput(input, scope)` (`:424`), so a
    /// caller-supplied scope only overrides the workspace.
    pub async fn update_memory(
        &self,
        id: &str,
        input: &Mem0MemoryInput,
        scope: Option<&Mem0Scope>,
    ) -> Result<(), MemoryError> {
        let resolved = scope_from_memory_input(input, scope);
        let id = id.to_string();
        let content = input.content.clone();
        let input_metadata = input.metadata.clone();
        let body_scope = resolved.clone();
        run_scoped(
            self.executor.as_ref(),
            Some(&resolved),
            Box::new(move |session| {
                Box::pin(async move {
                    update_memory_row(session, body_scope, id, content, input_metadata).await
                })
            }),
        )
        .await
    }

    /// `deleteMemory(id, scope?)` — `postgresMemoryClient.ts:503-567`.
    ///
    /// The scope is mandatory: without it the source throws
    /// (`:505-507`) and the port returns the same message before any statement.
    pub async fn delete_memory(
        &self,
        id: &str,
        scope: Option<&Mem0Scope>,
    ) -> Result<(), MemoryError> {
        let Some(resolved) = scope.map(scope_from) else {
            return Err(MemoryError::message(SCOPED_DELETION_REQUIRED));
        };
        let id = id.to_string();
        let body_scope = resolved.clone();
        run_scoped(
            self.executor.as_ref(),
            Some(&resolved),
            Box::new(move |session| {
                Box::pin(async move { delete_memory_row(session, body_scope, id).await })
            }),
        )
        .await
    }

    /// `deleteMemoriesByFilter(input)` — `postgresMemoryClient.ts:569-630`.
    ///
    /// One locked read, then an update plus a history row per match, then the
    /// vector cleanup — which the source only runs when the read found rows
    /// (`:622-627`). The result is the number of deleted rows.
    pub async fn delete_memories_by_filter(
        &self,
        input: &Mem0DeleteByFilterInput,
    ) -> Result<i64, MemoryError> {
        let scope = scope_from_parts(
            &input.user_id,
            &input.persona_id,
            input.workspace_id.as_deref(),
        );
        let body_scope = scope.clone();
        run_scoped(
            self.executor.as_ref(),
            Some(&scope),
            Box::new(move |session| {
                Box::pin(async move { delete_memories_in_scope(session, body_scope).await })
            }),
        )
        .await
    }

    /// `countMemories(input)` — `postgresMemoryClient.ts:632-650`.
    ///
    /// Not part of [`Mem0Client`] in TypeScript either — the interface ends at
    /// `mem0/types.ts:108` — so the port keeps it inherent. A blank user id
    /// returns `0` without touching the database (`:637-638`), and without a
    /// persona the statement runs unscoped (`:649`, `execute()`).
    pub async fn count_memories(&self, input: &Mem0CountInput) -> Result<i64, MemoryError> {
        let user_id = input.user_id.as_deref().unwrap_or("").trim().to_string();
        if user_id.is_empty() {
            return Ok(0);
        }
        let persona = input.persona_id.as_deref();
        let scope = match persona {
            // `input.personaId ? scopeFrom({…}) : undefined` — the truthiness test
            // happens *before* the trim, exactly like `:639`.
            Some(persona_id) if truthy_str(Some(persona_id)) => Some(scope_from_parts(
                &user_id,
                persona_id,
                input.workspace_id.as_deref(),
            )),
            _ => None,
        };
        let params = vec![
            PgValue::text(user_id.as_str()),
            // `input.personaId?.trim() || null` — `:645`.
            PgValue::nullable_text(
                persona
                    .map(|persona_id| persona_id.trim().to_string())
                    .filter(|persona_id| !persona_id.is_empty()),
            ),
            PgValue::nullable_text(
                input
                    .workspace_id
                    .as_deref()
                    .map(|workspace_id| workspace_id.trim().to_string())
                    .filter(|workspace_id| !workspace_id.is_empty()),
            ),
        ];
        let statement = PgStatement::with_params(SQL_COUNT_MEMORY_ITEMS, params);
        let result = match &scope {
            Some(scope) => scoped_query(self.executor.as_ref(), scope, statement).await?,
            None => self.executor.query(statement).await?,
        };
        Ok(counted(result.first()))
    }
}

// ─── Transaction bodies ─────────────────────────────────────────────────────

/// The `withWorldModelTransaction(async (db) => …)` body of `addMemory` —
/// `postgresMemoryClient.ts:173-258`.
///
/// The statement order is the source order: the two duplicate pre-checks, the
/// insert, the conflict resolution when the insert returned no row, and the
/// history row only after a successful insert.
async fn insert_new_memory(
    session: Arc<dyn PgSession>,
    scope: NormalizedScope,
    item: NewMemoryItem,
) -> Result<Mem0AddResult, MemoryError> {
    if let Some(idempotency_key) = item.idempotency_key.as_deref() {
        let mut params = scope_params(&scope);
        params.push(PgValue::text(idempotency_key));
        let existing = session
            .query(PgStatement::with_params(SQL_ADD_MEMORY_IDEMPOTENCY, params))
            .await?;
        if let Some(id) = existing.first_id() {
            return Ok(Mem0AddResult::existing(id));
        }
    }

    if let (Some(legacy_provider), Some(legacy_provider_id)) = (
        item.legacy_provider.as_deref(),
        item.legacy_provider_id.as_deref(),
    ) {
        let mut params = scope_params(&scope);
        params.push(PgValue::text(legacy_provider));
        params.push(PgValue::text(legacy_provider_id));
        let existing = session
            .query(PgStatement::with_params(SQL_ADD_MEMORY_LEGACY, params))
            .await?;
        if let Some(id) = existing.first_id() {
            return Ok(Mem0AddResult::existing(id));
        }
    }

    let mut params = vec![PgValue::text(item.id.as_str())];
    params.extend(scope_params(&scope));
    params.push(PgValue::text(item.memory_type.as_str()));
    params.push(PgValue::text(item.content.as_str()));
    params.push(PgValue::int(item.importance));
    params.push(PgValue::float(item.confidence));
    params.push(PgValue::text(item.lifecycle_status.as_str()));
    params.push(PgValue::int(item.version));
    params.push(PgValue::text(item.metadata_json.as_str()));
    params.push(PgValue::nullable_text(item.idempotency_key.clone()));
    params.push(PgValue::nullable_text(item.legacy_provider.clone()));
    params.push(PgValue::nullable_text(item.legacy_provider_id.clone()));
    params.push(PgValue::nullable_text(item.source_observation_id.clone()));
    let inserted = session
        .query(PgStatement::with_params(SQL_ADD_MEMORY_INSERT, params))
        .await?;

    // `if (!inserted.rows[0]?.id)` — `:221`.
    let Some(inserted_id) = inserted.first_id() else {
        let mut params = scope_params(&scope);
        params.push(PgValue::nullable_text(item.idempotency_key.clone()));
        params.push(PgValue::nullable_text(item.legacy_provider.clone()));
        params.push(PgValue::nullable_text(item.legacy_provider_id.clone()));
        let conflict = session
            .query(PgStatement::with_params(SQL_ADD_MEMORY_CONFLICT, params))
            .await?;
        return match conflict.first_id() {
            Some(id) => Ok(Mem0AddResult::existing(id)),
            None => Err(MemoryError::message(UNKNOWN_INSERT_CONFLICT)),
        };
    };

    let mut params = vec![PgValue::text(item.id.as_str())];
    params.extend(scope_params(&scope));
    params.push(PgValue::int(item.version));
    params.push(PgValue::text(item.content.as_str()));
    params.push(PgValue::text(item.metadata_json.as_str()));
    session
        .query(PgStatement::with_params(SQL_INSERT_HISTORY_CREATE, params))
        .await?;

    Ok(Mem0AddResult::created(inserted_id))
}

/// The `withWorldModelTransaction(async (db) => …)` body of `updateMemory` —
/// `postgresMemoryClient.ts:426-500`.
async fn update_memory_row(
    session: Arc<dyn PgSession>,
    scope: NormalizedScope,
    id: String,
    content: String,
    input_metadata: MemoryMetadata,
) -> Result<(), MemoryError> {
    let mut params = vec![PgValue::text(id.as_str())];
    params.extend(scope_params(&scope));
    let current = session
        .query(PgStatement::with_params(
            SQL_SELECT_MEMORY_ITEM_FOR_UPDATE,
            params,
        ))
        .await?;
    let Some(row) = current.first() else {
        return Err(MemoryError::message(format!(
            "{MEMORY_NOT_FOUND_PREFIX}{id}"
        )));
    };

    let current_version = row_number(row, "version") as i64;
    // `Number.isFinite(supplied) ? Math.floor(supplied) : Number(row.version)` —
    // `:440-443`.
    let supplied = js_number(input_metadata.get("expectedVersion"));
    let expected_version = if supplied.is_finite() {
        supplied.floor() as i64
    } else {
        current_version
    };
    if expected_version != current_version {
        return Err(MemoryError::VersionConflict { current_version });
    }

    let version = current_version + 1;
    let memory_type = text_or(input_metadata.get("type"), &row_value(row, "memory_type"));
    let importance = clamp_importance(
        input_metadata.get("importance"),
        row_number(row, "importance"),
    );
    let confidence = clamp_confidence(
        input_metadata.get("confidence"),
        row_number(row, "confidence"),
    );
    let lifecycle_status = text_or(
        input_metadata.get("lifecycleStatus"),
        &row_value(row, "lifecycle_status"),
    );

    // `const persistedMetadata = { ...inputMetadata }; delete
    // persistedMetadata.expectedVersion;` — `:458-459`.
    let mut persisted = input_metadata;
    persisted.remove("expectedVersion");
    let persisted_json = Value::Object(persisted).to_string();

    session
        .query(PgStatement::with_params(
            SQL_UPDATE_MEMORY_ITEM,
            vec![
                PgValue::text(memory_type.as_str()),
                PgValue::text(content.as_str()),
                PgValue::int(importance),
                PgValue::float(confidence),
                PgValue::text(lifecycle_status.as_str()),
                PgValue::int(version),
                PgValue::text(persisted_json.as_str()),
                PgValue::text(id.as_str()),
                PgValue::int(expected_version),
            ],
        ))
        .await?;

    // `if (updated.rowCount !== 1) throw …` — `:477-485`.
    let mut params = vec![PgValue::text(id.as_str())];
    params.extend(scope_params(&scope));
    params.push(PgValue::int(version));
    let updated = session
        .query(PgStatement::with_params(SQL_VERIFY_MEMORY_VERSION, params))
        .await?;
    if updated.row_count != 1 {
        return Err(MemoryError::VersionConflict { current_version });
    }

    let mut params = vec![PgValue::text(id.as_str())];
    params.extend(scope_params(&scope));
    params.push(PgValue::int(version));
    params.push(PgValue::text(content.as_str()));
    params.push(PgValue::text(persisted_json.as_str()));
    session
        .query(PgStatement::with_params(SQL_INSERT_HISTORY_UPDATE, params))
        .await?;

    Ok(())
}

/// The `withWorldModelTransaction(async (db) => …)` body of `deleteMemory` —
/// `postgresMemoryClient.ts:508-566`.
async fn delete_memory_row(
    session: Arc<dyn PgSession>,
    scope: NormalizedScope,
    id: String,
) -> Result<(), MemoryError> {
    let mut params = vec![PgValue::text(id.as_str())];
    params.extend(scope_params(&scope));
    let current = session
        .query(PgStatement::with_params(
            SQL_SELECT_MEMORY_ITEM_FOR_UPDATE,
            params,
        ))
        .await?;
    let Some(row) = current.first() else {
        return Err(MemoryError::message(format!(
            "{MEMORY_NOT_FOUND_PREFIX}{id}"
        )));
    };

    let next_version = row_number(row, "version") as i64 + 1;
    let next_metadata = deleted_metadata(row, next_version);
    let content = row_value(row, "content");

    let mut params = vec![PgValue::int(next_version)];
    params.push(PgValue::text(next_metadata.as_str()));
    params.push(PgValue::text(id.as_str()));
    params.extend(scope_params(&scope));
    session
        .query(PgStatement::with_params(
            SQL_SOFT_DELETE_MEMORY_ITEM,
            params,
        ))
        .await?;

    let mut params = vec![PgValue::text(id.as_str())];
    params.extend(scope_params(&scope));
    params.push(PgValue::int(next_version));
    params.push(PgValue::text(content.as_str()));
    params.push(PgValue::text(next_metadata.as_str()));
    session
        .query(PgStatement::with_params(SQL_INSERT_HISTORY_DELETE, params))
        .await?;

    let mut params = vec![PgValue::text(id.as_str())];
    params.extend(scope_params(&scope));
    session
        .query(PgStatement::with_params(
            SQL_DELETE_EMBEDDING_BY_TARGET,
            params,
        ))
        .await?;

    Ok(())
}

/// The `withWorldModelTransaction(async (db) => …)` body of
/// `deleteMemoriesByFilter` — `postgresMemoryClient.ts:575-629`.
async fn delete_memories_in_scope(
    session: Arc<dyn PgSession>,
    scope: NormalizedScope,
) -> Result<i64, MemoryError> {
    let current = session
        .query(PgStatement::with_params(
            SQL_SELECT_MEMORY_ITEMS_IN_SCOPE_FOR_UPDATE,
            scope_params(&scope),
        ))
        .await?;

    for row in &current.rows {
        let next_version = row_number(row, "version") as i64 + 1;
        let next_metadata = deleted_metadata(row, next_version);
        let row_id = row_value(row, "id");

        let mut params = vec![PgValue::int(next_version)];
        params.push(PgValue::text(next_metadata.as_str()));
        params.push(PgValue::text(row_id.as_str()));
        params.extend(scope_params(&scope));
        session
            .query(PgStatement::with_params(
                SQL_SOFT_DELETE_MEMORY_ITEM,
                params,
            ))
            .await?;

        let mut params = vec![PgValue::text(row_id.as_str())];
        params.extend(scope_params(&scope));
        params.push(PgValue::int(next_version));
        params.push(PgValue::text(row_value(row, "content").as_str()));
        params.push(PgValue::text(next_metadata.as_str()));
        session
            .query(PgStatement::with_params(SQL_INSERT_HISTORY_DELETE, params))
            .await?;
    }

    // `if (current.rows.length > 0)` — `:622`.
    if !current.rows.is_empty() {
        session
            .query(PgStatement::with_params(
                SQL_DELETE_EMBEDDINGS_IN_SCOPE,
                scope_params(&scope),
            ))
            .await?;
    }

    Ok(current.rows.len() as i64)
}

/// `Mem0MemoryRecord` → the declared `Mem0SearchHit` (deviation 3).
fn to_hit(record: Mem0MemoryRecord) -> Mem0SearchHit {
    Mem0SearchHit {
        id: record.id,
        content: record.content,
        score: record.score,
        metadata: record.metadata,
    }
}

// ─── The synchronous `Mem0Client` contract ──────────────────────────────────

/// Drives one operation future to completion for the synchronous [`Mem0Client`]
/// contract (deviation 8).
///
/// Three cases, exactly like the bridge of `Mem0HttpClient`:
///
/// * inside a multi-threaded runtime the current worker is released with
///   `block_in_place` and the future is driven through the runtime handle;
/// * inside a current-thread runtime the driver *is* the calling thread, so
///   blocking would dead-lock it — [`SYNC_BRIDGE_MESSAGE`] is returned and the
///   caller has to use the async methods;
/// * outside any runtime a temporary current-thread runtime is created, which is
///   what a plain `#[test]` or a blocking gateway thread does.
fn drive_sync<T>(future: impl std::future::Future<Output = T>) -> Result<T, MemoryError> {
    match tokio::runtime::Handle::try_current() {
        Ok(handle) if handle.runtime_flavor() == tokio::runtime::RuntimeFlavor::MultiThread => {
            Ok(tokio::task::block_in_place(|| handle.block_on(future)))
        }
        Ok(_) => Err(MemoryError::message(SYNC_BRIDGE_MESSAGE)),
        Err(_) => {
            let runtime = tokio::runtime::Builder::new_current_thread()
                .enable_all()
                .build()
                .map_err(|error| MemoryError::storage(format!("tokio runtime: {error}")))?;
            Ok(runtime.block_on(future))
        }
    }
}

/// `PostgresMemoryClient` as the provider the rest of the slice consumes.
///
/// Every method delegates to the inherent async method of the same name; the
/// trailing `?` unwraps the *bridge* result (a runtime problem, see
/// [`drive_sync`]) while the operation's own [`Result`] stays the return value.
/// The method-call syntax is required for the delegation: an inherent method
/// wins over the trait method of the same name, exactly as documented for
/// `Mem0HttpClient`.
impl Mem0Client for PostgresMemoryClient {
    /// `readonly provider = 'postgres' as const` — `postgresMemoryClient.ts:155`.
    fn provider(&self) -> Option<MemoryProviderKind> {
        Some(MemoryProviderKind::Postgres)
    }

    /// `addMemory(input, signal?)` — the class method declares no signal (`:157`).
    fn add_memory(&self, input: &Mem0MemoryInput) -> Result<Mem0AddResult, MemoryError> {
        drive_sync(self.add_memory(input))?
    }

    /// `searchMemories(input)` — `postgresMemoryClient.ts:263`.
    fn search_memories(&self, input: &Mem0SearchInput) -> Result<Vec<Mem0SearchHit>, MemoryError> {
        drive_sync(self.search_memories(input))?
    }

    /// `listMemories(input)` — `postgresMemoryClient.ts:332`.
    fn list_memories(&self, input: &Mem0ListInput) -> Result<Mem0ListMemoryResult, MemoryError> {
        drive_sync(self.list_memories(input))?
    }

    /// `getMemory(id, scope?)` — `postgresMemoryClient.ts:385`.
    fn get_memory(
        &self,
        id: &str,
        scope: Option<&Mem0Scope>,
    ) -> Result<Option<Mem0MemoryRecord>, MemoryError> {
        drive_sync(self.get_memory(id, scope))?
    }

    /// `getMemoryHistory(id, scope?)` — `postgresMemoryClient.ts:405`.
    fn get_memory_history(
        &self,
        id: &str,
        scope: Option<&Mem0Scope>,
    ) -> Result<Vec<Mem0HistoryEntry>, MemoryError> {
        drive_sync(self.get_memory_history(id, scope))?
    }

    /// `updateMemory(id, input, scope?)` — `postgresMemoryClient.ts:423`.
    fn update_memory(
        &self,
        id: &str,
        input: &Mem0MemoryInput,
        scope: Option<&Mem0Scope>,
    ) -> Result<(), MemoryError> {
        drive_sync(self.update_memory(id, input, scope))?
    }

    /// `deleteMemory(id, scope?)` — `postgresMemoryClient.ts:503`.
    fn delete_memory(&self, id: &str, scope: Option<&Mem0Scope>) -> Result<(), MemoryError> {
        drive_sync(self.delete_memory(id, scope))?
    }

    /// `deleteMemoriesByFilter(input)` — `postgresMemoryClient.ts:569`.
    fn delete_memories_by_filter(
        &self,
        input: &Mem0DeleteByFilterInput,
    ) -> Result<i64, MemoryError> {
        drive_sync(self.delete_memories_by_filter(input))?
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::{Arc, Mutex};

    use serde_json::json;

    /// The recorded work of the fake pool.
    #[derive(Default)]
    struct FakeState {
        statements: Mutex<Vec<PgStatement>>,
        releases: AtomicUsize,
    }

    /// The scripted answer of one statement: a result or the failure the driver
    /// would report as `MemoryError::Storage`.
    type Reply = Box<dyn Fn(&PgStatement) -> Result<PgQueryResult, MemoryError> + Send + Sync>;

    struct FakeSession {
        state: Arc<FakeState>,
        reply: Arc<Reply>,
    }

    impl PgSession for FakeSession {
        fn query<'a>(
            &'a self,
            statement: PgStatement,
        ) -> BoxFuture<'a, Result<PgQueryResult, MemoryError>> {
            let state = Arc::clone(&self.state);
            let reply = Arc::clone(&self.reply);
            Box::pin(async move {
                let result = reply(&statement);
                state
                    .statements
                    .lock()
                    .expect("statement log")
                    .push(statement);
                result
            })
        }

        fn release(&self) {
            self.state.releases.fetch_add(1, Ordering::SeqCst);
        }
    }

    /// A pool that records every statement and answers from a script.
    struct FakeExecutor {
        state: Arc<FakeState>,
        reply: Arc<Reply>,
    }

    impl FakeExecutor {
        fn new(
            reply: impl Fn(&PgStatement) -> Result<PgQueryResult, MemoryError> + Send + Sync + 'static,
        ) -> Self {
            Self {
                state: Arc::new(FakeState::default()),
                reply: Arc::new(Box::new(reply)),
            }
        }

        /// Answers every statement with an empty result.
        fn empty() -> Self {
            Self::new(|_| Ok(PgQueryResult::empty()))
        }

        fn statements(&self) -> Vec<PgStatement> {
            self.state.statements.lock().expect("statement log").clone()
        }

        fn releases(&self) -> usize {
            self.state.releases.load(Ordering::SeqCst)
        }

        /// Every statement that carries data, i.e. without `BEGIN`, `COMMIT`,
        /// `ROLLBACK` and the scope call.
        fn data(&self) -> Vec<PgStatement> {
            self.statements()
                .into_iter()
                .filter(|statement| !is_control(&statement.sql))
                .collect()
        }

        /// The data statements with collapsed whitespace, for the contract
        /// comparisons of deviation 9.
        fn sql(&self) -> Vec<String> {
            self.data()
                .iter()
                .map(|statement| normalized(&statement.sql))
                .collect()
        }
    }

    impl PgExecutor for FakeExecutor {
        fn connect<'a>(&'a self) -> BoxFuture<'a, Result<Arc<dyn PgSession>, MemoryError>> {
            let state = Arc::clone(&self.state);
            let reply = Arc::clone(&self.reply);
            Box::pin(
                async move { Ok(Arc::new(FakeSession { state, reply }) as Arc<dyn PgSession>) },
            )
        }

        fn query<'a>(
            &'a self,
            statement: PgStatement,
        ) -> BoxFuture<'a, Result<PgQueryResult, MemoryError>> {
            let state = Arc::clone(&self.state);
            let reply = Arc::clone(&self.reply);
            Box::pin(async move {
                let result = reply(&statement);
                state
                    .statements
                    .lock()
                    .expect("statement log")
                    .push(statement);
                result
            })
        }
    }

    /// A pool that cannot hand out a connection at all.
    struct FailingExecutor;

    impl PgExecutor for FailingExecutor {
        fn connect<'a>(&'a self) -> BoxFuture<'a, Result<Arc<dyn PgSession>, MemoryError>> {
            Box::pin(async { Err(MemoryError::storage("connection refused")) })
        }

        fn query<'a>(
            &'a self,
            _statement: PgStatement,
        ) -> BoxFuture<'a, Result<PgQueryResult, MemoryError>> {
            Box::pin(async { Err(MemoryError::storage("connection refused")) })
        }
    }

    /// `getConfiguredEmbeddingProvider()` + `generateEmbeddingOnce` as a seam.
    struct RecordingEmbedder {
        embedding: Option<Vec<f64>>,
        fails: bool,
        seen: Mutex<Vec<String>>,
    }

    impl RecordingEmbedder {
        fn returning(values: Vec<f64>) -> Arc<Self> {
            Arc::new(Self {
                embedding: Some(values),
                fails: false,
                seen: Mutex::new(Vec::new()),
            })
        }

        fn unavailable() -> Arc<Self> {
            Arc::new(Self {
                embedding: None,
                fails: false,
                seen: Mutex::new(Vec::new()),
            })
        }

        fn failing() -> Arc<Self> {
            Arc::new(Self {
                embedding: None,
                fails: true,
                seen: Mutex::new(Vec::new()),
            })
        }

        fn seen(&self) -> Vec<String> {
            self.seen.lock().expect("embedder log").clone()
        }
    }

    impl QueryEmbedder for RecordingEmbedder {
        fn embed<'a>(
            &'a self,
            text: &'a str,
        ) -> BoxFuture<'a, Result<Option<Vec<f64>>, MemoryError>> {
            self.seen
                .lock()
                .expect("embedder log")
                .push(text.to_string());
            let result = if self.fails {
                Err(MemoryError::message("embedding unavailable"))
            } else {
                Ok(self.embedding.clone())
            };
            Box::pin(async move { result })
        }
    }

    fn is_control(sql: &str) -> bool {
        sql == SQL_BEGIN || sql == SQL_COMMIT || sql == SQL_ROLLBACK || sql == SQL_SET_SCOPE
    }

    /// The comparison form of deviation 9: the SQL is compared token for token
    /// with collapsed whitespace.
    fn normalized(sql: &str) -> String {
        sql.split_whitespace().collect::<Vec<_>>().join(" ")
    }

    fn row(value: Value) -> PgRow {
        match value {
            Value::Object(map) => map,
            other => panic!("a fixture row must be an object: {other}"),
        }
    }

    fn rows(values: Vec<Value>) -> PgQueryResult {
        PgQueryResult::from_rows(values.into_iter().map(row).collect())
    }

    fn affected(row_count: i64) -> PgQueryResult {
        PgQueryResult::affected(row_count)
    }

    /// `memoryRow()` of `tests/unit/memory/postgres-memory-client.test.ts:30-50`.
    fn memory_row() -> Value {
        json!({
            "id": "memory-1",
            "user_id": "user-a",
            "persona_id": "assistant",
            "workspace_id": "workspace-a",
            "memory_type": "fact",
            "content": "A saved fact",
            "importance": 3,
            "confidence": 0.7,
            "lifecycle_status": "confirmed",
            "version": 2,
            "metadata": {"source": "test"},
            "idempotency_key": null,
            "legacy_provider": null,
            "legacy_provider_id": null,
            "created_at": "2026-10-01T00:00:00.000Z",
            "updated_at": "2026-10-02T00:00:00.000Z",
        })
    }

    fn scope() -> Mem0Scope {
        Mem0Scope {
            user_id: "user-a".to_string(),
            persona_id: "assistant".to_string(),
            workspace_id: Some("workspace-a".to_string()),
        }
    }

    fn metadata(entries: Vec<(&str, Value)>) -> MemoryMetadata {
        entries
            .into_iter()
            .map(|(key, value)| (key.to_string(), value))
            .collect()
    }

    fn memory_input(content: &str, metadata: MemoryMetadata) -> Mem0MemoryInput {
        Mem0MemoryInput {
            user_id: "user-a".to_string(),
            persona_id: "assistant".to_string(),
            workspace_id: Some("workspace-a".to_string()),
            content: content.to_string(),
            metadata,
        }
    }

    fn search_input(query: &str, limit: i64) -> Mem0SearchInput {
        Mem0SearchInput {
            user_id: "user-a".to_string(),
            persona_id: "assistant".to_string(),
            workspace_id: Some("workspace-a".to_string()),
            query: query.to_string(),
            limit,
            filters: None,
        }
    }

    fn list_input(
        query: Option<&str>,
        node_type: Option<&str>,
        page: i64,
        page_size: i64,
    ) -> Mem0ListInput {
        Mem0ListInput {
            user_id: "user-a".to_string(),
            persona_id: Some("assistant".to_string()),
            workspace_id: Some("workspace-a".to_string()),
            page,
            page_size,
            query: query.map(str::to_string),
            node_type: node_type.map(str::to_string),
        }
    }

    fn text(value: &str) -> PgValue {
        PgValue::Text(value.to_string())
    }

    /// `postgresMemoryClient.ts:196-202`.
    const INSERT_SQL: &str = "INSERT INTO world_model_memory_items (id, user_id, persona_id, \
workspace_id, memory_type, content, importance, confidence, lifecycle_status, version, metadata, \
idempotency_key, legacy_provider, legacy_provider_id, source_observation_id) \
VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb,$12,$13,$14,$15) ON CONFLICT DO NOTHING \
RETURNING id";

    /// `postgresMemoryClient.ts:314-325`.
    const LEXICAL_SQL: &str =
        "SELECT id, user_id, persona_id, workspace_id, memory_type, content, \
importance, confidence, lifecycle_status, version, metadata, idempotency_key, legacy_provider, \
legacy_provider_id, created_at, updated_at FROM world_model_memory_items WHERE user_id = $1 AND \
persona_id = $2 AND workspace_id = $3 AND deleted_at IS NULL AND lifecycle_status IN ('new', \
'confirmed') AND ($4 = '' OR content ILIKE '%' || $4 || '%' OR to_tsvector('simple', content) @@ \
plainto_tsquery('simple', $4)) ORDER BY updated_at DESC LIMIT $5";

    const METADATA_JSON: &str = "{\"type\":\" preference \",\"importance\":8.7,\"confidence\":-2,\
\"version\":0,\"idempotencyKey\":\"stable-key\",\"legacyProvider\":\" mem0 \",\
\"legacyMem0Id\":\" legacy-1 \",\"source_observation_id\":\" observation-1 \"}";

    #[tokio::test]
    async fn add_memory_writes_the_row_and_the_history_row_in_one_scoped_transaction() {
        let executor = Arc::new(FakeExecutor::new(|statement| {
            if statement.sql == SQL_ADD_MEMORY_INSERT {
                return Ok(rows(vec![json!({ "id": "memory-created" })]));
            }
            Ok(PgQueryResult::empty())
        }));
        let client = PostgresMemoryClient::new(executor.clone());

        let result = client
            .add_memory(&memory_input(
                "Saved content",
                metadata(vec![
                    ("type", json!(" preference ")),
                    ("importance", json!(8.7)),
                    ("confidence", json!(-2)),
                    ("version", json!(0)),
                    ("idempotencyKey", json!("stable-key")),
                    ("legacyProvider", json!(" mem0 ")),
                    ("legacyMem0Id", json!(" legacy-1 ")),
                    ("source_observation_id", json!(" observation-1 ")),
                ]),
            ))
            .await
            .expect("insert");

        assert!(result.created);
        assert_eq!(result.id.as_deref(), Some("memory-created"));

        // `BEGIN` → `world_model_set_scope` → work → `COMMIT` on one connection.
        let sequence: Vec<String> = executor
            .statements()
            .iter()
            .map(|statement| normalized(&statement.sql))
            .collect();
        assert_eq!(
            sequence,
            vec![
                "BEGIN".to_string(),
                normalized(SQL_SET_SCOPE),
                normalized(SQL_ADD_MEMORY_IDEMPOTENCY),
                normalized(SQL_ADD_MEMORY_LEGACY),
                INSERT_SQL.to_string(),
                normalized(SQL_INSERT_HISTORY_CREATE),
                "COMMIT".to_string(),
            ]
        );
        assert_eq!(executor.releases(), 1);

        let statements = executor.statements();
        assert_eq!(
            statements[1].params,
            vec![text("user-a"), text("assistant"), text("workspace-a")]
        );
        assert_eq!(
            statements[2].params,
            vec![
                text("user-a"),
                text("assistant"),
                text("workspace-a"),
                text("stable-key"),
            ],
            "the idempotency pre-check binds the trimmed key"
        );
        assert_eq!(
            statements[3].params,
            vec![
                text("user-a"),
                text("assistant"),
                text("workspace-a"),
                text("mem0"),
                text("legacy-1"),
            ]
        );

        let insert = &statements[4];
        let id = match &insert.params[0] {
            PgValue::Text(id) => id.clone(),
            other => panic!("$1 must be the generated uuid: {other:?}"),
        };
        assert_eq!(
            Uuid::parse_str(&id).expect("a v4 uuid").get_version_num(),
            4
        );
        assert_eq!(
            insert.params[1..],
            [
                text("user-a"),
                text("assistant"),
                text("workspace-a"),
                text("preference"),
                text("Saved content"),
                PgValue::Int64(5),
                PgValue::Float64(0.1),
                text("new"),
                PgValue::Int64(1),
                text(METADATA_JSON),
                text("stable-key"),
                text("mem0"),
                text("legacy-1"),
                text("observation-1"),
            ]
        );

        let history = &statements[5];
        assert_eq!(history.sql, SQL_INSERT_HISTORY_CREATE);
        assert_eq!(
            history.params,
            vec![
                text(&id),
                text("user-a"),
                text("assistant"),
                text("workspace-a"),
                PgValue::Int64(1),
                text("Saved content"),
                text(METADATA_JSON),
            ]
        );
    }

    /// A pool whose `INSERT` returns one canonical row and whose other
    /// statements return empty results — the happy path of `addMemory`.
    fn insert_executor() -> Arc<FakeExecutor> {
        Arc::new(FakeExecutor::new(|statement| {
            if statement.sql == SQL_ADD_MEMORY_INSERT {
                return Ok(rows(vec![json!({ "id": "memory-created" })]));
            }
            Ok(PgQueryResult::empty())
        }))
    }

    #[tokio::test]
    async fn add_memory_returns_the_existing_row_for_an_idempotent_duplicate() {
        let executor = Arc::new(FakeExecutor::new(|statement| {
            if statement.sql == SQL_ADD_MEMORY_IDEMPOTENCY {
                return Ok(rows(vec![json!({ "id": "existing-id" })]));
            }
            Ok(PgQueryResult::empty())
        }));
        let client = PostgresMemoryClient::new(executor.clone());

        let result = client
            .add_memory(&memory_input(
                "duplicate",
                metadata(vec![("idempotencyKey", json!("same-key"))]),
            ))
            .await
            .expect("duplicate");

        assert!(!result.created);
        assert_eq!(result.id.as_deref(), Some("existing-id"));
        assert_eq!(executor.data().len(), 1, "no insert is attempted");
        assert_eq!(
            executor.statements().last().expect("last statement").sql,
            SQL_COMMIT
        );
    }

    #[tokio::test]
    async fn add_memory_deduplicates_a_legacy_provider_id() {
        let executor = Arc::new(FakeExecutor::new(|statement| {
            if statement.sql == SQL_ADD_MEMORY_LEGACY {
                return Ok(rows(vec![json!({ "id": "legacy" })]));
            }
            Ok(PgQueryResult::empty())
        }));
        let client = PostgresMemoryClient::new(executor.clone());

        let result = client
            .add_memory(&memory_input(
                "legacy duplicate",
                metadata(vec![
                    ("legacyProvider", json!("mem0")),
                    ("legacyProviderId", json!("legacy-id")),
                ]),
            ))
            .await
            .expect("legacy");

        assert!(!result.created);
        assert_eq!(result.id.as_deref(), Some("legacy"));
        assert_eq!(executor.data().len(), 1);
    }

    #[tokio::test]
    async fn add_memory_resolves_an_insert_conflict_and_rejects_an_unknown_one() {
        let executor = Arc::new(FakeExecutor::new(|statement| {
            if statement.sql == SQL_ADD_MEMORY_CONFLICT {
                return Ok(rows(vec![json!({ "id": "race-winner" })]));
            }
            Ok(PgQueryResult::empty())
        }));
        let client = PostgresMemoryClient::new(executor.clone());

        let result = client
            .add_memory(&memory_input(
                "concurrent duplicate",
                metadata(vec![("idempotencyKey", json!("race-key"))]),
            ))
            .await
            .expect("conflict");

        assert!(!result.created);
        assert_eq!(result.id.as_deref(), Some("race-winner"));
        assert_eq!(
            executor.sql(),
            vec![
                normalized(SQL_ADD_MEMORY_IDEMPOTENCY),
                INSERT_SQL.to_string(),
                normalized(SQL_ADD_MEMORY_CONFLICT),
            ]
        );
        assert_eq!(
            executor.data()[2].params,
            vec![
                text("user-a"),
                text("assistant"),
                text("workspace-a"),
                text("race-key"),
                PgValue::Null,
                PgValue::Null,
            ],
            "`$4::text IS NOT NULL` needs a real NULL, not an omitted parameter"
        );
        assert_eq!(executor.releases(), 1);

        // An insert that returned no row and a conflict lookup that found none.
        let executor = Arc::new(FakeExecutor::empty());
        let client = PostgresMemoryClient::new(executor.clone());
        let error = client
            .add_memory(&memory_input("unknown conflict", MemoryMetadata::new()))
            .await
            .expect_err("conflict");

        assert_eq!(error.to_string(), UNKNOWN_INSERT_CONFLICT);
        assert_eq!(
            executor.statements().last().expect("last statement").sql,
            SQL_ROLLBACK
        );
        assert_eq!(executor.releases(), 1);
    }

    #[tokio::test]
    async fn the_scope_statement_carries_the_normalized_tenant_triple() {
        let executor = insert_executor();
        let client = PostgresMemoryClient::new(executor.clone());
        client
            .add_memory(&Mem0MemoryInput {
                user_id: " user-a ".to_string(),
                persona_id: " assistant ".to_string(),
                workspace_id: None,
                content: "c".to_string(),
                metadata: metadata(vec![("workspaceId", json!(" workspace-from-metadata "))]),
            })
            .await
            .expect("insert");

        let statements = executor.statements();
        assert_eq!(statements[0].sql, SQL_BEGIN);
        assert_eq!(statements[1].sql, SQL_SET_SCOPE);
        assert_eq!(
            statements[1].params,
            vec![
                text("user-a"),
                text("assistant"),
                text("workspace-from-metadata"),
            ]
        );

        // Without a workspace anywhere the triple carries the empty string that
        // `normalizedScope` fills in (`db.ts:34`).
        let executor = insert_executor();
        let client = PostgresMemoryClient::new(executor.clone());
        client
            .add_memory(&Mem0MemoryInput {
                user_id: "user-a".to_string(),
                persona_id: "assistant".to_string(),
                workspace_id: None,
                content: "c".to_string(),
                metadata: MemoryMetadata::new(),
            })
            .await
            .expect("insert");
        assert_eq!(
            executor.statements()[1].params,
            vec![text("user-a"), text("assistant"), text("")]
        );
    }

    /// One `world_model_embeddings` row, as `vectorSearch` maps it.
    fn vector_row(target_type: &str, target_id: &str, similarity: f64) -> Value {
        json!({
            "target_type": target_type,
            "target_id": target_id,
            "text": "chunk",
            "similarity": similarity,
            "model": "embed-test",
            "model_version": "1",
        })
    }

    #[tokio::test]
    async fn search_memories_uses_the_lexical_statement_and_nullable_scores() {
        let executor = Arc::new(FakeExecutor::new(|_| Ok(rows(vec![memory_row()]))));
        let client = PostgresMemoryClient::new(executor.clone());

        let hits = client
            .search_memories(&search_input("  coffee  ", 10))
            .await
            .expect("search");
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].id, "memory-1");
        assert_eq!(hits[0].content, "A saved fact");
        assert_eq!(hits[0].score, Some(0.5));

        assert_eq!(executor.sql(), vec![LEXICAL_SQL.to_string()]);
        assert_eq!(
            executor.data()[0].params,
            vec![
                text("user-a"),
                text("assistant"),
                text("workspace-a"),
                text("coffee"),
                PgValue::Int64(10),
            ]
        );

        // A blank query is bound as `''` and reported without a score (`:328`),
        // and `safePageSize(0)` is 1.
        let executor = Arc::new(FakeExecutor::new(|_| Ok(rows(vec![memory_row()]))));
        let client = PostgresMemoryClient::new(executor.clone());
        let hits = client
            .search_memories(&search_input("  ", 0))
            .await
            .expect("search");
        assert_eq!(hits[0].score, None);
        assert_eq!(
            executor.data()[0].params,
            vec![
                text("user-a"),
                text("assistant"),
                text("workspace-a"),
                text(""),
                PgValue::Int64(1),
            ]
        );
    }

    #[tokio::test]
    async fn search_memories_maps_the_semantic_hits_through_the_scoped_row_lookup() {
        let executor = Arc::new(FakeExecutor::new(|statement| {
            if statement.sql == SQL_VECTOR_SEARCH {
                return Ok(rows(vec![
                    vector_row("entity", "entity-1", 0.99),
                    vector_row("memory", "memory-1", 0.91),
                    vector_row("memory", "missing-row", 0.8),
                    vector_row("memory", "second-row", 0.7),
                ]));
            }
            if statement.sql == SQL_SEARCH_BY_IDS {
                return Ok(rows(vec![memory_row()]));
            }
            Ok(PgQueryResult::empty())
        }));
        let embedder = RecordingEmbedder::returning(vec![0.1, 0.2]);
        let client = PostgresMemoryClient::with_embedder(executor.clone(), embedder.clone());

        let hits = client
            .search_memories(&search_input("semantic query", 1))
            .await
            .expect("search");

        assert_eq!(
            hits.len(),
            1,
            "only the row that exists survives the lookup"
        );
        assert_eq!(hits[0].id, "memory-1");
        assert_eq!(hits[0].score, Some(0.91));
        assert_eq!(embedder.seen(), vec!["semantic query".to_string()]);
        assert_eq!(
            executor.sql(),
            vec![normalized(SQL_VECTOR_SEARCH), normalized(SQL_SEARCH_BY_IDS)],
            "the early return of :296-302 skips the lexical statement"
        );

        // `Math.max(20, Math.min(100, 1 * 5))`, `0.2`, and the target filter.
        assert_eq!(
            executor.data()[0].params,
            vec![
                text("[0.1,0.2]"),
                text("user-a"),
                text("assistant"),
                text("workspace-a"),
                PgValue::Float64(0.2),
                PgValue::Int64(20),
                PgValue::TextArray(vec!["memory".to_string()]),
                PgValue::Null,
                PgValue::Bool(true),
            ]
        );
        assert_eq!(
            executor.data()[1].params,
            vec![
                PgValue::TextArray(vec![
                    "memory-1".to_string(),
                    "missing-row".to_string(),
                    "second-row".to_string(),
                ]),
                text("user-a"),
                text("assistant"),
                text("workspace-a"),
            ]
        );
    }

    #[tokio::test]
    async fn search_memories_falls_back_to_lexical_only_without_a_memory_hit() {
        // (a) no embedding provider is configured at all: `vectorSearch` is never
        //     reached (`:267-268`).
        let executor = Arc::new(FakeExecutor::new(|statement| {
            if statement.sql == SQL_SEARCH_LEXICAL {
                return Ok(rows(vec![memory_row()]));
            }
            Ok(PgQueryResult::empty())
        }));
        let client =
            PostgresMemoryClient::with_embedder(executor.clone(), RecordingEmbedder::unavailable());
        let hits = client
            .search_memories(&search_input("lexical query", 5))
            .await
            .expect("search");
        assert_eq!(hits[0].score, Some(0.5));
        assert_eq!(executor.sql(), vec![LEXICAL_SQL.to_string()]);

        // (b) the embedder throws — the `catch` of `:304-309` logs and continues.
        let executor = Arc::new(FakeExecutor::new(|statement| {
            if statement.sql == SQL_SEARCH_LEXICAL {
                return Ok(rows(vec![memory_row()]));
            }
            Ok(PgQueryResult::empty())
        }));
        let client =
            PostgresMemoryClient::with_embedder(executor.clone(), RecordingEmbedder::failing());
        let hits = client
            .search_memories(&search_input("fallback query", 5))
            .await
            .expect("search");
        assert_eq!(hits[0].score, Some(0.5));
        assert_eq!(executor.sql(), vec![LEXICAL_SQL.to_string()]);

        // (c) the vector search only found other target types.
        let executor = Arc::new(FakeExecutor::new(|statement| {
            if statement.sql == SQL_VECTOR_SEARCH {
                return Ok(rows(vec![vector_row("entity", "entity-1", 0.99)]));
            }
            if statement.sql == SQL_SEARCH_LEXICAL {
                return Ok(rows(vec![memory_row()]));
            }
            Ok(PgQueryResult::empty())
        }));
        let client = PostgresMemoryClient::with_embedder(
            executor.clone(),
            RecordingEmbedder::returning(vec![0.1]),
        );
        let hits = client
            .search_memories(&search_input("lexical query", 5))
            .await
            .expect("search");
        assert_eq!(hits[0].score, Some(0.5));
        assert_eq!(executor.sql().len(), 2);

        // (d) the hard case: a memory hit whose row is gone yields an empty
        //     result instead of falling back (`:296-302`).
        let executor = Arc::new(FakeExecutor::new(|statement| {
            if statement.sql == SQL_VECTOR_SEARCH {
                return Ok(rows(vec![vector_row("memory", "gone", 0.9)]));
            }
            Ok(PgQueryResult::empty())
        }));
        let client = PostgresMemoryClient::with_embedder(
            executor.clone(),
            RecordingEmbedder::returning(vec![0.1]),
        );
        let hits = client
            .search_memories(&search_input("gone query", 5))
            .await
            .expect("search");
        assert!(hits.is_empty());
        assert_eq!(
            executor.sql(),
            vec![normalized(SQL_VECTOR_SEARCH), normalized(SQL_SEARCH_BY_IDS)]
        );
    }

    #[test]
    fn the_pagination_clamps_follow_the_source() {
        assert_eq!(safe_page(0.0), 1);
        assert_eq!(safe_page(-4.0), 1);
        assert_eq!(safe_page(f64::NAN), 1);
        assert_eq!(safe_page(3.0), 3);
        assert_eq!(safe_page_size(500.0), 200);
        assert_eq!(safe_page_size(0.0), 1);
        assert_eq!(safe_page_size(f64::NAN), 50);
        assert_eq!(safe_page_size(f64::INFINITY), 50);
    }

    #[tokio::test]
    async fn list_memories_applies_the_trimmed_filters_and_clamps_the_page() {
        let executor = Arc::new(FakeExecutor::new(|statement| {
            if statement.sql.starts_with("SELECT count(*)::text AS count") {
                return Ok(rows(vec![json!({ "count": "2" })]));
            }
            if statement.sql.contains("ORDER BY updated_at DESC, id ASC") {
                return Ok(rows(vec![memory_row()]));
            }
            Ok(PgQueryResult::empty())
        }));
        let client = PostgresMemoryClient::new(executor.clone());

        let result = client
            .list_memories(&list_input(Some(" coffee "), Some(" fact "), 0, 500))
            .await
            .expect("list");

        assert_eq!(result.total, 2);
        assert_eq!(result.page, 1);
        assert_eq!(result.page_size, 200);
        assert_eq!(result.memories.len(), 1);
        assert_eq!(result.memories[0].id, "memory-1");
        assert_eq!(result.memories[0].score, None);

        assert_eq!(
            executor.sql()[0],
            "SELECT count(*)::text AS count FROM world_model_memory_items WHERE user_id = $1 AND \
persona_id = $2 AND workspace_id = $3 AND deleted_at IS NULL AND content ILIKE '%' || $4 || \
'%' AND memory_type = $5"
        );
        assert!(
            executor.sql()[1].ends_with("ORDER BY updated_at DESC, id ASC OFFSET $6 LIMIT $7"),
            "{}",
            executor.sql()[1]
        );

        // Deviation 2: the count statement carries the parameters it had at call
        // time, the page statement the extended list.
        assert_eq!(
            executor.data()[0].params,
            vec![
                text("user-a"),
                text("assistant"),
                text("workspace-a"),
                text("coffee"),
                text("fact"),
            ]
        );
        assert_eq!(
            executor.data()[1].params,
            vec![
                text("user-a"),
                text("assistant"),
                text("workspace-a"),
                text("coffee"),
                text("fact"),
                PgValue::Int64(0),
                PgValue::Int64(200),
            ]
        );

        // Each statement is its own scoped transaction (`db.ts:107-110`).
        let statements = executor.statements();
        assert_eq!(statements.len(), 8);
        for index in [1usize, 5] {
            assert_eq!(statements[index].sql, SQL_SET_SCOPE);
            assert_eq!(
                statements[index].params,
                vec![text("user-a"), text("assistant"), text("workspace-a")]
            );
        }
        assert_eq!(executor.releases(), 2);
    }

    #[tokio::test]
    async fn list_memories_uses_the_empty_defaults_of_the_source() {
        let executor = Arc::new(FakeExecutor::empty());
        let client = PostgresMemoryClient::new(executor.clone());

        let result = client
            .list_memories(&Mem0ListInput {
                user_id: "user-a".to_string(),
                persona_id: None,
                workspace_id: None,
                page: 1,
                page_size: 50,
                query: None,
                node_type: None,
            })
            .await
            .expect("list");

        assert_eq!(result.total, 0);
        assert_eq!(result.page, 1);
        assert_eq!(result.page_size, 50);
        assert_eq!(
            executor.data()[0].params,
            vec![text("user-a"), text(""), text("")]
        );
        assert_eq!(
            executor.data()[1].params,
            vec![
                text("user-a"),
                text(""),
                text(""),
                PgValue::Int64(0),
                PgValue::Int64(50),
            ],
            "without optional filters `next` stays 4, so the offset is $4"
        );
        assert!(executor.sql()[1].ends_with("ORDER BY updated_at DESC, id ASC OFFSET $4 LIMIT $5"));
    }

    #[tokio::test]
    async fn get_memory_reads_scoped_and_unscoped_rows() {
        let executor = Arc::new(FakeExecutor::new(|_| Ok(rows(vec![memory_row()]))));
        let client = PostgresMemoryClient::new(executor.clone());

        let record = client
            .get_memory("memory-1", Some(&scope()))
            .await
            .expect("get")
            .expect("row");
        assert_eq!(record.id, "memory-1");
        assert_eq!(record.content, "A saved fact");
        assert_eq!(
            record.created_at.as_deref(),
            Some("2026-10-01T00:00:00.000Z")
        );
        assert_eq!(
            record.updated_at.as_deref(),
            Some("2026-10-02T00:00:00.000Z")
        );
        assert_eq!(record.metadata.get("type"), Some(&json!("fact")));
        assert_eq!(record.metadata.get("source"), Some(&json!("test")));
        assert_eq!(
            record.metadata.get("memoryProvider"),
            Some(&json!("postgres"))
        );
        assert_eq!(record.metadata.get("memoryId"), Some(&json!("memory-1")));
        assert_eq!(
            record.metadata.get("workspaceId"),
            Some(&json!("workspace-a"))
        );
        assert_eq!(
            record.metadata.get("lastVerified"),
            Some(&json!("2026-10-02T00:00:00.000Z"))
        );

        let statements = executor.statements();
        assert_eq!(statements.len(), 4);
        assert_eq!(statements[0].sql, SQL_BEGIN);
        assert_eq!(statements[1].sql, SQL_SET_SCOPE);
        assert_eq!(
            statements[2].params,
            vec![
                text("memory-1"),
                text("user-a"),
                text("assistant"),
                text("workspace-a"),
            ]
        );
        assert!(normalized(&statements[2].sql)
            .contains("WHERE id = $1 AND user_id = $2 AND persona_id = $3 AND workspace_id = $4"));
        assert_eq!(statements[3].sql, SQL_COMMIT);

        // No scope: `pool.query` — no `BEGIN`, no scope call.
        let executor = Arc::new(FakeExecutor::empty());
        let client = PostgresMemoryClient::new(executor.clone());
        assert!(client
            .get_memory("missing", None)
            .await
            .expect("get")
            .is_none());

        let statements = executor.statements();
        assert_eq!(statements.len(), 1);
        assert_eq!(statements[0].params, vec![text("missing")]);
        assert!(!normalized(&statements[0].sql).contains("AND user_id"));
        assert_eq!(executor.releases(), 0, "the pool owns the connection");
    }

    #[tokio::test]
    async fn get_memory_history_maps_scoped_and_unscoped_rows() {
        let history_row = json!({
            "action": "update",
            "version": "3",
            "content": "Updated fact",
            "metadata": {"source": "import"},
            "created_at": "2026-10-03T00:00:00.000Z",
        });
        let executor = Arc::new(FakeExecutor::new(move |_| {
            Ok(rows(vec![history_row.clone()]))
        }));
        let client = PostgresMemoryClient::new(executor.clone());

        let entries = client
            .get_memory_history("memory-1", Some(&scope()))
            .await
            .expect("history");
        assert_eq!(entries.len(), 1);
        let entry = &entries[0];
        assert_eq!(entry.action, "update");
        assert_eq!(entry.content.as_deref(), Some("Updated fact"));
        assert_eq!(entry.timestamp.as_deref(), Some("2026-10-03T00:00:00.000Z"));
        assert_eq!(entry.metadata.get("source"), Some(&json!("import")));
        assert_eq!(entry.metadata.get("version"), Some(&json!(3)));
        assert_eq!(entry.raw.get("action"), Some(&json!("update")));
        assert_eq!(entry.raw.get("version"), Some(&json!(3)));
        assert_eq!(entry.raw.get("content"), Some(&json!("Updated fact")));
        assert_eq!(
            entry.raw.get("metadata"),
            Some(&json!({"source": "import"}))
        );

        let statements = executor.statements();
        assert_eq!(
            statements[2].params,
            vec![
                text("memory-1"),
                text("user-a"),
                text("assistant"),
                text("workspace-a"),
            ]
        );
        assert!(normalized(&statements[2].sql).ends_with("ORDER BY version ASC, created_at ASC"));

        // Unscoped, the clause disappears and `pool.query` runs it directly.
        let executor = Arc::new(FakeExecutor::empty());
        let client = PostgresMemoryClient::new(executor.clone());
        assert!(client
            .get_memory_history("memory-1", None)
            .await
            .expect("history")
            .is_empty());
        let statements = executor.statements();
        assert_eq!(statements.len(), 1);
        assert_eq!(statements[0].params, vec![text("memory-1")]);
        assert!(!normalized(&statements[0].sql).contains("AND user_id"));
    }

    #[tokio::test]
    async fn update_memory_preserves_the_canonical_defaults_and_writes_a_new_version() {
        let executor = Arc::new(FakeExecutor::new(|statement| {
            if statement.sql == SQL_SELECT_MEMORY_ITEM_FOR_UPDATE {
                return Ok(rows(vec![memory_row()]));
            }
            if statement.sql == SQL_VERIFY_MEMORY_VERSION {
                return Ok(affected(1));
            }
            Ok(PgQueryResult::empty())
        }));
        let client = PostgresMemoryClient::new(executor.clone());

        client
            .update_memory(
                "memory-1",
                &memory_input("Revised fact", MemoryMetadata::new()),
                Some(&scope()),
            )
            .await
            .expect("update");

        assert_eq!(
            executor.sql(),
            vec![
                normalized(SQL_SELECT_MEMORY_ITEM_FOR_UPDATE),
                normalized(SQL_UPDATE_MEMORY_ITEM),
                normalized(SQL_VERIFY_MEMORY_VERSION),
                normalized(SQL_INSERT_HISTORY_UPDATE),
            ]
        );
        assert_eq!(
            executor.data()[1].params,
            vec![
                text("fact"),
                text("Revised fact"),
                PgValue::Int64(3),
                PgValue::Float64(0.7),
                text("confirmed"),
                PgValue::Int64(3),
                text("{}"),
                text("memory-1"),
                PgValue::Int64(2),
            ],
            "an empty metadata bag keeps the stored columns and an absent expectedVersion reads the stored version"
        );
        assert_eq!(
            executor.data()[2].params,
            vec![
                text("memory-1"),
                text("user-a"),
                text("assistant"),
                text("workspace-a"),
                PgValue::Int64(3),
            ]
        );
        assert_eq!(
            executor.data()[3].params,
            vec![
                text("memory-1"),
                text("user-a"),
                text("assistant"),
                text("workspace-a"),
                PgValue::Int64(3),
                text("Revised fact"),
                text("{}"),
            ]
        );
        assert_eq!(executor.releases(), 1);
    }

    #[tokio::test]
    async fn update_memory_strips_the_expected_version_and_rejects_stale_ones() {
        // A stale expectation fails before any write.
        let executor = Arc::new(FakeExecutor::new(|statement| {
            if statement.sql == SQL_SELECT_MEMORY_ITEM_FOR_UPDATE {
                return Ok(rows(vec![memory_row()]));
            }
            Ok(PgQueryResult::empty())
        }));
        let client = PostgresMemoryClient::new(executor.clone());
        let error = client
            .update_memory(
                "memory-1",
                &memory_input("revised", metadata(vec![("expectedVersion", json!(9))])),
                Some(&scope()),
            )
            .await
            .expect_err("conflict");

        assert_eq!(error.version_conflict(), Some(2));
        assert_eq!(executor.data().len(), 1);
        assert_eq!(
            executor.statements().last().expect("last statement").sql,
            SQL_ROLLBACK
        );
        assert_eq!(executor.releases(), 1);

        // A missing row is reported before the version check (`:438-439`).
        let executor = Arc::new(FakeExecutor::empty());
        let client = PostgresMemoryClient::new(executor.clone());
        let error = client
            .update_memory(
                "missing",
                &memory_input("revised", MemoryMetadata::new()),
                Some(&scope()),
            )
            .await
            .expect_err("not found");
        assert_eq!(error.to_string(), "Memory node not found: missing");

        // The metadata that is written has no `expectedVersion` key (`:458-459`).
        let executor = Arc::new(FakeExecutor::new(|statement| {
            if statement.sql == SQL_SELECT_MEMORY_ITEM_FOR_UPDATE {
                return Ok(rows(vec![memory_row()]));
            }
            if statement.sql == SQL_VERIFY_MEMORY_VERSION {
                return Ok(affected(1));
            }
            Ok(PgQueryResult::empty())
        }));
        let client = PostgresMemoryClient::new(executor.clone());
        client
            .update_memory(
                "memory-1",
                &memory_input(
                    "revised",
                    metadata(vec![
                        ("source", json!("import")),
                        ("expectedVersion", json!(2)),
                    ]),
                ),
                Some(&scope()),
            )
            .await
            .expect("update");
        assert_eq!(
            executor.data()[1].params[6],
            text("{\"source\":\"import\"}")
        );
        assert_eq!(executor.data()[1].params[8], PgValue::Int64(2));
    }

    #[tokio::test]
    async fn update_memory_reports_a_lost_optimistic_race() {
        let executor = Arc::new(FakeExecutor::new(|statement| {
            if statement.sql == SQL_SELECT_MEMORY_ITEM_FOR_UPDATE {
                return Ok(rows(vec![memory_row()]));
            }
            if statement.sql == SQL_VERIFY_MEMORY_VERSION {
                return Ok(affected(0));
            }
            Ok(PgQueryResult::empty())
        }));
        let client = PostgresMemoryClient::new(executor.clone());

        let error = client
            .update_memory(
                "memory-1",
                &memory_input("revised", metadata(vec![("expectedVersion", json!(2))])),
                Some(&scope()),
            )
            .await
            .expect_err("conflict");

        assert_eq!(error.version_conflict(), Some(2));
        assert_eq!(
            executor.data().len(),
            3,
            "the history row of :486-499 is not reached"
        );
    }

    fn filter_input(workspace_id: Option<&str>) -> Mem0DeleteByFilterInput {
        Mem0DeleteByFilterInput {
            user_id: "user-a".to_string(),
            persona_id: "assistant".to_string(),
            workspace_id: workspace_id.map(str::to_string),
        }
    }

    #[tokio::test]
    async fn delete_memory_requires_a_scope_and_removes_the_vector() {
        let executor = Arc::new(FakeExecutor::empty());
        let client = PostgresMemoryClient::new(executor.clone());
        let error = client
            .delete_memory("memory-1", None)
            .await
            .expect_err("scope");
        assert_eq!(error.to_string(), SCOPED_DELETION_REQUIRED);
        assert!(
            executor.statements().is_empty(),
            "the guard of :505-507 runs before any statement"
        );

        let executor = Arc::new(FakeExecutor::empty());
        let client = PostgresMemoryClient::new(executor.clone());
        let error = client
            .delete_memory("missing", Some(&scope()))
            .await
            .expect_err("not found");
        assert_eq!(error.to_string(), "Memory node not found: missing");
        assert_eq!(executor.data().len(), 1);
        assert_eq!(
            executor.statements().last().expect("last statement").sql,
            SQL_ROLLBACK
        );

        let executor = Arc::new(FakeExecutor::new(|statement| {
            if statement.sql == SQL_SELECT_MEMORY_ITEM_FOR_UPDATE {
                return Ok(rows(vec![memory_row()]));
            }
            Ok(PgQueryResult::empty())
        }));
        let client = PostgresMemoryClient::new(executor.clone());
        client
            .delete_memory("memory-1", Some(&scope()))
            .await
            .expect("delete");

        assert_eq!(
            executor.sql(),
            vec![
                normalized(SQL_SELECT_MEMORY_ITEM_FOR_UPDATE),
                normalized(SQL_SOFT_DELETE_MEMORY_ITEM),
                normalized(SQL_INSERT_HISTORY_DELETE),
                normalized(SQL_DELETE_EMBEDDING_BY_TARGET),
            ]
        );
        let deleted = "{\"source\":\"test\",\"lifecycleStatus\":\"deleted\",\"version\":3}";
        assert_eq!(
            executor.data()[1].params,
            vec![
                PgValue::Int64(3),
                text(deleted),
                text("memory-1"),
                text("user-a"),
                text("assistant"),
                text("workspace-a"),
            ]
        );
        assert_eq!(
            executor.data()[2].params,
            vec![
                text("memory-1"),
                text("user-a"),
                text("assistant"),
                text("workspace-a"),
                PgValue::Int64(3),
                text("A saved fact"),
                text(deleted),
            ]
        );
        assert_eq!(
            executor.data()[3].params,
            vec![
                text("memory-1"),
                text("user-a"),
                text("assistant"),
                text("workspace-a"),
            ]
        );
        assert_eq!(executor.releases(), 1);
    }

    #[tokio::test]
    async fn delete_memories_by_filter_writes_history_per_row_and_skips_empty_scopes() {
        let executor = Arc::new(FakeExecutor::new(|statement| {
            if statement.sql == SQL_SELECT_MEMORY_ITEMS_IN_SCOPE_FOR_UPDATE {
                return Ok(rows(vec![
                    memory_row(),
                    json!({
                        "id": "memory-2",
                        "version": 4,
                        "content": "second",
                        "metadata": {},
                    }),
                ]));
            }
            Ok(PgQueryResult::empty())
        }));
        let client = PostgresMemoryClient::new(executor.clone());

        let deleted = client
            .delete_memories_by_filter(&filter_input(Some("workspace-a")))
            .await
            .expect("delete");

        assert_eq!(deleted, 2);
        assert_eq!(
            executor.data().len(),
            6,
            "one read, two writes each, one cleanup"
        );
        assert_eq!(
            executor.data()[0].sql,
            SQL_SELECT_MEMORY_ITEMS_IN_SCOPE_FOR_UPDATE
        );
        assert_eq!(executor.data()[1].params[0], PgValue::Int64(3));
        assert_eq!(executor.data()[3].params[0], PgValue::Int64(5));
        assert_eq!(executor.data()[5].sql, SQL_DELETE_EMBEDDINGS_IN_SCOPE);
        assert_eq!(
            executor.data()[5].params,
            vec![text("user-a"), text("assistant"), text("workspace-a")]
        );
        assert_eq!(
            executor
                .sql()
                .iter()
                .filter(|sql| sql.as_str() == normalized(SQL_DELETE_EMBEDDINGS_IN_SCOPE))
                .count(),
            1,
            "the cleanup runs once for the whole scope, not per row"
        );

        // An empty scope does not touch the embeddings at all (`:622`).
        let executor = Arc::new(FakeExecutor::empty());
        let client = PostgresMemoryClient::new(executor.clone());
        let deleted = client
            .delete_memories_by_filter(&filter_input(None))
            .await
            .expect("delete");
        assert_eq!(deleted, 0);
        assert_eq!(executor.data().len(), 1);
    }

    #[tokio::test]
    async fn count_memories_guards_the_user_id_and_switches_the_scope() {
        let executor = Arc::new(FakeExecutor::new(|_| {
            Ok(rows(vec![json!({ "count": "7" })]))
        }));
        let client = PostgresMemoryClient::new(executor.clone());

        assert_eq!(
            client
                .count_memories(&Mem0CountInput {
                    user_id: Some("  ".to_string()),
                    persona_id: None,
                    workspace_id: None,
                })
                .await
                .expect("count"),
            0
        );
        assert!(
            executor.statements().is_empty(),
            "a blank id does not reach the database (`:637-638`)"
        );

        assert_eq!(
            client
                .count_memories(&Mem0CountInput {
                    user_id: Some("user-a".to_string()),
                    persona_id: Some(" assistant ".to_string()),
                    workspace_id: Some("workspace-a".to_string()),
                })
                .await
                .expect("count"),
            7
        );
        let statements = executor.statements();
        assert_eq!(statements[0].sql, SQL_BEGIN);
        assert_eq!(statements[1].sql, SQL_SET_SCOPE);
        assert_eq!(
            statements[1].params,
            vec![text("user-a"), text("assistant"), text("workspace-a")]
        );
        assert_eq!(statements[2].sql, SQL_COUNT_MEMORY_ITEMS);
        assert_eq!(
            statements[2].params,
            vec![text("user-a"), text("assistant"), text("workspace-a")]
        );
        assert_eq!(statements[3].sql, SQL_COMMIT);

        // Without a persona the statement runs unscoped on the pool (`:649`).
        let executor = Arc::new(FakeExecutor::empty());
        let client = PostgresMemoryClient::new(executor.clone());
        assert_eq!(
            client
                .count_memories(&Mem0CountInput {
                    user_id: Some("user-a".to_string()),
                    persona_id: None,
                    workspace_id: None,
                })
                .await
                .expect("count"),
            0
        );
        let statements = executor.statements();
        assert_eq!(statements.len(), 1);
        assert_eq!(statements[0].sql, SQL_COUNT_MEMORY_ITEMS);
        assert_eq!(
            statements[0].params,
            vec![text("user-a"), PgValue::Null, PgValue::Null],
            "`?.trim() || null` sends a real NULL"
        );
    }

    #[test]
    fn row_mapping_reproduces_the_metadata_bag() {
        let stored = json!({
            "id": "memory-1",
            "workspace_id": "workspace-a",
            "memory_type": "fact",
            "content": "A saved fact",
            "importance": 3,
            "confidence": 0.7,
            "lifecycle_status": "confirmed",
            "version": 2,
            "metadata": [],
            "legacy_provider_id": "legacy-1",
            "created_at": "not a timestamp",
            "updated_at": "2026-10-02T00:00:00.000Z",
        });
        let record = to_record(&row(stored), None);

        assert_eq!(record.metadata.get("type"), Some(&json!("fact")));
        assert_eq!(
            record.metadata.get("importance"),
            Some(&json!(3)),
            "an integral number keeps the JavaScript spelling (deviation 6)"
        );
        assert_eq!(record.metadata.get("confidence"), Some(&json!(0.7)));
        assert_eq!(
            record.metadata.get("lifecycleStatus"),
            Some(&json!("confirmed"))
        );
        assert_eq!(record.metadata.get("version"), Some(&json!(2)));
        assert_eq!(
            record.metadata.get("source"),
            Some(&json!("postgres")),
            "an array metadata bag is discarded and the provider label applies"
        );
        assert_eq!(
            record.metadata.get("memoryProvider"),
            Some(&json!("postgres"))
        );
        assert_eq!(record.metadata.get("memoryId"), Some(&json!("memory-1")));
        assert_eq!(
            record.metadata.get("workspaceId"),
            Some(&json!("workspace-a"))
        );
        assert_eq!(
            record.metadata.get("legacyProviderId"),
            Some(&json!("legacy-1"))
        );
        assert_eq!(
            record.metadata.get("lastVerified"),
            Some(&json!("2026-10-02T00:00:00.000Z"))
        );
        let created_at = record.created_at.clone().expect("stamp");
        assert_ne!(created_at, "not a timestamp", "an unparsable stamp is now");
        assert!(created_at.ends_with('Z'), "{created_at}");
        assert_eq!(record.score, None);

        // A stored `source` wins, the two conditional keys disappear when their
        // columns are empty, and the score is carried through.
        let stored = json!({
            "id": "memory-2",
            "workspace_id": "",
            "memory_type": "lesson",
            "content": "c",
            "importance": 1,
            "confidence": 0.1,
            "lifecycle_status": "new",
            "version": 1,
            "metadata": {"source": "import"},
            "legacy_provider_id": null,
            "created_at": "2026-10-01T00:00:00.000Z",
            "updated_at": "2026-10-01T00:00:00.000Z",
        });
        let record = to_record(&row(stored), Some(0.91));
        assert_eq!(record.metadata.get("source"), Some(&json!("import")));
        assert_eq!(record.metadata.get("workspaceId"), None);
        assert_eq!(record.metadata.get("legacyProviderId"), None);
        assert_eq!(record.score, Some(0.91));
        assert_eq!(record.created_at, record.updated_at);
    }

    #[test]
    fn pgvector_text_follows_json_stringify() {
        assert_eq!(pgvector_text(&[0.1, 0.2]), "[0.1,0.2]");
        assert_eq!(pgvector_text(&[]), "[]");
        assert_eq!(pgvector_text(&[1.0, -2.0, 0.0]), "[1,-2,0]");
        assert_eq!(pgvector_text(&[f64::NAN, f64::INFINITY]), "[null,null]");
        assert_eq!(pgvector_text(&[1e-7]), "[1e-7]");
    }

    #[tokio::test]
    async fn a_failing_statement_rolls_back_and_releases_the_connection() {
        let executor = Arc::new(FakeExecutor::new(|statement| {
            if statement.sql == SQL_ADD_MEMORY_INSERT {
                return Err(MemoryError::storage(
                    "duplicate key value violates unique constraint",
                ));
            }
            Ok(PgQueryResult::empty())
        }));
        let client = PostgresMemoryClient::new(executor.clone());

        let error = client
            .add_memory(&memory_input("c", MemoryMetadata::new()))
            .await
            .expect_err("insert");

        assert_eq!(
            error.to_string(),
            "duplicate key value violates unique constraint"
        );
        let sequence: Vec<String> = executor
            .statements()
            .iter()
            .map(|statement| normalized(&statement.sql))
            .collect();
        assert_eq!(sequence.last().map(String::as_str), Some("ROLLBACK"));
        assert!(!sequence.iter().any(|sql| sql == "COMMIT"));
        assert_eq!(executor.releases(), 1);

        // A pool that cannot hand out a connection fails before the first
        // statement and asks for no second one.
        let client: PostgresMemoryClient = PostgresMemoryClient::new(Arc::new(FailingExecutor));
        let error = client
            .get_memory("memory-1", Some(&scope()))
            .await
            .expect_err("connect");
        assert_eq!(error.to_string(), "connection refused");
    }

    #[tokio::test]
    async fn an_unconfigured_executor_reports_itself() {
        let client = PostgresMemoryClient::new(Arc::new(UnconfiguredPgExecutor));
        let error = client
            .get_memory("memory-1", None)
            .await
            .expect_err("executor");
        assert_eq!(error.to_string(), UNCONFIGURED_EXECUTOR_MESSAGE);
    }

    /// Outside any runtime [`drive_sync`] builds a current-thread runtime, which
    /// is the path a plain `#[test]` and a blocking gateway thread take.
    #[test]
    fn the_sync_contract_drives_the_async_methods() {
        let executor = Arc::new(FakeExecutor::new(|_| Ok(rows(vec![memory_row()]))));
        let client = PostgresMemoryClient::new(executor.clone());

        assert_eq!(
            Mem0Client::provider(&client),
            Some(MemoryProviderKind::Postgres)
        );
        let record = Mem0Client::get_memory(&client, "memory-1", None)
            .expect("get")
            .expect("row");
        assert_eq!(record.id, "memory-1");
        assert!(Mem0Client::get_memory(&client, "memory-1", Some(&scope()))
            .expect("get")
            .is_some());
        assert_eq!(
            Mem0Client::get_memory_history(&client, "memory-1", None)
                .expect("history")
                .len(),
            1
        );
    }

    /// A current-thread runtime cannot be blocked: the bridge refuses instead of
    /// dead-locking the driver thread.
    #[tokio::test(flavor = "current_thread")]
    async fn the_sync_bridge_refuses_a_current_thread_runtime() {
        let executor = Arc::new(FakeExecutor::empty());
        let client = PostgresMemoryClient::new(executor.clone());

        let error = Mem0Client::get_memory(&client, "memory-1", None).expect_err("bridge");
        assert_eq!(error.to_string(), SYNC_BRIDGE_MESSAGE);
        assert!(executor.statements().is_empty());
    }
}
