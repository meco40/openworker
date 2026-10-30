//! Diagnostics port of the ops family: the health and doctor reports over the Rust
//! stores.
//!
//! Implements the collaborators of `src/commands/healthCommand.ts` and
//! `src/commands/doctorCommand.ts`, which `app/api/health/route.ts` and
//! `app/api/doctor/route.ts` call. The checks are in `betaclaw_core::diagnostics`;
//! this file answers their ports from the Rust stores, the HTTP client and the
//! operating system.
//!
//! Deviations from the Node process:
//! - Knowledge stats: the Rust knowledge repository has no SQLite implementation
//!   yet, so the knowledge check is skipped while the layer is enabled.
//! - Memory pressure is the share of host memory in use. Rust has no V8 heap, so
//!   `heapUsed / heapTotal` does not exist. The host figures come from
//!   `/proc/meminfo` on Linux and `Win32_OperatingSystem` on Windows.
//! - Process memory comes from `/proc/self/statm` (4 KiB pages) on Linux and from
//!   `Get-Process` on Windows. Other platforms report the probe as failed.
//! - The node-process listing runs `ps` on Linux and `Get-CimInstance` on Windows,
//!   with the 1.2 s timeout of the TypeScript probe.
//!
//! Wiring: [`RustDiagnostics::open`] builds the port. The integrator assigns it to
//! `Services::diagnostics`; this file does not change `Services` or the router.

use std::collections::HashMap;
use std::future::Future;
use std::path::Path;
use std::process::Stdio;
use std::sync::{Arc, Mutex, OnceLock, PoisonError};
use std::time::{Duration, Instant};

use betaclaw_core::diagnostics::doctor::run_doctor_command;
use betaclaw_core::diagnostics::health::run_health_command;
use betaclaw_core::diagnostics::model::HealthOptions;
use betaclaw_core::diagnostics::ports::{
    BridgeSource, GatewaySource, HttpProbe, KnowledgeSource, LogRecord, LogSource, MemorySource,
    PortFailure, PortResult, ProbeFailure, ProcessMemory, ProcessSource, RawNodeProcess,
    RuntimeSource, SecuritySource, StatsSource,
};
use betaclaw_core::gateway::registry::SharedRegistry;
use betaclaw_core::knowledge::config::resolve_knowledge_config;
use betaclaw_core::knowledge::repository::{KnowledgeRepository, KnowledgeStats};
use betaclaw_core::knowledge::sqlite_knowledge_repository::SqliteKnowledgeRepository;
use betaclaw_core::logging::repository::{
    LogCategory, LogEntry, LogFilter, LogLevel, LogRepository,
};
use betaclaw_core::logging::service::log as write_log;
use betaclaw_core::memory::errors::MemoryError;
use betaclaw_core::memory::lifecycle::NoopLifecyclePublisher;
use betaclaw_core::memory::mem0::create_mem0_client_from_env;
use betaclaw_core::memory::runtime::{
    configured_provider, ConfiguredProvider, MemoryClientFactory, MemoryRuntime, MemoryRuntimeError,
};
use betaclaw_core::memory::service::{Mem0PolicyConfig, MemoryService, MemoryServiceDependencies};
use betaclaw_core::memory::sqlite::client::SqliteMemoryClient;
use betaclaw_core::memory::types::{Mem0Client, MemoryNode};
use betaclaw_core::model_hub::env::EnvOverrides;
use betaclaw_core::model_hub::http::HttpTransport;
use betaclaw_core::security::status::{
    build_security_status_snapshot, CommandPermission, SecurityStatusSnapshot, SnapshotInput,
};
use betaclaw_core::stats::token_usage::TokenUsageRepository;
use betaclaw_core::world_model::config::resolve_world_model_config;
use betaclaw_core::world_model::db::PgExecutor;
use serde_json::{json, Value};

use super::ports::{DiagnosticsPort, PortError, PortFuture};
use super::world_model_port::LazyPgExecutor;
use super::BuildError;
use crate::model_hub_transport::ReqwestTransport;

