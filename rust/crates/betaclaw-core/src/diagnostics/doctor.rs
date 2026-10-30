//! Port of `src/commands/doctorRules.ts` (the findings) and
//! `src/commands/doctorCommand.ts` (the report).

use serde::Serialize;

use super::health::run_health_command;
use super::helpers::entry_time_ms;
use super::model::{
    generated_at, HealthCheck, HealthCheckStatus, HealthOptions, HealthReportStatus,
};
use super::ports::{HealthSources, PortResult};

/// Error logs read for the trend, `listLogs({ level: 'error', limit: 2000 })`.
const ERROR_LOG_LIMIT: usize = 2_000;
/// The window of the trend: fifteen minutes.
const WINDOW_MS: i64 = 15 * 60 * 1000;
const ERROR_SPIKE_WARNING_THRESHOLD: usize = 5;
const ERROR_SPIKE_CRITICAL_THRESHOLD: usize = 10;

/// `DoctorFindingSeverity` of `doctorRules.ts`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum DoctorSeverity {
    Warning,
    Critical,
}

/// `DoctorFinding` of `doctorRules.ts`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DoctorFinding {
    pub id: &'static str,
    pub severity: DoctorSeverity,
    pub title: &'static str,
    pub detail: String,
    pub recommendation: &'static str,
}

/// The error counts of the two 15-minute windows.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ErrorCounts {
    pub last_15m: usize,
    pub previous_15m: usize,
}

/// `buildDoctorFindings`. The rules run in the order of the TypeScript file, which
/// is the order of the findings.
pub fn build_doctor_findings(checks: &[HealthCheck], errors: ErrorCounts) -> Vec<DoctorFinding> {
    let mut findings = Vec::new();

    let security = checks.iter().find(|check| check.id == "security.snapshot");
    match security.map(|check| (check.status, check.message.clone())) {
        Some((HealthCheckStatus::Critical, detail)) => findings.push(DoctorFinding {
            id: "security_critical",
            severity: DoctorSeverity::Critical,
            title: "Critical Security Findings",
            detail,
            recommendation: "Review `/api/security/status`, disable high-risk command permissions, and fix missing secrets.",
        }),
        Some((HealthCheckStatus::Warning, detail)) => findings.push(DoctorFinding {
            id: "security_warning",
            severity: DoctorSeverity::Warning,
            title: "Security Warnings Present",
            detail,
            recommendation: "Open `/api/security/status` and resolve the reported warnings before promoting to production.",
        }),
        _ => {}
    }

    let bridge_issue = checks.iter().find(|check| {
        check.id.starts_with("integration.")
            && check.id.ends_with("_bridge")
            && matches!(
                check.status,
                HealthCheckStatus::Warning | HealthCheckStatus::Critical
            )
    });
    if let Some(issue) = bridge_issue {
        findings.push(DoctorFinding {
            id: "bridge_unreachable",
            severity: if issue.status == HealthCheckStatus::Critical {
                DoctorSeverity::Critical
            } else {
                DoctorSeverity::Warning
            },
            title: "Bridge Health Degraded",
            detail: issue.message.clone(),
            recommendation: "Verify bridge availability and credentials, then rerun health checks.",
        });
    }

    if errors.last_15m >= ERROR_SPIKE_WARNING_THRESHOLD {
        findings.push(DoctorFinding {
            id: "error_spike",
            severity: if errors.last_15m >= ERROR_SPIKE_CRITICAL_THRESHOLD {
                DoctorSeverity::Critical
            } else {
                DoctorSeverity::Warning
            },
            title: "Error Spike Detected",
            detail: format!("{} error logs in the last 15 minutes.", errors.last_15m),
            recommendation:
                "Inspect recent error logs and correlate with recent deployments or outages.",
        });
    }

    let (last, previous) = (errors.last_15m, errors.previous_15m);
    if last >= 8
        && ((previous == 0 && last >= 10)
            || (previous > 0 && last >= previous * 2 && last - previous >= 5))
    {
        findings.push(DoctorFinding {
            id: "error_trend_anomaly",
            severity: if previous == 0 || last >= previous * 3 {
                DoctorSeverity::Critical
            } else {
                DoctorSeverity::Warning
            },
            title: "Error Trend Anomaly",
            detail: format!(
                "Error trend changed from {previous} to {last} in consecutive 15-minute windows."
            ),
            recommendation: "Investigate recent deployments or upstream dependency changes and set temporary alert escalation.",
        });
    }

    findings
}

