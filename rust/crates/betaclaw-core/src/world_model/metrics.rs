//! Port of `src/server/world-model/metrics.ts` (292 lines).
//!
//! | TypeScript | Rust |
//! | --- | --- |
//! | `metrics.ts:5-11` (`WorldModelMetricsInput`) | [`WorldModelMetricsInput`] |
//! | `metrics.ts:13-27` (`WorldModelMetrics`) | [`WorldModelMetrics`] |
//! | `metrics.ts:29-36` (`WorldModelAlertThresholds`) | [`WorldModelAlertThresholds`] |
//! | `metrics.ts:38-45` (`DEFAULT_WM_ALERT_THRESHOLDS`) | [`DEFAULT_WM_ALERT_THRESHOLDS`] |
//! | `metrics.ts:50-68` (`summarizeWorldModelMetrics`) | [`summarize_world_model_metrics`] |
//! | `metrics.ts:70-77` (`worldModelHealthStatus`) | [`world_model_health_status`] |
//! | `metrics.ts:79-91` (`RawWorldModelMetrics`) | [`RawWorldModelMetrics`] |
//! | `metrics.ts:97-219` (`collectWorldModelMetrics`) | [`collect_world_model_metrics`] |
//! | `metrics.ts:224-253` (`getWorldModelMetrics`) | [`get_world_model_metrics`] |
//! | `metrics.ts:259-309` (`evaluateWorldModelAlerts`) | [`evaluate_world_model_alerts`] |
//!
//! # Scope
//!
//! `collectWorldModelMetrics(db = getWorldModelDb())` reads seven aggregates and
//! **none** of them carries a tenant predicate: the numbers describe the whole
//! installation. The TypeScript resolves `getWorldModelDb()`, whose `query`
//! wraps a statement in RLS only when an ambient scope is active
//! (`db.ts:107-110`). The port keeps that dispatch as an explicit
//! `Option<&NormalizedScope>`: `None` is the unscoped `pool.query` of
//! `db.ts:109`, `Some` is [`scoped_query`] — the two shapes of the seam, not a
//! third one (`.tmp/s6s7-plan.md`, rule 6). The public callers of this module
//! (`worldModel.ts:76` re-exports the summary helpers) run without an ambient
//! scope, so `None` is the productive case.
//!
//! # Verified TypeScript quirks
//!
//! * The seven aggregates run concurrently (`Promise.all`, `:114-216`) and every
//!   one has its **own** `try`/`catch`, so a failing query leaves its fields at
//!   their initial `0` while the others still report (`:123-125`, `:212-214`).
//! * `pendingObservations` counts observations older than five minutes
//!   (`received_at < now() - interval '5 minutes'`, `:120`) — an *age* filter,
//!   not a status.
//! * `outboxAgeMs` and `projectionLagMs` go through `Math.round(Number(…))`
//!   (`:169`, `:197`); the `?? 0` makes a missing row `0`, so the port never
//!   reports a `NaN` from a missing aggregate row.
//! * `Math.max(0, value)` (`:55-60`) propagates a `NaN` — `Math.max` does not
//!   clamp it away and `NaN > threshold` is `false` — so [`non_negative`] keeps
//!   the `NaN` instead of using `f64::max`, which would return the `0`.
//! * `worldModelHealthStatus` compares against the **default** thresholds, not a
//!   caller's, and consults only four of the six fields (`:71-76`).
//! * The alert list has a fixed order and uses strict `>` comparisons, so the
//!   boundary value of a threshold emits no alert (`:265-306`).
//! * The Graphiti health probe runs only for `graphitiShadowEnabled`, and a
//!   failure sets `graphitiReachable: false` (`:243-250`); with the check off the
//!   property stays absent, which is `None` here.
//!
//! Numbers are JavaScript `number`s, so the metric fields are `f64` and the
//! rounding uses [`js_round`] (`floor(value + 0.5)`) rather than `f64::round`,
//! which rounds halves away from zero.

use crate::js::{js_number_str, js_round};
use crate::world_model::config::WorldModelConfig;
use crate::world_model::db::{
    scoped_query, BoxFuture, NormalizedScope, PgError, PgExecutor, PgQueryResult, PgRow,
    PgStatement,
};
use crate::world_model::graphiti::client::{GraphitiHealthStatus, GraphitiRestClient};