/// The Node probe's `PROCESS_DISCOVERY_TIMEOUT_MS`.
const PROBE_TIMEOUT: Duration = Duration::from_millis(1_200);
/// How long a host-memory reading is reused. The health route is polled, and a
/// PowerShell call per request would be slow on Windows.
const MEMORY_CACHE_TTL: Duration = Duration::from_secs(5);
/// Page size of the Linux `statm` counters (x86-64 and arm64 builds).
const LINUX_PAGE_BYTES: u64 = 4_096;
const MEMORY_CLIENT_UNAVAILABLE: &str = "Invalid memory configuration: memory client unavailable. Set MEMORY_PROVIDER=postgres, mem0, or sqlite.";
/// `Get-CimInstance Win32_Process` for `node.exe`, as the Node probe runs it.
const NODE_LISTING_SCRIPT: &str = r#"$items = Get-CimInstance Win32_Process -Filter "Name = 'node.exe'" | ForEach-Object { [PSCustomObject]@{ pid = $_.ProcessId; rssBytes = [int64]$_.WorkingSetSize; privateBytes = [int64]$_.PrivatePageCount; command = $_.CommandLine } }; $items | ConvertTo-Json -Compress"#;

/// The lifecycle publisher of `routes/memory.rs`: reads never publish events.
static NOOP_PUBLISHER: NoopLifecyclePublisher = NoopLifecyclePublisher;

/// Inputs of [`RustDiagnostics::open`].
pub struct DiagnosticsDeps<'a> {
    pub env: &'a EnvOverrides,
    pub logs_db_path: &'a str,
    pub stats_db_path: &'a str,
    /// The messages database, which holds the `channel_credentials` table.
    pub messages_db_path: &'a str,
    pub registry: SharedRegistry,
    /// The HTTP client the bridge probes and the Mem0 client use.
    pub http: reqwest::Client,
}

/// The diagnostics port over the Rust stores.
pub struct RustDiagnostics {
    env: EnvOverrides,
    logs: Mutex<LogRepository>,
    stats: Mutex<TokenUsageRepository>,
    messages_db_path: String,
    registry: SharedRegistry,
    http: reqwest::Client,
    started_at: Instant,
    memory_cache: Mutex<Option<(Instant, ProcessMemory)>>,
    /// Pool for the canonical memory provider, opened on the first postgres read.
    memory_pg: OnceLock<Arc<dyn PgExecutor>>,
}

fn store_error(error: impl std::fmt::Display) -> BuildError {
    BuildError::Store(error.to_string())
}

fn failed(error: impl std::fmt::Display) -> PortFailure {
    PortFailure::Failed(error.to_string())
}

/// `process.env` as a map, for the readers that take one (memory, knowledge, world model).
fn process_env() -> HashMap<String, String> {
    std::env::vars().collect()
}

fn memory_policy(env: &HashMap<String, String>) -> Mem0PolicyConfig {
    let world_model = resolve_world_model_config(env);
    Mem0PolicyConfig {
        mem0_preferences_only: world_model.mem0_preferences_only,
        mode_canonical: world_model.mode.is_canonical(),
    }
}

/// The client constructor of the diagnostics memory runtime. Same rules as the
/// factory of `routes/memory.rs`, which is private there.
struct DiagnosticsMemoryFactory {
    transport: Arc<dyn HttpTransport>,
    postgres: Option<Arc<dyn PgExecutor>>,
}

impl MemoryClientFactory for DiagnosticsMemoryFactory {
    fn create(
        &self,
        provider: ConfiguredProvider,
        env: &HashMap<String, String>,
    ) -> Result<Box<dyn Mem0Client>, MemoryRuntimeError> {
        match provider {
            ConfiguredProvider::Sqlite => SqliteMemoryClient::new()
                .map(|client| Box::new(client) as Box<dyn Mem0Client>)
                .map_err(|error| MemoryRuntimeError::Configuration(error.to_string())),
            ConfiguredProvider::Mem0 => {
                match create_mem0_client_from_env(env, self.transport.clone()) {
                    Ok(Some(client)) => Ok(Box::new(client) as Box<dyn Mem0Client>),
                    Ok(None) => Err(MemoryRuntimeError::Configuration(
                        MEMORY_CLIENT_UNAVAILABLE.to_string(),
                    )),
                    Err(error) => Err(MemoryRuntimeError::Configuration(error.to_string())),
                }
            }
            ConfiguredProvider::Postgres => self
                .postgres
                .as_ref()
                .map(|executor| {
                    Box::new(crate::model_hub_embedding::canonical_memory_client(Arc::clone(executor))) as Box<dyn Mem0Client>
                })
                .ok_or_else(|| {
                    MemoryRuntimeError::Configuration(
                        "Invalid memory configuration: the canonical PostgreSQL executor is unavailable."
                            .to_string(),
                    )
                }),
        }
    }
}

