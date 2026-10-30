//! Port of `src/commands/healthChecks.ts` (the check order) and
//! `src/commands/healthCommand.ts` (the summary and the report status).

use super::checks::{
    gateway_registry_check, integration_checks, knowledge_layer_check, logging_repository_check,
    memory_repository_check, security_snapshot_check, stats_repository_check,
};
use super::diagnostics_checks::{alert_routing_check, error_budget_check, memory_pressure_check};
use super::model::{
    generated_at, report_status, summarize, HealthCheck, HealthOptions, HealthReport,
    DEFAULT_TIMEOUT_MS,
};
use super::ports::HealthSources;

/// `runHealthChecks`. The order is the order of the report.
pub async fn run_health_checks<S: HealthSources>(
    src: &S,
    options: &HealthOptions,
) -> Vec<HealthCheck> {
    let timeout_ms = options.timeout_ms.unwrap_or(DEFAULT_TIMEOUT_MS);
    let detailed = options.memory_diagnostics_enabled;

    let mut checks = vec![
        logging_repository_check(src),
        stats_repository_check(src),
        memory_repository_check(src),
        security_snapshot_check(src),
        gateway_registry_check(src),
        error_budget_check(src),
        memory_pressure_check(src, detailed).await,
        alert_routing_check(src),
    ];
    checks.extend(integration_checks(src, timeout_ms).await);
    checks.push(knowledge_layer_check(src));
    checks
}

/// `runHealthCommand`.
pub async fn run_health_command<S: HealthSources>(
    src: &S,
    options: &HealthOptions,
) -> HealthReport {
    let checks = run_health_checks(src, options).await;
    let summary = summarize(&checks);
    HealthReport {
        status: report_status(&summary),
        checks,
        summary,
        generated_at: generated_at(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::diagnostics::model::{HealthCheckStatus, HealthReportStatus};
    use crate::diagnostics::ports::PortFailure;
    use crate::diagnostics::test_support::Fake;

    #[tokio::test]
    async fn healthy_sources_give_an_ok_report_in_the_documented_order() {
        let report = run_health_command(&Fake::default(), &HealthOptions::default()).await;
        assert_eq!(report.status, HealthReportStatus::Ok);
        let ids: Vec<&str> = report
            .checks
            .iter()
            .map(|check| check.id.as_str())
            .collect();
        assert_eq!(
            ids,
            [
                "core.logging_repository",
                "core.stats_repository",
                "core.memory_repository",
                "security.snapshot",
                "core.gateway_registry",
                "diagnostics.error_budget",
                "diagnostics.memory_pressure",
                "diagnostics.alert_routing",
                "integration.whatsapp_bridge",
                "integration.imessage_bridge",
                "core.knowledge_layer",
            ]
        );
        assert_eq!(report.summary.critical, 0);
        assert_eq!(report.summary.warning, 0);
        assert!(report.generated_at.ends_with('Z'));
    }

    #[tokio::test]
    async fn a_warning_degrades_and_a_critical_check_is_critical() {
        let with_critical_repo = run_health_command(
            &Fake {
                usage_total: Err(PortFailure::Failed("slow".into())),
                memory_usage: Ok(crate::diagnostics::ports::ProcessMemory {
                    rss_bytes: 1,
                    system_total_bytes: 1_000,
                    system_free_bytes: 150,
                }),
                ..Fake::default()
            },
            &HealthOptions::default(),
        )
        .await;
        assert_eq!(with_critical_repo.status, HealthReportStatus::Critical);

        let warning_only = run_health_command(
            &Fake {
                memory_usage: Ok(crate::diagnostics::ports::ProcessMemory {
                    rss_bytes: 1,
                    system_total_bytes: 1_000,
                    system_free_bytes: 150,
                }),
                ..Fake::default()
            },
            &HealthOptions::default(),
        )
        .await;
        assert_eq!(warning_only.status, HealthReportStatus::Degraded);
        assert_eq!(warning_only.summary.warning, 1);
        let memory = warning_only
            .checks
            .iter()
            .find(|check| check.id == "diagnostics.memory_pressure")
            .expect("memory check");
        assert_eq!(memory.status, HealthCheckStatus::Warning);
    }

    #[tokio::test]
    async fn a_failing_repository_is_critical() {
        let report = run_health_command(
            &Fake {
                log_total: Err(PortFailure::Failed("gone".into())),
                ..Fake::default()
            },
            &HealthOptions::default(),
        )
        .await;
        assert_eq!(report.status, HealthReportStatus::Critical);
        assert_eq!(report.checks[0].status, HealthCheckStatus::Critical);
    }
}
