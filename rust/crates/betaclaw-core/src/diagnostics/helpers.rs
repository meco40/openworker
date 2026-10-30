//! Port of `src/commands/health/checkHelpers.ts`: the error-budget window, the
//! memory-node and node-process diagnostics, and the bridge health probe.

use serde::Serialize;
use serde_json::json;

use super::model::{
    fail_check, ok_check, skipped_check, HealthCategory, HealthCheck, HealthCheckStatus,
};
use super::ports::{
    BridgeSource, LogRecord, LogSource, MemorySource, PortResult, ProcessSource, RuntimeSource,
};
use crate::memory::types::MemoryNode;

/// `ERROR_BUDGET_WINDOW_MS`: fifteen minutes.
pub const ERROR_BUDGET_WINDOW_MS: i64 = 15 * 60 * 1000;

/// `listLogs({ limit: 4000 })` of `resolveRecentLogWindowStats`.
const ERROR_BUDGET_LOG_LIMIT: usize = 4_000;

/// Output of `resolveRecentLogWindowStats`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct RecentLogWindow {
    pub total: i64,
    pub errors: i64,
    pub window_minutes: i64,
}

/// `Date.parse(entry.createdAt || entry.timestamp)`. RFC 3339 is the format the
/// logs table writes; other spellings count as unparsable.
pub fn entry_time_ms(entry: &LogRecord) -> Option<i64> {
    let raw = if entry.created_at.is_empty() {
        &entry.timestamp
    } else {
        &entry.created_at
    };
    chrono::DateTime::parse_from_rfc3339(raw)
        .ok()
        .map(|time| time.timestamp_millis())
}

/// `resolveRecentLogWindowStats`. Memory samples written by the memory check are
/// not counted, so the check does not feed on its own output.
pub fn recent_log_window_stats<S: LogSource + RuntimeSource>(
    src: &S,
) -> PortResult<RecentLogWindow> {
    let threshold = src.now_ms() - ERROR_BUDGET_WINDOW_MS;
    let logs = src.recent_logs(ERROR_BUDGET_LOG_LIMIT)?;
    let mut stats = RecentLogWindow {
        total: 0,
        errors: 0,
        window_minutes: ERROR_BUDGET_WINDOW_MS / 60_000,
    };
    for entry in &logs {
        if entry.category == "diagnostics"
            && entry.source == "MEM"
            && entry.message.starts_with("memory.diagnostics.sample")
        {
            continue;
        }
        match entry_time_ms(entry) {
            Some(time) if time >= threshold => {}
            _ => continue,
        }
        stats.total += 1;
        if entry.level == "error" {
            stats.errors += 1;
        }
    }
    Ok(stats)
}

/// `MemoryNodeDiagnostics.summary`.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SizeSummary {
    pub total_nodes: i64,
    pub total_bytes: i64,
    pub content_bytes: i64,
    pub embedding_bytes: i64,
    pub metadata_bytes: i64,
}

/// One `byType` row of the memory diagnostics.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TypeSizes {
    #[serde(rename = "type")]
    pub node_type: String,
    pub count: i64,
    pub total_bytes: i64,
    pub content_bytes: i64,
    pub embedding_bytes: i64,
    pub metadata_bytes: i64,
}

/// One `largestNodes` row of the memory diagnostics.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NodeSizes {
    pub id: String,
    #[serde(rename = "type")]
    pub node_type: String,
    pub total_bytes: i64,
    pub content_bytes: i64,
    pub embedding_bytes: i64,
    pub metadata_bytes: i64,
}

/// `MemoryNodeDiagnostics` of `checkHelpers.ts`.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MemoryNodeDiagnostics {
    pub summary: SizeSummary,
    pub by_type: Vec<TypeSizes>,
    pub largest_nodes: Vec<NodeSizes>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub collection_error: Option<String>,
}

struct NodeSize {
    id: String,
    node_type: String,
    content: i64,
    embedding: i64,
    metadata: i64,
}

impl NodeSize {
    fn total(&self) -> i64 {
        self.content + self.embedding + self.metadata
    }
}