/// `WorldModelMetricsInput` from `metrics.ts:5-11`.
#[derive(Debug, Clone, Copy, Default, PartialEq)]
pub struct WorldModelMetricsInput {
    pub pending_observations: f64,
    pub outbox_age_ms: f64,
    pub outbox_dead_letters: f64,
    pub due_open_loops: f64,
    pub projection_lag_ms: f64,
}

/// `WorldModelMetrics` from `metrics.ts:13-27`.
#[derive(Debug, Clone, PartialEq)]
pub struct WorldModelMetrics {
    pub ingestion_lag_ms: f64,
    pub pending_observations: f64,
    pub projection_lag_ms: f64,
    pub outbox_age_ms: f64,
    pub outbox_dead_letters: f64,
    pub due_open_loops: f64,
    pub mode: String,
    /// Absent unless the shadow health probe ran (`:243-250`).
    pub graphiti_reachable: Option<bool>,
    pub embeddings_total: f64,
    pub embeddings_without_text: f64,
    pub pending_projections: f64,
    pub failed_projections: f64,
    pub delivery_receipts: f64,
}

/// `WorldModelAlertThresholds` from `metrics.ts:29-36`.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct WorldModelAlertThresholds {
    pub outbox_age_ms: f64,
    pub outbox_dead_letters: f64,
    pub pending_observations: f64,
    pub pending_projections: f64,
    pub failed_projections: f64,
    pub projection_lag_ms: f64,
}

/// `DEFAULT_WM_ALERT_THRESHOLDS` from `metrics.ts:38-45`.
pub const DEFAULT_WM_ALERT_THRESHOLDS: WorldModelAlertThresholds = WorldModelAlertThresholds {
    outbox_age_ms: 5.0 * 60_000.0,
    outbox_dead_letters: 10.0,
    pending_observations: 50.0,
    pending_projections: 50.0,
    failed_projections: 0.0,
    projection_lag_ms: 5.0 * 60_000.0,
};

/// `RawWorldModelMetrics` from `metrics.ts:79-91`.
#[derive(Debug, Clone, Copy, Default, PartialEq)]
pub struct RawWorldModelMetrics {
    pub pending_observations: f64,
    pub outbox_pending: f64,
    pub outbox_failed: f64,
    pub outbox_age_ms: f64,
    pub due_open_loops: f64,
    pub projection_lag_ms: f64,
    pub embeddings_total: f64,
    pub embeddings_without_text: f64,
    pub pending_projections: f64,
    pub failed_projections: f64,
    pub delivery_receipts: f64,
}

/// `'healthy' | 'degraded'` of `metrics.ts:70`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum WorldModelHealthStatus {
    Healthy,
    Degraded,
}

impl WorldModelHealthStatus {
    /// The union literal.
    pub fn as_str(self) -> &'static str {
        match self {
            WorldModelHealthStatus::Healthy => "healthy",
            WorldModelHealthStatus::Degraded => "degraded",
        }
    }
}

/// One alert of `evaluateWorldModelAlerts` — `metrics.ts:262`.
#[derive(Debug, Clone, PartialEq)]
pub struct WorldModelAlert {
    pub rule: String,
    pub value: f64,
    pub threshold: f64,
}

/// The Graphiti health probe — `checkGraphitiHealth()` of
/// `graphiti/client.ts:273-289`, which never throws: a failed probe is a
/// `reachable: false` result, so the `catch` of `metrics.ts:247-249` has no Rust
/// counterpart.
pub trait GraphitiHealthCheck: Send + Sync {
    fn probe<'a>(&'a self) -> BoxFuture<'a, GraphitiHealthStatus>;
}

impl GraphitiHealthCheck for GraphitiRestClient {
    fn probe<'a>(&'a self) -> BoxFuture<'a, GraphitiHealthStatus> {
        Box::pin(self.health())
    }
}

/// `Math.max(0, value)` — `NaN` stays `NaN`, unlike `f64::max(0.0, NaN)`.
fn non_negative(value: f64) -> f64 {
    if value.is_nan() {
        f64::NAN
    } else {
        value.max(0.0)
    }
}

