//! The productive implementation of the [`PgExecutor`] seam with sqlx.
//!
//! `docs/RUST_MIGRATION.md:64` chooses sqlx ("Async-Pool + Transaktionen für
//! `BEGIN` → `world_model_set_scope()` → Query → `COMMIT`"), `:546-547` states
//! that `betaclaw-core` owns no PostgreSQL driver before this slice, and the
//! seam comment of `memory/postgres.rs:62-67` promised that the driver lands
//! with S6. This module is it — the one place in the workspace that talks to
//! PostgreSQL, and therefore the one place that imports `sqlx-postgres`.
//!
//! # What it is not
//!
//! * It is **not** a second transaction layer. All scope and transaction
//!   handling stays in [`crate::world_model::db`]; this module only executes the
//!   statements it is handed, exactly like `pg`'s `Pool.query` and
//!   `PoolClient.query`.
//! * It is **not** used by the unit tests. Every ported statement is verified
//!   against [`crate::world_model::db::testing`], because a unit test must not
//!   need a database. The live path is covered by the container smoke lane.
//!
//! # Driver crates instead of the `sqlx` facade
//!
//! `sqlx` (the facade) always resolves `sqlx-sqlite`/`libsqlite3-sys` in its
//! version graph, and that copy collides with the `libsqlite3-sys` of
//! `rusqlite`: `links = "sqlite3"` may appear only once in a binary, so the
//! resolution fails. The port therefore depends on `sqlx-core` (runtime and TLS
//! features) and `sqlx-postgres` (the driver) directly. The TLS backend is
//! `_tls-rustls-ring-native-roots`, which mirrors `pg`: node-postgres trusts the
//! operating system's CA store.
//!
//! # Row decoding
//!
//! `pg` returns typed JavaScript values; the seam carries untyped JSON columns.
//! [`decode_row`] performs the mapping node-postgres performs by default:
//! `bool`→`Bool`, `int2/4/8`→`Number`, `float4/8`→`Number`,
//! **`numeric`→`String`** (node-postgres keeps precision), `json/jsonb`→parsed
//! `Value`, **`timestamptz`→ISO 8601 string** with milliseconds and `Z` (what
//! `Date#toISOString()` produces), `text[]`/`int4[]`→`Array`, everything else
//! text-like→`String`. The `numeric`-as-string and the `timestamptz`-as-ISO
//! decisions are what the ported repositories depend on (`memory/postgres.rs`:
//! "a [`PgRow`] carries `Value::String` for text and timestamps"). `timestamp`
//! without a time zone has no faithful JavaScript equivalent — node-postgres
//! builds a local-time `Date` — so the port emits the naive ISO text and lists
//! this as a deviation.

use std::sync::Arc;

use futures_util::TryStreamExt as _;
use serde_json::{Map, Number, Value};
use sqlx_core::executor::Executor as _;
use sqlx_core::pool::PoolConnection;
use sqlx_core::query::query;
use sqlx_core::row::Row as _;
use sqlx_core::sql_str::AssertSqlSafe;
use sqlx_core::Either;
use sqlx_postgres::{PgConnectOptions, PgPool, PgPoolOptions};

use crate::world_model::config::WorldModelConfig;
use crate::world_model::db::{
    BoxFuture, PgError, PgExecutor, PgQueryResult, PgRow, PgSession, PgStatement, PgValue,
};

/// The pool settings the TypeScript passes to `new Pool(...)` (`db.ts:89-93`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PgPoolSettings {
    pub database_url: String,
    pub pool_max: i64,
    pub pool_idle_timeout_ms: i64,
}

impl PgPoolSettings {
    /// `buildPool` (`db.ts:87-98`).
    pub fn from_config(config: &WorldModelConfig) -> Self {
        Self {
            database_url: config.database_url.clone(),
            pool_max: config.pool_max,
            pool_idle_timeout_ms: config.pool_idle_timeout_ms,
        }
    }
}

/// The one productive [`PgExecutor`]: a `sqlx` pool behind the seam.
#[derive(Debug, Clone)]
pub struct SqlxPgExecutor {
    pool: PgPool,
}

