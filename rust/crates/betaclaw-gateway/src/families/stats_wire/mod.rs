//! Family stats_wire: the stats, debug, knowledge-graph and events routes.
//!
//! Ports `app/api/stats/**` (3 routes), `app/api/debug/**` (3), the knowledge
//! graph (`app/api/knowledge/graph/route.ts`) and `app/api/events/**` (the feed,
//! the manual event and the SSE stream). Each module names the TypeScript source
//! it mirrors.
//!
//! Wiring: [`build`] opens the stores this family owns, [`router`] returns the
//! routes, and the handlers read the services from `Extension<Arc<Services>>`.
//! The integrator attaches the extension with
//! `.layer(Extension(Arc::new(services)))`. Other families publish SSE events
//! through [`Services::events`].

mod auth;
mod debug;
mod events;
mod knowledge;
mod params;
mod sse;
mod stats;
#[cfg(test)]
mod test_support;

use std::path::PathBuf;
use std::sync::{Arc, Mutex, MutexGuard, PoisonError};
use std::time::{Duration, Instant};

use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::{Json, Router};
use betaclaw_core::db::{self, OpenOptions};
use betaclaw_core::knowledge::repositories::run_knowledge_migrations;
use betaclaw_core::master::repository::db::default_master_db_path;
use betaclaw_core::master::repository::sqlite_master_repository::SqliteMasterRepository;
use betaclaw_core::messages_store::default_messages_db_path;
use betaclaw_core::stats::engineering_migrations::run_engineering_migrations;
use betaclaw_core::stats::engineering_snapshot_repository::EngineeringSnapshotRepository;
use betaclaw_core::stats::prompt_dispatch::PromptDispatchRepository;
use betaclaw_core::stats::token_usage::TokenUsageRepository;
use betaclaw_core::stats::util::js_parse_int;
use betaclaw_core::stats::{default_stats_db_path, StatsError};
use betaclaw_core::tasks::migrations::run_migrations as run_task_migrations;
use rusqlite::Connection;
use serde_json::json;

use crate::state::SharedState;

pub use sse::{EventHub, SseEvent, Subscription};

/// Where the stores live and how the SSE hub is sized. [`StatsWireConfig::from_env`]
/// resolves the same paths as the TypeScript modules do.
#[derive(Debug, Clone)]
pub struct StatsWireConfig {
    /// `STATS_DB_PATH`: token usage and prompt dispatches.
    pub stats_db_path: String,
    /// `KNOWLEDGE_DB_PATH || MESSAGES_DB_PATH`: the knowledge tables.
    pub knowledge_db_path: String,
    /// `DATABASE_PATH`: events, tasks, agents, workspaces and engineering snapshots.
    pub main_db_path: String,
    /// `MASTER_DB_PATH`: the master signals of the engineering metrics.
    pub master_db_path: String,
    /// `config/harness-rollout-gates.json`, relative to the working directory.
    pub rollout_config_path: PathBuf,
    /// `docs/contracts/DOMAIN_REGISTRY.json`, relative to the working directory.
    pub domain_registry_path: PathBuf,
    /// `SSE_MAX_CLIENTS`, at least 1.
    pub sse_max_clients: usize,
    /// Interval of the SSE keep-alive comment.
    pub sse_keepalive: Duration,
}

impl StatsWireConfig {
    pub fn from_env() -> Self {
        let env = |key: &str| {
            std::env::var(key)
                .ok()
                .map(|value| value.trim().to_string())
                .filter(|value| !value.is_empty())
        };
        Self {
            stats_db_path: default_stats_db_path(),
            knowledge_db_path: env("KNOWLEDGE_DB_PATH").unwrap_or_else(default_messages_db_path),
            // `lib/db/index.ts`: `DATABASE_PATH`, default `mission-control.db` in the working directory.
            main_db_path: env("DATABASE_PATH").unwrap_or_else(|| "mission-control.db".to_string()),
            master_db_path: default_master_db_path(),
            rollout_config_path: PathBuf::from("config/harness-rollout-gates.json"),
            domain_registry_path: PathBuf::from("docs/contracts/DOMAIN_REGISTRY.json"),
            sse_max_clients: env("SSE_MAX_CLIENTS")
                .as_deref()
                .and_then(js_parse_int)
                .map_or(20, |value| value.max(1) as usize),
            sse_keepalive: Duration::from_secs(30),
        }
    }
}

/// Failures of [`build`]. Each store reports its own error; both convert into
/// `anyhow::Error` with `?`.
#[derive(Debug, thiserror::Error)]
pub enum BuildError {
    #[error("database error: {0}")]
    Database(#[from] rusqlite::Error),
    #[error(transparent)]
    Stats(#[from] StatsError),
}

/// The main database: events, tasks, agents and workspaces. One connection under
/// a mutex, as the other stores of the gateway.
pub(super) struct MainStore {
    connection: Mutex<Connection>,
}

impl MainStore {
    pub(super) fn lock(&self) -> MutexGuard<'_, Connection> {
        self.connection
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
    }
}

/// Everything this family reads and writes, opened once by [`build`].
pub struct Services {
    /// The in-memory SSE hub behind `GET /api/events/stream`.
    pub events: Arc<EventHub>,
    token_usage: TokenUsageRepository,
    prompt_dispatch: PromptDispatchRepository,
    snapshots: EngineeringSnapshotRepository,
    master: Mutex<SqliteMasterRepository>,
    main: Arc<MainStore>,
    knowledge: knowledge::KnowledgeStore,
    rollout_config_path: PathBuf,
    domain_registry_path: PathBuf,
    // ponytail: the uptime counts from this build, not from process start.
    started: Instant,
}

/// Opens every store of this family and runs the migrations they need.
///
/// The main database also carries tables that the tasks family owns. Both
/// migration sets are idempotent, so running them here too is safe.
pub fn build(config: &StatsWireConfig) -> Result<Services, BuildError> {
    let mut main = db::open(OpenOptions::new(&config.main_db_path))?;
    run_task_migrations(&mut main)?;
    run_engineering_migrations(&mut main)?;
    let snapshots = EngineeringSnapshotRepository::open(&config.main_db_path)?;

    let knowledge_connection = db::open(OpenOptions::new(&config.knowledge_db_path))?;
    run_knowledge_migrations(&knowledge_connection)?;

    Ok(Services {
        events: EventHub::new(config.sse_max_clients, config.sse_keepalive),
        token_usage: TokenUsageRepository::open(&config.stats_db_path)?,
        prompt_dispatch: PromptDispatchRepository::open(&config.stats_db_path)?,
        snapshots,
        master: Mutex::new(SqliteMasterRepository::open(&config.master_db_path)?),
        main: Arc::new(MainStore {
            connection: Mutex::new(main),
        }),
        knowledge: knowledge::KnowledgeStore::new(knowledge_connection),
        rollout_config_path: config.rollout_config_path.clone(),
        domain_registry_path: config.domain_registry_path.clone(),
        started: Instant::now(),
    })
}

/// The routes of this family. A method the family does not handle falls through
/// to the reverse proxy, as the other families do.
pub fn router() -> Router<SharedState> {
    Router::new()
        .merge(stats::router())
        .merge(debug::router())
        .merge(knowledge::router())
        .merge(events::router())
}

/// `{ "ok": false, "error": message }`, the error body of the stats, debug and
/// knowledge routes.
pub(super) fn error_response(status: StatusCode, message: &str) -> Response {
    (status, Json(json!({ "ok": false, "error": message }))).into_response()
}