/// `Number(row?.<column>) ?? 0` — `metrics.ts:122`, `:134-135`, `:167-168`,
/// `:182`, `:210-211`. Shared with the health route, which reads the same columns.
pub fn counted(row: Option<&PgRow>, column: &str) -> f64 {
    let Some(row) = row else {
        return 0.0;
    };
    match row.get(column) {
        None | Some(serde_json::Value::Null) => 0.0,
        Some(serde_json::Value::Number(number)) => number.as_f64().unwrap_or(f64::NAN),
        Some(serde_json::Value::String(text)) => js_number_str(text),
        Some(serde_json::Value::Bool(flag)) => {
            if *flag {
                1.0
            } else {
                0.0
            }
        }
        Some(_) => f64::NAN,
    }
}

/// `summarizeWorldModelMetrics(input, mode)` — `metrics.ts:50-68`.
///
/// The counting fields of a fresh report are `0`; `ingestionLagMs` mirrors
/// `projectionLagMs` (`:55`).
pub fn summarize_world_model_metrics(
    input: &WorldModelMetricsInput,
    mode: &str,
) -> WorldModelMetrics {
    WorldModelMetrics {
        ingestion_lag_ms: non_negative(input.projection_lag_ms),
        pending_observations: non_negative(input.pending_observations),
        projection_lag_ms: non_negative(input.projection_lag_ms),
        outbox_age_ms: non_negative(input.outbox_age_ms),
        outbox_dead_letters: non_negative(input.outbox_dead_letters),
        due_open_loops: non_negative(input.due_open_loops),
        mode: mode.to_string(),
        graphiti_reachable: None,
        embeddings_total: 0.0,
        embeddings_without_text: 0.0,
        pending_projections: 0.0,
        failed_projections: 0.0,
        delivery_receipts: 0.0,
    }
}

/// `worldModelHealthStatus(metrics)` — `metrics.ts:70-77`.
///
/// Compares against [`DEFAULT_WM_ALERT_THRESHOLDS`] and consults the dead
/// letters, the failed projections, the outbox age and the pending
/// observations only.
pub fn world_model_health_status(metrics: &WorldModelMetrics) -> WorldModelHealthStatus {
    let degraded = metrics.outbox_dead_letters > 0.0
        || metrics.failed_projections > 0.0
        || metrics.outbox_age_ms > DEFAULT_WM_ALERT_THRESHOLDS.outbox_age_ms
        || metrics.pending_observations > DEFAULT_WM_ALERT_THRESHOLDS.pending_observations;
    if degraded {
        WorldModelHealthStatus::Degraded
    } else {
        WorldModelHealthStatus::Healthy
    }
}

/// `evaluateWorldModelAlerts(metrics, thresholds)` — `metrics.ts:259-309`.
///
/// The order of the rules is fixed and every comparison is strict, so a value
/// *at* its threshold emits nothing. The source's default parameter is the
/// public [`DEFAULT_WM_ALERT_THRESHOLDS`] constant.
pub fn evaluate_world_model_alerts(
    metrics: &WorldModelMetrics,
    thresholds: &WorldModelAlertThresholds,
) -> Vec<WorldModelAlert> {
    let mut alerts = Vec::new();
    let mut push = |rule: &str, value: f64, threshold: f64| {
        if value > threshold {
            alerts.push(WorldModelAlert {
                rule: rule.to_string(),
                value,
                threshold,
            });
        }
    };
    push(
        "outbox_age",
        metrics.outbox_age_ms,
        thresholds.outbox_age_ms,
    );
    push(
        "outbox_dead_letters",
        metrics.outbox_dead_letters,
        thresholds.outbox_dead_letters,
    );
    push(
        "pending_observations",
        metrics.pending_observations,
        thresholds.pending_observations,
    );
    push(
        "pending_projections",
        metrics.pending_projections,
        thresholds.pending_projections,
    );
    push(
        "failed_projections",
        metrics.failed_projections,
        thresholds.failed_projections,
    );
    push(
        "projection_lag",
        metrics.projection_lag_ms,
        thresholds.projection_lag_ms,
    );
    alerts
}

// ─── The seven aggregates ───────────────────────────────────────────────────
//
// Each statement is the template literal of the named source lines, token for
// token. The source indents the continuation lines inside the template literals
// (`metrics.ts:118-120`, …); that indentation is not part of the statement.

/// `metrics.ts:118-120`.
const SQL_PENDING_OBSERVATIONS: &str = "SELECT COUNT(*) AS count
FROM world_model_observations
WHERE received_at < now() - interval '5 minutes'";

