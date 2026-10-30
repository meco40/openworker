//! Test doubles of the diagnostics ports.
//!
//! `Fake::default()` is a healthy host: every read succeeds and the memory is at
//! 20 %. A test overrides the one field it exercises.

use std::collections::HashMap;
use std::future::Future;
use std::sync::Mutex;

use serde_json::Value;

use crate::diagnostics::ports::{
    BridgeSource, GatewaySource, HttpProbe, KnowledgeSource, LogRecord, LogSource, MemorySource,
    PortResult, ProbeFailure, ProcessMemory, ProcessSource, RawNodeProcess, RuntimeSource,
    SecuritySource, StatsSource,
};
use crate::knowledge::repository::KnowledgeStats;
use crate::memory::types::{MemoryNode, MemoryType};
use crate::security::status::{SecurityStatusSnapshot, SecuritySummary};

/// A fixed "now" in epoch milliseconds, so latencies and windows are exact.
pub const NOW: i64 = 1_786_000_000_000;

/// A log row created `at_ms` after the epoch, in the format the logs table writes.
pub fn log(level: &str, category: &str, source: &str, message: &str, at_ms: i64) -> LogRecord {
    let created_at = chrono::DateTime::from_timestamp_millis(at_ms)
        .expect("valid timestamp")
        .to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
    LogRecord {
        level: level.to_string(),
        category: category.to_string(),
        source: source.to_string(),
        message: message.to_string(),
        created_at: created_at.clone(),
        timestamp: created_at,
    }
}

/// A memory node without metadata.
pub fn node(id: &str, node_type: MemoryType, content: &str, embedding: Vec<f64>) -> MemoryNode {
    MemoryNode {
        id: id.to_string(),
        node_type,
        content: content.to_string(),
        embedding,
        importance: 0.5,
        confidence: 0.5,
        timestamp: "2026-01-01T00:00:00.000Z".to_string(),
        metadata: None,
    }
}

/// A security snapshot with four passing checks and no findings.
pub fn healthy_security() -> SecurityStatusSnapshot {
    SecurityStatusSnapshot {
        checks: Vec::new(),
        channels: Vec::new(),
        summary: SecuritySummary {
            ok: 4,
            warning: 0,
            critical: 0,
        },
        generated_at: "2026-01-01T00:00:00.000Z".to_string(),
    }
}

/// Every port in one struct. The fields are the answers the ports give.
pub struct Fake {
    pub now_ms: i64,
    pub env: HashMap<String, String>,
    pub log_total: PortResult<i64>,
    pub recent: PortResult<Vec<LogRecord>>,
    pub error_logs: PortResult<Vec<LogRecord>>,
    pub usage_total: PortResult<i64>,
    pub provider_name: PortResult<String>,
    pub node_total: PortResult<i64>,
    pub nodes: PortResult<Vec<MemoryNode>>,
    pub knowledge_on: bool,
    pub knowledge_stats: PortResult<KnowledgeStats>,
    pub connection_total: PortResult<usize>,
    pub security: PortResult<SecurityStatusSnapshot>,
    pub pid: u32,
    pub uptime: u64,
    pub memory_usage: PortResult<ProcessMemory>,
    pub node_procs: PortResult<Vec<RawNodeProcess>>,
    pub credentials: HashMap<(String, String), String>,
    pub probe: Result<HttpProbe, ProbeFailure>,
    /// URLs the bridge probe was asked for.
    pub probed: Mutex<Vec<String>>,
    /// `(level, message, metadata)` of every memory sample written.
    pub samples: Mutex<Vec<(String, String, Value)>>,
}