/// `estimateNodeSize`. The embedding and metadata sizes are the length of the
/// compact JSON text, as `JSON.stringify(...)` measures them in TypeScript.
fn node_size(node: &MemoryNode) -> NodeSize {
    let json_len = |text: serde_json::Result<String>| text.map_or(0, |text| text.len() as i64);
    NodeSize {
        id: node.id.clone(),
        node_type: node.node_type.as_str().to_string(),
        content: node.content.len() as i64,
        embedding: json_len(serde_json::to_string(&node.embedding)),
        // `node.metadata || {}`: an absent bag measures as `{}`.
        metadata: match &node.metadata {
            Some(metadata) => json_len(serde_json::to_string(metadata)),
            None => 2,
        },
    }
}

fn summarize_nodes(nodes: &[MemoryNode], limit: usize) -> MemoryNodeDiagnostics {
    let sized: Vec<NodeSize> = nodes.iter().map(node_size).collect();
    let mut summary = SizeSummary {
        total_nodes: sized.len() as i64,
        ..SizeSummary::default()
    };
    let mut by_type: Vec<TypeSizes> = Vec::new();
    for size in &sized {
        summary.content_bytes += size.content;
        summary.embedding_bytes += size.embedding;
        summary.metadata_bytes += size.metadata;
        summary.total_bytes += size.total();

        let index = match by_type
            .iter()
            .position(|row| row.node_type == size.node_type)
        {
            Some(index) => index,
            None => {
                by_type.push(TypeSizes {
                    node_type: size.node_type.clone(),
                    count: 0,
                    total_bytes: 0,
                    content_bytes: 0,
                    embedding_bytes: 0,
                    metadata_bytes: 0,
                });
                by_type.len() - 1
            }
        };
        let row = &mut by_type[index];
        row.count += 1;
        row.total_bytes += size.total();
        row.content_bytes += size.content;
        row.embedding_bytes += size.embedding;
        row.metadata_bytes += size.metadata;
    }
    // Stable sort, as the TypeScript `Array.prototype.sort` is.
    by_type.sort_by(|a, b| {
        b.total_bytes
            .cmp(&a.total_bytes)
            .then(b.count.cmp(&a.count))
    });

    let mut largest: Vec<&NodeSize> = sized.iter().collect();
    largest.sort_by_key(|size| std::cmp::Reverse(size.total()));
    let largest_nodes = largest
        .into_iter()
        .take(limit.max(1))
        .map(|size| NodeSizes {
            id: size.id.clone(),
            node_type: size.node_type.clone(),
            total_bytes: size.total(),
            content_bytes: size.content,
            embedding_bytes: size.embedding,
            metadata_bytes: size.metadata,
        })
        .collect();

    MemoryNodeDiagnostics {
        summary,
        by_type,
        largest_nodes,
        collection_error: None,
    }
}

/// `resolveMemoryNodeDiagnostics(limit)`. A failure is returned as
/// `collectionError`, not as an error, as in TypeScript.
pub fn memory_node_diagnostics<S: MemorySource>(src: &S, limit: usize) -> MemoryNodeDiagnostics {
    match src.snapshot() {
        Ok(nodes) => summarize_nodes(&nodes, limit),
        Err(failure) => MemoryNodeDiagnostics {
            collection_error: Some(failure.message()),
            ..MemoryNodeDiagnostics::default()
        },
    }
}

/// `normalizeCommand`: collapses whitespace and cuts the text at 240 characters.
pub fn normalize_command(command: &str) -> String {
    let compact = command.split_whitespace().collect::<Vec<_>>().join(" ");
    if compact.chars().count() > 240 {
        format!("{}...", compact.chars().take(237).collect::<String>())
    } else {
        compact
    }
}

/// One row of `NodeProcessDiagnostics.topByRss`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NodeProcessRow {
    pub pid: u32,
    pub rss_bytes: u64,
    pub private_bytes: Option<u64>,
    pub command: String,
    pub is_current: bool,
}

/// `NodeProcessDiagnostics` of `checkHelpers.ts`.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NodeProcessDiagnostics {
    pub total_tracked: usize,
    pub top_by_rss: Vec<NodeProcessRow>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub collection_error: Option<String>,
}

