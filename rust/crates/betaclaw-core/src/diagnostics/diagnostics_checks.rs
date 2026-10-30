//! Port of `src/commands/health/checks/diagnosticsChecks.ts`: the error budget,
//! the memory pressure and the alert routing.

use serde_json::{json, Map, Value};

use super::helpers::{memory_node_diagnostics, node_process_diagnostics, recent_log_window_stats};
use super::model::{
    fail_check, format_percent, ok_check, skipped_check, HealthCategory, HealthCheck,
    HealthCheckStatus,
};
use super::ports::{HealthSources, RuntimeSource};

const ERROR_BUDGET_MIN_SAMPLE: i64 = 20;
const ERROR_BUDGET_WARNING_RATIO: f64 = 0.05;
const ERROR_BUDGET_CRITICAL_RATIO: f64 = 0.1;
const MEMORY_PRESSURE_WARNING: f64 = 0.8;
const MEMORY_PRESSURE_CRITICAL: f64 = 0.9;

/// `runErrorBudgetCheck`.
pub fn error_budget_check<S: HealthSources>(src: &S) -> HealthCheck {
    const ID: &str = "diagnostics.error_budget";
    let start = src.now_ms();
    let result = recent_log_window_stats(src);
    let now = src.now_ms();
    let stats = match result {
        Ok(stats) => stats,
        Err(failure) => {
            return fail_check(
                ID,
                HealthCategory::Diagnostics,
                start,
                now,
                HealthCheckStatus::Warning,
                format!("Error budget check failed: {}", failure.message()),
                None,
            )
        }
    };
    let window_details = |ratio: Option<f64>| {
        let mut details = json!({
            "total": stats.total,
            "errors": stats.errors,
            "windowMinutes": stats.window_minutes,
        });
        if let Some(ratio) = ratio {
            details["ratio"] = json!(ratio);
        }
        details
    };

    if stats.total < ERROR_BUDGET_MIN_SAMPLE {
        return skipped_check(
            ID,
            HealthCategory::Diagnostics,
            format!(
                "Error budget skipped: insufficient sample size ({}/{}).",
                stats.total, ERROR_BUDGET_MIN_SAMPLE
            ),
            Some(window_details(None)),
        );
    }

    let ratio = stats.errors as f64 / stats.total as f64;
    let pct = format_percent(ratio);
    let window = stats.window_minutes;
    let (status, message) = if ratio >= ERROR_BUDGET_CRITICAL_RATIO {
        (
            HealthCheckStatus::Critical,
            format!("Error budget exceeded: {pct} in last {window}m."),
        )
    } else if ratio >= ERROR_BUDGET_WARNING_RATIO {
        (
            HealthCheckStatus::Warning,
            format!("Error budget degraded: {pct} in last {window}m."),
        )
    } else {
        (
            HealthCheckStatus::Ok,
            format!("Error budget healthy: {pct} in last {window}m."),
        )
    };
    let details = Some(window_details(Some(ratio)));
    if status == HealthCheckStatus::Ok {
        ok_check(
            ID,
            HealthCategory::Diagnostics,
            start,
            now,
            message,
            details,
        )
    } else {
        fail_check(
            ID,
            HealthCategory::Diagnostics,
            start,
            now,
            status,
            message,
            details,
        )
    }
}

