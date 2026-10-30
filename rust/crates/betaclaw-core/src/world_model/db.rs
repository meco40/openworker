//! Port of `src/server/world-model/db.ts` — the canonical PostgreSQL pool, the
//! tenant-scoped transactions and the RLS contract.
//!
//! | TypeScript | Rust |
//! | --- | --- |
//! | `db.ts:23-28` (`WorldModelQueryExecutor`) | [`PgSession`], [`PgStatement`], [`PgQueryResult`] |
//! | `db.ts:18-21` (`WorldModelDb`) | [`PgExecutor`] |
//! | `db.ts:30-36` (`normalizedScope`) | [`NormalizedScope`] |
//! | `db.ts:38-48` (`setDatabaseScope`) | [`set_database_scope`] |
//! | `db.ts:50-60` (`runWithWorldModelScope`, `getWorldModelScope`) | the explicit `scope` parameter of [`scoped_query`] and [`run_scoped`] |
//! | `db.ts:62-85` (`queryWithScope`) | [`scoped_query`] |
//! | `db.ts:100-112` (`getWorldModelDb`) | [`PgExecutor`] (supplied by the caller) |
//! | `db.ts:204-229` (`withWorldModelTransaction`) | [`run_scoped`] |
//! | `db.ts:130-202` (migrations) | [`migrations`](crate::world_model::migrations) |
//! | `db.ts:87-98` (`buildPool`), `:121-128` (`isConnectionUsable`), `:231-233` (`resetWorldModelDbForTests`) | [`driver`](crate::world_model::driver) |
//!
//! # Why this module exists
//!
//! Until S5 the seam lived in `memory/postgres.rs`, because that provider was
//! the first port that needed a PostgreSQL pool. Its module header promised the
//! move (`postgres.rs:62-67`: "when S6 lands, `PgExecutor` and the statement
//! types move next to the world-model module") and the TypeScript home of the
//! seam has always been this file (`db.ts:23-28`). S6 performed the move: the
//! types below are the same definitions, with the single exception that the
//! error type is now [`PgError`] instead of `MemoryError`, so this module does
//! not depend on the memory slice. `memory::postgres` re-exports every name it
//! used to declare and `memory::errors` converts a [`PgError`] into a
//! `MemoryError`, so no ported behaviour moved with it.
//!
//! # The ambient scope is a parameter
//!
//! `AsyncLocalStorage` (`db.ts:11`) has no Rust counterpart, so the two
//! TypeScript wrappers become two functions that take the scope explicitly:
//!
//! * [`scoped_query`] is `db.ts:62-85`: one statement in its own scoped
//!   transaction. Every statement a ported method issues while
//!   `runWithWorldModelScope` is active takes this shape, because the
//!   TypeScript wraps each `getWorldModelDb().query(...)` call individually
//!   (`db.ts:107-110`).
//! * [`run_scoped`] is `db.ts:204-229`: acquire, `BEGIN` →
//!   `world_model_set_scope` → work → `COMMIT`, and `ROLLBACK` plus `release()`
//!   on every failure path.
//!
//! The unscoped path is preserved as well: `db.ts:109` runs a bare
//! `pool.query` when no scope is active, so a caller without a scope uses
//! [`PgExecutor::query`] and issues **no** `BEGIN` and **no** scope call.

use std::future::Future;
use std::pin::Pin;
use std::sync::Arc;

use serde_json::{Map, Value};

/// The boxed future of every seam method.
pub type BoxFuture<'a, T> = Pin<Box<dyn Future<Output = T> + Send + 'a>>;

/// The failure of a [`PgSession`] or [`PgExecutor`] call.
///
/// The TypeScript throws the `pg` `Error` and logs `error.message`
/// (`db.ts:79`, `:94-96`, `:221`); the port keeps exactly that much of it. The
/// memory slice converts it with `impl From<PgError> for MemoryError` so its own
/// error surface is unchanged.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
#[error("{message}")]
pub struct PgError {
    pub message: String,
}