/// `metrics.ts:130-132`.
const SQL_PENDING_PROJECTIONS: &str =
    "SELECT COUNT(*) FILTER (WHERE status = 'pending') AS pending,
COUNT(*) FILTER (WHERE status = 'failed') AS failed
FROM world_model_projection_pending";

/// `metrics.ts:143`.
const SQL_DELIVERY_RECEIPTS: &str = "SELECT COUNT(*) AS count FROM world_model_delivery_receipts";

/// `metrics.ts:157-165`.
const SQL_OUTBOX: &str = "SELECT
COUNT(*) FILTER (WHERE status = 'pending') AS pending,
COUNT(*) FILTER (WHERE status = 'failed') AS failed,
COALESCE(
EXTRACT(EPOCH FROM (now() - MIN(created_at))) * 1000,
0
)::text AS oldest_age_ms
FROM world_model_outbox_events
WHERE status IN ('pending', 'failed')";

/// `metrics.ts:177-180`.
const SQL_DUE_OPEN_LOOPS: &str = "SELECT COUNT(*) AS count
FROM world_model_open_loops
WHERE status IN ('open', 'scheduled')
AND (trigger_at IS NULL OR trigger_at <= now())";

/// `metrics.ts:190-195`.
const SQL_PROJECTION_LAG: &str = "SELECT
COALESCE(
EXTRACT(EPOCH FROM (now() - MAX(received_at))) * 1000,
0
)::text AS max_lag_ms
FROM world_model_observations";

/// `metrics.ts:205-208`.
const SQL_EMBEDDINGS: &str = "SELECT
COUNT(*) AS total,
COUNT(*) FILTER (WHERE target_content IS NULL OR target_content = '') AS without_text
FROM world_model_embeddings";

/// One aggregate: `scope` selects the scoped transaction, a failure is logged
/// and the caller keeps its initial `0` (`metrics.ts:123-125`, …).
async fn aggregate(
    executor: &dyn PgExecutor,
    scope: Option<&NormalizedScope>,
    sql: &'static str,
    label: &str,
) -> Option<PgQueryResult> {
    let statement = PgStatement::new(sql);
    let outcome = match scope {
        Some(scope) => scoped_query::<PgError>(executor, scope, statement).await,
        None => executor.query(statement).await,
    };
    match outcome {
        Ok(result) => Some(result),
        Err(error) => {
            tracing::error!(
                target: "world_model::metrics",
                "[world-model:metrics] {label} query failed: {}",
                crate::safe_error_message(&error)
            );
            None
        }
    }
}

/// `Math.round(Number(row?.column ?? 0))` — `metrics.ts:169`, `:197`.
fn rounded(row: Option<&PgRow>, column: &str) -> f64 {
    js_round(counted(row, column))
}

/// `collectWorldModelMetrics(db)` — `metrics.ts:97-219`.
///
/// The seven aggregates start concurrently and each keeps its own failure
/// isolation, so a partial result is a valid result. `scope: None` is the
/// unscoped `pool.query` of `db.ts:109`, `Some` is one scoped transaction per
/// statement (see the module header).
pub async fn collect_world_model_metrics(
    executor: &dyn PgExecutor,
    scope: Option<&NormalizedScope>,
) -> RawWorldModelMetrics {
    let mut result = RawWorldModelMetrics::default();

    let (observations, projections, receipts, outbox, loops, lag, embeddings) = tokio::join!(
        aggregate(
            executor,
            scope,
            SQL_PENDING_OBSERVATIONS,
            "pending observations"
        ),
        aggregate(
            executor,
            scope,
            SQL_PENDING_PROJECTIONS,
            "pending projection"
        ),
        aggregate(executor, scope, SQL_DELIVERY_RECEIPTS, "delivery receipt"),
        aggregate(executor, scope, SQL_OUTBOX, "outbox"),
        aggregate(executor, scope, SQL_DUE_OPEN_LOOPS, "open loops"),
        aggregate(executor, scope, SQL_PROJECTION_LAG, "projection lag"),
        aggregate(executor, scope, SQL_EMBEDDINGS, "embeddings"),
    );

    if let Some(row) = observations.as_ref().and_then(|result| result.rows.first()) {
        result.pending_observations = counted(Some(row), "count");
    }
    if let Some(row) = projections.as_ref().and_then(|result| result.rows.first()) {
        result.pending_projections = counted(Some(row), "pending");
        result.failed_projections = counted(Some(row), "failed");
    }
    if let Some(row) = receipts.as_ref().and_then(|result| result.rows.first()) {
        result.delivery_receipts = counted(Some(row), "count");
    }
    if let Some(row) = outbox.as_ref().and_then(|result| result.rows.first()) {
        result.outbox_pending = counted(Some(row), "pending");
        result.outbox_failed = counted(Some(row), "failed");
        result.outbox_age_ms = rounded(Some(row), "oldest_age_ms");
    }
    if let Some(row) = loops.as_ref().and_then(|result| result.rows.first()) {
        result.due_open_loops = counted(Some(row), "count");
    }
    if let Some(row) = lag.as_ref().and_then(|result| result.rows.first()) {
        result.projection_lag_ms = rounded(Some(row), "max_lag_ms");
    }
    if let Some(row) = embeddings.as_ref().and_then(|result| result.rows.first()) {
        result.embeddings_total = counted(Some(row), "total");
        result.embeddings_without_text = counted(Some(row), "without_text");
    }

    result
}

