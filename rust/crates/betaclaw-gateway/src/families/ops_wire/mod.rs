//! Family ops_wire: Ops aggregation, health, doctor, control plane, the internal
//! Graphiti and engineering-ingest endpoints, and the BetaClaw runtime routes.
//!
//! Ports `app/api/ops/{instances,nodes,sessions}/route.ts`,
//! `app/api/health/route.ts`, `app/api/health/scheduler/route.ts`,
//! `app/api/health/world-model/route.ts`, `app/api/doctor/route.ts`,
//! `app/api/control-plane/metrics/route.ts`,
//! `app/api/internal/model-hub/graphiti/[...path]/route.ts`,
//! `app/api/internal/stats/engineering/snapshots/route.ts` and
//! `app/api/betaclaw/{models,sessions,sessions/[id],status}/route.ts`.
//!
//! The routes read their services from `Extension<Arc<Services>>`. Stores with a
//! Rust implementation are owned here. Collaborators that exist only in TypeScript
//! are traits in [`ports`]; [`Unwired`] answers for them until they are wired.
//!
//! Deviation: [`build`] takes only the environment and returns [`BuildError`].
//! The workspace has no `anyhow`, and this family may not change `Cargo.toml`.

pub mod betaclaw;
pub mod channel_pairing;
pub mod control_plane;
pub mod control_plane_port;
pub mod diagnostics;
pub mod health;
pub mod internal;
pub mod ops;
pub mod ports;
pub mod world_model_port;

#[cfg(test)]
mod test_support;

use std::sync::Arc;
use std::time::Instant;

use axum::http::{HeaderMap, StatusCode, Uri};
use axum::response::{IntoResponse, Response};
use axum::{Json, Router};
use betaclaw_core::automation::sqlite_repository::SqliteAutomationRepository;
use betaclaw_core::config::LEGACY_LOCAL_USER_ID;
use betaclaw_core::db::default_db_path;
use betaclaw_core::gateway::registry::SharedRegistry;
use betaclaw_core::model_hub::env::EnvOverrides;
use betaclaw_core::skills::exec_approval::ExecApprovalStore;
use betaclaw_core::stats::engineering_snapshot_repository::EngineeringSnapshotRepository;
use betaclaw_core::stats::token_usage::TokenUsageRepository;
use serde_json::json;
use tokio::sync::Mutex;

use crate::auth_gate::{unauthorized_response, user_id_from_headers};
use crate::state::SharedState;

use diagnostics::{DiagnosticsDeps, RustDiagnostics};
use ports::{
    BetaClawPort, ChannelPairingPort, ControlPlanePort, DiagnosticsPort, Unwired, WorldModelPort,
};

/// What the diagnostics port reads from the running gateway. `state.rs` fills it.
pub struct GatewayLinks<'a> {
    pub logs_db_path: &'a str,
    pub messages_db_path: &'a str,
    pub registry: SharedRegistry,
    pub http: reqwest::Client,
}

/// `process.env.X` lookups of the scheduler health probe, resolved once at build.
#[derive(Debug, Clone)]
struct SchedulerSettings {
    token: String,
    lease_ttl_ms: u64,
    tick_interval_ms: u64,
    stale_after_ms: u64,
}

/// The engineering-ingest gate: the feature flag, the token and the per-minute window.
struct IngestSettings {
    enabled: bool,
    token: String,
    rate_window: std::sync::Mutex<Vec<i64>>,
}

/// Everything the ops family's routes need at runtime.
pub struct Services {
    started_at: Instant,
    exec_approvals: ExecApprovalStore,
    automation: Mutex<SqliteAutomationRepository>,
    token_usage: Mutex<TokenUsageRepository>,
    engineering: Mutex<EngineeringSnapshotRepository>,
    model_hub_db_path: String,
    env: EnvOverrides,
    scheduler: SchedulerSettings,
    ingest: IngestSettings,
    graphiti_token: String,
    diagnostics: Arc<dyn DiagnosticsPort>,
    world_model: Arc<dyn WorldModelPort>,
    control_plane: Arc<dyn ControlPlanePort>,
    channel_pairing: Arc<dyn ChannelPairingPort>,
    betaclaw: Arc<dyn BetaClawPort>,
}