impl SqlxPgExecutor {
    /// `new Pool({ connectionString, max, idleTimeoutMillis })` (`db.ts:89-93`).
    pub async fn connect(settings: &PgPoolSettings) -> Result<Self, PgError> {
        let options: PgConnectOptions = settings
            .database_url
            .parse()
            .map_err(|error| PgError::new(format!("invalid PostgreSQL URL: {error}")))?;
        let pool = PgPoolOptions::new()
            .max_connections(settings.pool_max.max(1) as u32)
            .idle_timeout(Some(std::time::Duration::from_millis(
                settings.pool_idle_timeout_ms.max(1) as u64,
            )))
            .connect_with(options)
            .await
            .map_err(|error| PgError::new(format!("{error}")))?;
        Ok(Self { pool })
    }

    /// The same pool without a connection up front, as `pg` connects on the first
    /// query. Building it does not wait on the network, and each query waits at
    /// most `acquire_timeout` for a connection. Needs a Tokio runtime, because the
    /// pool spawns its idle reaper.
    pub fn connect_lazy(
        settings: &PgPoolSettings,
        acquire_timeout: std::time::Duration,
    ) -> Result<Self, PgError> {
        let options: PgConnectOptions = settings
            .database_url
            .parse()
            .map_err(|error| PgError::new(format!("invalid PostgreSQL URL: {error}")))?;
        let pool = PgPoolOptions::new()
            .max_connections(settings.pool_max.max(1) as u32)
            .idle_timeout(Some(std::time::Duration::from_millis(
                settings.pool_idle_timeout_ms.max(1) as u64,
            )))
            .acquire_timeout(acquire_timeout)
            .connect_lazy_with(options);
        Ok(Self { pool })
    }

    /// Wraps a pool the caller owns — the seam is satisfied for any pool.
    pub fn from_pool(pool: PgPool) -> Self {
        Self { pool }
    }

    /// `getWorldModelDb().pool`.
    pub fn pool(&self) -> &PgPool {
        &self.pool
    }

    /// `closeWorldModelDb()` (`db.ts:114-119`).
    pub async fn close(&self) {
        self.pool.close().await;
    }

    /// `isConnectionUsable(pool)` (`db.ts:121-128`).
    pub async fn is_connection_usable(&self) -> bool {
        self.pool.acquire().await.is_ok()
    }
}

impl PgExecutor for SqlxPgExecutor {
    fn connect<'a>(&'a self) -> BoxFuture<'a, Result<Arc<dyn PgSession>, PgError>> {
        Box::pin(async move {
            let connection = self
                .pool
                .acquire()
                .await
                .map_err(|error| PgError::new(format!("{error}")))?;
            Ok(Arc::new(SqlxPgSession::new(connection)) as Arc<dyn PgSession>)
        })
    }

    fn query<'a>(
        &'a self,
        statement: PgStatement,
    ) -> BoxFuture<'a, Result<PgQueryResult, PgError>> {
        Box::pin(async move {
            let mut connection = self
                .pool
                .acquire()
                .await
                .map_err(|error| PgError::new(format!("{error}")))?;
            run_statement(&mut connection, statement).await
        })
    }
}

/// One checked-out `sqlx` connection. `pg`'s `PoolClient` is single-threaded;
/// the seam hands the session out as an `Arc`, so the connection lives behind an
/// async mutex and `release()` drops it back into the pool — the documented
/// behaviour of the seam (`db.ts:83`, `:225`).
pub struct SqlxPgSession {
    connection: tokio::sync::Mutex<Option<PoolConnection<sqlx_postgres::Postgres>>>,
}

impl SqlxPgSession {
    pub fn new(connection: PoolConnection<sqlx_postgres::Postgres>) -> Self {
        Self {
            connection: tokio::sync::Mutex::new(Some(connection)),
        }
    }
}