/// `DoctorReport` of `doctorCommand.ts`.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DoctorReport {
    pub status: HealthReportStatus,
    pub checks: Vec<HealthCheck>,
    pub findings: Vec<DoctorFinding>,
    pub recommendations: Vec<&'static str>,
    pub generated_at: String,
}

/// `resolveDoctorStatus`.
fn doctor_status(health: HealthReportStatus, findings: &[DoctorFinding]) -> HealthReportStatus {
    if health == HealthReportStatus::Critical
        || findings
            .iter()
            .any(|finding| finding.severity == DoctorSeverity::Critical)
    {
        return HealthReportStatus::Critical;
    }
    if health == HealthReportStatus::Degraded || !findings.is_empty() {
        return HealthReportStatus::Degraded;
    }
    HealthReportStatus::Ok
}

/// `runDoctorCommand`. A failed error-log read fails the whole report, as the
/// TypeScript command throws.
pub async fn run_doctor_command<S: HealthSources>(
    src: &S,
    options: &HealthOptions,
) -> PortResult<DoctorReport> {
    let health = run_health_command(src, options).await;

    let now = src.now_ms();
    let error_logs = src.recent_error_logs(ERROR_LOG_LIMIT)?;
    let count = |lower: i64, upper: Option<i64>| {
        error_logs
            .iter()
            .filter_map(entry_time_ms)
            .filter(|time| *time >= lower && upper.is_none_or(|upper| *time < upper))
            .count()
    };
    let errors = ErrorCounts {
        last_15m: count(now - WINDOW_MS, None),
        previous_15m: count(now - 2 * WINDOW_MS, Some(now - WINDOW_MS)),
    };

    let findings = build_doctor_findings(&health.checks, errors);
    let mut recommendations: Vec<&'static str> = Vec::new();
    for finding in &findings {
        if !recommendations.contains(&finding.recommendation) {
            recommendations.push(finding.recommendation);
        }
    }

    Ok(DoctorReport {
        status: doctor_status(health.status, &findings),
        checks: health.checks,
        findings,
        recommendations,
        generated_at: generated_at(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::diagnostics::model::{fail_check, HealthCategory};
    use crate::diagnostics::ports::{LogRecord, PortFailure};
    use crate::diagnostics::test_support::{log, Fake, NOW};

    fn critical(id: &str, message: &str) -> HealthCheck {
        fail_check(
            id,
            HealthCategory::Integration,
            0,
            0,
            HealthCheckStatus::Critical,
            message,
            None,
        )
    }

    fn counts(last_15m: usize, previous_15m: usize) -> ErrorCounts {
        ErrorCounts {
            last_15m,
            previous_15m,
        }
    }

    #[test]
    fn critical_security_and_bridge_findings() {
        let checks = vec![
            critical(
                "security.snapshot",
                "Security snapshot contains critical findings.",
            ),
            critical(
                "integration.imessage_bridge",
                "Bridge health check failed: timeout",
            ),
        ];
        let findings = build_doctor_findings(&checks, counts(0, 0));
        assert_eq!(findings.len(), 2);
        assert_eq!(findings[0].id, "security_critical");
        assert_eq!(findings[0].severity, DoctorSeverity::Critical);
        assert_eq!(findings[1].id, "bridge_unreachable");
        assert_eq!(findings[1].severity, DoctorSeverity::Critical);
        assert_eq!(findings[1].detail, "Bridge health check failed: timeout");
    }

    #[test]
    fn warning_security_and_bridge_findings_are_warnings() {
        let warning = |id: &str| {
            fail_check(
                id,
                HealthCategory::Security,
                0,
                0,
                HealthCheckStatus::Warning,
                "w",
                None,
            )
        };
        let findings = build_doctor_findings(
            &[
                warning("security.snapshot"),
                warning("integration.whatsapp_bridge"),
            ],
            counts(0, 0),
        );
        assert_eq!(findings[0].id, "security_warning");
        assert_eq!(findings[0].severity, DoctorSeverity::Warning);
        assert_eq!(findings[1].id, "bridge_unreachable");
        assert_eq!(findings[1].severity, DoctorSeverity::Warning);
    }

    #[test]
    fn error_spike_thresholds_are_five_and_ten() {
        let at = |last| build_doctor_findings(&[], counts(last, 0));
        assert!(at(4).is_empty());
        assert_eq!(at(5)[0].severity, DoctorSeverity::Warning);
        assert_eq!(at(9)[0].severity, DoctorSeverity::Warning);
        assert_eq!(at(10)[0].severity, DoctorSeverity::Critical);
        assert_eq!(at(10)[0].detail, "10 error logs in the last 15 minutes.");
    }

    #[test]
    fn trend_anomaly_from_zero_is_critical_and_growth_is_graded() {
        // Nothing before, ten now: critical.
        let from_zero = build_doctor_findings(&[], counts(10, 0));
        let anomaly = from_zero
            .iter()
            .find(|finding| finding.id == "error_trend_anomaly")
            .expect("anomaly");
        assert_eq!(anomaly.severity, DoctorSeverity::Critical);
        assert_eq!(
            anomaly.detail,
            "Error trend changed from 0 to 10 in consecutive 15-minute windows."
        );

        // Doubled from 4 to 8 with a difference of 4: not an anomaly.
        assert!(build_doctor_findings(&[], counts(8, 4))
            .iter()
            .all(|finding| finding.id != "error_trend_anomaly"));

        // 5 to 10: doubled with +5, below triple: warning.
        let warning = build_doctor_findings(&[], counts(10, 5));
        let anomaly = warning
            .iter()
            .find(|finding| finding.id == "error_trend_anomaly")
            .expect("anomaly");
        assert_eq!(anomaly.severity, DoctorSeverity::Warning);

        // 3 to 9: at least triple: critical.
        let tripled = build_doctor_findings(&[], counts(9, 3));
        assert_eq!(
            tripled
                .iter()
                .find(|finding| finding.id == "error_trend_anomaly")
                .expect("anomaly")
                .severity,
            DoctorSeverity::Critical
        );
    }

    #[test]
    fn doctor_status_combines_health_and_findings() {
        let findings = build_doctor_findings(&[], counts(5, 0));
        assert_eq!(
            doctor_status(HealthReportStatus::Ok, &findings),
            HealthReportStatus::Degraded
        );
        assert_eq!(
            doctor_status(HealthReportStatus::Critical, &[]),
            HealthReportStatus::Critical
        );
        assert_eq!(
            doctor_status(HealthReportStatus::Ok, &[]),
            HealthReportStatus::Ok
        );
    }

    fn error_at(ms: i64) -> LogRecord {
        log("error", "system", "SYS", "boom", ms)
    }

    #[tokio::test]
    async fn doctor_counts_the_two_windows_and_reports_both_findings() {
        let errors: Vec<LogRecord> = (0..10)
            .map(|_| error_at(NOW - 1_000))
            .chain((0..5).map(|_| error_at(NOW - WINDOW_MS - 1_000)))
            .chain(std::iter::once(error_at(NOW - 2 * WINDOW_MS - 1_000)))
            .collect();
        let src = Fake {
            error_logs: Ok(errors),
            ..Fake::default()
        };
        let report = run_doctor_command(&src, &HealthOptions::default())
            .await
            .expect("doctor");
        // Ten recent errors, five in the previous window, one before both.
        assert_eq!(report.findings.len(), 2);
        assert_eq!(report.findings[0].id, "error_spike");
        assert_eq!(report.findings[1].id, "error_trend_anomaly");
        assert_eq!(report.status, HealthReportStatus::Critical);
        // The two findings carry different recommendations, so both are listed.
        assert_eq!(report.recommendations.len(), 2);
    }

    #[tokio::test]
    async fn doctor_is_ok_without_errors_and_fails_when_the_log_read_fails() {
        let healthy = run_doctor_command(&Fake::default(), &HealthOptions::default())
            .await
            .expect("doctor");
        assert_eq!(healthy.status, HealthReportStatus::Ok);
        assert!(healthy.findings.is_empty());
        assert!(healthy.recommendations.is_empty());

        let failing = Fake {
            error_logs: Err(PortFailure::Failed("locked".into())),
            ..Fake::default()
        };
        assert_eq!(
            run_doctor_command(&failing, &HealthOptions::default()).await,
            Err(PortFailure::Failed("locked".into()))
        );
    }
}