/// The `LogEntry` fields the checks read, as the port's record.
fn log_record(entry: &LogEntry) -> LogRecord {
    LogRecord {
        level: entry.level.as_str().to_string(),
        category: entry.category.as_str().to_string(),
        source: entry.source.clone(),
        message: entry.message.clone(),
        created_at: entry.created_at.clone(),
        timestamp: entry.timestamp.clone(),
    }
}

/// `SELECT value FROM channel_credentials`, read-only, over the connection cache
/// in `routes/security.rs`.
fn channel_credential(db_path: &str, channel: &str, key: &str) -> Option<String> {
    crate::routes::security::read_channel_credential(db_path, channel, key)
}

impl RustDiagnostics {
    /// Opens the log and stats stores. The memory runtime is built per call, so a
    /// broken memory configuration shows up in the report, not at start-up.
    pub fn open(deps: DiagnosticsDeps<'_>) -> Result<Self, BuildError> {
        Ok(Self {
            env: deps.env.clone(),
            logs: Mutex::new(LogRepository::open(deps.logs_db_path).map_err(store_error)?),
            stats: Mutex::new(TokenUsageRepository::open(deps.stats_db_path).map_err(store_error)?),
            messages_db_path: deps.messages_db_path.to_string(),
            registry: deps.registry,
            http: deps.http,
            started_at: Instant::now(),
            memory_cache: Mutex::new(None),
            memory_pg: OnceLock::new(),
        })
    }

    fn logs_list(&self, filter: LogFilter) -> PortResult<Vec<LogRecord>> {
        let repository = self.logs.lock().unwrap_or_else(PoisonError::into_inner);
        let entries = repository.list_logs(&filter).map_err(failed)?;
        Ok(entries.iter().map(log_record).collect())
    }

    fn memory_runtime(&self, env: &HashMap<String, String>) -> PortResult<MemoryRuntime> {
        let transport: Arc<dyn HttpTransport> =
            Arc::new(ReqwestTransport::with_client(self.http.clone()));
        let postgres = (configured_provider(env) == ConfiguredProvider::Postgres).then(|| {
            Arc::clone(self.memory_pg.get_or_init(|| {
                Arc::new(LazyPgExecutor::new(&resolve_world_model_config(env)))
                    as Arc<dyn PgExecutor>
            }))
        });
        MemoryRuntime::from_env(
            env,
            &DiagnosticsMemoryFactory {
                transport,
                postgres,
            },
        )
        .map_err(|error| PortFailure::Failed(error.message()))
    }

    /// Runs one read on the memory service built from the current environment.
    fn with_memory<T>(
        &self,
        operation: impl FnOnce(&MemoryService<'_>) -> Result<T, MemoryError>,
    ) -> PortResult<T> {
        let env = process_env();
        let runtime = self.memory_runtime(&env)?;
        let policy = memory_policy(&env);
        let service = runtime
            .memory_service(MemoryServiceDependencies {
                publisher: &NOOP_PUBLISHER,
                policy: &policy,
                counter: None,
            })
            .map_err(|error| PortFailure::Failed(error.message()))?;
        operation(&service).map_err(failed)
    }

    /// `process.env[key]`, trimmed, `None` when blank.
    fn env_text(&self, key: &str) -> Option<String> {
        self.env.get(key).filter(|value| !value.trim().is_empty())
    }

    fn channel_secret_configured(&self, channel: &str, key: &str) -> bool {
        let webhook_secret = format!("{}_WEBHOOK_SECRET", channel.to_ascii_uppercase());
        if self.env_text(&webhook_secret).is_some() {
            return true;
        }
        if channel == "discord" && self.env_text("DISCORD_PUBLIC_KEY").is_some() {
            return true;
        }
        self.channel_credential(channel, key).is_some()
    }

    fn fresh_memory(&self) -> Option<ProcessMemory> {
        let entry = *self
            .memory_cache
            .lock()
            .unwrap_or_else(PoisonError::into_inner);
        entry
            .filter(|(at, _)| at.elapsed() < MEMORY_CACHE_TTL)
            .map(|(_, usage)| usage)
    }
}

impl LogSource for RustDiagnostics {
    fn log_count(&self) -> PortResult<i64> {
        let repository = self.logs.lock().unwrap_or_else(PoisonError::into_inner);
        repository
            .get_log_count(&LogFilter::default())
            .map_err(failed)
    }