/// `runMemoryPressureCheck`.
///
/// Deviation: Rust has no V8 heap, so the ratio is the share of host memory in use
/// (`(total - free) / total`), not `heapUsed / heapTotal`. The thresholds are the
/// same. The detailed form adds the process, node-process and memory-node figures
/// and writes one `memory.diagnostics.sample` log row.
pub async fn memory_pressure_check<S: HealthSources>(src: &S, detailed: bool) -> HealthCheck {
    const ID: &str = "diagnostics.memory_pressure";
    let start = src.now_ms();
    let usage = match src.process_memory().await {
        Ok(usage) => usage,
        Err(failure) => {
            return fail_check(
                ID,
                HealthCategory::Diagnostics,
                start,
                src.now_ms(),
                HealthCheckStatus::Warning,
                format!("Memory pressure check failed: {}", failure.message()),
                None,
            )
        }
    };

    let used = usage
        .system_total_bytes
        .saturating_sub(usage.system_free_bytes);
    let ratio = if usage.system_total_bytes > 0 {
        used as f64 / usage.system_total_bytes as f64
    } else {
        0.0
    };
    let mut details = Map::new();
    details.insert("usedBytes".into(), json!(used));
    details.insert("totalBytes".into(), json!(usage.system_total_bytes));
    details.insert("ratio".into(), json!(ratio));

    let pct = format_percent(ratio);
    let (status, message) = if ratio >= MEMORY_PRESSURE_CRITICAL {
        (
            HealthCheckStatus::Critical,
            format!("Memory pressure critical: {pct} memory in use."),
        )
    } else if ratio >= MEMORY_PRESSURE_WARNING {
        (
            HealthCheckStatus::Warning,
            format!("Memory pressure elevated: {pct} memory in use."),
        )
    } else {
        (
            HealthCheckStatus::Ok,
            format!("Memory pressure healthy: {pct} memory in use."),
        )
    };

    if detailed {
        let nodes = node_process_diagnostics(src, 10).await;
        let memory_nodes = memory_node_diagnostics(src, 10);
        let current_process = json!({
            "pid": src.current_pid(),
            "uptimeSec": src.uptime_secs(),
            "rssBytes": usage.rss_bytes,
        });
        details.insert("rssBytes".into(), json!(usage.rss_bytes));
        details.insert("currentProcess".into(), current_process.clone());
        details.insert("nodeProcesses".into(), json!(nodes));
        details.insert("memoryNodes".into(), json!(memory_nodes));
        details.insert(
            "systemMemory".into(),
            json!({
                "totalBytes": usage.system_total_bytes,
                "freeBytes": usage.system_free_bytes,
            }),
        );

        // The sample keeps the first five rows of each list, as the TypeScript does.
        let level = match status {
            HealthCheckStatus::Critical => "error",
            HealthCheckStatus::Warning => "warn",
            _ => "info",
        };
        let metadata: Value = json!({
            "ratio": ratio,
            "currentProcess": current_process,
            "nodeProcesses": nodes.top_by_rss.iter().take(5).collect::<Vec<_>>(),
            "memoryNodes": {
                "summary": memory_nodes.summary,
                "byType": memory_nodes.by_type.iter().take(5).collect::<Vec<_>>(),
                "largestNodes": memory_nodes.largest_nodes.iter().take(5).collect::<Vec<_>>(),
            },
        });
        // A failed log write does not change the memory status.
        let _ = src.record_memory_sample(
            level,
            &format!("memory.diagnostics.sample:{pct} memory in use"),
            metadata,
        );
    }

    let now = src.now_ms();
    let details = Some(Value::Object(details));
    if status == HealthCheckStatus::Ok {
        ok_check(
            ID,
            HealthCategory::Diagnostics,
            start,
            now,
            message,
            details,
        )
    } else {
        fail_check(
            ID,
            HealthCategory::Diagnostics,
            start,
            now,
            status,
            message,
            details,
        )
    }
}

