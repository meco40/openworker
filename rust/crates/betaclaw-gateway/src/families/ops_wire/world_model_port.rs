//! World-Model health and metrics of the ops family.
//!
//! Ports the body of `app/api/health/world-model/route.ts` (checks 1 to 9;
//! `health.rs` sets the status code from the body) and the `getWorldModelMetrics()`
//! projection that `app/api/control-plane/metrics/route.ts` copies into its
//! `worldModel` field. The figures come from `betaclaw_core::world_model::metrics`,
//! the statements go through the [`PgExecutor`] seam, and the port opens no
//! connection of its own.
//!
//! Check 8 (the scheduler lease) is not read here. The route passes the automation
//! metrics in, because the SQLite lease lives in the automation repository that the
//! ops family owns.
//!
//! Wiring: [`WorldModelHealth::from_process_env`] attaches a [`LazyPgExecutor`]
//! when the World Model is on. With it off, statements go to
//! [`UnconfiguredPgExecutor`]; the report returns before any query then. Tests
//! attach their own executor with [`WorldModelHealth::new`].

use std::collections::HashMap;
use std::sync::{Arc, OnceLock};
use std::time::Duration;

use betaclaw_core::model_hub::http::HttpTransport;
use betaclaw_core::world_model::config::{resolve_world_model_config, WorldModelConfig};
use betaclaw_core::world_model::db::{
    BoxFuture, PgError, PgExecutor, PgQueryResult, PgSession, PgStatement, UnconfiguredPgExecutor,
};
use betaclaw_core::world_model::driver::{PgPoolSettings, SqlxPgExecutor};
use betaclaw_core::world_model::embeddings::provider::configured_embedding_provider;
use betaclaw_core::world_model::graphiti::client::GraphitiRestClient;
use betaclaw_core::world_model::metrics::{
    collect_world_model_metrics, counted, evaluate_world_model_alerts, get_world_model_metrics,
    metrics_from_raw, world_model_health_status, GraphitiHealthCheck, WorldModelHealthStatus,
    DEFAULT_WM_ALERT_THRESHOLDS,
};
use serde_json::{json, Map, Value};

use super::now_iso;
use super::ports::{PortFuture, WorldModelPort};
use crate::model_hub_transport::ReqwestTransport;
use crate::scheduler_runtime::DEFAULT_AUTOMATION_LEASE_TTL_MS;

/// How long one health or metrics query waits for a connection. `pg` has no
/// connect timeout, so an unreachable host held the TypeScript route until the
/// OS gave up on the TCP connect.
const HEALTH_ACQUIRE_TIMEOUT: Duration = Duration::from_secs(5);

/// The PostgreSQL pool of the health and metrics port, built on first use.
///
/// The pool connects per query (`SqlxPgExecutor::connect_lazy`), so no request
/// waits behind another request's connect, and an unreachable database costs each
/// query at most [`HEALTH_ACQUIRE_TIMEOUT`]. It is built inside the first query
/// because the pool needs a Tokio runtime, which `from_process_env` may lack.
///
/// ponytail: a second pool next to `AppState::get_world_model_pg_executor`, so up
/// to twice `WORLD_MODEL_POOL_MAX` connections; share it once that one is lazy too.
pub struct LazyPgExecutor {
    settings: PgPoolSettings,
    pool: OnceLock<Result<SqlxPgExecutor, PgError>>,
}

impl LazyPgExecutor {
    pub fn new(config: &WorldModelConfig) -> Self {
        Self {
            settings: PgPoolSettings::from_config(config),
            pool: OnceLock::new(),
        }
    }

    fn executor(&self) -> Result<&SqlxPgExecutor, PgError> {
        self.pool
            .get_or_init(|| SqlxPgExecutor::connect_lazy(&self.settings, HEALTH_ACQUIRE_TIMEOUT))
            .as_ref()
            .map_err(Clone::clone)
    }
}