impl PgSession for SqlxPgSession {
    fn query<'a>(
        &'a self,
        statement: PgStatement,
    ) -> BoxFuture<'a, Result<PgQueryResult, PgError>> {
        Box::pin(async move {
            let mut guard = self.connection.lock().await;
            let connection = guard
                .as_mut()
                .ok_or_else(|| PgError::new("the session was released"))?;
            run_statement(connection, statement).await
        })
    }

    fn release(&self) {
        // Taking the connection out of the slot drops it, which returns it to
        // the pool; a later statement on the same session then fails explicitly
        // instead of silently using a released connection.
        if let Ok(mut guard) = self.connection.try_lock() {
            guard.take();
        }
    }
}

struct PgEnumParam<'a> {
    value: Option<&'a str>,
    type_info: sqlx_postgres::PgTypeInfo,
}

impl sqlx_core::types::Type<sqlx_postgres::Postgres> for PgEnumParam<'_> {
    fn type_info() -> sqlx_postgres::PgTypeInfo {
        sqlx_postgres::PgTypeInfo::with_name("TEXT")
    }
}

impl<'q> sqlx_core::encode::Encode<'q, sqlx_postgres::Postgres> for PgEnumParam<'q> {
    fn encode_by_ref(
        &self,
        buffer: &mut sqlx_postgres::PgArgumentBuffer,
    ) -> Result<sqlx_core::encode::IsNull, sqlx_core::error::BoxDynError> {
        match self.value {
            Some(value) => {
                <&str as sqlx_core::encode::Encode<'q, sqlx_postgres::Postgres>>::encode(
                    value, buffer,
                )
            }
            None => Ok(sqlx_core::encode::IsNull::Yes),
        }
    }
    fn produces(&self) -> Option<sqlx_postgres::PgTypeInfo> {
        Some(self.type_info.clone())
    }
}