/// `runAlertRoutingCheck`. Only the shape of the URL is checked; no traffic is sent.
pub fn alert_routing_check<S: RuntimeSource>(src: &S) -> HealthCheck {
    const ID: &str = "diagnostics.alert_routing";
    let Some(raw) = src
        .env_var("ALERT_WEBHOOK_URL")
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
    else {
        return skipped_check(
            ID,
            HealthCategory::Diagnostics,
            "Alert routing not configured (optional).",
            None,
        );
    };
    let start = src.now_ms();
    match src.normalize_url(&raw) {
        Some(normalized) => ok_check(
            ID,
            HealthCategory::Diagnostics,
            start,
            src.now_ms(),
            "Alert routing configured.",
            Some(json!({ "alertWebhook": normalized })),
        ),
        None => fail_check(
            ID,
            HealthCategory::Diagnostics,
            start,
            src.now_ms(),
            HealthCheckStatus::Warning,
            "Alert routing URL is invalid.",
            Some(json!({ "alertWebhook": raw })),
        ),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::diagnostics::ports::PortFailure;
    use crate::diagnostics::ports::ProcessMemory;
    use crate::diagnostics::test_support::{log, Fake, NOW};

    fn error_rows(errors: usize, infos: usize) -> Vec<crate::diagnostics::ports::LogRecord> {
        let mut rows = Vec::new();
        for _ in 0..errors {
            rows.push(log("error", "system", "SYS", "boom", NOW - 1_000));
        }
        for _ in 0..infos {
            rows.push(log("info", "system", "SYS", "ok", NOW - 1_000));
        }
        rows
    }

    #[test]
    fn error_budget_is_skipped_below_twenty_samples() {
        let check = error_budget_check(&Fake {
            recent: Ok(error_rows(19, 0)),
            ..Fake::default()
        });
        assert_eq!(check.status, HealthCheckStatus::Skipped);
        assert_eq!(
            check.message,
            "Error budget skipped: insufficient sample size (19/20)."
        );
    }

    #[test]
    fn error_budget_levels_follow_the_ratio() {
        // 2 of 20 is exactly 10 %: critical.
        let critical = error_budget_check(&Fake {
            recent: Ok(error_rows(2, 18)),
            ..Fake::default()
        });
        assert_eq!(critical.status, HealthCheckStatus::Critical);
        assert_eq!(
            critical.message,
            "Error budget exceeded: 10.0% in last 15m."
        );

        // 1 of 20 is 5 %: warning.
        let warning = error_budget_check(&Fake {
            recent: Ok(error_rows(1, 19)),
            ..Fake::default()
        });
        assert_eq!(warning.status, HealthCheckStatus::Warning);
        assert_eq!(warning.message, "Error budget degraded: 5.0% in last 15m.");

        let healthy = error_budget_check(&Fake {
            recent: Ok(error_rows(0, 20)),
            ..Fake::default()
        });
        assert_eq!(healthy.status, HealthCheckStatus::Ok);
        assert_eq!(healthy.message, "Error budget healthy: 0.0% in last 15m.");
        assert_eq!(
            healthy.details.as_ref().map(|d| d["total"].clone()),
            Some(json!(20))
        );
    }

    #[test]
    fn error_budget_read_failure_is_a_warning() {
        let check = error_budget_check(&Fake {
            recent: Err(PortFailure::Failed("locked".into())),
            ..Fake::default()
        });
        assert_eq!(check.status, HealthCheckStatus::Warning);
        assert_eq!(check.message, "Error budget check failed: locked");
    }

    fn memory(total: u64, free: u64) -> ProcessMemory {
        ProcessMemory {
            rss_bytes: 100,
            system_total_bytes: total,
            system_free_bytes: free,
        }
    }

    #[tokio::test]
    async fn memory_pressure_levels_follow_host_usage() {
        let healthy = memory_pressure_check(&Fake::default(), false).await;
        assert_eq!(healthy.status, HealthCheckStatus::Ok);
        assert_eq!(
            healthy.message,
            "Memory pressure healthy: 20.0% memory in use."
        );

        let elevated = memory_pressure_check(
            &Fake {
                memory_usage: Ok(memory(1_000, 150)),
                ..Fake::default()
            },
            false,
        )
        .await;
        assert_eq!(elevated.status, HealthCheckStatus::Warning);

        let critical = memory_pressure_check(
            &Fake {
                memory_usage: Ok(memory(1_000, 50)),
                ..Fake::default()
            },
            false,
        )
        .await;
        assert_eq!(critical.status, HealthCheckStatus::Critical);
        assert_eq!(
            critical.message,
            "Memory pressure critical: 95.0% memory in use."
        );
    }

    #[tokio::test]
    async fn memory_pressure_probe_failure_is_a_warning() {
        let check = memory_pressure_check(
            &Fake {
                memory_usage: Err(PortFailure::Failed("no /proc".into())),
                ..Fake::default()
            },
            false,
        )
        .await;
        assert_eq!(check.status, HealthCheckStatus::Warning);
        assert_eq!(check.message, "Memory pressure check failed: no /proc");
    }

    #[tokio::test]
    async fn detailed_memory_pressure_writes_one_sample() {
        let src = Fake {
            memory_usage: Ok(memory(1_000, 50)),
            ..Fake::default()
        };
        let check = memory_pressure_check(&src, true).await;
        assert_eq!(check.status, HealthCheckStatus::Critical);
        let details = check.details.expect("details");
        assert_eq!(details["currentProcess"]["pid"], json!(4242));
        assert!(details["nodeProcesses"]["topByRss"].is_array());
        assert_eq!(details["systemMemory"]["freeBytes"], json!(50));

        let samples = src.samples.lock().expect("samples");
        assert_eq!(samples.len(), 1);
        assert_eq!(samples[0].0, "error");
        assert!(samples[0].1.starts_with("memory.diagnostics.sample:"));
    }

    #[test]
    fn alert_routing_is_skipped_when_unset() {
        let check = alert_routing_check(&Fake::default());
        assert_eq!(check.status, HealthCheckStatus::Skipped);
        assert_eq!(check.message, "Alert routing not configured (optional).");
    }

    #[test]
    fn alert_routing_accepts_a_url_and_flags_a_broken_one() {
        let good = alert_routing_check(&Fake {
            env: [(
                "ALERT_WEBHOOK_URL".to_string(),
                " https://hooks.example/a ".to_string(),
            )]
            .into_iter()
            .collect(),
            ..Fake::default()
        });
        assert_eq!(good.status, HealthCheckStatus::Ok);
        assert_eq!(
            good.details,
            Some(json!({ "alertWebhook": "https://hooks.example/a" }))
        );

        let broken = alert_routing_check(&Fake {
            env: [("ALERT_WEBHOOK_URL".to_string(), "not a url".to_string())]
                .into_iter()
                .collect(),
            ..Fake::default()
        });
        assert_eq!(broken.status, HealthCheckStatus::Warning);
        assert_eq!(broken.message, "Alert routing URL is invalid.");
    }
}
