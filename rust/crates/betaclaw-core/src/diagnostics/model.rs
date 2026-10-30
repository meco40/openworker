//! Report types of the health and doctor commands (`src/commands/healthTypes.ts`)
//! and the check builders of `src/commands/health/checkHelpers.ts`.

use serde::Serialize;
use serde_json::Value;

/// `DEFAULT_TIMEOUT_MS` of `checkHelpers.ts`.
pub const DEFAULT_TIMEOUT_MS: u64 = 3_000;

/// `HealthReportStatus` of `healthTypes.ts`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum HealthReportStatus {
    Ok,
    Degraded,
    Critical,
}

/// `HealthCheckStatus` of `healthTypes.ts`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum HealthCheckStatus {
    Ok,
    Warning,
    Critical,
    Skipped,
}

/// `HealthCheckCategory` of `healthTypes.ts`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum HealthCategory {
    Core,
    Security,
    Integration,
    Diagnostics,
}

/// `HealthCheck` of `healthTypes.ts`. `details` is left out when absent, as
/// `JSON.stringify` drops `undefined`.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HealthCheck {
    pub id: String,
    pub category: HealthCategory,
    pub status: HealthCheckStatus,
    pub message: String,
    pub latency_ms: i64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub details: Option<Value>,
}

/// `HealthSummary` of `healthTypes.ts`.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize)]
pub struct HealthSummary {
    pub ok: usize,
    pub warning: usize,
    pub critical: usize,
    pub skipped: usize,
}

/// `HealthReport` of `healthTypes.ts`.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HealthReport {
    pub status: HealthReportStatus,
    pub checks: Vec<HealthCheck>,
    pub summary: HealthSummary,
    pub generated_at: String,
}

/// `HealthCommandOptions` of `healthTypes.ts`. The `fetchImpl` seam of the
/// TypeScript version is the `BridgeSource` port in Rust.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct HealthOptions {
    pub timeout_ms: Option<u64>,
    pub memory_diagnostics_enabled: bool,
}

/// `okCheck`. The latency is `now - start`, as `elapsedMs` computes it.
pub fn ok_check(
    id: &str,
    category: HealthCategory,
    start_ms: i64,
    now_ms: i64,
    message: impl Into<String>,
    details: Option<Value>,
) -> HealthCheck {
    build(
        id,
        category,
        HealthCheckStatus::Ok,
        message,
        now_ms - start_ms,
        details,
    )
}

/// `failCheck` with a `warning` or `critical` status.
pub fn fail_check(
    id: &str,
    category: HealthCategory,
    start_ms: i64,
    now_ms: i64,
    status: HealthCheckStatus,
    message: impl Into<String>,
    details: Option<Value>,
) -> HealthCheck {
    build(id, category, status, message, now_ms - start_ms, details)
}

/// `skippedCheck`. A skipped check has no latency.
pub fn skipped_check(
    id: &str,
    category: HealthCategory,
    message: impl Into<String>,
    details: Option<Value>,
) -> HealthCheck {
    build(
        id,
        category,
        HealthCheckStatus::Skipped,
        message,
        0,
        details,
    )
}

fn build(
    id: &str,
    category: HealthCategory,
    status: HealthCheckStatus,
    message: impl Into<String>,
    latency_ms: i64,
    details: Option<Value>,
) -> HealthCheck {
    HealthCheck {
        id: id.to_string(),
        category,
        status,
        message: message.into(),
        latency_ms,
        details,
    }
}

/// `aggregateSummary` of `healthCommand.ts`.
pub fn summarize(checks: &[HealthCheck]) -> HealthSummary {
    let mut summary = HealthSummary::default();
    for check in checks {
        match check.status {
            HealthCheckStatus::Ok => summary.ok += 1,
            HealthCheckStatus::Warning => summary.warning += 1,
            HealthCheckStatus::Critical => summary.critical += 1,
            HealthCheckStatus::Skipped => summary.skipped += 1,
        }
    }
    summary
}

/// `toHealthStatus` of `healthCommand.ts`: any critical check makes the report
/// critical, any warning makes it degraded.
pub fn report_status(summary: &HealthSummary) -> HealthReportStatus {
    if summary.critical > 0 {
        HealthReportStatus::Critical
    } else if summary.warning > 0 {
        HealthReportStatus::Degraded
    } else {
        HealthReportStatus::Ok
    }
}

/// `formatPercent` of `checkHelpers.ts`: `(value * 100).toFixed(1) + '%'`.
///
/// `toFixed` rounds exact ties upwards, while `format!` rounds them to even, so the
/// tenth is rounded here with `round()` (half away from zero, which is upwards for
/// the non-negative ratios used here).
pub fn format_percent(value: f64) -> String {
    let tenths = (value * 100.0 * 10.0).round() as i64;
    format!("{}.{}%", tenths / 10, tenths % 10)
}

/// `new Date().toISOString()`.
pub fn generated_at() -> String {
    chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn format_percent_matches_to_fixed_one() {
        assert_eq!(format_percent(0.0), "0.0%");
        assert_eq!(format_percent(0.1234), "12.3%");
        // 6.25 is exact in binary: toFixed(1) answers 6.3, format! would give 6.2.
        assert_eq!(format_percent(0.0625), "6.3%");
        assert_eq!(format_percent(1.0), "100.0%");
    }

    #[test]
    fn summary_and_status_follow_the_worst_check() {
        let mut checks = vec![ok_check("x", HealthCategory::Core, 0, 0, "m", None)];
        assert_eq!(report_status(&summarize(&checks)), HealthReportStatus::Ok);

        checks.push(fail_check(
            "x",
            HealthCategory::Core,
            0,
            0,
            HealthCheckStatus::Warning,
            "w",
            None,
        ));
        assert_eq!(
            report_status(&summarize(&checks)),
            HealthReportStatus::Degraded
        );

        checks.push(fail_check(
            "x",
            HealthCategory::Core,
            0,
            0,
            HealthCheckStatus::Critical,
            "c",
            None,
        ));
        checks.push(skipped_check("x", HealthCategory::Core, "m", None));
        let summary = summarize(&checks);
        assert_eq!(summary.critical, 1);
        assert_eq!(summary.skipped, 1);
        assert_eq!(report_status(&summary), HealthReportStatus::Critical);
    }

    #[test]
    fn details_are_left_out_when_absent() {
        let without = skipped_check("a", HealthCategory::Core, "m", None);
        assert!(serde_json::to_value(&without)
            .expect("serialize")
            .get("details")
            .is_none());

        let with = ok_check(
            "a",
            HealthCategory::Core,
            10,
            25,
            "m",
            Some(json!({ "total": 1 })),
        );
        let value = serde_json::to_value(&with).expect("serialize");
        assert_eq!(value["latencyMs"], 15);
        assert_eq!(value["status"], "ok");
        assert_eq!(value["category"], "core");
    }
}