impl PgError {
    pub fn new(message: impl Into<String>) -> Self {
        Self {
            message: message.into(),
        }
    }

    /// `error.message`.
    pub fn into_message(self) -> String {
        self.message
    }
}

/// One positional parameter of a `pg` statement.
///
/// The variants mirror what the TypeScript passes (`values` of every
/// `db.query(text, values)` call): `string`, `number`, `boolean`, `null` and
/// `string[]`. `pg` encodes every parameter as text and leaves the type to the
/// statement — the explicit casts (`$11::jsonb`, `$1::vector`, `$4::text[]`,
/// `$9::boolean`) are part of the SQL text and the rest is inferred from the
/// column context. A driver binds the variants that way; the distinction the
/// contract tests assert is the JavaScript one, so an integral number is
/// [`PgValue::Int64`] and a fractional one [`PgValue::Float64`].
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
/// The column contracts of the ported repositories are the TypeScript row
/// interfaces; the accessors read them by name, exactly like TypeScript property
/// access does.
pub type PgRow = Map<String, Value>;

/// `QueryResult` from `pg`, reduced to what the ported statements read.
///
/// `rowCount` is the row count of a `SELECT` and the affected count of a write.
/// `first_id` is an extension the memory slice adds in `memory/postgres.rs`,
/// because no World-Model statement needs it.
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
}

/// One checked-out connection — `pg`'s `PoolClient`.
///
/// The methods are async and take `&self`, so an implementation can hand out an
/// `Arc` of itself (`sqlx`'s `PoolConnection` works exactly like that).
pub trait PgSession: Send + Sync {
    /// `client.query(text, values)` of `db.ts:72`, `:214` and their siblings.
    fn query<'a>(&'a self, statement: PgStatement)
        -> BoxFuture<'a, Result<PgQueryResult, PgError>>;

    /// `client.release()` in the `finally` block of `db.ts:83` and `db.ts:225`.
    ///
    /// An implementation that returns the connection to its pool when the
    /// [`Arc`] is dropped (the sqlx behaviour) answers with an empty body; the
    /// port calls it on every path, so a recording implementation can assert it.
    fn release(&self);
}

/// The seam between the ported repositories and a real PostgreSQL pool —
/// `pg`'s `Pool`.
///
/// Two capabilities, because `db.ts` uses exactly two: `pool.connect()` inside
/// the scoped wrappers and `pool.query()` on the unscoped path
/// (`db.ts:107-110`).
pub trait PgExecutor: Send + Sync {
    /// `pool.connect()` — `db.ts:68`, `:182`, `:210`.
    fn connect<'a>(&'a self) -> BoxFuture<'a, Result<Arc<dyn PgSession>, PgError>>;

    /// `pool.query(text, values)` — `db.ts:109`, the no-scope branch.
    fn query<'a>(&'a self, statement: PgStatement)
        -> BoxFuture<'a, Result<PgQueryResult, PgError>>;
}

/// The failure of [`UnconfiguredPgExecutor`]: the caller handed over no pool.
pub const UNCONFIGURED_EXECUTOR_MESSAGE: &str =
    "No PostgreSQL executor is configured for the canonical memory provider.";

/// An executor that fails every statement, mirroring
/// [`UnreachableTransport`](crate::model_hub::http::UnreachableTransport).
///
/// It is the explicit "no pool configured" answer for callers that build a state
/// without a database. A productive caller uses
/// [`SqlxPgExecutor`](crate::world_model::driver::SqlxPgExecutor).
#[derive(Debug, Clone, Copy, Default)]
pub struct UnconfiguredPgExecutor;

impl PgExecutor for UnconfiguredPgExecutor {
    fn connect<'a>(&'a self) -> BoxFuture<'a, Result<Arc<dyn PgSession>, PgError>> {
        Box::pin(async { Err(PgError::new(UNCONFIGURED_EXECUTOR_MESSAGE)) })
    }

    fn query<'a>(
        &'a self,
        _statement: PgStatement,
    ) -> BoxFuture<'a, Result<PgQueryResult, PgError>> {
        Box::pin(async { Err(PgError::new(UNCONFIGURED_EXECUTOR_MESSAGE)) })
    }
}