    fn recent_logs(&self, limit: usize) -> PortResult<Vec<LogRecord>> {
        self.logs_list(LogFilter {
            limit: Some(limit),
            ..LogFilter::default()
        })
    }

    fn recent_error_logs(&self, limit: usize) -> PortResult<Vec<LogRecord>> {
        self.logs_list(LogFilter {
            level: Some(LogLevel::Error),
            limit: Some(limit),
            ..LogFilter::default()
        })
    }

    fn record_memory_sample(&self, level: &str, message: &str, metadata: Value) -> PortResult<()> {
        let level = LogLevel::parse(level).unwrap_or(LogLevel::Info);
        let repository = self.logs.lock().unwrap_or_else(PoisonError::into_inner);
        write_log(
            &repository,
            Some(&self.registry),
            level,
            "MEM",
            message,
            Some(&metadata),
            Some(LogCategory::Diagnostics),
        )
        .map(|_| ())
        .map_err(failed)
    }
}

impl StatsSource for RustDiagnostics {
    fn usage_entry_count(&self) -> PortResult<i64> {
        let stats = self.stats.lock().unwrap_or_else(PoisonError::into_inner);
        stats.get_entry_count().map_err(failed)
    }
}

impl MemorySource for RustDiagnostics {
    fn provider_kind(&self) -> PortResult<String> {
        let runtime = self.memory_runtime(&process_env())?;
        runtime
            .provider_kind()
            .map(|kind| kind.as_str().to_string())
            .map_err(|error| PortFailure::Failed(error.message()))
    }

    fn node_count(&self) -> PortResult<i64> {
        self.with_memory(|service| service.count(None, None, None))
    }

    fn snapshot(&self) -> PortResult<Vec<MemoryNode>> {
        self.with_memory(|service| service.snapshot(None, None, None))
    }
}

impl KnowledgeSource for RustDiagnostics {
    fn knowledge_layer_enabled(&self) -> bool {
        resolve_knowledge_config(&process_env()).layer_enabled
    }

    fn knowledge_stats(&self, user_id: &str, persona_id: &str) -> PortResult<KnowledgeStats> {
        let db_path = self
            .env_text("KNOWLEDGE_DB_PATH")
            .unwrap_or_else(|| self.messages_db_path.clone());
        let repo = SqliteKnowledgeRepository::open(&db_path).map_err(failed)?;
        repo.get_knowledge_stats(user_id, persona_id)
            .map_err(failed)
    }
}

impl GatewaySource for RustDiagnostics {
    fn connection_count(&self) -> PortResult<usize> {
        Ok(self.registry.connection_count())
    }
}

impl SecuritySource for RustDiagnostics {
    fn security_snapshot(&self) -> PortResult<SecurityStatusSnapshot> {
        // The same generated fixture as `routes/security.rs`.
        let commands: Vec<CommandPermission> = serde_json::from_str(include_str!(
            "../../fixtures/security-rules.json"
        ))
        .map_err(|error| PortFailure::Failed(format!("Failed to read security rules: {error}")))?;
        // `APP_URL || NEXT_PUBLIC_APP_URL`, each ignored when blank.
        let app_url = self
            .env_text("APP_URL")
            .or_else(|| self.env_text("NEXT_PUBLIC_APP_URL"))
            .unwrap_or_default();
        let messages_db_path = Path::new(&self.messages_db_path);
        Ok(build_security_status_snapshot(&SnapshotInput {
            commands: &commands,
            app_url: &app_url,
            messages_db_path,
            // The Rust gateway always links the crypto primitives, as in routes/security.rs.
            secure_crypto: true,
            channel_secret_configured: &|channel: &str, key: &str| {
                self.channel_secret_configured(channel, key)
            },
        }))
    }
}

impl ProcessSource for RustDiagnostics {
    fn current_pid(&self) -> u32 {
        std::process::id()
    }