impl PgExecutor for LazyPgExecutor {
    fn connect<'a>(&'a self) -> BoxFuture<'a, Result<Arc<dyn PgSession>, PgError>> {
        Box::pin(async move { self.executor()?.connect().await })
    }

    fn query<'a>(
        &'a self,
        statement: PgStatement,
    ) -> BoxFuture<'a, Result<PgQueryResult, PgError>> {
        Box::pin(async move { self.executor()?.query(statement).await })
    }
}

/// Check 2 of the route.
const SQL_VERSION: &str = "SELECT version()";

/// Check 3 of the route.
const SQL_MIGRATIONS: &str =
    "SELECT id FROM _world_model_migrations ORDER BY applied_at DESC LIMIT 1";

/// Check 5 of the route: the outbox with its age in seconds.
const SQL_OUTBOX_AGE: &str = "SELECT
COUNT(*) FILTER (WHERE status = 'pending') AS pending,
COUNT(*) FILTER (WHERE status = 'failed') AS failed,
EXTRACT(EPOCH FROM (NOW() - MIN(created_at)))::text AS oldest_age_seconds
FROM world_model_outbox_events
WHERE status IN ('pending', 'failed')";

/// Check 6 of the route: the canonical targets that have no embedding row.
const SQL_EMBEDDING_COVERAGE: &str = "SELECT
COUNT(*) AS total,
COUNT(*) FILTER (WHERE NOT EXISTS (
SELECT 1 FROM world_model_embeddings e
WHERE e.target_type = targets.target_type AND e.target_id = targets.target_id
)) AS without_embedding
FROM (
SELECT 'observation'::text AS target_type, id::text AS target_id
FROM world_model_observations
UNION ALL
SELECT 'assertion'::text, id::text FROM world_model_assertions
WHERE status = 'active' AND known_to IS NULL
UNION ALL
SELECT 'event'::text, id::text FROM world_model_events
UNION ALL
SELECT 'task'::text, id::text FROM world_model_tasks
UNION ALL
SELECT 'entity'::text, id::text FROM world_model_entities
UNION ALL
SELECT 'memory'::text, id::text FROM world_model_memory_items
WHERE deleted_at IS NULL
) AS targets";

/// World-Model port: the health body and the control-plane projection.
pub struct WorldModelHealth {
    executor: Arc<dyn PgExecutor>,
    config: WorldModelConfig,
    graphiti: Arc<dyn GraphitiHealthCheck>,
    embedding_provider_configured: bool,
    /// `AUTOMATION_LEASE_TTL_MS`, read once at startup (route.ts check 8).
    lease_ttl_ms: i64,
}

impl WorldModelHealth {
    pub fn new(
        executor: Arc<dyn PgExecutor>,
        config: WorldModelConfig,
        graphiti: Arc<dyn GraphitiHealthCheck>,
        embedding_provider_configured: bool,
    ) -> Self {
        Self {
            executor,
            config,
            graphiti,
            embedding_provider_configured,
            lease_ttl_ms: DEFAULT_AUTOMATION_LEASE_TTL_MS,
        }
    }

    /// The wiring of `assemble`: the configuration and the embedding provider from
    /// `process.env`, the Graphiti client, and a lazy PostgreSQL pool when configured.
    pub fn from_process_env() -> Self {
        let env: HashMap<String, String> = std::env::vars().collect();
        let config = resolve_world_model_config(&env);
        let transport: Arc<dyn HttpTransport> = Arc::new(ReqwestTransport::new());
        let embedding_provider_configured =
            configured_embedding_provider(&env, Arc::clone(&transport), None).is_some();
        let graphiti = Arc::new(GraphitiRestClient::from_env(transport));
        let executor: Arc<dyn PgExecutor> =
            if (config.enabled || config.e2e_enabled) && !config.database_url.is_empty() {
                Arc::new(LazyPgExecutor::new(&config))
            } else {
                Arc::new(UnconfiguredPgExecutor)
            };
        let lease_ttl_ms = std::env::var("AUTOMATION_LEASE_TTL_MS")
            .ok()
            .and_then(|value| value.trim().parse::<i64>().ok())
            .filter(|value| *value > 0)
            .unwrap_or(DEFAULT_AUTOMATION_LEASE_TTL_MS);
        Self {
            lease_ttl_ms,
            ..Self::new(executor, config, graphiti, embedding_provider_configured)
        }
    }