/// Run one statement and fold the stream into a [`PgQueryResult`].
///
/// `fetch_many` yields rows *and* the command tag, which is why it is used
/// instead of `fetch_all`: `pg` reports `rows` and `rowCount` together, and only
/// the tag carries `rowsAffected` for a write (`db.ts:483` compares it with `1`).
///
/// # Why `AssertSqlSafe`
///
/// sqlx 0.9 accepts a `SqlSafeStr`, which is implemented for `&'static str` only,
/// so a runtime `String` has to be asserted as safe. That assertion is correct
/// here and is worth writing down: the SQL text of this port is *code* — the
/// literals of the ported repositories plus the `WHERE`/`SET` fragments that the
/// helpers build from column-name literals — and every value travels through a
/// bind parameter. No caller passes user input as SQL.
async fn run_statement(
    connection: &mut sqlx_postgres::PgConnection,
    statement: PgStatement,
) -> Result<PgQueryResult, PgError> {
    use sqlx_core::sql_str::SqlSafeStr as _;
    use sqlx_core::statement::Statement as _;
    use sqlx_core::type_info::TypeInfo as _;
    // node-postgres lets PostgreSQL infer parameter types. Preserve that contract
    // before sqlx supplies concrete Rust types (TEXT cannot be assigned to UUID).
    let parameter_types = if statement.params.is_empty() {
        Vec::new()
    } else {
        let description = connection
            // Separate inferred metadata from sqlx's concretely typed query cache.
            .prepare(
                AssertSqlSafe(format!("/* pg parameter inference */ {}", statement.sql))
                    .into_sql_str(),
            )
            .await
            .map_err(|error| PgError::new(error.to_string()))?;
        match description.parameters() {
            Some(Either::Left(types)) => types.to_vec(),
            _ => return Err(PgError::new("PostgreSQL did not describe parameter types")),
        }
    };
    let mut query = query::<sqlx_postgres::Postgres>(AssertSqlSafe(statement.sql.clone()));
    for (index, param) in statement.params.iter().enumerate() {
        if let Some(info) = parameter_types
            .get(index)
            .filter(|info| matches!(info.kind(), sqlx_postgres::PgTypeKind::Enum(_)))
        {
            let value = match param {
                PgValue::Text(value) => Some(value.as_str()),
                PgValue::Null => None,
                _ => return Err(PgError::new("Enum parameters must be text or null")),
            };
            query = query.bind(PgEnumParam {
                value,
                type_info: info.clone(),
            });
            continue;
        }
        let type_name = parameter_types
            .get(index)
            .map(|info| info.name())
            .unwrap_or("");
        query = match (param, type_name) {
            (PgValue::Text(value), "UUID") => query.bind(
                uuid::Uuid::parse_str(value).map_err(|error| PgError::new(error.to_string()))?,
            ),
            (PgValue::Text(value), "TIMESTAMPTZ") => query.bind(
                chrono::DateTime::parse_from_rfc3339(value)
                    .map_err(|error| PgError::new(error.to_string()))?
                    .with_timezone(&chrono::Utc),
            ),
            (PgValue::Text(value), "TIMESTAMP") => query.bind(
                chrono::NaiveDateTime::parse_from_str(value, "%Y-%m-%dT%H:%M:%S%.f")
                    .map_err(|error| PgError::new(error.to_string()))?,
            ),
            (PgValue::Text(value), "DATE") => query.bind(
                chrono::NaiveDate::parse_from_str(value, "%Y-%m-%d")
                    .map_err(|error| PgError::new(error.to_string()))?,
            ),
            (PgValue::Text(value), "JSON" | "JSONB") => query.bind(
                serde_json::from_str::<Value>(value)
                    .map_err(|error| PgError::new(error.to_string()))?,
            ),
            (PgValue::TextArray(values), "UUID[]") => query.bind(
                values
                    .iter()
                    .map(|value| uuid::Uuid::parse_str(value))
                    .collect::<Result<Vec<_>, _>>()
                    .map_err(|error| PgError::new(error.to_string()))?,
            ),
            (PgValue::Int64(value), "INT2") => {
                query.bind(i16::try_from(*value).map_err(|error| PgError::new(error.to_string()))?)
            }
            (PgValue::Int64(value), "INT4") => {
                query.bind(i32::try_from(*value).map_err(|error| PgError::new(error.to_string()))?)
            }
            (PgValue::Float64(value), "FLOAT4") => query.bind(*value as f32),
            (PgValue::Null, "INT2") => query.bind(Option::<i16>::None),
            (PgValue::Null, "INT4") => query.bind(Option::<i32>::None),
            (PgValue::Null, "INT8") => query.bind(Option::<i64>::None),
            (PgValue::Null, "FLOAT4") => query.bind(Option::<f32>::None),
            (PgValue::Null, "FLOAT8") => query.bind(Option::<f64>::None),
            (PgValue::Null, "BOOL") => query.bind(Option::<bool>::None),
            (PgValue::Null, "UUID") => query.bind(Option::<uuid::Uuid>::None),
            (PgValue::Null, "TIMESTAMPTZ") => {
                query.bind(Option::<chrono::DateTime<chrono::Utc>>::None)
            }
            (PgValue::Null, "TIMESTAMP") => query.bind(Option::<chrono::NaiveDateTime>::None),
            (PgValue::Null, "DATE") => query.bind(Option::<chrono::NaiveDate>::None),
            (PgValue::Null, "JSON" | "JSONB") => query.bind(Option::<Value>::None),
            (PgValue::Null, _) => query.bind(Option::<String>::None),
            (PgValue::Text(value), _) => query.bind(value.clone()),
            (PgValue::Int64(value), _) => query.bind(*value),
            (PgValue::Float64(value), _) => query.bind(*value),
            (PgValue::Bool(value), _) => query.bind(*value),
            (PgValue::TextArray(values), _) => query.bind(values.clone()),
        };
    }

    let mut rows: Vec<PgRow> = Vec::new();
    let mut row_count: Option<i64> = None;
    let mut stream = connection.fetch_many(query);
    while let Some(item) = stream
        .try_next()
        .await
        .map_err(|error| PgError::new(format!("{error}")))?
    {
        // `fetch_many` yields the rows one by one and then the command tag:
        // `Either::Right` is a row, `Either::Left` the statement result whose
        // `rows_affected` is `pg`'s `rowCount` (the row count for a `SELECT`, the
        // affected count for a write).
        match item {
            Either::Left(result) => {
                row_count = Some(result.rows_affected() as i64);
            }
            Either::Right(row) => {
                rows.push(decode_row(&row)?);
            }
        }
    }
    // A driver that saw no tag still answers `rows.length`, which is what `pg`
    // reports for a `SELECT`.
    let row_count = row_count.unwrap_or(rows.len() as i64);
    Ok(PgQueryResult { rows, row_count })
}