    fn uptime_secs(&self) -> u64 {
        self.started_at.elapsed().as_secs()
    }

    async fn process_memory(&self) -> PortResult<ProcessMemory> {
        if let Some(usage) = self.fresh_memory() {
            return Ok(usage);
        }
        let usage = probe_memory().await.map_err(PortFailure::Failed)?;
        *self
            .memory_cache
            .lock()
            .unwrap_or_else(PoisonError::into_inner) = Some((Instant::now(), usage));
        Ok(usage)
    }

    async fn node_processes(&self) -> PortResult<Vec<RawNodeProcess>> {
        list_node_processes().await.map_err(PortFailure::Failed)
    }
}

impl BridgeSource for RustDiagnostics {
    fn channel_credential(&self, channel: &str, key: &str) -> Option<String> {
        channel_credential(&self.messages_db_path, channel, key)
    }

    fn probe_health(
        &self,
        url: String,
        timeout_ms: u64,
    ) -> impl Future<Output = Result<HttpProbe, ProbeFailure>> + Send {
        let client = self.http.clone();
        async move {
            let response = client
                .get(url.as_str())
                .timeout(Duration::from_millis(timeout_ms))
                .send()
                .await
                .map_err(|error| ProbeFailure {
                    timed_out: error.is_timeout(),
                    message: error.to_string(),
                })?;
            let status = response.status();
            // The body is read only for a success, as the Node check does.
            let body = if status.is_success() {
                response.json::<Value>().await.unwrap_or_else(|_| json!({}))
            } else {
                json!({})
            };
            Ok(HttpProbe {
                status: status.as_u16(),
                body,
            })
        }
    }
}

impl RuntimeSource for RustDiagnostics {
    fn env_var(&self, name: &str) -> Option<String> {
        self.env.get(name)
    }

    /// `new URL(raw).toString()`, through the URL parser `reqwest` re-exports.
    fn normalize_url(&self, raw: &str) -> Option<String> {
        reqwest::Url::parse(raw).ok().map(|url| url.to_string())
    }

    fn now_ms(&self) -> i64 {
        chrono::Utc::now().timestamp_millis()
    }
}

impl DiagnosticsPort for RustDiagnostics {
    fn health(&self, memory_diagnostics: bool) -> PortFuture<'_, Value> {
        Box::pin(async move {
            let options = HealthOptions {
                timeout_ms: None,
                memory_diagnostics_enabled: memory_diagnostics,
            };
            let report = run_health_command(self, &options).await;
            serde_json::to_value(report).map_err(|error| PortError::Failed(error.to_string()))
        })
    }

    fn doctor(&self, memory_diagnostics: bool) -> PortFuture<'_, Value> {
        Box::pin(async move {
            let options = HealthOptions {
                timeout_ms: None,
                memory_diagnostics_enabled: memory_diagnostics,
            };
            let report = run_doctor_command(self, &options)
                .await
                .map_err(|failure| PortError::Failed(failure.message()))?;
            serde_json::to_value(report).map_err(|error| PortError::Failed(error.to_string()))
        })
    }
}

/// Runs a program and returns its stdout. The child is killed when the timeout
/// expires (`kill_on_drop`), as `execFile` with `timeout` does.
async fn run_with_timeout(program: &str, args: &[&str]) -> Result<String, String> {
    let child = tokio::process::Command::new(program)
        .args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .kill_on_drop(true)
        .spawn()
        .map_err(|error| error.to_string())?;
    let output = tokio::time::timeout(PROBE_TIMEOUT, child.wait_with_output())
        .await
        .map_err(|_| format!("{program} timed out"))?
        .map_err(|error| error.to_string())?;
    if !output.status.success() {
        return Err(format!("{program} exited with {}", output.status));
    }
    Ok(String::from_utf8_lossy(&output.stdout).into_owned())
}