    /// `GET /api/health/world-model` without the status code (`route.ts`, checks 1
    /// to 7 and 9).
    async fn report(&self, scheduler: Result<Value, String>) -> Value {
        let config = &self.config;
        let mode = config.mode.as_str();
        if !config.enabled && !config.e2e_enabled {
            return json!({
                "status": "unavailable",
                "mode": mode,
                "reason": "World Model is not enabled",
                "checks": {},
            });
        }

        let executor = &*self.executor;
        let mut checks = Map::new();
        let mut overall: &'static str = "healthy";

        // Check 2: PostgreSQL connectivity.
        match executor.query(PgStatement::new(SQL_VERSION)).await {
            Ok(result) => {
                let detail = result
                    .first()
                    .and_then(|row| row.get("version"))
                    .and_then(Value::as_str)
                    .map(|version| version.split(',').next().unwrap_or_default().to_string())
                    .unwrap_or_else(|| "connected".to_string());
                checks.insert("postgresql".into(), check("ok", detail));
            }
            Err(error) => {
                overall = "unhealthy";
                checks.insert(
                    "postgresql".into(),
                    check("unavailable", error.into_message()),
                );
            }
        }

        // Check 3: migration version.
        match executor.query(PgStatement::new(SQL_MIGRATIONS)).await {
            Ok(result) => {
                let applied = !result.rows.is_empty();
                if !applied {
                    degrade(&mut overall);
                }
                let detail = result
                    .first()
                    .and_then(|row| row.get("id"))
                    .and_then(Value::as_str)
                    .unwrap_or("no migrations found");
                checks.insert("migrations".into(), check(level(applied), detail));
            }
            Err(error) => {
                overall = "unhealthy";
                checks.insert(
                    "migrations".into(),
                    check("unavailable", error.into_message()),
                );
            }
        }

        // Check 4: operational metrics. The collection cannot fail: a failing
        // aggregate is zero, as in `collectWorldModelMetrics`.
        let raw = collect_world_model_metrics(executor, None).await;
        let metrics = metrics_from_raw(&raw, mode);
        let metrics_healthy =
            world_model_health_status(&metrics) == WorldModelHealthStatus::Healthy;
        if !metrics_healthy {
            degrade(&mut overall);
        }
        checks.insert(
            "metrics".into(),
            check(
                level(metrics_healthy),
                format!(
                    "pending={}, failed={}, pending_projection={}, failed_projection={}, due_loops={}, lag={}ms",
                    raw.outbox_pending,
                    raw.outbox_failed,
                    raw.pending_projections,
                    raw.failed_projections,
                    raw.due_open_loops,
                    raw.projection_lag_ms,
                ),
            ),
        );

        // Check 5b: the failed projection queue, visible independently of the outbox.
        let projections_failing = raw.failed_projections > 0.0;
        if projections_failing {
            degrade(&mut overall);
        }
        let projections_detail = if projections_failing {
            format!(
                "pending={}, failed={}",
                raw.pending_projections, raw.failed_projections
            )
        } else {
            format!("pending={}, failed=0", raw.pending_projections)
        };
        checks.insert(
            "projections".into(),
            check(level(!projections_failing), projections_detail),
        );

        // Check 5: outbox, detailed.
        let outbox = match executor.query(PgStatement::new(SQL_OUTBOX_AGE)).await {
            Ok(result) => {
                let row = result.first();
                let pending = counted(row, "pending");
                let failed = counted(row, "failed");
                let oldest_age = counted(row, "oldest_age_seconds");
                if failed > 10.0 || oldest_age > 3600.0 {
                    degrade(&mut overall);
                    check(
                        "degraded",
                        format!("pending={pending}, failed={failed}, oldest_age={oldest_age}s"),
                    )
                } else {
                    check("ok", format!("pending={pending}, failed={failed}"))
                }
            }
            Err(_) => {
                degrade(&mut overall);
                check("degraded", "outbox check failed")
            }
        };
        checks.insert("outbox".into(), outbox);

        // Check 6: embedding coverage and the configured provider.
        let embeddings = match executor
            .query(PgStatement::new(SQL_EMBEDDING_COVERAGE))
            .await
        {
            Ok(result) => {
                let row = result.first();
                let total = counted(row, "total");
                let without = counted(row, "without_embedding");
                let mostly_missing = total > 0.0 && without / total > 0.5;
                let healthy = !mostly_missing && self.embedding_provider_configured;
                if !healthy {
                    degrade(&mut overall);
                }
                let provider = if self.embedding_provider_configured {
                    "configured"
                } else {
                    "missing"
                };
                check(
                    level(healthy),
                    format!(
                        "{}/{} canonical targets embedded; provider={provider}",
                        total - without,
                        total
                    ),
                )
            }
            Err(_) => {
                degrade(&mut overall);
                check("degraded", "embedding check failed")
            }
        };
        checks.insert("embeddings".into(), embeddings);

        // Check 7: Graphiti, when the shadow or the backend flag is on.
        let graphiti = if config.graphiti_shadow_enabled || config.graphiti_backend_enabled {
            let probe = self.graphiti.probe().await;
            if !probe.reachable {
                degrade(&mut overall);
            }
            let detail = if probe.reachable {
                format!("reachable, latency={}ms", probe.latency_ms)
            } else {
                probe.error.unwrap_or_else(|| "unreachable".to_string())
            };
            check(level(probe.reachable), detail)
        } else {
            check("ok", "shadow disabled")
        };
        checks.insert("graphiti".into(), graphiti);

        // Check 8: automation scheduler lease/heartbeat (route.ts check 8). A lease
        // older than twice its TTL is degraded; a failed read is unavailable.
        let scheduler = match scheduler {
            Ok(metrics) => {
                let age = metrics["leaseAgeSeconds"].as_i64();
                let healthy = age.is_some_and(|seconds| seconds * 1000 <= self.lease_ttl_ms * 2);
                let level = if healthy { "ok" } else { "degraded" };
                if !healthy && overall == "healthy" {
                    overall = "degraded";
                }
                let age_text = age.map_or("missing".to_string(), |seconds| seconds.to_string());
                check(
                    level,
                    format!(
                        "lease_age={age_text}s, active_rules={}, dead_letters={}",
                        metrics["activeRules"], metrics["deadLetterRuns"]
                    ),
                )
            }
            Err(message) => {
                if overall == "healthy" {
                    overall = "degraded";
                }
                check("unavailable", message)
            }
        };
        checks.insert("scheduler".into(), scheduler);

        // Check 9: mode.
        checks.insert("mode".into(), check("ok", mode));

        let alerts: Vec<Value> =
            evaluate_world_model_alerts(&metrics, &DEFAULT_WM_ALERT_THRESHOLDS)
                .into_iter()
                .map(|alert| {
                    json!({
                        "rule": alert.rule,
                        "value": alert.value,
                        "threshold": alert.threshold,
                    })
                })
                .collect();

        json!({
            "status": overall,
            "mode": mode,
            "timestamp": now_iso(),
            "checks": checks,
            "alerts": alerts,
        })
    }