/// `getWorldModelMetrics()` — `metrics.ts:224-253`.
///
/// The aggregate is read through [`collect_world_model_metrics`]; the Graphiti
/// probe is added only for `graphitiShadowEnabled` and a failing probe reports
/// `false` (`:243-250`).
pub async fn get_world_model_metrics(
    executor: &dyn PgExecutor,
    config: &WorldModelConfig,
    scope: Option<&NormalizedScope>,
    graphiti: &dyn GraphitiHealthCheck,
) -> WorldModelMetrics {
    let raw = collect_world_model_metrics(executor, scope).await;

    let mut metrics = metrics_from_raw(&raw, config.mode.as_str());
    if config.graphiti_shadow_enabled {
        metrics.graphiti_reachable = Some(graphiti.probe().await.reachable);
    }

    metrics
}

/// The field mapping of `getWorldModelMetrics()` (`metrics.ts:231-244`) and of the
/// health route (`route.ts`, the `metrics` object). `graphitiReachable` stays
/// absent: only the shadow probe sets it.
pub fn metrics_from_raw(raw: &RawWorldModelMetrics, mode: &str) -> WorldModelMetrics {
    WorldModelMetrics {
        ingestion_lag_ms: raw.projection_lag_ms,
        pending_observations: raw.pending_observations,
        projection_lag_ms: raw.projection_lag_ms,
        outbox_age_ms: raw.outbox_age_ms,
        outbox_dead_letters: raw.outbox_failed,
        due_open_loops: raw.due_open_loops,
        mode: mode.to_string(),
        graphiti_reachable: None,
        embeddings_total: raw.embeddings_total,
        embeddings_without_text: raw.embeddings_without_text,
        pending_projections: raw.pending_projections,
        failed_projections: raw.failed_projections,
        delivery_receipts: raw.delivery_receipts,
    }
}

#[cfg(test)]
mod tests {
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::Arc;

    use serde_json::{json, Value};

    use super::*;
    use crate::world_model::db::{PgSession, UnconfiguredPgExecutor};
    use crate::world_model::mode::WorldModelMode;