/// Process memory and host memory, one reading.
async fn probe_memory() -> Result<ProcessMemory, String> {
    if cfg!(windows) {
        let script = format!(
            "$p = Get-Process -Id {}; $o = Get-CimInstance Win32_OperatingSystem; \"$($p.WorkingSet64) $($o.TotalVisibleMemorySize) $($o.FreePhysicalMemory)\"",
            std::process::id()
        );
        parse_windows_memory(
            &run_with_timeout("powershell", &["-NoProfile", "-Command", script.as_str()]).await?,
        )
    } else if cfg!(target_os = "linux") {
        let statm =
            std::fs::read_to_string("/proc/self/statm").map_err(|error| error.to_string())?;
        let meminfo =
            std::fs::read_to_string("/proc/meminfo").map_err(|error| error.to_string())?;
        parse_linux_memory(&statm, &meminfo)
    } else {
        Err("process memory is not measured on this platform".to_string())
    }
}

/// The `node` processes, as the Node probe lists them.
async fn list_node_processes() -> Result<Vec<RawNodeProcess>, String> {
    if cfg!(windows) {
        parse_windows_processes(
            &run_with_timeout(
                "powershell",
                &["-NoProfile", "-Command", NODE_LISTING_SCRIPT],
            )
            .await?,
        )
    } else {
        let listing = run_with_timeout("ps", &["-eo", "pid=,rss=,comm=,args="]).await?;
        Ok(parse_ps_output(&listing))
    }
}

/// `/proc/self/statm` (resident pages) and `/proc/meminfo` (`MemTotal`, `MemAvailable`).
fn parse_linux_memory(statm: &str, meminfo: &str) -> Result<ProcessMemory, String> {
    let resident_pages: u64 = statm
        .split_whitespace()
        .nth(1)
        .and_then(|field| field.parse().ok())
        .ok_or("unreadable /proc/self/statm")?;
    let field_kib = |name: &str| {
        meminfo.lines().find_map(|line| {
            let rest = line.strip_prefix(name)?.strip_prefix(':')?;
            rest.split_whitespace().next()?.parse::<u64>().ok()
        })
    };
    let total = field_kib("MemTotal").ok_or("MemTotal missing from /proc/meminfo")?;
    let available = field_kib("MemAvailable").ok_or("MemAvailable missing from /proc/meminfo")?;
    Ok(ProcessMemory {
        rss_bytes: resident_pages * LINUX_PAGE_BYTES,
        system_total_bytes: total * 1024,
        system_free_bytes: available * 1024,
    })
}

/// The three numbers of the PowerShell memory script: working set in bytes, total
/// and free physical memory in KiB.
fn parse_windows_memory(text: &str) -> Result<ProcessMemory, String> {
    let numbers = text
        .split_whitespace()
        .map(str::parse::<u64>)
        .collect::<Result<Vec<u64>, _>>()
        .map_err(|error| format!("unreadable memory probe: {error}"))?;
    match numbers.as_slice() {
        [rss, total_kib, free_kib] => Ok(ProcessMemory {
            rss_bytes: *rss,
            system_total_bytes: total_kib * 1024,
            system_free_bytes: free_kib * 1024,
        }),
        _ => Err("unreadable memory probe".to_string()),
    }
}

/// `ps -eo pid=,rss=,comm=,args=` rows whose name or command mentions `node`.
/// `rss` is in KiB. A command that is missing falls back to the name.
fn parse_ps_output(listing: &str) -> Vec<RawNodeProcess> {
    listing
        .lines()
        .filter_map(|line| {
            let mut fields = line.split_whitespace();
            let pid: u32 = fields.next()?.parse().ok()?;
            let rss_kib: u64 = fields.next()?.parse().ok()?;
            let name = fields.next()?.to_string();
            let args = fields.collect::<Vec<_>>().join(" ");
            let command = if args.is_empty() { name.clone() } else { args };
            if !format!("{name} {command}").to_lowercase().contains("node") {
                return None;
            }
            Some(RawNodeProcess {
                pid,
                rss_bytes: rss_kib * 1024,
                private_bytes: None,
                command,
            })
        })
        .collect()
}