/// The embedding step of a semantic search branch —
/// `getConfiguredEmbeddingProvider()` plus `generateEmbeddingOnce`
/// (`embeddings/provider.ts:17-34`, `:92-95`).
///
/// The port folds the two calls into one: `Ok(None)` is "no provider is
/// configured" (the `if (provider && …)` guard) and `Err` is the throw the
/// surrounding `catch` logs before the lexical fallback.
pub trait QueryEmbedder: Send + Sync {
    fn embed<'a>(&'a self, text: &'a str) -> BoxFuture<'a, Result<Option<Vec<f64>>, PgError>>;
}

/// The embedder of an installation without a configured provider: every query
/// takes the lexical path, like `getConfiguredEmbeddingProvider() === null`.
#[derive(Debug, Clone, Copy, Default)]
pub struct NoQueryEmbedder;

impl QueryEmbedder for NoQueryEmbedder {
    fn embed<'a>(&'a self, _text: &'a str) -> BoxFuture<'a, Result<Option<Vec<f64>>, PgError>> {
        Box::pin(async { Ok(None) })
    }
}

/// Returned by [`drive_sync`] on a current-thread tokio runtime, which cannot be
/// blocked without dead-locking it.
pub const SYNC_BRIDGE_MESSAGE: &str =
    "The ported synchronous contract cannot be driven from a current-thread tokio runtime; call \
the async methods instead.";

/// Drives an async method from a synchronous trait implementation.
///
/// Rust-only helper: the TypeScript contract is async end to end, so nothing in
/// the source corresponds to it. It was introduced for `memory/postgres.rs` and
/// `memory/mem0.rs`; S6 moved the shared copy here because the World-Model
/// services bridge the same way.
///
/// * inside a multi-threaded runtime it blocks in place;
/// * inside a current-thread runtime the driver *is* the calling thread, so
///   blocking would dead-lock it — [`SYNC_BRIDGE_MESSAGE`] is returned and the
///   caller has to use the async methods;
/// * outside any runtime a temporary current-thread runtime is created, which is
///   what a plain `#[test]` or a blocking gateway thread does.
pub fn drive_sync<T>(future: impl Future<Output = T>) -> Result<T, PgError> {
    match tokio::runtime::Handle::try_current() {
        Ok(handle) if handle.runtime_flavor() == tokio::runtime::RuntimeFlavor::MultiThread => {
            Ok(tokio::task::block_in_place(|| handle.block_on(future)))
        }
        Ok(_) => Err(PgError::new(SYNC_BRIDGE_MESSAGE)),
        Err(_) => {
            let runtime = tokio::runtime::Builder::new_current_thread()
                .enable_all()
                .build()
                .map_err(|error| PgError::new(format!("tokio runtime: {error}")))?;
            Ok(runtime.block_on(future))
        }
    }
}

/// `SELECT world_model_set_scope($1, $2, $3)` — `db.ts:43-47`.
pub const SQL_SET_SCOPE: &str = "SELECT world_model_set_scope($1, $2, $3)";
/// `db.ts:70`, `:154`, `:212`.
pub const SQL_BEGIN: &str = "BEGIN";
/// `db.ts:73`, `:158`, `:215`.
pub const SQL_COMMIT: &str = "COMMIT";
/// `db.ts:77`, `:161`, `:218`.
pub const SQL_ROLLBACK: &str = "ROLLBACK";

/// `Required<WorldModelScope>` — what `normalizedScope` produces
/// (`db.ts:30-36`) and what `scopeFrom` returns
/// (`postgresMemoryClient.ts:72-82`).
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

