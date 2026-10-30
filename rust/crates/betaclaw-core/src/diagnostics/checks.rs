//! Port of `src/commands/health/checks/coreChecks.ts`, `securityChecks.ts` and
//! `integrationChecks.ts`.
//!
//! A failed collaborator is a `critical` (or `warning`) check, as in TypeScript. A
//! capability the Rust gateway does not have yet ([`PortFailure::NotWired`]) is
//! reported as `skipped`, so the health report does not claim a fault that is only
//! missing wiring.

use serde_json::json;

use super::helpers::bridge_health_check;
use super::model::{
    fail_check, ok_check, skipped_check, HealthCategory, HealthCheck, HealthCheckStatus,
};
use super::ports::{HealthSources, PortFailure};
use crate::config::LEGACY_LOCAL_USER_ID;

/// `KNOWLEDGE_LAG_WARNING_MS`: fifteen minutes.
const KNOWLEDGE_LAG_WARNING_MS: f64 = 900_000.0;

/// Builds the check for a failed collaborator.
fn failed_check(
    id: &str,
    category: HealthCategory,
    start_ms: i64,
    now_ms: i64,
    status: HealthCheckStatus,
    prefix: &str,
    failure: PortFailure,
) -> HealthCheck {
    match failure {
        PortFailure::NotWired(what) => skipped_check(
            id,
            category,
            format!("Not wired in the Rust gateway yet: {what}."),
            Some(json!({ "notWired": what })),
        ),
        PortFailure::Failed(message) => fail_check(
            id,
            category,
            start_ms,
            now_ms,
            status,
            format!("{prefix}{message}"),
            None,
        ),
    }
}

/// `runLoggingRepositoryCheck`.
pub fn logging_repository_check<S: HealthSources>(src: &S) -> HealthCheck {
    const ID: &str = "core.logging_repository";
    let start = src.now_ms();
    let result = src.log_count();
    let now = src.now_ms();
    match result {
        Ok(total) => ok_check(
            ID,
            HealthCategory::Core,
            start,
            now,
            "Logging repository reachable.",
            Some(json!({ "total": total })),
        ),
        Err(failure) => failed_check(
            ID,
            HealthCategory::Core,
            start,
            now,
            HealthCheckStatus::Critical,
            "Logging repository unavailable: ",
            failure,
        ),
    }
}

/// `runStatsRepositoryCheck`.
pub fn stats_repository_check<S: HealthSources>(src: &S) -> HealthCheck {
    const ID: &str = "core.stats_repository";
    let start = src.now_ms();
    let result = src.usage_entry_count();
    let now = src.now_ms();
    match result {
        Ok(entries) => ok_check(
            ID,
            HealthCategory::Core,
            start,
            now,
            "Stats repository reachable.",
            Some(json!({ "usageEntries": entries })),
        ),
        Err(failure) => failed_check(
            ID,
            HealthCategory::Core,
            start,
            now,
            HealthCheckStatus::Critical,
            "Stats repository unavailable: ",
            failure,
        ),
    }
}

/// `runMemoryRepositoryCheck`. The count is read first, then the provider, as in
/// TypeScript; the first failure decides the message.
pub fn memory_repository_check<S: HealthSources>(src: &S) -> HealthCheck {
    const ID: &str = "core.memory_repository";
    let start = src.now_ms();
    let result = src
        .node_count()
        .and_then(|count| src.provider_kind().map(|provider| (count, provider)));
    let now = src.now_ms();
    match result {
        Ok((count, provider)) => ok_check(
            ID,
            HealthCategory::Core,
            start,
            now,
            "Memory repository reachable.",
            Some(json!({ "nodeCount": count, "provider": provider })),
        ),
        Err(failure) => failed_check(
            ID,
            HealthCategory::Core,
            start,
            now,
            HealthCheckStatus::Critical,
            "Memory repository unavailable: ",
            failure,
        ),
    }
}

/// `runGatewayRegistryCheck`.
pub fn gateway_registry_check<S: HealthSources>(src: &S) -> HealthCheck {
    const ID: &str = "core.gateway_registry";
    let start = src.now_ms();
    let result = src.connection_count();
    let now = src.now_ms();
    match result {
        Ok(sessions) => ok_check(
            ID,
            HealthCategory::Core,
            start,
            now,
            "Gateway registry readable.",
            Some(json!({ "activeWsSessions": sessions })),
        ),
        Err(failure) => failed_check(
            ID,
            HealthCategory::Core,
            start,
            now,
            HealthCheckStatus::Critical,
            "Gateway registry check failed: ",
            failure,
        ),
    }
}