/// `resolveNodeProcessDiagnostics(limit)`.
pub async fn node_process_diagnostics<S: ProcessSource>(
    src: &S,
    limit: usize,
) -> NodeProcessDiagnostics {
    let raw = match src.node_processes().await {
        Ok(raw) => raw,
        Err(failure) => {
            return NodeProcessDiagnostics {
                collection_error: Some(failure.message()),
                ..NodeProcessDiagnostics::default()
            }
        }
    };
    let current = src.current_pid();
    let mut rows: Vec<NodeProcessRow> = raw
        .into_iter()
        .map(|process| {
            // `String(row.command || 'node')`
            let command = if process.command.trim().is_empty() {
                "node".to_string()
            } else {
                normalize_command(&process.command)
            };
            NodeProcessRow {
                pid: process.pid,
                rss_bytes: process.rss_bytes,
                private_bytes: process.private_bytes,
                command,
                is_current: process.pid == current,
            }
        })
        .collect();
    rows.sort_by(|a, b| b.rss_bytes.cmp(&a.rss_bytes));
    let total_tracked = rows.len();
    rows.truncate(limit.max(1));
    NodeProcessDiagnostics {
        total_tracked,
        top_by_rss: rows,
        collection_error: None,
    }
}

/// `runBridgeHealthCheck`. The bridge is probed only when its URL is configured
/// and its channel is paired.
pub async fn bridge_health_check<S: BridgeSource + RuntimeSource>(
    src: &S,
    id: &str,
    channel: &str,
    env_name: &str,
    timeout_ms: u64,
) -> HealthCheck {
    let Some(raw) = src
        .env_var(env_name)
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
    else {
        return skipped_check(
            id,
            HealthCategory::Integration,
            format!("{env_name} not configured."),
            None,
        );
    };
    if src.channel_credential(channel, "pairing_status").as_deref() != Some("connected") {
        return skipped_check(
            id,
            HealthCategory::Integration,
            format!("{channel} bridge check skipped (channel not paired)."),
            Some(json!({ "envName": env_name, "configured": true, "paired": false })),
        );
    }

    let start = src.now_ms();
    // `bridgeUrl.replace(/\/$/, '')`: one trailing slash at most.
    let url = format!("{}/health", raw.strip_suffix('/').unwrap_or(raw.as_str()));
    let outcome = src.probe_health(url.clone(), timeout_ms).await;
    let now = src.now_ms();
    match outcome {
        Ok(probe) if (200..300).contains(&probe.status) => ok_check(
            id,
            HealthCategory::Integration,
            start,
            now,
            "Bridge health check passed.",
            Some(probe.body),
        ),
        Ok(probe) => fail_check(
            id,
            HealthCategory::Integration,
            start,
            now,
            HealthCheckStatus::Warning,
            format!("Bridge health failed with {}.", probe.status),
            Some(json!({ "url": url, "status": probe.status })),
        ),
        Err(failure) => {
            let lower = failure.message.to_lowercase();
            let timed_out =
                failure.timed_out || lower.contains("timeout") || lower.contains("timed out");
            let status = if timed_out {
                HealthCheckStatus::Critical
            } else {
                HealthCheckStatus::Warning
            };
            fail_check(
                id,
                HealthCategory::Integration,
                start,
                now,
                status,
                format!("Bridge health check failed: {}", failure.message),
                Some(json!({ "bridgeUrl": raw, "timeoutMs": timeout_ms })),
            )
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::diagnostics::ports::RawNodeProcess;
    use crate::diagnostics::ports::{HttpProbe, PortFailure, ProbeFailure};
    use crate::diagnostics::test_support::{log, node, Fake, NOW};
    use crate::memory::types::MemoryType;

    #[test]
    fn error_budget_window_counts_recent_rows_and_skips_memory_samples() {
        let src = Fake {
            recent: Ok(vec![
                log("error", "system", "SYS", "boom", NOW - 1_000),
                log("info", "system", "SYS", "ok", NOW - 2_000),
                log(
                    "error",
                    "system",
                    "SYS",
                    "old",
                    NOW - ERROR_BUDGET_WINDOW_MS - 1,
                ),
                log(
                    "warn",
                    "diagnostics",
                    "MEM",
                    "memory.diagnostics.sample:10.0% heap usage",
                    NOW - 3_000,
                ),
            ]),
            ..Fake::default()
        };
        let stats = recent_log_window_stats(&src).expect("window");
        assert_eq!(
            stats,
            RecentLogWindow {
                total: 2,
                errors: 1,
                window_minutes: 15
            }
        );
    }

    #[test]
    fn error_budget_window_reports_a_failed_read() {
        let src = Fake {
            recent: Err(PortFailure::Failed("locked".into())),
            ..Fake::default()
        };
        assert_eq!(
            recent_log_window_stats(&src),
            Err(PortFailure::Failed("locked".into()))
        );
    }

    #[test]
    fn memory_node_diagnostics_sizes_and_orders_the_nodes() {
        let big = node("big", MemoryType::Lesson, "abcdefghij", vec![0.5, 0.25]);
        let small = node("small", MemoryType::Fact, "x", vec![]);
        let src = Fake {
            nodes: Ok(vec![
                small,
                big.clone(),
                node("b2", MemoryType::Lesson, "", vec![]),
            ]),
            ..Fake::default()
        };
        let diagnostics = memory_node_diagnostics(&src, 1);

        assert_eq!(diagnostics.summary.total_nodes, 3);
        assert_eq!(diagnostics.collection_error, None);
        // The lesson type holds two nodes, so it outranks the single fact.
        assert_eq!(diagnostics.by_type[0].node_type, "lesson");
        assert_eq!(diagnostics.by_type[0].count, 2);
        // `limit` is honoured, the largest node comes first.
        assert_eq!(diagnostics.largest_nodes.len(), 1);
        assert_eq!(diagnostics.largest_nodes[0].id, "big");
        // Metadata of an absent bag measures as `{}`.
        assert_eq!(diagnostics.largest_nodes[0].metadata_bytes, 2);
        assert_eq!(diagnostics.largest_nodes[0].content_bytes, 10);
    }

    #[test]
    fn memory_node_diagnostics_reports_a_failed_snapshot_as_collection_error() {
        let src = Fake {
            nodes: Err(PortFailure::Failed("no table".into())),
            ..Fake::default()
        };
        let diagnostics = memory_node_diagnostics(&src, 5);
        assert_eq!(diagnostics.collection_error.as_deref(), Some("no table"));
        assert!(diagnostics.by_type.is_empty());
    }

    #[tokio::test]
    async fn node_process_diagnostics_marks_the_current_process_and_sorts() {
        let src = Fake {
            pid: 7,
            node_procs: Ok(vec![
                RawNodeProcess {
                    pid: 7,
                    rss_bytes: 10,
                    private_bytes: None,
                    command: "  node   server.js ".into(),
                },
                RawNodeProcess {
                    pid: 9,
                    rss_bytes: 30,
                    private_bytes: Some(5),
                    command: String::new(),
                },
            ]),
            ..Fake::default()
        };
        let diagnostics = node_process_diagnostics(&src, 10).await;
        assert_eq!(diagnostics.total_tracked, 2);
        assert_eq!(diagnostics.top_by_rss[0].pid, 9);
        assert_eq!(diagnostics.top_by_rss[0].command, "node");
        assert!(diagnostics.top_by_rss[1].is_current);
        assert_eq!(diagnostics.top_by_rss[1].command, "node server.js");
    }

    #[tokio::test]
    async fn node_process_diagnostics_reports_a_failed_listing() {
        let src = Fake {
            node_procs: Err(PortFailure::Failed("ps missing".into())),
            ..Fake::default()
        };
        let diagnostics = node_process_diagnostics(&src, 10).await;
        assert_eq!(diagnostics.total_tracked, 0);
        assert_eq!(diagnostics.collection_error.as_deref(), Some("ps missing"));
    }

    #[test]
    fn normalize_command_cuts_long_text() {
        let long = "a ".repeat(200);
        let cut = normalize_command(&long);
        assert_eq!(cut.chars().count(), 240);
        assert!(cut.ends_with("..."));
    }

    fn bridge_env(value: &str) -> Fake {
        Fake {
            env: [("WHATSAPP_BRIDGE_URL".to_string(), value.to_string())]
                .into_iter()
                .collect(),
            credentials: [(
                ("whatsapp".to_string(), "pairing_status".to_string()),
                "connected".to_string(),
            )]
            .into_iter()
            .collect(),
            ..Fake::default()
        }
    }

    #[tokio::test]
    async fn bridge_is_skipped_without_a_url_or_pairing() {
        let unset = Fake::default();
        let check = bridge_health_check(
            &unset,
            "integration.whatsapp_bridge",
            "whatsapp",
            "WHATSAPP_BRIDGE_URL",
            3_000,
        )
        .await;
        assert_eq!(check.status, HealthCheckStatus::Skipped);
        assert_eq!(check.message, "WHATSAPP_BRIDGE_URL not configured.");

        let mut unpaired = bridge_env("http://bridge:9000");
        unpaired.credentials.clear();
        let check = bridge_health_check(
            &unpaired,
            "integration.whatsapp_bridge",
            "whatsapp",
            "WHATSAPP_BRIDGE_URL",
            3_000,
        )
        .await;
        assert_eq!(check.status, HealthCheckStatus::Skipped);
        assert_eq!(
            check.message,
            "whatsapp bridge check skipped (channel not paired)."
        );
    }

    #[tokio::test]
    async fn bridge_success_probes_health_without_a_trailing_slash() {
        let src = Fake {
            probe: Ok(HttpProbe {
                status: 200,
                body: json!({ "state": "up" }),
            }),
            ..bridge_env("http://bridge:9000/")
        };
        let check = bridge_health_check(
            &src,
            "integration.whatsapp_bridge",
            "whatsapp",
            "WHATSAPP_BRIDGE_URL",
            3_000,
        )
        .await;
        assert_eq!(check.status, HealthCheckStatus::Ok);
        assert_eq!(check.message, "Bridge health check passed.");
        assert_eq!(check.details, Some(json!({ "state": "up" })));
        assert_eq!(
            *src.probed.lock().expect("probed"),
            vec!["http://bridge:9000/health".to_string()]
        );
    }

    #[tokio::test]
    async fn bridge_non_success_status_is_a_warning() {
        let src = Fake {
            probe: Ok(HttpProbe {
                status: 503,
                body: json!({}),
            }),
            ..bridge_env("http://bridge:9000")
        };
        let check = bridge_health_check(
            &src,
            "integration.whatsapp_bridge",
            "whatsapp",
            "WHATSAPP_BRIDGE_URL",
            3_000,
        )
        .await;
        assert_eq!(check.status, HealthCheckStatus::Warning);
        assert_eq!(check.message, "Bridge health failed with 503.");
    }

    #[tokio::test]
    async fn bridge_timeout_is_critical_and_other_errors_are_warnings() {
        let timeout = Fake {
            probe: Err(ProbeFailure {
                timed_out: true,
                message: "operation aborted".into(),
            }),
            ..bridge_env("http://bridge:9000")
        };
        let check = bridge_health_check(
            &timeout,
            "integration.whatsapp_bridge",
            "whatsapp",
            "WHATSAPP_BRIDGE_URL",
            3_000,
        )
        .await;
        assert_eq!(check.status, HealthCheckStatus::Critical);
        assert_eq!(
            check.details,
            Some(json!({ "bridgeUrl": "http://bridge:9000", "timeoutMs": 3000 }))
        );

        let refused = Fake {
            probe: Err(ProbeFailure {
                timed_out: false,
                message: "connection refused".into(),
            }),
            ..bridge_env("http://bridge:9000")
        };
        let check = bridge_health_check(
            &refused,
            "integration.whatsapp_bridge",
            "whatsapp",
            "WHATSAPP_BRIDGE_URL",
            3_000,
        )
        .await;
        assert_eq!(check.status, HealthCheckStatus::Warning);
        assert_eq!(
            check.message,
            "Bridge health check failed: connection refused"
        );
    }
}