/// `setDatabaseScope(client, scope)` — `db.ts:38-48`.
///
/// The single statement that makes the RLS policies of the following work see
/// this tenant (`docs/RUST_MIGRATION.md:199-201`).
///
/// The error type is the caller's: `E: From<PgError>` lets the memory provider
/// keep `MemoryError` as its error surface without a lossy round trip through
/// [`PgError`] (`memory/postgres.rs` adapters).
pub async fn set_database_scope<E: From<PgError> + Send + 'static>(
    session: &dyn PgSession,
    scope: &NormalizedScope,
) -> Result<(), E> {
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
        .map_err(E::from)
}

/// The `(db) => …` callback of `withWorldModelTransaction` (`db.ts:204-207`),
/// boxed so the port can hand the session over as an owned [`Arc`] — the
/// `db.ts` callback receives the `PoolClient` of the transaction in the same way.
pub type ScopedBody<T, E> =
    Box<dyn FnOnce(Arc<dyn PgSession>) -> BoxFuture<'static, Result<T, E>> + Send>;

/// `withWorldModelTransaction(callback, scope)` — `db.ts:204-229`.
///
/// Acquire a connection, run `BEGIN` → scope → work → `COMMIT`, roll back on
/// failure and always release, like the `try`/`catch`/`finally` of the source.
pub async fn run_scoped<T: Send + 'static, E: From<PgError> + Send + 'static>(
    executor: &dyn PgExecutor,
    scope: Option<&NormalizedScope>,
    body: ScopedBody<T, E>,
) -> Result<T, E> {
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
async fn scoped_transaction<T: Send + 'static, E: From<PgError> + Send + 'static>(
    session: Arc<dyn PgSession>,
    scope: Option<&NormalizedScope>,
    body: ScopedBody<T, E>,
) -> Result<T, E> {
    session.query(PgStatement::new(SQL_BEGIN)).await?;
    if let Some(scope) = scope {
        set_database_scope::<E>(session.as_ref(), scope).await?;
    }
    let value = body(Arc::clone(&session)).await?;
    session.query(PgStatement::new(SQL_COMMIT)).await?;
    Ok(value)
}

/// `queryWithScope(pool, text, values, scope)` — `db.ts:62-85`.
///
/// The shape of every statement a repository runs while
/// `runWithWorldModelScope` is active: one statement, its own scoped
/// transaction, because the TypeScript wraps each `getWorldModelDb().query(...)`
/// call individually (`db.ts:107-110`).
pub async fn scoped_query<E: From<PgError> + Send + 'static>(
    executor: &dyn PgExecutor,
    scope: &NormalizedScope,
    statement: PgStatement,
) -> Result<PgQueryResult, E> {
    run_scoped::<_, E>(
        executor,
        Some(scope),
        Box::new(move |session| {
            Box::pin(async move { session.query(statement).await.map_err(E::from) })
        }),
    )
    .await
}

#[cfg(test)]
pub mod testing {
    //! The recording double every ported repository test uses.
    //!
    //! `pg` is not available in unit tests, so the seam is implemented by a
    //! double that records the statement order and answers from a queue. It is
    //! `pub` so the repository, retrieval, projector and service modules reuse it
    //! instead of re-inventing a second recorder.

    use std::sync::{Arc, Mutex};

    use super::*;

    /// One recorded call: either a statement or the `release()` of a session.
    #[derive(Debug, Clone, PartialEq)]
    pub enum Recorded {
        Statement(PgStatement),
        Release,
    }

    impl Recorded {
        pub fn sql(&self) -> &str {
            match self {
                Recorded::Statement(statement) => statement.sql.as_str(),
                Recorded::Release => "<release>",
            }
        }
    }

    /// A session that records the statements it receives and answers them from a
    /// queue. An exhausted queue answers an empty result, which is what a
    /// statement without a `RETURNING` produces.
    pub struct RecordingSession {
        pub calls: Arc<Mutex<Vec<Recorded>>>,
        pub answers: Arc<Mutex<std::collections::VecDeque<Result<PgQueryResult, PgError>>>>,
    }

    impl RecordingSession {
        pub fn new(
            calls: Arc<Mutex<Vec<Recorded>>>,
            answers: Arc<Mutex<std::collections::VecDeque<Result<PgQueryResult, PgError>>>>,
        ) -> Self {
            Self { calls, answers }
        }
    }