/// Failure of [`build`].
#[derive(Debug, thiserror::Error)]
pub enum BuildError {
    #[error("exec approval store: {0}")]
    Approvals(#[from] std::io::Error),
    #[error("{0}")]
    Store(String),
}

fn store_error(error: impl std::fmt::Display) -> BuildError {
    BuildError::Store(error.to_string())
}

/// A trimmed, non-empty environment value.
fn env_nonempty(env: &EnvOverrides, key: &str) -> Option<String> {
    env.get(key)
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
}

/// Port of `Number(value)` followed by the positive check of the scheduler probe.
fn positive_ms(raw: Option<String>, fallback: u64) -> u64 {
    raw.and_then(|value| value.parse::<f64>().ok())
        .filter(|value| value.is_finite() && *value > 0.0)
        .map(|value| value.floor() as u64)
        .unwrap_or(fallback)
}

/// Builds the family from the process environment.
pub fn build(env: &EnvOverrides, links: GatewayLinks<'_>) -> Result<Services, BuildError> {
    let approvals = ExecApprovalStore::in_current_dir()?;
    assemble(env, approvals, links)
}

/// [`build`] with the approval store supplied by the caller, so tests can keep
/// the JSON file out of the working directory.
pub(crate) fn assemble(
    env: &EnvOverrides,
    exec_approvals: ExecApprovalStore,
    links: GatewayLinks<'_>,
) -> Result<Services, BuildError> {
    let automation_path =
        env_nonempty(env, "AUTOMATION_DB_PATH").unwrap_or_else(|| default_db_path("automation.db"));
    let stats_path =
        env_nonempty(env, "STATS_DB_PATH").unwrap_or_else(|| default_db_path("stats.db"));
    let automation = SqliteAutomationRepository::open(&automation_path).map_err(store_error)?;
    let token_usage = TokenUsageRepository::open(&stats_path).map_err(store_error)?;
    // The engineering tables (migrations 009 to 012) live in the main database, where
    // the migration runner creates them. `stats_wire` opens the same file.
    let main_db_path =
        env_nonempty(env, "DATABASE_PATH").unwrap_or_else(|| "mission-control.db".to_string());
    let engineering = EngineeringSnapshotRepository::open(&main_db_path).map_err(store_error)?;

    let lease_ttl_ms = positive_ms(env_nonempty(env, "AUTOMATION_LEASE_TTL_MS"), 30_000);
    let tick_interval_ms = positive_ms(env_nonempty(env, "AUTOMATION_TICK_INTERVAL_MS"), 15_000);
    let stale_after_ms = positive_ms(
        env_nonempty(env, "SCHEDULER_HEALTH_STALE_AFTER_MS"),
        lease_ttl_ms.max(tick_interval_ms * 2),
    );
    let ingest_enabled = matches!(
        env_nonempty(env, "ENGINEERING_INGEST_ENABLED")
            .map(|value| value.to_ascii_lowercase())
            .as_deref(),
        Some("1" | "true")
    );

    Ok(Services {
        started_at: Instant::now(),
        exec_approvals,
        automation: Mutex::new(automation),
        token_usage: Mutex::new(token_usage),
        engineering: Mutex::new(engineering),
        model_hub_db_path: env_nonempty(env, "MODEL_HUB_DB_PATH")
            .unwrap_or_else(|| ".local/model-hub.db".to_string()),
        env: env.clone(),
        scheduler: SchedulerSettings {
            token: env_nonempty(env, "SCHEDULER_HEALTH_TOKEN").unwrap_or_default(),
            lease_ttl_ms,
            tick_interval_ms,
            stale_after_ms,
        },
        ingest: IngestSettings {
            enabled: ingest_enabled,
            token: env_nonempty(env, "ENGINEERING_INGEST_TOKEN").unwrap_or_default(),
            rate_window: std::sync::Mutex::new(Vec::new()),
        },
        graphiti_token: env_nonempty(env, "GRAPHITI_MODEL_HUB_TOKEN").unwrap_or_default(),
        diagnostics: Arc::new(RustDiagnostics::open(DiagnosticsDeps {
            env,
            logs_db_path: links.logs_db_path,
            stats_db_path: &stats_path,
            messages_db_path: links.messages_db_path,
            registry: links.registry,
            http: links.http,
        })?),
        world_model: Arc::new(world_model_port::WorldModelHealth::from_process_env()),
        control_plane: Arc::new(control_plane_port::ControlPlaneFigures),
        channel_pairing: Arc::new(Unwired),
        betaclaw: Arc::new(Unwired),
    })
}

/// Every route of the family. The integrator merges this into the gateway router
/// and attaches `Extension(Arc::new(services))`.
pub fn router() -> Router<SharedState> {
    Router::new()
        .merge(ops::router())
        .merge(health::router())
        .merge(control_plane::router())
        .merge(internal::router())
        .merge(betaclaw::router())
}

/// `{ "ok": false, "error": message }` with the given status, the body the
/// TypeScript routes send from their `catch` blocks.
pub(crate) fn error_json(status: StatusCode, message: impl Into<String>) -> Response {
    (
        status,
        Json(json!({ "ok": false, "error": message.into() })),
    )
        .into_response()
}

/// Identity of `withUserContext`: the user id, or the 401 response.
#[allow(clippy::result_large_err)]
pub(crate) fn require_user(headers: &HeaderMap) -> Result<String, Response> {
    user_id_from_headers(headers).ok_or_else(unauthorized_response)
}

/// Identity of `withResolvedUserContext`: the user id, or the legacy local user.
pub(crate) fn user_id_from_headers_or_legacy(headers: &HeaderMap) -> String {
    user_id_from_headers(headers).unwrap_or_else(|| LEGACY_LOCAL_USER_ID.to_string())
}

/// `URLSearchParams.get(key)` on the request's query string.
pub(crate) fn query_param(uri: &Uri, key: &str) -> Option<String> {
    uri.query()?.split('&').find_map(|pair| {
        let (name, value) = pair.split_once('=').unwrap_or((pair, ""));
        (form_decode(name) == key).then(|| form_decode(value))
    })
}

fn form_decode(input: &str) -> String {
    let bytes = input.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut index = 0;
    while index < bytes.len() {
        let byte = bytes[index];
        if byte == b'+' {
            out.push(b' ');
        } else if byte == b'%' && index + 2 < bytes.len() {
            let hex = std::str::from_utf8(&bytes[index + 1..index + 3]).unwrap_or("");
            if let Ok(decoded) = u8::from_str_radix(hex, 16) {
                out.push(decoded);
                index += 3;
                continue;
            }
            out.push(byte);
        } else {
            out.push(byte);
        }
        index += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

/// `Number.parseInt(raw, 10)`: an optional sign, then the leading digits.
pub(crate) fn js_parse_int(raw: &str) -> Option<i64> {
    let trimmed = raw.trim_start();
    let (negative, digits) = match trimmed.strip_prefix('-') {
        Some(rest) => (true, rest),
        None => (false, trimmed.strip_prefix('+').unwrap_or(trimmed)),
    };
    let length = digits.bytes().take_while(u8::is_ascii_digit).count();
    let value: i64 = digits[..length].parse().ok()?;
    Some(if negative { -value } else { value })
}

/// `parseClampedInt` of `app/api/ops/_shared/query.ts`.
pub(crate) fn clamped_int(uri: &Uri, key: &str, fallback: i64, min: i64, max: i64) -> i64 {
    query_param(uri, key)
        .and_then(|raw| js_parse_int(&raw))
        .map_or(fallback, |value| value.clamp(min, max))
}

/// `new Date(ms).toISOString()`.
pub(crate) fn iso_from_ms(ms: i64) -> String {
    chrono::DateTime::from_timestamp_millis(ms)
        .unwrap_or_else(chrono::Utc::now)
        .to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}

/// `new Date().toISOString()`.
pub(crate) fn now_iso() -> String {
    iso_from_ms(chrono::Utc::now().timestamp_millis())
}