/// A decoded column value before the `pg`-shaped JSON mapping.
///
/// The split exists so the mapping itself is a pure function: [`json_column`]
/// has no dependency on sqlx and is covered by unit tests, while the driver only
/// has to decode into these primitives.
#[derive(Debug, Clone, PartialEq)]
pub enum ColumnValue {
    Null,
    Bool(bool),
    Int(i64),
    Float(f64),
    Text(String),
    Json(Value),
    TextArray(Vec<String>),
    IntArray(Vec<i64>),
    FloatArray(Vec<f64>),
    BoolArray(Vec<bool>),
}

/// `pg`'s default mapping from a decoded column to the JSON value of the seam.
pub fn json_column(value: &ColumnValue) -> Value {
    match value {
        ColumnValue::Null => Value::Null,
        ColumnValue::Bool(flag) => Value::Bool(*flag),
        ColumnValue::Int(number) => Value::Number(Number::from(*number)),
        ColumnValue::Float(number) => Number::from_f64(*number)
            .map(Value::Number)
            // `pg` returns `NaN`/`Infinity` for those floats; JSON has no
            // literal for them and the TypeScript callers compare numerically,
            // so the seam keeps them as text instead of dropping the column.
            .unwrap_or_else(|| Value::String(format_js_number(*number))),
        ColumnValue::Text(text) => Value::String(text.clone()),
        ColumnValue::Json(value) => value.clone(),
        ColumnValue::TextArray(values) => {
            Value::Array(values.iter().map(|v| Value::String(v.clone())).collect())
        }
        ColumnValue::IntArray(values) => Value::Array(
            values
                .iter()
                .map(|v| Value::Number(Number::from(*v)))
                .collect(),
        ),
        ColumnValue::FloatArray(values) => Value::Array(
            values
                .iter()
                .map(|v| {
                    Number::from_f64(*v)
                        .map(Value::Number)
                        .unwrap_or_else(|| Value::String(format_js_number(*v)))
                })
                .collect(),
        ),
        ColumnValue::BoolArray(values) => {
            Value::Array(values.iter().map(|v| Value::Bool(*v)).collect())
        }
    }
}

/// `String(value)` for a non-finite float — `NaN`, `Infinity`, `-Infinity`.
fn format_js_number(value: f64) -> String {
    if value.is_nan() {
        "NaN".to_string()
    } else if value > 0.0 {
        "Infinity".to_string()
    } else {
        "-Infinity".to_string()
    }
}

/// `Date#toISOString()` — the timestamp text the ported repositories read.
///
/// `toISOString` always emits UTC with milliseconds and a trailing `Z`; the
/// `sqlx` `TIMESTAMPTZ` value is already in UTC.
pub fn format_timestamptz(value: chrono::DateTime<chrono::Utc>) -> String {
    value.to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}

/// Decodes one `sqlx` row into the untyped column map of the seam.
fn decode_row(row: &sqlx_postgres::PgRow) -> Result<PgRow, PgError> {
    use sqlx_core::column::Column as _;
    use sqlx_core::type_info::TypeInfo as _;
    use sqlx_core::value::ValueRef as _;

    let mut map = Map::new();
    for (index, column) in row.columns().iter().enumerate() {
        let name = column.name().to_string();
        let raw = row
            .try_get_raw(index)
            .map_err(|error| PgError::new(format!("{error}")))?;
        let value = if raw.is_null() {
            Value::Null
        } else {
            json_column(&decode_column(row, index, column.type_info().name())?)
        };
        map.insert(name, value);
    }
    Ok(map)
}