/// `runKnowledgeLayerCheck`. The knowledge layer is off unless its flag is set.
pub fn knowledge_layer_check<S: HealthSources>(src: &S) -> HealthCheck {
    const ID: &str = "core.knowledge_layer";
    if !src.knowledge_layer_enabled() {
        return skipped_check(ID, HealthCategory::Core, "Knowledge layer disabled.", None);
    }
    let start = src.now_ms();
    let result = src.knowledge_stats(LEGACY_LOCAL_USER_ID, "");
    let now = src.now_ms();
    match result {
        Ok(stats) => {
            // `NaN` (no ingestion yet) serialises as `null`, as `JSON.stringify` does.
            let details = json!({
                "episodeCount": stats.episode_count,
                "ledgerCount": stats.ledger_count,
                "retrievalErrorCount": stats.retrieval_error_count,
                "latestIngestionAt": stats.latest_ingestion_at,
                "ingestionLagMs": stats.ingestion_lag_ms,
            });
            if stats.ingestion_lag_ms > KNOWLEDGE_LAG_WARNING_MS {
                let seconds = (stats.ingestion_lag_ms / 1000.0).round() as i64;
                fail_check(
                    ID,
                    HealthCategory::Core,
                    start,
                    now,
                    HealthCheckStatus::Warning,
                    format!("Knowledge ingestion lag exceeds threshold ({seconds}s)."),
                    Some(details),
                )
            } else {
                ok_check(
                    ID,
                    HealthCategory::Core,
                    start,
                    now,
                    "Knowledge layer healthy.",
                    Some(details),
                )
            }
        }
        Err(failure) => failed_check(
            ID,
            HealthCategory::Core,
            start,
            now,
            HealthCheckStatus::Critical,
            "Knowledge layer unavailable: ",
            failure,
        ),
    }
}

/// `runSecuritySnapshotCheck`. Critical findings outrank warnings.
pub fn security_snapshot_check<S: HealthSources>(src: &S) -> HealthCheck {
    const ID: &str = "security.snapshot";
    let start = src.now_ms();
    let result = src.security_snapshot();
    let now = src.now_ms();
    match result {
        Ok(snapshot) => {
            let (status, message) = if snapshot.summary.critical > 0 {
                (
                    HealthCheckStatus::Critical,
                    "Security snapshot contains critical findings.",
                )
            } else if snapshot.summary.warning > 0 {
                (
                    HealthCheckStatus::Warning,
                    "Security snapshot contains warnings.",
                )
            } else {
                (HealthCheckStatus::Ok, "Security snapshot healthy.")
            };
            HealthCheck {
                id: ID.to_string(),
                category: HealthCategory::Security,
                status,
                message: message.to_string(),
                latency_ms: now - start,
                details: Some(json!({
                    "summary": snapshot.summary,
                    "channels": snapshot.channels,
                })),
            }
        }
        Err(failure) => failed_check(
            ID,
            HealthCategory::Security,
            start,
            now,
            HealthCheckStatus::Critical,
            "Security snapshot failed: ",
            failure,
        ),
    }
}