    /// The control statements of the RLS contract. They are recorded but never
    /// consume a scripted answer: a test writes one answer per *data* statement,
    /// which is what the ported SQL does.
    fn is_control(sql: &str) -> bool {
        matches!(sql, SQL_BEGIN | SQL_COMMIT | SQL_ROLLBACK | SQL_SET_SCOPE)
    }

    impl PgSession for RecordingSession {
        fn query<'a>(
            &'a self,
            statement: PgStatement,
        ) -> BoxFuture<'a, Result<PgQueryResult, PgError>> {
            let control = is_control(&statement.sql);
            self.calls
                .lock()
                .expect("recording mutex")
                .push(Recorded::Statement(statement));
            if control {
                return Box::pin(async { Ok(PgQueryResult::empty()) });
            }
            let answer = self
                .answers
                .lock()
                .expect("answer mutex")
                .pop_front()
                .unwrap_or_else(|| Ok(PgQueryResult::empty()));
            Box::pin(async move { answer })
        }

        fn release(&self) {
            self.calls
                .lock()
                .expect("recording mutex")
                .push(Recorded::Release);
        }
    }

    /// An executor with exactly one session and an optional unscoped answer.
    pub struct RecordingExecutor {
        pub calls: Arc<Mutex<Vec<Recorded>>>,
        pub answers: Arc<Mutex<std::collections::VecDeque<Result<PgQueryResult, PgError>>>>,
        pub connect_error: Option<PgError>,
    }

    impl RecordingExecutor {
        pub fn new(answers: Vec<Result<PgQueryResult, PgError>>) -> Self {
            Self {
                calls: Arc::new(Mutex::new(Vec::new())),
                answers: Arc::new(Mutex::new(answers.into_iter().collect())),
                connect_error: None,
            }
        }

        pub fn calls(&self) -> Vec<Recorded> {
            self.calls.lock().expect("recording mutex").clone()
        }
    }

    impl PgExecutor for RecordingExecutor {
        fn connect<'a>(&'a self) -> BoxFuture<'a, Result<Arc<dyn PgSession>, PgError>> {
            let error = self.connect_error.clone();
            let calls = Arc::clone(&self.calls);
            let answers = Arc::clone(&self.answers);
            Box::pin(async move {
                if let Some(error) = error {
                    return Err(error);
                }
                Ok(Arc::new(RecordingSession::new(calls, answers)) as Arc<dyn PgSession>)
            })
        }

        fn query<'a>(
            &'a self,
            statement: PgStatement,
        ) -> BoxFuture<'a, Result<PgQueryResult, PgError>> {
            self.calls
                .lock()
                .expect("recording mutex")
                .push(Recorded::Statement(statement));
            let answer = self
                .answers
                .lock()
                .expect("answer mutex")
                .pop_front()
                .unwrap_or_else(|| Ok(PgQueryResult::empty()));
            Box::pin(async move { answer })
        }
    }
}

#[cfg(test)]
mod tests {
    use super::testing::{Recorded, RecordingExecutor};
    use super::*;
    use serde_json::json;

    fn scope() -> NormalizedScope {
        NormalizedScope {
            user_id: "u1".to_string(),
            persona_id: "p1".to_string(),
            workspace_id: "w1".to_string(),
        }
    }

    fn sqls(executor: &RecordingExecutor) -> Vec<String> {
        executor
            .calls()
            .iter()
            .map(|call| call.sql().to_string())
            .collect()
    }

    #[test]
    fn a_scoped_statement_runs_between_begin_and_commit() {
        let row = json!({ "id": "e1" }).as_object().unwrap().clone();
        let executor = RecordingExecutor::new(vec![Ok(PgQueryResult::from_rows(vec![row]))]);
        let result = drive_sync(scoped_query::<PgError>(
            &executor,
            &scope(),
            PgStatement::with_params("SELECT 1", vec![PgValue::text("x")]),
        ))
        .expect("bridge")
        .expect("scoped query");
        assert_eq!(result.rows.len(), 1);
        assert_eq!(
            sqls(&executor),
            vec![
                "BEGIN".to_string(),
                SQL_SET_SCOPE.to_string(),
                "SELECT 1".to_string(),
                "COMMIT".to_string(),
                "<release>".to_string()
            ]
        );
    }