    /// The fields of `getWorldModelMetrics()` that the control-plane route copies
    /// (`route.ts`, `worldModelMetrics`). `graphitiReachable` is present only when
    /// the shadow probe ran, as the TypeScript object omits an unset property.
    async fn metrics_projection(&self) -> Value {
        let metrics =
            get_world_model_metrics(&*self.executor, &self.config, None, &*self.graphiti).await;
        let mut body = json!({
            "mode": metrics.mode,
            "status": world_model_health_status(&metrics).as_str(),
            "pendingObservations": metrics.pending_observations,
            "outboxDeadLetters": metrics.outbox_dead_letters,
            "outboxAgeMs": metrics.outbox_age_ms,
            "dueOpenLoops": metrics.due_open_loops,
            "projectionLagMs": metrics.projection_lag_ms,
            "embeddingsTotal": metrics.embeddings_total,
        });
        if let (Some(reachable), Some(fields)) = (metrics.graphiti_reachable, body.as_object_mut())
        {
            fields.insert("graphitiReachable".to_string(), Value::Bool(reachable));
        }
        body
    }
}

impl WorldModelPort for WorldModelHealth {
    fn health(&self, scheduler: Result<Value, String>) -> PortFuture<'_, Value> {
        Box::pin(async move { Ok(self.report(scheduler).await) })
    }

    fn metrics(&self) -> PortFuture<'_, Value> {
        Box::pin(async move { Ok(self.metrics_projection().await) })
    }
}