/// `runBridgeIntegrationChecks`: the WhatsApp and iMessage bridges, in that order.
pub async fn integration_checks<S: HealthSources>(src: &S, timeout_ms: u64) -> Vec<HealthCheck> {
    vec![
        bridge_health_check(
            src,
            "integration.whatsapp_bridge",
            "whatsapp",
            "WHATSAPP_BRIDGE_URL",
            timeout_ms,
        )
        .await,
        bridge_health_check(
            src,
            "integration.imessage_bridge",
            "imessage",
            "IMESSAGE_BRIDGE_URL",
            timeout_ms,
        )
        .await,
    ]
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::diagnostics::test_support::{healthy_security, Fake};
    use crate::knowledge::repository::KnowledgeStats;
    use crate::security::status::SecurityStatusSnapshot;

    fn failure(message: &str) -> PortFailure {
        PortFailure::Failed(message.to_string())
    }

    #[test]
    fn logging_repository_reports_the_total() {
        let ok = logging_repository_check(&Fake::default());
        assert_eq!(ok.status, HealthCheckStatus::Ok);
        assert_eq!(ok.details, Some(json!({ "total": 10 })));

        let bad = logging_repository_check(&Fake {
            log_total: Err(failure("disk I/O")),
            ..Fake::default()
        });
        assert_eq!(bad.status, HealthCheckStatus::Critical);
        assert_eq!(bad.message, "Logging repository unavailable: disk I/O");
    }

    #[test]
    fn stats_repository_reports_the_entry_count() {
        let ok = stats_repository_check(&Fake::default());
        assert_eq!(ok.status, HealthCheckStatus::Ok);
        assert_eq!(ok.details, Some(json!({ "usageEntries": 3 })));

        let bad = stats_repository_check(&Fake {
            usage_total: Err(failure("no table")),
            ..Fake::default()
        });
        assert_eq!(bad.status, HealthCheckStatus::Critical);
        assert_eq!(bad.message, "Stats repository unavailable: no table");
    }

    #[test]
    fn memory_repository_reports_count_and_provider() {
        let ok = memory_repository_check(&Fake::default());
        assert_eq!(ok.status, HealthCheckStatus::Ok);
        assert_eq!(
            ok.details,
            Some(json!({ "nodeCount": 2, "provider": "sqlite" }))
        );

        let bad = memory_repository_check(&Fake {
            node_total: Err(failure("client closed")),
            ..Fake::default()
        });
        assert_eq!(bad.status, HealthCheckStatus::Critical);
        assert_eq!(bad.message, "Memory repository unavailable: client closed");

        let unwired = memory_repository_check(&Fake {
            provider_name: Err(PortFailure::NotWired("memory provider")),
            ..Fake::default()
        });
        assert_eq!(unwired.status, HealthCheckStatus::Skipped);
    }

    #[test]
    fn gateway_registry_reports_active_sessions() {
        let ok = gateway_registry_check(&Fake::default());
        assert_eq!(ok.status, HealthCheckStatus::Ok);
        assert_eq!(ok.details, Some(json!({ "activeWsSessions": 1 })));

        let bad = gateway_registry_check(&Fake {
            connection_total: Err(failure("poisoned")),
            ..Fake::default()
        });
        assert_eq!(bad.status, HealthCheckStatus::Critical);
        assert_eq!(bad.message, "Gateway registry check failed: poisoned");
    }

    fn stats(lag_ms: f64) -> KnowledgeStats {
        KnowledgeStats {
            episode_count: 4,
            ledger_count: 5,
            retrieval_error_count: 1,
            latest_ingestion_at: Some("2026-01-01T00:00:00.000Z".into()),
            ingestion_lag_ms: lag_ms,
        }
    }

    #[test]
    fn knowledge_layer_is_skipped_when_disabled() {
        let check = knowledge_layer_check(&Fake::default());
        assert_eq!(check.status, HealthCheckStatus::Skipped);
        assert_eq!(check.message, "Knowledge layer disabled.");
    }

    #[test]
    fn knowledge_layer_ok_warning_and_failure() {
        let ok = knowledge_layer_check(&Fake {
            knowledge_on: true,
            knowledge_stats: Ok(stats(1_000.0)),
            ..Fake::default()
        });
        assert_eq!(ok.status, HealthCheckStatus::Ok);
        assert_eq!(ok.message, "Knowledge layer healthy.");

        let lagging = knowledge_layer_check(&Fake {
            knowledge_on: true,
            knowledge_stats: Ok(stats(1_200_000.0)),
            ..Fake::default()
        });
        assert_eq!(lagging.status, HealthCheckStatus::Warning);
        assert_eq!(
            lagging.message,
            "Knowledge ingestion lag exceeds threshold (1200s)."
        );

        let failed = knowledge_layer_check(&Fake {
            knowledge_on: true,
            knowledge_stats: Err(failure("locked")),
            ..Fake::default()
        });
        assert_eq!(failed.status, HealthCheckStatus::Critical);
        assert_eq!(failed.message, "Knowledge layer unavailable: locked");
    }

    #[test]
    fn knowledge_layer_without_a_rust_repository_is_skipped() {
        let check = knowledge_layer_check(&Fake {
            knowledge_on: true,
            knowledge_stats: Err(PortFailure::NotWired("knowledge layer stats")),
            ..Fake::default()
        });
        assert_eq!(check.status, HealthCheckStatus::Skipped);
        assert_eq!(
            check.details,
            Some(json!({ "notWired": "knowledge layer stats" }))
        );
    }

    fn security(warning: usize, critical: usize) -> SecurityStatusSnapshot {
        let mut snapshot = healthy_security();
        snapshot.summary.warning = warning;
        snapshot.summary.critical = critical;
        snapshot
    }

    #[test]
    fn security_snapshot_follows_the_summary() {
        let ok = security_snapshot_check(&Fake::default());
        assert_eq!(ok.status, HealthCheckStatus::Ok);
        assert_eq!(ok.category, HealthCategory::Security);

        let warn = security_snapshot_check(&Fake {
            security: Ok(security(2, 0)),
            ..Fake::default()
        });
        assert_eq!(warn.status, HealthCheckStatus::Warning);
        assert_eq!(warn.message, "Security snapshot contains warnings.");

        let critical = security_snapshot_check(&Fake {
            security: Ok(security(2, 1)),
            ..Fake::default()
        });
        assert_eq!(critical.status, HealthCheckStatus::Critical);
        assert_eq!(
            critical.message,
            "Security snapshot contains critical findings."
        );
        assert_eq!(
            critical
                .details
                .as_ref()
                .map(|details| details["summary"]["critical"].clone()),
            Some(json!(1))
        );

        let failed = security_snapshot_check(&Fake {
            security: Err(failure("rules missing")),
            ..Fake::default()
        });
        assert_eq!(failed.status, HealthCheckStatus::Critical);
        assert_eq!(failed.message, "Security snapshot failed: rules missing");
    }

    #[tokio::test]
    async fn integration_checks_cover_both_bridges_in_order() {
        let checks = integration_checks(&Fake::default(), 3_000).await;
        let ids: Vec<&str> = checks.iter().map(|check| check.id.as_str()).collect();
        assert_eq!(
            ids,
            ["integration.whatsapp_bridge", "integration.imessage_bridge"]
        );
        assert!(checks
            .iter()
            .all(|check| check.status == HealthCheckStatus::Skipped));
    }
}
