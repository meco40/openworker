//! Collaborators of the diagnostics checks.
//!
//! Each trait covers one TypeScript dependency of the health or doctor command.
//! The gateway implements them against the Rust stores; the tests implement them
//! with doubles. The async methods return `Send` futures, so the gateway can call
//! the checks from its request handlers.

use std::future::Future;

use serde_json::Value;

use crate::knowledge::repository::KnowledgeStats;
use crate::memory::types::MemoryNode;
use crate::security::status::SecurityStatusSnapshot;

/// Failure of a collaborator.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PortFailure {
    /// The Rust gateway has no implementation of this capability yet. A check
    /// reports it as skipped, not as a failure.
    NotWired(&'static str),
    /// The collaborator ran and failed. The text is the error message.
    Failed(String),
}

impl PortFailure {
    /// The error text the TypeScript checks put into their messages.
    pub fn message(&self) -> String {
        match self {
            PortFailure::NotWired(what) => format!("Not wired in the Rust gateway yet: {what}."),
            PortFailure::Failed(message) => message.clone(),
        }
    }
}

pub type PortResult<T> = Result<T, PortFailure>;

/// One row of the logs table, with the fields the checks read.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LogRecord {
    pub level: String,
    pub category: String,
    pub source: String,
    pub message: String,
    pub created_at: String,
    pub timestamp: String,
}

/// `getLogRepository()` of `logging/logRepository.ts`.
pub trait LogSource {
    /// `getLogCount()`.
    fn log_count(&self) -> PortResult<i64>;
    /// `listLogs({ limit })`: the newest entries.
    fn recent_logs(&self, limit: usize) -> PortResult<Vec<LogRecord>>;
    /// `listLogs({ level: 'error', limit })`.
    fn recent_error_logs(&self, limit: usize) -> PortResult<Vec<LogRecord>>;
    /// `log(level, 'MEM', message, metadata, 'diagnostics')`.
    fn record_memory_sample(&self, level: &str, message: &str, metadata: Value) -> PortResult<()>;
}

/// `getTokenUsageRepository()` of `server/stats/tokenUsageRepository.ts`.
pub trait StatsSource {
    /// `getEntryCount()`.
    fn usage_entry_count(&self) -> PortResult<i64>;
}

/// `getMemoryService()` and `getMemoryProviderKind()` of `server/memory/runtime.ts`.
pub trait MemorySource {
    /// `getMemoryProviderKind()`, for example `sqlite` or `mem0`.
    fn provider_kind(&self) -> PortResult<String>;
    /// `getMemoryService().count()`.
    fn node_count(&self) -> PortResult<i64>;
    /// `getMemoryService().snapshot()`.
    fn snapshot(&self) -> PortResult<Vec<MemoryNode>>;
}

/// `resolveKnowledgeConfig` and `getKnowledgeRepository()` of `server/knowledge`.
pub trait KnowledgeSource {
    /// `resolveKnowledgeConfig(process.env).layerEnabled`.
    fn knowledge_layer_enabled(&self) -> bool;
    /// `getKnowledgeRepository().getKnowledgeStats(user_id, persona_id)`.
    fn knowledge_stats(&self, user_id: &str, persona_id: &str) -> PortResult<KnowledgeStats>;
}

/// `getClientRegistry()` of `server/gateway/client-registry.ts`.
pub trait GatewaySource {
    /// `connectionCount`.
    fn connection_count(&self) -> PortResult<usize>;
}

/// `buildSecurityStatusSnapshot()` of `server/security/status.ts`.
pub trait SecuritySource {
    fn security_snapshot(&self) -> PortResult<SecurityStatusSnapshot>;
}

/// Memory figures of the process and of the host.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ProcessMemory {
    pub rss_bytes: u64,
    pub system_total_bytes: u64,
    pub system_free_bytes: u64,
}

/// One `node` process as the operating system lists it. The command is `None`
/// when the listing has none.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RawNodeProcess {
    pub pid: u32,
    pub rss_bytes: u64,
    pub private_bytes: Option<u64>,
    pub command: String,
}

/// The process facts the memory checks read: `process.pid`, `process.uptime()`,
/// `process.memoryUsage()`, `os.totalmem()` and `os.freemem()`, and the `node`
/// process listing.
pub trait ProcessSource {
    fn current_pid(&self) -> u32;
    fn uptime_secs(&self) -> u64;
    fn process_memory(&self) -> impl Future<Output = PortResult<ProcessMemory>> + Send;
    fn node_processes(&self) -> impl Future<Output = PortResult<Vec<RawNodeProcess>>> + Send;
}

/// Answer of a bridge health endpoint that responded.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HttpProbe {
    pub status: u16,
    /// The JSON body, or `{}` when the body is not JSON.
    pub body: Value,
}

/// A bridge probe that did not get an answer.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProbeFailure {
    /// True for an aborted or timed-out request (`AbortError` in TypeScript).
    pub timed_out: bool,
    pub message: String,
}

/// Channel credentials and the bridge HTTP probe.
pub trait BridgeSource {
    /// `getCredentialStore().getCredential(channel, key)`. `None` when the value is
    /// absent or the store cannot be read.
    fn channel_credential(&self, channel: &str, key: &str) -> Option<String>;
    /// `fetch(url)` with `timeout_ms`. A success reads the JSON body.
    fn probe_health(
        &self,
        url: String,
        timeout_ms: u64,
    ) -> impl Future<Output = Result<HttpProbe, ProbeFailure>> + Send;
}

/// The process environment, URL parsing and the clock.
pub trait RuntimeSource {
    /// `process.env[name]`.
    fn env_var(&self, name: &str) -> Option<String>;
    /// `new URL(raw).toString()`, `None` when the URL does not parse.
    fn normalize_url(&self, raw: &str) -> Option<String>;
    /// `Date.now()`.
    fn now_ms(&self) -> i64;
}

/// Everything the health command reads. Any type that implements the parts gets
/// this trait for free.
pub trait HealthSources:
    LogSource
    + StatsSource
    + MemorySource
    + KnowledgeSource
    + GatewaySource
    + SecuritySource
    + ProcessSource
    + BridgeSource
    + RuntimeSource
    + Sync
{
}

impl<T> HealthSources for T where
    T: LogSource
        + StatsSource
        + MemorySource
        + KnowledgeSource
        + GatewaySource
        + SecuritySource
        + ProcessSource
        + BridgeSource
        + RuntimeSource
        + Sync
{
}