impl Default for Fake {
    fn default() -> Self {
        Self {
            now_ms: NOW,
            env: HashMap::new(),
            log_total: Ok(10),
            recent: Ok(Vec::new()),
            error_logs: Ok(Vec::new()),
            usage_total: Ok(3),
            provider_name: Ok("sqlite".to_string()),
            node_total: Ok(2),
            nodes: Ok(Vec::new()),
            knowledge_on: false,
            knowledge_stats: Ok(KnowledgeStats {
                episode_count: 4,
                ledger_count: 5,
                retrieval_error_count: 0,
                latest_ingestion_at: None,
                ingestion_lag_ms: 0.0,
            }),
            connection_total: Ok(1),
            security: Ok(healthy_security()),
            pid: 4242,
            uptime: 60,
            memory_usage: Ok(ProcessMemory {
                rss_bytes: 100,
                system_total_bytes: 1_000,
                system_free_bytes: 800,
            }),
            node_procs: Ok(Vec::new()),
            credentials: HashMap::new(),
            probe: Err(ProbeFailure {
                timed_out: false,
                message: "no probe configured".to_string(),
            }),
            probed: Mutex::new(Vec::new()),
            samples: Mutex::new(Vec::new()),
        }
    }
}

impl LogSource for Fake {
    fn log_count(&self) -> PortResult<i64> {
        self.log_total.clone()
    }

    fn recent_logs(&self, _limit: usize) -> PortResult<Vec<LogRecord>> {
        self.recent.clone()
    }

    fn recent_error_logs(&self, _limit: usize) -> PortResult<Vec<LogRecord>> {
        self.error_logs.clone()
    }

    fn record_memory_sample(&self, level: &str, message: &str, metadata: Value) -> PortResult<()> {
        self.samples.lock().expect("samples").push((
            level.to_string(),
            message.to_string(),
            metadata,
        ));
        Ok(())
    }
}

impl StatsSource for Fake {
    fn usage_entry_count(&self) -> PortResult<i64> {
        self.usage_total.clone()
    }
}

impl MemorySource for Fake {
    fn provider_kind(&self) -> PortResult<String> {
        self.provider_name.clone()
    }

    fn node_count(&self) -> PortResult<i64> {
        self.node_total.clone()
    }

    fn snapshot(&self) -> PortResult<Vec<MemoryNode>> {
        self.nodes.clone()
    }
}

impl KnowledgeSource for Fake {
    fn knowledge_layer_enabled(&self) -> bool {
        self.knowledge_on
    }

    fn knowledge_stats(&self, _user_id: &str, _persona_id: &str) -> PortResult<KnowledgeStats> {
        self.knowledge_stats.clone()
    }
}

impl GatewaySource for Fake {
    fn connection_count(&self) -> PortResult<usize> {
        self.connection_total.clone()
    }
}

impl SecuritySource for Fake {
    fn security_snapshot(&self) -> PortResult<SecurityStatusSnapshot> {
        self.security.clone()
    }
}

impl ProcessSource for Fake {
    fn current_pid(&self) -> u32 {
        self.pid
    }

    fn uptime_secs(&self) -> u64 {
        self.uptime
    }

    fn process_memory(&self) -> impl Future<Output = PortResult<ProcessMemory>> + Send {
        let value = self.memory_usage.clone();
        async move { value }
    }

    fn node_processes(&self) -> impl Future<Output = PortResult<Vec<RawNodeProcess>>> + Send {
        let value = self.node_procs.clone();
        async move { value }
    }
}

impl BridgeSource for Fake {
    fn channel_credential(&self, channel: &str, key: &str) -> Option<String> {
        self.credentials
            .get(&(channel.to_string(), key.to_string()))
            .cloned()
    }

    fn probe_health(
        &self,
        url: String,
        _timeout_ms: u64,
    ) -> impl Future<Output = Result<HttpProbe, ProbeFailure>> + Send {
        self.probed.lock().expect("probed").push(url);
        let answer = self.probe.clone();
        async move { answer }
    }
}

impl RuntimeSource for Fake {
    fn env_var(&self, name: &str) -> Option<String> {
        self.env.get(name).cloned()
    }

    fn normalize_url(&self, raw: &str) -> Option<String> {
        if raw.starts_with("http://") || raw.starts_with("https://") {
            Some(raw.to_string())
        } else {
            None
        }
    }

    fn now_ms(&self) -> i64 {
        self.now_ms
    }
}