    #[test]
    fn the_scope_call_binds_the_tenant_triple_in_order() {
        let executor = RecordingExecutor::new(vec![]);
        drive_sync(scoped_query::<PgError>(
            &executor,
            &scope(),
            PgStatement::new("SELECT 1"),
        ))
        .expect("bridge")
        .expect("scoped query");
        let calls = executor.calls();
        match &calls[1] {
            Recorded::Statement(statement) => {
                assert_eq!(statement.sql, SQL_SET_SCOPE);
                assert_eq!(
                    statement.params,
                    vec![
                        PgValue::text("u1"),
                        PgValue::text("p1"),
                        PgValue::text("w1")
                    ]
                );
            }
            other => panic!("expected the scope statement, got {other:?}"),
        }
    }

    #[test]
    fn a_failing_statement_rolls_back_and_releases() {
        let executor = RecordingExecutor::new(vec![Err(PgError::new("boom"))]);
        let error = drive_sync(scoped_query::<PgError>(
            &executor,
            &scope(),
            PgStatement::new("SELECT 1"),
        ))
        .expect("bridge")
        .expect_err("the statement fails");
        assert_eq!(error, PgError::new("boom"));
        assert_eq!(
            sqls(&executor),
            vec![
                "BEGIN".to_string(),
                SQL_SET_SCOPE.to_string(),
                "SELECT 1".to_string(),
                SQL_ROLLBACK.to_string(),
                "<release>".to_string()
            ]
        );
        assert_eq!(executor.calls().last(), Some(&Recorded::Release));
    }

    #[test]
    fn an_unscoped_query_issues_no_transaction() {
        let executor = RecordingExecutor::new(vec![Ok(PgQueryResult::affected(3))]);
        let result = drive_sync(executor.query(PgStatement::new("UPDATE t SET a = 1")))
            .expect("bridge")
            .expect("unscoped query");
        assert_eq!(result.row_count, 3);
        assert_eq!(
            sqls(&executor),
            vec!["UPDATE t SET a = 1".to_string()],
            "no BEGIN, no scope, no COMMIT"
        );
    }

    #[test]
    fn an_unconfigured_executor_reports_the_missing_pool() {
        // `drive_sync` unwraps only the bridge; the operation's own `Result` is
        // its return value, exactly like the memory provider's bridge.
        let outcome = drive_sync(UnconfiguredPgExecutor.connect()).expect("bridge");
        let error = match outcome {
            Ok(_) => panic!("the unconfigured executor must fail"),
            Err(error) => error,
        };
        assert_eq!(error.message, UNCONFIGURED_EXECUTOR_MESSAGE);
    }

    #[test]
    fn the_no_embedder_takes_the_lexical_path() {
        let value = drive_sync(NoQueryEmbedder.embed("hello"))
            .expect("bridge")
            .expect("no provider");
        assert_eq!(value, None);
    }

    #[test]
    fn the_sync_bridge_works_outside_a_runtime() {
        assert_eq!(drive_sync(async { 7 }).expect("bridge"), 7);
    }

    #[test]
    fn result_constructors_follow_pg() {
        assert_eq!(PgQueryResult::empty(), PgQueryResult::default());
        let row = json!({ "id": "a" }).as_object().unwrap().clone();
        let from_rows = PgQueryResult::from_rows(vec![row]);
        assert_eq!(from_rows.row_count, 1);
        assert_eq!(
            from_rows.first().and_then(|r| r.get("id")),
            Some(&json!("a"))
        );
        let affected = PgQueryResult::affected(2);
        assert_eq!(affected.row_count, 2);
        assert!(affected.rows.is_empty());
    }
}
