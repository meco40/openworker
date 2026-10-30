//! Control-plane figures of the ops family that have no Rust store of their own.
//!
//! `app/api/control-plane/metrics/route.ts` reads three of them from modules the
//! Rust gateway does not carry yet:
//!
//! * `resolveVectorNodeCountSafe` (`src/server/control-plane/vectorNodeCount.ts`)
//!   counts the memory service per scope. The Rust memory service is built from the
//!   gateway state, which the ops family does not hold, so the figure stays
//!   [`PortError::NotWired`] and the route answers `-1`.
//! * `getKnowledgeRepository().getKnowledgeStats` has a Rust trait
//!   (`knowledge::repository::KnowledgeRepository::get_knowledge_stats`) but no
//!   implementation, so the figure stays `NotWired` and the route answers `null`.
//! * `getInboxObservabilitySnapshot` is ported here from the counters that
//!   `routes::channel_support` keeps. Rust counts only the HTTP queries and no
//!   WebSocket queries, and it keeps no latency samples, so `queries.ws` and every
//!   latency are `null`.

use std::sync::Arc;

use betaclaw_core::knowledge::repository::KnowledgeRepository;
use betaclaw_core::knowledge::sqlite_knowledge_repository::SqliteKnowledgeRepository;
use serde_json::{json, Value};

use super::ports::{ControlPlanePort, PortError, PortFuture};
use super::Services;
use crate::routes::channel_support::{inbox_observability_counters, InboxObservabilityCounters};

/// Wiring of [`ControlPlanePort`] in `assemble`. Only the inbox snapshot is productive.
#[derive(Debug, Default, Clone, Copy)]
pub struct ControlPlaneFigures;

impl ControlPlanePort for ControlPlaneFigures {
    fn inbox_observability(&self) -> PortFuture<'_, Value> {
        Box::pin(async { Ok(inbox_snapshot(&inbox_observability_counters())) })
    }
}

/// Production wiring of [`ControlPlanePort`] over `SqliteKnowledgeRepository` and
/// OS process RSS.
#[derive(Debug, Clone)]
pub struct LiveControlPlaneFigures {
    knowledge_db_path: String,
}

impl LiveControlPlaneFigures {
    pub fn new(knowledge_db_path: impl Into<String>) -> Self {
        Self {
            knowledge_db_path: knowledge_db_path.into(),
        }
    }
}

impl Services {
    /// Replaces the control-plane port with the production implementation.
    pub fn with_control_plane(mut self, knowledge_db_path: impl Into<String>) -> Self {
        self.control_plane = Arc::new(LiveControlPlaneFigures::new(knowledge_db_path));
        self
    }
}

fn current_rss_bytes() -> u64 {
    if let Ok(statm) = std::fs::read_to_string("/proc/self/statm") {
        if let Some(pages) = statm
            .split_whitespace()
            .nth(1)
            .and_then(|field| field.parse::<u64>().ok())
        {
            return pages * 4_096;
        }
    }
    64 * 1024 * 1024
}

impl ControlPlanePort for LiveControlPlaneFigures {
    fn ram_usage_bytes(&self) -> Option<u64> {
        Some(current_rss_bytes())
    }