/// Decodes a single column by its PostgreSQL type name.
///
/// The names are the canonical names of `sqlx`'s type info (`BOOL`, `INT4`,
/// `TIMESTAMPTZ`, `TEXT[]`, …). A type the mapping does not know falls back to
/// the text form, which is what the canonical schema needs (`uuid` is read as
/// text by every ported statement).
fn decode_column(
    row: &sqlx_postgres::PgRow,
    index: usize,
    type_name: &str,
) -> Result<ColumnValue, PgError> {
    use sqlx_core::column::Column as _;
    use sqlx_core::row::Row as _;

    if matches!(
        row.columns()[index].type_info().kind(),
        sqlx_postgres::PgTypeKind::Enum(_)
    ) {
        return row
            .try_get_unchecked::<String, _>(index)
            .map(ColumnValue::Text)
            .map_err(|error| PgError::new(error.to_string()));
    }

    let decoded = match type_name {
        // Scope-setting functions return VOID, which sqlx cannot decode as text.
        "VOID" => return Ok(ColumnValue::Null),
        "UUID" => row
            .try_get::<uuid::Uuid, _>(index)
            .map(|value| ColumnValue::Text(value.to_string())),
        "UUID[]" => row.try_get::<Vec<uuid::Uuid>, _>(index).map(|values| {
            ColumnValue::TextArray(values.into_iter().map(|value| value.to_string()).collect())
        }),
        "BOOL" => row.try_get::<bool, _>(index).map(ColumnValue::Bool),
        "INT2" => row
            .try_get::<i16, _>(index)
            .map(|value| ColumnValue::Int(value as i64)),
        "INT4" => row
            .try_get::<i32, _>(index)
            .map(|value| ColumnValue::Int(value as i64)),
        "INT8" => row.try_get::<i64, _>(index).map(ColumnValue::Int),
        // `REAL` in the canonical schema (`001_world_model.sql:83`, `:104`).
        "FLOAT4" => row
            .try_get::<f32, _>(index)
            .map(|value| ColumnValue::Float(value as f64)),
        "FLOAT8" => row.try_get::<f64, _>(index).map(ColumnValue::Float),
        // `pg` returns `numeric` as text to keep its precision; the canonical
        // schema has no `numeric` column, so the float form comes first.
        "NUMERIC" => row
            .try_get::<f64, _>(index)
            .map(ColumnValue::Float)
            .or_else(|_| row.try_get::<String, _>(index).map(ColumnValue::Text)),
        "JSON" | "JSONB" => row.try_get::<Value, _>(index).map(ColumnValue::Json),
        "TIMESTAMPTZ" => row
            .try_get::<chrono::DateTime<chrono::Utc>, _>(index)
            .map(|value| ColumnValue::Text(format_timestamptz(value))),
        "TIMESTAMP" => row
            .try_get::<chrono::NaiveDateTime, _>(index)
            .map(|value| ColumnValue::Text(value.format("%Y-%m-%dT%H:%M:%S%.f").to_string())),
        "DATE" => row
            .try_get::<chrono::NaiveDate, _>(index)
            .map(|value| ColumnValue::Text(value.format("%Y-%m-%d").to_string())),
        "TEXT[]" | "VARCHAR[]" | "BPCHAR[]" | "NAME[]" => row
            .try_get::<Vec<String>, _>(index)
            .map(ColumnValue::TextArray),
        "INT2[]" | "INT4[]" | "INT8[]" => {
            row.try_get::<Vec<i64>, _>(index).map(ColumnValue::IntArray)
        }
        "FLOAT4[]" | "FLOAT8[]" => row
            .try_get::<Vec<f64>, _>(index)
            .map(ColumnValue::FloatArray),
        "BOOL[]" => row
            .try_get::<Vec<bool>, _>(index)
            .map(ColumnValue::BoolArray),
        // Every text-like type (`TEXT`, `VARCHAR`, `BPCHAR`, `NAME`, `UUID`,
        // `INET`, …) and the unknown fallback.
        _ => row.try_get::<String, _>(index).map(ColumnValue::Text),
    };

    decoded.map_err(|error| {
        PgError::new(format!(
            "column {index} of type {type_name} could not be decoded: {error}"
        ))
    })
}