    /// Answers each statement with the first fixture whose needle it contains.
    struct Fixtures(Vec<(&'static str, Result<PgQueryResult, PgError>)>);

    impl PgExecutor for Fixtures {
        fn connect<'a>(&'a self) -> BoxFuture<'a, Result<Arc<dyn PgSession>, PgError>> {
            Box::pin(async { Err(PgError::new("the metrics never open a session")) })
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

    fn row(value: Value) -> PgRow {
        value.as_object().cloned().expect("a JSON object")
    }

    fn rows(value: Value) -> Result<PgQueryResult, PgError> {
        Ok(PgQueryResult::from_rows(vec![row(value)]))
    }

    fn aggregates() -> Vec<(&'static str, Result<PgQueryResult, PgError>)> {
        vec![
            ("received_at < now()", rows(json!({ "count": "3" }))),
            (
                "world_model_projection_pending",
                rows(json!({ "pending": "4", "failed": "2" })),
            ),
            ("world_model_delivery_receipts", rows(json!({ "count": 7 }))),
            (
                "world_model_outbox_events",
                rows(json!({
                    "pending": 5,
                    "failed": 6,
                    "oldest_age_ms": "1234.6",
                    "oldest_age_seconds": "1.2346",
                })),
            ),
            ("world_model_open_loops", rows(json!({ "count": "8" }))),
            ("MAX(received_at)", rows(json!({ "max_lag_ms": "250.4" }))),
            (
                "without_text",
                rows(json!({ "total": "9", "without_text": "1" })),
            ),
        ]
    }

    /// A probe double that counts its calls.
    struct Probe {
        status: GraphitiHealthStatus,
        calls: AtomicUsize,
    }

    impl Probe {
        fn new(reachable: bool, error: Option<&str>) -> Self {
            Self {
                status: GraphitiHealthStatus {
                    reachable,
                    latency_ms: 4,
                    error: error.map(str::to_string),
                },
                calls: AtomicUsize::new(0),
            }
        }

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

    fn config(shadow: bool) -> WorldModelConfig {
        WorldModelConfig {
            mode: WorldModelMode::Shadow,
            graphiti_shadow_enabled: shadow,
            ..WorldModelConfig::default()
        }
    }

    fn metrics_with(edit: impl FnOnce(&mut WorldModelMetrics)) -> WorldModelMetrics {
        let mut metrics = metrics_from_raw(&RawWorldModelMetrics::default(), "canonical");
        edit(&mut metrics);
        metrics
    }

    #[test]
    fn summary_clamps_negatives_to_zero_and_keeps_nan() {
        let input = WorldModelMetricsInput {
            pending_observations: -4.0,
            outbox_age_ms: f64::NAN,
            outbox_dead_letters: 2.0,
            due_open_loops: -1.0,
            projection_lag_ms: 30.0,
        };
        let metrics = summarize_world_model_metrics(&input, "canonical");
        assert_eq!(metrics.pending_observations, 0.0);
        assert!(metrics.outbox_age_ms.is_nan());
        assert_eq!(metrics.outbox_dead_letters, 2.0);
        assert_eq!(metrics.due_open_loops, 0.0);
        assert_eq!(metrics.ingestion_lag_ms, 30.0);
        assert_eq!(metrics.mode, "canonical");
        assert_eq!(metrics.graphiti_reachable, None);
    }

    #[test]
    fn counted_reads_numbers_strings_booleans_and_nulls_like_js_number() {
        let fields =
            row(json!({ "n": 4, "s": "12.5", "t": true, "f": false, "z": null, "x": "x" }));
        assert_eq!(counted(Some(&fields), "n"), 4.0);
        assert_eq!(counted(Some(&fields), "s"), 12.5);
        assert_eq!(counted(Some(&fields), "t"), 1.0);
        assert_eq!(counted(Some(&fields), "f"), 0.0);
        assert_eq!(counted(Some(&fields), "z"), 0.0);
        assert_eq!(counted(Some(&fields), "missing"), 0.0);
        assert!(counted(Some(&fields), "x").is_nan());
        assert_eq!(counted(None, "n"), 0.0);
    }

    #[test]
    fn health_is_degraded_only_strictly_past_a_default_threshold() {
        use super::WorldModelHealthStatus::{Degraded, Healthy};
        assert_eq!(world_model_health_status(&metrics_with(|_| {})), Healthy);
        assert_eq!(
            world_model_health_status(&metrics_with(|m| m.outbox_dead_letters = 1.0)),
            Degraded
        );
        assert_eq!(
            world_model_health_status(&metrics_with(|m| m.failed_projections = 1.0)),
            Degraded
        );
        assert_eq!(
            world_model_health_status(&metrics_with(|m| m.outbox_age_ms = 300_001.0)),
            Degraded
        );
        assert_eq!(
            world_model_health_status(&metrics_with(|m| m.pending_observations = 51.0)),
            Degraded
        );
        // A value at its threshold is still healthy.
        assert_eq!(
            world_model_health_status(&metrics_with(|m| m.outbox_age_ms = 300_000.0)),
            Healthy
        );
        assert_eq!(
            world_model_health_status(&metrics_with(|m| m.pending_observations = 50.0)),
            Healthy
        );
        // The projection lag is not one of the four rules that decide the status.
        assert_eq!(
            world_model_health_status(&metrics_with(|m| m.projection_lag_ms = 1e9)),
            Healthy
        );
    }

    #[test]
    fn alerts_fire_strictly_above_each_threshold_in_the_fixed_order() {
        let thresholds = DEFAULT_WM_ALERT_THRESHOLDS;
        assert!(evaluate_world_model_alerts(&metrics_with(|_| {}), &thresholds).is_empty());

        let at_limit = metrics_with(|m| {
            m.outbox_age_ms = 300_000.0;
            m.outbox_dead_letters = 10.0;
            m.pending_observations = 50.0;
            m.pending_projections = 50.0;
            m.projection_lag_ms = 300_000.0;
        });
        assert!(evaluate_world_model_alerts(&at_limit, &thresholds).is_empty());

        let loud = metrics_with(|m| {
            m.projection_lag_ms = 300_001.0;
            m.failed_projections = 1.0;
            m.pending_projections = 51.0;
            m.pending_observations = 51.0;
            m.outbox_dead_letters = 11.0;
            m.outbox_age_ms = 300_001.0;
        });
        let alerts = evaluate_world_model_alerts(&loud, &thresholds);
        let rules: Vec<&str> = alerts.iter().map(|alert| alert.rule.as_str()).collect();
        assert_eq!(
            rules,
            [
                "outbox_age",
                "outbox_dead_letters",
                "pending_observations",
                "pending_projections",
                "failed_projections",
                "projection_lag",
            ]
        );
        assert_eq!(alerts[0].value, 300_001.0);
        assert_eq!(alerts[0].threshold, 300_000.0);
    }

    #[tokio::test]
    async fn collect_fills_each_field_from_its_aggregate() {
        let raw = collect_world_model_metrics(&Fixtures(aggregates()), None).await;
        assert_eq!(raw.pending_observations, 3.0);
        assert_eq!(raw.pending_projections, 4.0);
        assert_eq!(raw.failed_projections, 2.0);
        assert_eq!(raw.delivery_receipts, 7.0);
        assert_eq!(raw.outbox_pending, 5.0);
        assert_eq!(raw.outbox_failed, 6.0);
        // `Math.round` of the reported milliseconds.
        assert_eq!(raw.outbox_age_ms, 1235.0);
        assert_eq!(raw.due_open_loops, 8.0);
        assert_eq!(raw.projection_lag_ms, 250.0);
        assert_eq!(raw.embeddings_total, 9.0);
        assert_eq!(raw.embeddings_without_text, 1.0);
    }

    #[tokio::test]
    async fn a_failing_aggregate_stays_at_zero_and_the_others_still_report() {
        let mut answers = aggregates();
        answers.retain(|(needle, _)| *needle != "world_model_outbox_events");
        answers.push((
            "world_model_outbox_events",
            Err(PgError::new("relation does not exist")),
        ));
        let raw = collect_world_model_metrics(&Fixtures(answers), None).await;
        assert_eq!(raw.outbox_pending, 0.0);
        assert_eq!(raw.outbox_failed, 0.0);
        assert_eq!(raw.outbox_age_ms, 0.0);
        assert_eq!(raw.pending_observations, 3.0);
        assert_eq!(raw.projection_lag_ms, 250.0);
    }

    #[tokio::test]
    async fn without_a_pool_every_figure_is_zero() {
        let raw = collect_world_model_metrics(&UnconfiguredPgExecutor, None).await;
        assert_eq!(raw, RawWorldModelMetrics::default());
    }

    #[tokio::test]
    async fn the_shadow_probe_runs_only_when_graphiti_shadow_is_on() {
        let off = Probe::new(true, None);
        let metrics =
            get_world_model_metrics(&UnconfiguredPgExecutor, &config(false), None, &off).await;
        assert_eq!(metrics.graphiti_reachable, None);
        assert_eq!(metrics.mode, "shadow");
        assert_eq!(metrics.outbox_dead_letters, 0.0);
        assert_eq!(off.calls(), 0);

        let up = Probe::new(true, None);
        let metrics =
            get_world_model_metrics(&UnconfiguredPgExecutor, &config(true), None, &up).await;
        assert_eq!(metrics.graphiti_reachable, Some(true));

        let down = Probe::new(false, Some("connection refused"));
        let metrics =
            get_world_model_metrics(&UnconfiguredPgExecutor, &config(true), None, &down).await;
        assert_eq!(metrics.graphiti_reachable, Some(false));
        assert_eq!(down.calls(), 1);
    }
}