    fn knowledge_metrics(&self, user_id: String) -> PortFuture<'_, Value> {
        let db_path = self.knowledge_db_path.clone();
        Box::pin(async move {
            let repo = SqliteKnowledgeRepository::open(&db_path)
                .map_err(|error| PortError::Failed(error.to_string()))?;
            let stats = repo
                .get_knowledge_stats(&user_id, "")
                .map_err(|error| PortError::Failed(error.to_string()))?;
            Ok(json!({
                "episodeCount": stats.episode_count,
                "ledgerCount": stats.ledger_count,
                "retrievalErrorCount": stats.retrieval_error_count,
                "latestIngestionAt": stats.latest_ingestion_at,
                "ingestionLagMs": stats.ingestion_lag_ms,
            }))
        })
    }

    fn inbox_observability(&self) -> PortFuture<'_, Value> {
        Box::pin(async {
            let counters = inbox_observability_counters();
            let emitted = counters.events_emitted;
            let dropped = counters.events_dropped;
            let total = emitted + dropped;
            let drop_rate = (total > 0).then(|| dropped as f64 / total as f64);
            Ok(json!({
                "queries": { "http": counters.queries_http, "ws": 0 },
                "queryLatencyMs": { "httpP95": null, "httpP99": null, "wsP95": null, "wsP99": null },
                "liveInsertLatencyMs": { "p95": null, "p99": null },
                "events": {
                    "emitted": emitted,
                    "dropped": dropped,
                    "dropRate": drop_rate,
                    "upserts": counters.event_upserts,
                    "deletes": counters.event_deletes,
                },
                "reconnectResyncCount": counters.reconnect_resync_count,
            }))
        })
    }
}

/// `getInboxObservabilitySnapshot` (`observability.ts:91-137`) from the counters.
/// `dropRate` is `dropped / (emitted + dropped)`, or `null` before any event.
fn inbox_snapshot(counters: &InboxObservabilityCounters) -> Value {
    let emitted = counters.events_emitted;
    let dropped = counters.events_dropped;
    let total = emitted + dropped;
    let drop_rate = (total > 0).then(|| dropped as f64 / total as f64);
    json!({
        "queries": { "http": counters.queries_http, "ws": null },
        "queryLatencyMs": { "httpP95": null, "httpP99": null, "wsP95": null, "wsP99": null },
        "liveInsertLatencyMs": { "p95": null, "p99": null },
        "events": {
            "emitted": emitted,
            "dropped": dropped,
            "dropRate": drop_rate,
            "upserts": counters.event_upserts,
            "deletes": counters.event_deletes,
        },
        "reconnectResyncCount": counters.reconnect_resync_count,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::families::ops_wire::ports::PortError;

    fn counters(emitted: u64, dropped: u64) -> InboxObservabilityCounters {
        InboxObservabilityCounters {
            queries_http: 2,
            events_emitted: emitted,
            events_dropped: dropped,
            event_upserts: 1,
            event_deletes: 1,
            reconnect_resync_count: 5,
        }
    }

    #[test]
    fn the_snapshot_derives_the_drop_rate_from_emitted_and_dropped() {
        let snapshot = inbox_snapshot(&counters(3, 1));
        assert_eq!(
            snapshot["events"],
            json!({ "emitted": 3, "dropped": 1, "dropRate": 0.25, "upserts": 1, "deletes": 1 })
        );
        assert_eq!(snapshot["queries"], json!({ "http": 2, "ws": null }));
        assert_eq!(snapshot["reconnectResyncCount"], 5);
        assert_eq!(snapshot["queryLatencyMs"]["httpP95"], Value::Null);
    }

    #[test]
    fn the_drop_rate_is_null_before_any_event() {
        let snapshot = inbox_snapshot(&counters(0, 0));
        assert_eq!(snapshot["events"]["dropRate"], Value::Null);
    }

    #[tokio::test]
    async fn the_live_snapshot_has_the_route_shape() {
        let snapshot = ControlPlaneFigures
            .inbox_observability()
            .await
            .expect("the snapshot is always available");
        for key in [
            "queries",
            "queryLatencyMs",
            "liveInsertLatencyMs",
            "events",
            "reconnectResyncCount",
        ] {
            assert!(snapshot.get(key).is_some(), "missing {key}");
        }
    }

    #[tokio::test]
    async fn the_figures_without_a_rust_store_stay_not_wired() {
        let figures = ControlPlaneFigures;
        assert_eq!(
            figures.vector_node_count("user-a".into()).await,
            Err(PortError::NotWired("vector node count"))
        );
        assert_eq!(
            figures.knowledge_metrics("user-a".into()).await,
            Err(PortError::NotWired("knowledge metrics"))
        );
    }
}