/// The JSON of [`NODE_LISTING_SCRIPT`]: one object or an array. Rows without a
/// numeric pid and working set are dropped, as `Number.isFinite` drops them.
fn parse_windows_processes(text: &str) -> Result<Vec<RawNodeProcess>, String> {
    let trimmed = text.trim();
    if trimmed.is_empty() {
        return Ok(Vec::new());
    }
    let parsed: Value = serde_json::from_str(trimmed).map_err(|error| error.to_string())?;
    let rows = match parsed {
        Value::Array(rows) => rows,
        single => vec![single],
    };
    Ok(rows
        .iter()
        .filter_map(|row| {
            Some(RawNodeProcess {
                pid: u32::try_from(row.get("pid")?.as_u64()?).ok()?,
                rss_bytes: row.get("rssBytes")?.as_u64()?,
                private_bytes: row.get("privateBytes").and_then(Value::as_u64),
                command: row
                    .get("command")
                    .and_then(Value::as_str)
                    .unwrap_or_default()
                    .to_string(),
            })
        })
        .collect())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::families::ops_wire::test_support::{scratch, ScratchDir};
    use betaclaw_core::config::LEGACY_LOCAL_USER_ID;
    use betaclaw_core::gateway::registry::ClientRegistry;

    #[test]
    fn the_diagnostics_factory_builds_the_canonical_memory_client() {
        use betaclaw_core::memory::types::MemoryProviderKind;
        use betaclaw_core::world_model::db::UnconfiguredPgExecutor;

        let transport: Arc<dyn HttpTransport> = Arc::new(ReqwestTransport::new());
        let with_pool = DiagnosticsMemoryFactory {
            transport: Arc::clone(&transport),
            postgres: Some(Arc::new(UnconfiguredPgExecutor)),
        };
        let client = with_pool
            .create(ConfiguredProvider::Postgres, &HashMap::new())
            .expect("a pool yields the canonical memory client");
        assert_eq!(client.provider(), Some(MemoryProviderKind::Postgres));

        let without_pool = DiagnosticsMemoryFactory {
            transport,
            postgres: None,
        };
        assert!(without_pool
            .create(ConfiguredProvider::Postgres, &HashMap::new())
            .is_err());
    }

    fn diagnostics_in(scratch: &ScratchDir) -> RustDiagnostics {
        let env = EnvOverrides::new();
        RustDiagnostics::open(DiagnosticsDeps {
            env: &env,
            logs_db_path: &scratch.path("logs.db"),
            stats_db_path: &scratch.path("stats.db"),
            messages_db_path: &scratch.path("messages.db"),
            registry: Arc::new(ClientRegistry::new()),
            http: reqwest::Client::new(),
        })
        .expect("diagnostics open")
    }

    #[test]
    fn ps_listing_keeps_only_node_rows_and_falls_back_to_the_name() {
        let listing = "  101 2048 node     node /srv/app.js --port 3001\n\
                       202 4096 postgres /usr/bin/postgres\n\
                       303 1024 node\n";
        let rows = parse_ps_output(listing);
        assert_eq!(rows.len(), 2);
        assert_eq!(rows[0].pid, 101);
        assert_eq!(rows[0].rss_bytes, 2048 * 1024);
        assert_eq!(rows[0].command, "node /srv/app.js --port 3001");
        assert_eq!(rows[1].pid, 303);
        assert_eq!(rows[1].command, "node");
        assert_eq!(rows[1].private_bytes, None);
    }

    #[test]
    fn windows_process_json_reads_arrays_objects_and_empty_output() {
        let array = r#"[{"pid":7,"rssBytes":512,"privateBytes":256,"command":"node.exe x.js"},{"pid":"bad"}]"#;
        let rows = parse_windows_processes(array).expect("array");
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].private_bytes, Some(256));

        let single = r#"{"pid":8,"rssBytes":64,"command":null}"#;
        let rows = parse_windows_processes(single).expect("object");
        assert_eq!(rows[0].pid, 8);
        assert_eq!(rows[0].command, "");

        assert!(parse_windows_processes("  \n").expect("empty").is_empty());
        assert!(parse_windows_processes("{not json").is_err());
    }

    #[test]
    fn linux_memory_reads_statm_pages_and_meminfo_kib() {
        let statm = "2000 300 10 1 0 50 0\n";
        let meminfo = "MemTotal:       16000 kB\nMemFree:  1 kB\nMemAvailable:    4000 kB\n";
        let usage = parse_linux_memory(statm, meminfo).expect("linux");
        assert_eq!(usage.rss_bytes, 300 * 4_096);
        assert_eq!(usage.system_total_bytes, 16_000 * 1024);
        assert_eq!(usage.system_free_bytes, 4_000 * 1024);

        assert!(parse_linux_memory(statm, "MemTotal: 1 kB\n").is_err());
    }

    #[test]
    fn windows_memory_reads_three_numbers() {
        let usage = parse_windows_memory("1048576 8000000 2000000\n").expect("windows");
        assert_eq!(usage.rss_bytes, 1_048_576);
        assert_eq!(usage.system_total_bytes, 8_000_000 * 1024);
        assert_eq!(usage.system_free_bytes, 2_000_000 * 1024);
        assert!(parse_windows_memory("1 2").is_err());
    }

    #[test]
    fn channel_credential_is_none_without_a_messages_database() {
        let scratch = scratch();
        let diagnostics = diagnostics_in(&scratch);
        assert_eq!(
            BridgeSource::channel_credential(&diagnostics, "whatsapp", "pairing_status"),
            None
        );
    }

    #[test]
    fn log_port_writes_and_reads_memory_samples_through_the_repository() {
        let scratch = scratch();
        let diagnostics = diagnostics_in(&scratch);
        assert_eq!(diagnostics.log_count(), Ok(0));

        diagnostics
            .record_memory_sample(
                "warn",
                "memory.diagnostics.sample:85.0% memory in use",
                json!({ "ratio": 0.85 }),
            )
            .expect("sample written");

        assert_eq!(diagnostics.log_count(), Ok(1));
        let rows = diagnostics.recent_logs(10).expect("rows");
        assert_eq!(rows[0].source, "MEM");
        assert_eq!(rows[0].category, "diagnostics");
        assert_eq!(rows[0].level, "warn");
        assert!(diagnostics
            .recent_error_logs(10)
            .expect("errors")
            .is_empty());
    }

    #[test]
    fn knowledge_stats_reads_the_sqlite_knowledge_repository() {
        let scratch = scratch();
        let diagnostics = diagnostics_in(&scratch);
        let stats = diagnostics
            .knowledge_stats(LEGACY_LOCAL_USER_ID, "")
            .expect("knowledge stats");
        assert_eq!(stats.episode_count, 0);
        assert_eq!(stats.ledger_count, 0);
        assert_eq!(stats.retrieval_error_count, 0);
        assert_eq!(stats.latest_ingestion_at, None);
    }

    #[test]
    fn normalize_url_follows_the_url_parser() {
        let scratch = scratch();
        let diagnostics = diagnostics_in(&scratch);
        assert_eq!(
            diagnostics.normalize_url("https://hooks.example"),
            Some("https://hooks.example/".to_string())
        );
        assert_eq!(diagnostics.normalize_url("not a url"), None);
    }

    #[tokio::test]
    async fn health_and_doctor_reports_have_the_route_shape() {
        let scratch = scratch();
        let diagnostics = diagnostics_in(&scratch);

        let health = diagnostics.health(false).await.expect("health");
        assert!(matches!(
            health["status"].as_str(),
            Some("ok" | "degraded" | "critical")
        ));
        let checks = health["checks"].as_array().expect("checks array");
        assert_eq!(checks.len(), 11);
        assert_eq!(checks[0]["id"], "core.logging_repository");
        assert_eq!(checks[0]["status"], "ok");
        assert!(health["summary"]["skipped"].as_u64().unwrap_or(0) > 0);

        let doctor = diagnostics.doctor(false).await.expect("doctor");
        assert!(doctor["findings"].is_array());
        assert!(doctor["recommendations"].is_array());
        assert!(doctor["generatedAt"].is_string());
    }
}