/// One entry of the `checks` object: `{ status, detail }`.
fn check(status: &str, detail: impl Into<String>) -> Value {
    json!({ "status": status, "detail": detail.into() })
}

/// `'ok'` or `'degraded'`, the status of a check that has no `unavailable` case.
fn level(healthy: bool) -> &'static str {
    if healthy {
        "ok"
    } else {
        "degraded"
    }
}

/// `if (overall === 'healthy') overall = 'degraded'` of the route.
fn degrade(overall: &mut &'static str) {
    if *overall == "healthy" {
        *overall = "degraded";
    }
}

#[cfg(test)]
mod tests {
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::Arc;

    use axum::http::{Method, StatusCode};
    use betaclaw_core::world_model::db::{
        BoxFuture, PgError, PgExecutor, PgQueryResult, PgRow, PgSession, PgStatement,
        UnconfiguredPgExecutor,
    };
    use betaclaw_core::world_model::graphiti::client::GraphitiHealthStatus;
    use betaclaw_core::world_model::metrics::GraphitiHealthCheck;
    use betaclaw_core::world_model::mode::WorldModelMode;
    use serde_json::json;

    use super::*;
    use crate::families::ops_wire::test_support::{scratch, send, services_with_env, state_in};

    /// Answers each statement with the first fixture whose needle it contains.
    struct Fixtures(Vec<(&'static str, Result<PgQueryResult, PgError>)>);

    impl PgExecutor for Fixtures {
        fn connect<'a>(&'a self) -> BoxFuture<'a, Result<Arc<dyn PgSession>, PgError>> {
            Box::pin(async { Err(PgError::new("the port never opens a session")) })
        }

        fn query<'a>(
            &'a self,
            statement: PgStatement,
        ) -> BoxFuture<'a, Result<PgQueryResult, PgError>> {
            let answer = self
                .0
                .iter()
                .find(|(needle, _)| statement.sql.contains(needle))
                .map(|(_, answer)| answer.clone())
                .unwrap_or_else(|| Err(PgError::new(format!("no fixture for {}", statement.sql))));
            Box::pin(async move { answer })
        }
    }

    fn rows(value: serde_json::Value) -> Result<PgQueryResult, PgError> {
        let row: PgRow = value.as_object().cloned().expect("a JSON object");
        Ok(PgQueryResult::from_rows(vec![row]))
    }

    /// A healthy installation: every statement of the report and the projection has
    /// an answer, and no figure crosses a threshold.
    fn healthy() -> Vec<(&'static str, Result<PgQueryResult, PgError>)> {
        vec![
            (
                "SELECT version()",
                rows(
                    json!({ "version": "PostgreSQL 16.2 on x86_64-pc-linux-gnu, compiled by gcc" }),
                ),
            ),
            (
                "_world_model_migrations",
                rows(json!({ "id": "016_canonical_memory" })),
            ),
            ("received_at < now()", rows(json!({ "count": "3" }))),
            (
                "world_model_projection_pending",
                rows(json!({ "pending": "1", "failed": "0" })),
            ),
            (
                "world_model_delivery_receipts",
                rows(json!({ "count": "7" })),
            ),
            (
                "world_model_outbox_events",
                rows(json!({
                    "pending": "2",
                    "failed": "0",
                    "oldest_age_ms": "1500",
                    "oldest_age_seconds": "1.5",
                })),
            ),
            ("world_model_open_loops", rows(json!({ "count": "0" }))),
            ("MAX(received_at)", rows(json!({ "max_lag_ms": "250" }))),
            (
                "without_text",
                rows(json!({ "total": "10", "without_text": "0" })),
            ),
            (
                "without_embedding",
                rows(json!({ "total": "10", "without_embedding": "0" })),
            ),
        ]
    }

    /// A probe double that counts its calls.
    struct Probe {
        status: GraphitiHealthStatus,
        calls: AtomicUsize,
    }

    impl Probe {
        fn calls(&self) -> usize {
            self.calls.load(Ordering::SeqCst)
        }
    }

    impl GraphitiHealthCheck for Probe {
        fn probe<'a>(&'a self) -> BoxFuture<'a, GraphitiHealthStatus> {
            self.calls.fetch_add(1, Ordering::SeqCst);
            let status = self.status.clone();
            Box::pin(async move { status })
        }
    }

    fn probe_with(reachable: bool, error: Option<&str>) -> Arc<Probe> {
        Arc::new(Probe {
            status: GraphitiHealthStatus {
                reachable,
                latency_ms: 4,
                error: error.map(str::to_string),
            },
            calls: AtomicUsize::new(0),
        })
    }

    /// `getAutomationService().getMetrics()` with a lease renewed 2 s ago.
    fn lease_ok() -> Result<Value, String> {
        Ok(json!({
            "activeRules": 3,
            "queuedRuns": 0,
            "runningRuns": 0,
            "deadLetterRuns": 0,
            "leaseAgeSeconds": 2,
        }))
    }

    fn config(enabled: bool, shadow: bool) -> WorldModelConfig {
        WorldModelConfig {
            enabled,
            mode: WorldModelMode::Canonical,
            graphiti_shadow_enabled: shadow,
            ..WorldModelConfig::default()
        }
    }

    fn port(
        answers: Vec<(&'static str, Result<PgQueryResult, PgError>)>,
        config: WorldModelConfig,
        graphiti: Arc<dyn GraphitiHealthCheck>,
    ) -> WorldModelHealth {
        WorldModelHealth::new(Arc::new(Fixtures(answers)), config, graphiti, true)
    }

    #[tokio::test]
    async fn a_healthy_installation_reports_every_check_ok() {
        let wm = port(healthy(), config(true, false), probe_with(true, None));
        let body = wm.health(lease_ok()).await.expect("the port answers");
        assert_eq!(body["status"], "healthy");
        assert_eq!(body["mode"], "canonical");
        assert_eq!(
            body["checks"]["postgresql"],
            json!({ "status": "ok", "detail": "PostgreSQL 16.2 on x86_64-pc-linux-gnu" })
        );
        assert_eq!(
            body["checks"]["migrations"]["detail"],
            "016_canonical_memory"
        );
        assert_eq!(
            body["checks"]["metrics"],
            json!({
                "status": "ok",
                "detail": "pending=2, failed=0, pending_projection=1, failed_projection=0, due_loops=0, lag=250ms",
            })
        );
        assert_eq!(
            body["checks"]["projections"],
            json!({ "status": "ok", "detail": "pending=1, failed=0" })
        );
        assert_eq!(
            body["checks"]["outbox"],
            json!({ "status": "ok", "detail": "pending=2, failed=0" })
        );
        assert_eq!(
            body["checks"]["embeddings"],
            json!({ "status": "ok", "detail": "10/10 canonical targets embedded; provider=configured" })
        );
        assert_eq!(
            body["checks"]["graphiti"],
            json!({ "status": "ok", "detail": "shadow disabled" })
        );
        assert_eq!(
            body["checks"]["mode"],
            json!({ "status": "ok", "detail": "canonical" })
        );
        assert_eq!(body["alerts"], json!([]));
    }

    #[tokio::test]
    async fn a_stale_scheduler_lease_degrades_the_report() {
        // Twice the default TTL (30 s) is the limit; 61 s is past it.
        let stale = Ok(json!({
            "activeRules": 3,
            "deadLetterRuns": 1,
            "leaseAgeSeconds": 61,
        }));
        let wm = port(healthy(), config(true, false), probe_with(true, None));
        let body = wm.health(stale).await.expect("the port answers");
        assert_eq!(body["status"], "degraded");
        assert_eq!(
            body["checks"]["scheduler"],
            json!({
                "status": "degraded",
                "detail": "lease_age=61s, active_rules=3, dead_letters=1"
            })
        );
    }

    #[tokio::test]
    async fn a_failed_scheduler_read_is_unavailable_and_degrades() {
        let wm = port(healthy(), config(true, false), probe_with(true, None));
        let body = wm
            .health(Err("automation database is locked".to_string()))
            .await
            .expect("the port answers");
        assert_eq!(body["status"], "degraded");
        assert_eq!(
            body["checks"]["scheduler"],
            json!({ "status": "unavailable", "detail": "automation database is locked" })
        );
    }

    #[tokio::test]
    async fn failed_projections_degrade_the_report_and_raise_an_alert() {
        let mut answers = healthy();
        answers.retain(|(needle, _)| *needle != "world_model_projection_pending");
        answers.push((
            "world_model_projection_pending",
            rows(json!({ "pending": "4", "failed": "2" })),
        ));
        let wm = port(answers, config(true, false), probe_with(true, None));
        let body = wm.health(lease_ok()).await.expect("the port answers");
        assert_eq!(body["status"], "degraded");
        assert_eq!(
            body["checks"]["projections"],
            json!({ "status": "degraded", "detail": "pending=4, failed=2" })
        );
        assert_eq!(body["alerts"].as_array().map(Vec::len), Some(1));
        assert_eq!(body["alerts"][0]["rule"], "failed_projections");
        assert_eq!(body["alerts"][0]["value"], 2.0);
        assert_eq!(body["alerts"][0]["threshold"], 0.0);
    }

    #[tokio::test]
    async fn without_a_pool_the_report_is_unhealthy_and_the_figures_are_zero() {
        let wm = WorldModelHealth::new(
            Arc::new(UnconfiguredPgExecutor),
            config(true, false),
            probe_with(true, None),
            true,
        );
        let body = wm.health(lease_ok()).await.expect("the port answers");
        assert_eq!(body["status"], "unhealthy");
        assert_eq!(body["checks"]["postgresql"]["status"], "unavailable");
        assert_eq!(body["checks"]["migrations"]["status"], "unavailable");
        assert_eq!(
            body["checks"]["metrics"],
            json!({
                "status": "ok",
                "detail": "pending=0, failed=0, pending_projection=0, failed_projection=0, due_loops=0, lag=0ms",
            })
        );
        assert_eq!(
            body["checks"]["outbox"],
            json!({ "status": "degraded", "detail": "outbox check failed" })
        );
        assert_eq!(
            body["checks"]["embeddings"],
            json!({ "status": "degraded", "detail": "embedding check failed" })
        );
    }

    #[tokio::test]
    async fn a_disabled_world_model_is_unavailable_and_runs_no_check() {
        let wm = port(healthy(), config(false, false), probe_with(true, None));
        let body = wm.health(lease_ok()).await.expect("the port answers");
        assert_eq!(
            body,
            json!({
                "status": "unavailable",
                "mode": "canonical",
                "reason": "World Model is not enabled",
                "checks": {},
            })
        );
    }

    #[tokio::test]
    async fn a_failed_graphiti_probe_degrades_the_report_when_shadow_is_on() {
        let probe = probe_with(false, Some("connection refused"));
        let wm = port(healthy(), config(true, true), probe.clone());
        let body = wm.health(lease_ok()).await.expect("the port answers");
        assert_eq!(body["status"], "degraded");
        assert_eq!(
            body["checks"]["graphiti"],
            json!({ "status": "degraded", "detail": "connection refused" })
        );
        assert_eq!(probe.calls(), 1);
    }

    #[tokio::test]
    async fn the_control_plane_projection_carries_the_route_fields() {
        let wm = port(healthy(), config(true, false), probe_with(true, None));
        let body = wm.metrics().await.expect("the port answers");
        assert_eq!(
            body,
            json!({
                "mode": "canonical",
                "status": "healthy",
                "pendingObservations": 3.0,
                "outboxDeadLetters": 0.0,
                "outboxAgeMs": 1500.0,
                "dueOpenLoops": 0.0,
                "projectionLagMs": 250.0,
                "embeddingsTotal": 10.0,
            })
        );
    }

    #[tokio::test]
    async fn the_projection_reports_graphiti_only_when_the_shadow_probe_ran() {
        let probe = probe_with(false, Some("down"));
        let wm = port(healthy(), config(true, true), probe.clone());
        let body = wm.metrics().await.expect("the port answers");
        assert_eq!(body["graphitiReachable"], false);
        assert_eq!(probe.calls(), 1);
    }

    #[tokio::test]
    async fn the_route_answers_503_for_an_unhealthy_report() {
        let scratch = scratch();
        let state = state_in(&scratch);
        let mut services = services_with_env(&scratch, &[]);
        services.world_model = Arc::new(WorldModelHealth::new(
            Arc::new(UnconfiguredPgExecutor),
            config(true, false),
            probe_with(true, None),
            true,
        ));
        let services = Arc::new(services);
        let (status, body) = send(
            &state,
            &services,
            Method::GET,
            "/api/health/world-model",
            &[],
            None,
        )
        .await;
        assert_eq!(status, StatusCode::SERVICE_UNAVAILABLE);
        assert_eq!(body["status"], "unhealthy");
    }

    #[tokio::test]
    async fn the_route_answers_200_for_a_healthy_report() {
        let scratch = scratch();
        let state = state_in(&scratch);
        let mut services = services_with_env(&scratch, &[]);
        services.world_model =
            Arc::new(port(healthy(), config(true, false), probe_with(true, None)));
        // A healthy installation has a running scheduler, so its lease is fresh.
        let now = chrono::Utc::now().to_rfc3339();
        services
            .automation
            .lock()
            .await
            .acquire_lease("scheduler-test", 30_000, &now)
            .expect("lease");
        let services = Arc::new(services);
        let (status, body) = send(
            &state,
            &services,
            Method::GET,
            "/api/health/world-model",
            &[],
            None,
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(body["status"], "healthy");
        assert_eq!(body["checks"]["scheduler"]["status"], "ok");
    }

    #[tokio::test]
    async fn lazy_pg_executor_fails_concurrent_queries_within_one_timeout() {
        let mut cfg = config(true, false);
        // A non-routable address: the TCP connect hangs instead of being refused.
        cfg.database_url = "postgresql://u:p@10.255.255.1:5432/x".to_string();
        let lazy = LazyPgExecutor::new(&cfg);
        let started = std::time::Instant::now();
        let (a, b, c, d) = tokio::join!(
            lazy.query(PgStatement::new("SELECT 1")),
            lazy.query(PgStatement::new("SELECT 1")),
            lazy.query(PgStatement::new("SELECT 1")),
            lazy.query(PgStatement::new("SELECT 1")),
        );
        assert!(a.is_err() && b.is_err() && c.is_err() && d.is_err());
        // Serialised connects would take four timeouts.
        assert!(started.elapsed() < HEALTH_ACQUIRE_TIMEOUT * 2);
    }

    #[test]
    fn from_process_env_builds_without_panic() {
        let wm = WorldModelHealth::from_process_env();
        assert!(!wm.config.database_url.is_empty());
    }
}
