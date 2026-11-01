//! `betaclaw-scheduler drill [--scenario <name>]` replaces `pnpm run world-model:drill`
//! (`scripts/world-model-failure-drill.ts`, with `scripts/world-model-scheduler-restart-child.ts`).
//!
//! Controlled failure scenarios that check the system degrades or recovers as designed.
//! Scenarios: `postgres-outage`, `scheduler-restart`, `graphiti-outage`,
//! `embedder-outage`, `duplicate-webhook`, `all` (default). An unknown name runs
//! nothing and reports `Total: 0 passed, 0 failed`, as the script does.
//!
//! The scheduler-restart scenario starts this binary again as a child with the
//! hidden subcommand `drill-lease-child <owner> <ttl_ms>`. The child claims the
//! automation lease of `AUTOMATION_DB_PATH` and stays alive until it is terminated.
//!
//! The scenarios use the process environment only. `scripts/rust-scheduler-ops.mjs`
//! loads `.env.local` before it starts the binary.

use std::process::Stdio;
use std::sync::Arc;
use std::time::{Duration, Instant};

use betaclaw_core::automation::service::AutomationService;
use betaclaw_core::model_hub::http::HttpTransport;
use betaclaw_core::world_model::config::WorldModelConfig;
use betaclaw_core::world_model::data_lifecycle::{delete_world_model_scope, ScopeSelector};
use betaclaw_core::world_model::graphiti::client::GraphitiRestClient;
use betaclaw_core::world_model::retrieval::index::{
    retrieve_context, RetrievalContextResult, RetrievalDeps, RetrieveContextInput,
};
use betaclaw_core::world_model::scope::WorldModelScope;
use betaclaw_core::world_model::services::observation_service::{
    derive_write_health, record_observation, WorldModelWriteHealth,
};
use betaclaw_core::world_model::types::{ObservationInput, ObservationSourceType};
use serde_json::{json, Map, Value};
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::process::{Child, Command};

use super::{connect_lazy_executor, connect_url, env_or, iso_now, js_number, load_config};
use crate::families::chat_runtime::world::PgEventTimeline;
use crate::families::master::automation::UnwiredPromptRunner;
use crate::model_hub_embedding::ConfiguredQueryEmbedder;

/// The scenarios of `all`, in the order of the script.
const ALL_SCENARIOS: [&str; 5] = [
    "postgres-outage",
    "scheduler-restart",
    "graphiti-outage",
    "embedder-outage",
    "duplicate-webhook",
];
/// A dedicated endpoint nothing listens on; the shared database is never stopped.
const OUTAGE_DATABASE_URL: &str = "postgresql://drill:drill@127.0.0.1:59999/drill";
const GRAPHITI_OUTAGE_URL: &str = "http://127.0.0.1:59998/graphiti-outage";
const EMBEDDING_OUTAGE_URL: &str = "http://127.0.0.1:9999/outage-embeddings";
/// `withDrillTimeout(promise)` default.
const DRILL_TIMEOUT: Duration = Duration::from_millis(5_000);
/// The lease TTL of the restart scenario, and the wait after the first child ends.
const LEASE_TTL_MS: i64 = 250;
const LEASE_EXPIRY_MARGIN: Duration = Duration::from_millis(150);
/// Readiness timeout of a child.
const CHILD_READY_TIMEOUT: Duration = Duration::from_millis(5_000);
/// The embedding variables a scenario clears before it forces the outage.
const EMBEDDING_KEYS: [&str; 6] = [
    "EMBEDDING_API_URL",
    "EMBEDDING_API_KEY",
    "EMBEDDING_MODEL",
    "EMBEDDING_TIMEOUT_MS",
    "OPENAI_API_KEY",
    "OPENAI_BASE_URL",
];

/// One scenario's outcome (`DrillResult`).
#[derive(Debug, Clone, PartialEq)]
pub struct DrillResult {
    pub scenario: String,
    pub passed: bool,
    pub details: String,
    pub duration_ms: u128,
}

/// `parseArgs`: the value of `--scenario`, `all` when it is missing or empty.
pub fn parse_scenario(args: &[String]) -> String {
    let mut scenario = "all".to_string();
    let mut index = 0;
    while index < args.len() {
        if args[index] == "--scenario" {
            if let Some(value) = args.get(index + 1).filter(|value| !value.is_empty()) {
                scenario = value.clone();
                index += 1;
            }
        }
        index += 1;
    }
    scenario
}

/// Runs the drills and prints the report. Returns the exit status.
pub async fn run(args: &[String]) -> i32 {
    let scenario = parse_scenario(args);
    let results = run_drills(&scenario).await;
    println!();
    println!("=== Drill Results ===");
    let mut passed = 0;
    let mut failed = 0;
    for result in &results {
        let icon = if result.passed { "✅" } else { "❌" };
        println!(
            "{icon} {}: {} ({}ms)",
            result.scenario, result.details, result.duration_ms
        );
        if result.passed {
            passed += 1;
        } else {
            failed += 1;
        }
    }
    println!();
    println!("Total: {passed} passed, {failed} failed");
    if failed > 0 {
        1
    } else {
        0
    }
}

/// The scenarios of a selection, with the header lines of the script.
async fn run_drills(scenario: &str) -> Vec<DrillResult> {
    let scenarios: Vec<&str> = if scenario == "all" {
        ALL_SCENARIOS.to_vec()
    } else {
        vec![scenario]
    };
    println!("=== World Model Failure Drills ===");
    println!("Scenarios: {}", scenarios.join(", "));
    println!();

    let mut results = Vec::new();
    for name in scenarios {
        let result = match name {
            "postgres-outage" => Some(postgres_outage().await),
            "scheduler-restart" => Some(scheduler_restart().await),
            "duplicate-webhook" => Some(duplicate_webhook().await),
            "embedder-outage" => Some(embedder_outage().await),
            "graphiti-outage" => Some(graphiti_outage().await),
            _ => None,
        };
        results.extend(result);
    }
    results
}

/// The result of a failed setup step (`catch` of every scenario).
fn error_result(scenario: &str, started: Instant, message: &str) -> DrillResult {
    DrillResult {
        scenario: scenario.to_string(),
        passed: false,
        details: format!("Error: {message}"),
        duration_ms: started.elapsed().as_millis(),
    }
}

/// The result when World Model is disabled (`Blocked: ...`).
fn blocked_result(scenario: &str, started: Instant, details: &str) -> DrillResult {
    DrillResult {
        scenario: scenario.to_string(),
        passed: false,
        details: details.to_string(),
        duration_ms: started.elapsed().as_millis(),
    }
}

/// `!config.enabled && !config.e2eEnabled`.
fn world_model_off(config: &WorldModelConfig) -> bool {
    !config.enabled && !config.e2e_enabled
}

/// The write-health names of the script (`'healthy' | 'degraded' | 'blocked'`).
fn health_name(health: WorldModelWriteHealth) -> &'static str {
    match health {
        WorldModelWriteHealth::Healthy => "healthy",
        WorldModelWriteHealth::Degraded => "degraded",
        WorldModelWriteHealth::Blocked => "blocked",
    }
}

/// The retrieval source names of the script (`result.source`).
fn source_name(result: &RetrievalContextResult) -> &'static str {
    use betaclaw_core::world_model::retrieval::index::RetrievalSource;
    match result.source {
        RetrievalSource::Structured => "structured",
        RetrievalSource::Fulltext => "fulltext",
        RetrievalSource::Vector => "vector",
        RetrievalSource::Graphiti => "graphiti",
        RetrievalSource::None => "none",
    }
}

/// Sets the variables of a scenario and returns what they were before (`undefined`
/// becomes `None`), so the scenario can restore them afterwards.
fn set_env(values: &[(&str, Option<&str>)]) -> Vec<(String, Option<String>)> {
    values
        .iter()
        .map(|(key, value)| {
            let previous = std::env::var(key).ok();
            match value {
                Some(value) => std::env::set_var(key, value),
                None => std::env::remove_var(key),
            }
            (key.to_string(), previous)
        })
        .collect()
}

/// Restores the values returned by [`set_env`].
fn restore_env(previous: Vec<(String, Option<String>)>) {
    for (key, value) in previous {
        match value {
            Some(value) => std::env::set_var(&key, value),
            None => std::env::remove_var(&key),
        }
    }
}

/// `drillPostgresOutage`: a connection to a dedicated unused endpoint must fail, and
/// the write health must be `blocked` in canonical mode when a write fails.
async fn postgres_outage() -> DrillResult {
    const SCENARIO: &str = "postgres-outage";
    let started = Instant::now();
    println!("--- Drill: PostgreSQL Outage ---");

    let config = load_config();
    if world_model_off(&config) {
        return blocked_result(
            SCENARIO,
            started,
            "Blocked: World Model is disabled; this outage drill is not active.",
        );
    }
    let mode = config.mode.as_str();

    let outage_detected = connect_url(OUTAGE_DATABASE_URL, 1, 5_000).await.is_err();
    let health_ok = health_name(derive_write_health(true, mode));
    let health_fail = health_name(derive_write_health(false, mode));
    println!("  [INFO] Write health: ok={health_ok}, fail={health_fail}");
    println!("  [INFO] Mode: {mode}");

    let passed = outage_detected && !(mode == "canonical" && health_fail != "blocked");
    let duration_ms = started.elapsed().as_millis();
    if !passed {
        return DrillResult {
            scenario: SCENARIO.to_string(),
            passed: false,
            details: format!(
                "OutageDetected={outage_detected}; write health on failure={health_fail}"
            ),
            duration_ms,
        };
    }
    DrillResult {
        scenario: SCENARIO.to_string(),
        passed: true,
        details: format!(
            "Injected connection outage detected; write health: ok={health_ok}, fail={health_fail} (mode={mode})"
        ),
        duration_ms,
    }
}

/// A child of the restart scenario: the process and whether it claimed the lease.
struct LeaseChild {
    child: Child,
    claimed: bool,
}

/// Starts this binary as a lease child and reads its readiness line (`startChild`).
async fn start_lease_child(owner: &str, database_path: &str) -> Result<LeaseChild, String> {
    let executable = std::env::current_exe().map_err(|error| error.to_string())?;
    let mut child = Command::new(executable)
        .arg("drill-lease-child")
        .arg(owner)
        .arg(LEASE_TTL_MS.to_string())
        .env("AUTOMATION_DB_PATH", database_path)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true)
        .spawn()
        .map_err(|error| error.to_string())?;
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| "scheduler child has no stdout".to_string())?;
    let mut lines = BufReader::new(stdout).lines();

    let ready = async {
        loop {
            match lines.next_line().await {
                Ok(Some(line)) if line.trim_start().starts_with('{') => {
                    let value: Value =
                        serde_json::from_str(line.trim()).map_err(|error| error.to_string())?;
                    return Ok::<bool, String>(
                        value
                            .get("claimed")
                            .and_then(Value::as_bool)
                            .unwrap_or(false),
                    );
                }
                Ok(Some(_)) => continue,
                Ok(None) => {
                    let code = child.wait().await.ok().and_then(|status| status.code());
                    return Err(format!(
                        "scheduler child exited before claiming lease (code={})",
                        code.map(|value| value.to_string())
                            .unwrap_or_else(|| "null".into())
                    ));
                }
                Err(error) => return Err(error.to_string()),
            }
        }
    };
    let claimed = match tokio::time::timeout(CHILD_READY_TIMEOUT, ready).await {
        Ok(outcome) => outcome?,
        Err(_) => return Err("scheduler child readiness timeout".to_string()),
    };
    Ok(LeaseChild { child, claimed })
}

/// Terminates a child and waits until it has exited.
async fn stop_child(child: &mut Child) {
    let _ = child.start_kill();
    let _ = child.wait().await;
}

/// `drillSchedulerRestart`: a child that claimed the lease is terminated, and a
/// restarted child reclaims it once the TTL has expired.
async fn scheduler_restart() -> DrillResult {
    const SCENARIO: &str = "scheduler-restart";
    let started = Instant::now();
    println!("--- Drill: Scheduler Restart ---");

    let config = load_config();
    if world_model_off(&config) {
        return blocked_result(
            SCENARIO,
            started,
            "Blocked: World Model is disabled; scheduler recovery is not active.",
        );
    }

    let outcome = async {
        let root = std::env::temp_dir().join(format!(
            "world-model-scheduler-drill-{}",
            uuid::Uuid::new_v4()
        ));
        std::fs::create_dir_all(&root).map_err(|error| error.to_string())?;
        let database_path = root.join("automation.db").to_string_lossy().into_owned();

        let first_owner = format!(
            "world-model-drill-child-{}-{}",
            std::process::id(),
            chrono::Utc::now().timestamp_millis()
        );
        let second_owner = format!("{first_owner}-restarted");
        let mut first = start_lease_child(&first_owner, &database_path).await?;
        stop_child(&mut first.child).await;
        tokio::time::sleep(Duration::from_millis(LEASE_TTL_MS as u64) + LEASE_EXPIRY_MARGIN).await;
        let mut second = start_lease_child(&second_owner, &database_path).await?;
        stop_child(&mut second.child).await;
        let _ = std::fs::remove_dir_all(&root);
        Ok::<(bool, bool), String>((first.claimed, second.claimed))
    }
    .await;

    match outcome {
        Err(message) => error_result(SCENARIO, started, &message),
        Ok((first_claimed, second_claimed)) => {
            if !first_claimed || !second_claimed {
                return DrillResult {
                    scenario: SCENARIO.to_string(),
                    passed: false,
                    details: format!(
                        "Process-boundary lease recovery failed: first={first_claimed}, restarted={second_claimed}"
                    ),
                    duration_ms: started.elapsed().as_millis(),
                };
            }
            println!(
                "  [PASS] Independent scheduler process reclaimed the lease after termination"
            );
            DrillResult {
                scenario: SCENARIO.to_string(),
                passed: true,
                details: "Independent scheduler child claimed the lease, was terminated, and a restarted child reclaimed it after TTL expiry".to_string(),
                duration_ms: started.elapsed().as_millis(),
            }
        }
    }
}

/// `drillDuplicateWebhook`: an identical observation written twice yields one row.
async fn duplicate_webhook() -> DrillResult {
    const SCENARIO: &str = "duplicate-webhook";
    let started = Instant::now();
    println!("--- Drill: Duplicate Webhook ---");

    let config = load_config();
    if world_model_off(&config) {
        return blocked_result(
            SCENARIO,
            started,
            "Blocked: World Model is disabled; idempotency is not active.",
        );
    }

    let outcome = async {
        let executor = connect_lazy_executor(&config).map_err(|error| error.into_message())?;
        let scope = WorldModelScope::new("drill-user", "drill-persona", Some(String::new()));
        let source_id = format!("drill:duplicate-webhook:{}", uuid::Uuid::new_v4());
        let mut payload = Map::new();
        payload.insert("drill".into(), json!("duplicate-webhook"));
        payload.insert("sourceId".into(), json!(source_id));
        let input = ObservationInput {
            user_id: scope.user_id.clone(),
            persona_id: scope.persona_id.clone(),
            workspace_id: scope.workspace_id.clone(),
            source_type: ObservationSourceType::ChatMessage,
            source_id: source_id.clone(),
            occurred_at: iso_now(),
            payload,
            source_authority: Some("drill".to_string()),
        };
        let first = record_observation(&executor, input.clone(), Some(&scope), &config)
            .await
            .map_err(|error| error.into_message())?;
        let second = record_observation(&executor, input, Some(&scope), &config)
            .await
            .map_err(|error| error.into_message())?;
        let idempotent =
            first.created && !second.created && first.observation.id == second.observation.id;
        let selector = ScopeSelector {
            user_id: Some(scope.user_id.clone()),
            persona_id: Some(scope.persona_id.clone()),
            workspace_id: scope.workspace_id.clone(),
        };
        let cleanup = delete_world_model_scope(&executor, &selector).await;
        executor.close().await;
        cleanup.map_err(|error| error.into_message())?;
        Ok::<(bool, bool, bool), String>((first.created, second.created, idempotent))
    }
    .await;

    match outcome {
        Err(message) => error_result(SCENARIO, started, &message),
        Ok((_, _, true)) => {
            println!("  [PASS] Identical webhook replay returned the same observation");
            DrillResult {
                scenario: SCENARIO.to_string(),
                passed: true,
                details: "The observation writer deduplicates identical scoped source identities"
                    .to_string(),
                duration_ms: started.elapsed().as_millis(),
            }
        }
        Ok((first_created, second_created, false)) => DrillResult {
            scenario: SCENARIO.to_string(),
            passed: false,
            details: format!(
                "Replay was not idempotent: firstCreated={first_created}, secondCreated={second_created}"
            ),
            duration_ms: started.elapsed().as_millis(),
        },
    }
}

/// `drillEmbedderOutage`: retrieval still answers when the embedding endpoint fails.
async fn embedder_outage() -> DrillResult {
    const SCENARIO: &str = "embedder-outage";
    let started = Instant::now();
    println!("--- Drill: Embedder Outage ---");

    let config = load_config();
    if world_model_off(&config) {
        return blocked_result(
            SCENARIO,
            started,
            "Blocked: World Model is disabled; retrieval degradation is not active.",
        );
    }

    let mut overrides: Vec<(&str, Option<&str>)> =
        EMBEDDING_KEYS.iter().map(|key| (*key, None)).collect();
    overrides.push(("EMBEDDING_API_URL", Some(EMBEDDING_OUTAGE_URL)));
    overrides.push(("EMBEDDING_API_KEY", Some("drill-key")));
    overrides.push(("EMBEDDING_TIMEOUT_MS", Some("500")));
    let previous = set_env(&overrides);

    let input = RetrieveContextInput {
        user_id: "drill-test".into(),
        persona_id: "drill-test".into(),
        workspace_id: Some(String::new()),
        query: "test query".into(),
        limit: Some(5),
        as_of_known_time: None,
        as_of_valid_time: None,
    };
    let retrieval = async {
        let executor = connect_lazy_executor(&config).map_err(|error| error.into_message())?;
        let transport: Arc<dyn HttpTransport> =
            Arc::new(crate::model_hub_transport::ReqwestTransport::new());
        let graphiti = GraphitiRestClient::from_env(transport);
        let deps = RetrievalDeps {
            executor: &executor,
            embedder: &ConfiguredQueryEmbedder,
            timeline: &PgEventTimeline,
            graphiti: &graphiti,
        };
        let result = retrieve_context(&config, &deps, &input).await;
        executor.close().await;
        Ok::<RetrievalContextResult, String>(result)
    };
    let outcome = tokio::time::timeout(DRILL_TIMEOUT, retrieval).await;
    restore_env(previous);

    let result = match outcome {
        Err(_) => {
            return error_result(
                SCENARIO,
                started,
                &format!("drill timeout after {}ms", DRILL_TIMEOUT.as_millis()),
            )
        }
        Ok(Err(message)) => return error_result(SCENARIO, started, &message),
        Ok(Ok(result)) => result,
    };

    let source = source_name(&result);
    println!("  [INFO] Retrieval source: {source}");
    println!("  [INFO] Structured hits: {}", result.structured.len());
    println!("  [INFO] Fulltext hits: {}", result.full_text.len());
    println!("  [INFO] Vector hits: {}", result.vector.len());

    if !result.enabled {
        return DrillResult {
            scenario: SCENARIO.to_string(),
            passed: false,
            details: "World Model became disabled during the embedder outage drill.".to_string(),
            duration_ms: started.elapsed().as_millis(),
        };
    }
    DrillResult {
        scenario: SCENARIO.to_string(),
        passed: true,
        details: format!("Retrieval works without embeddings (source={source})"),
        duration_ms: started.elapsed().as_millis(),
    }
}

/// `drillGraphitiOutage`: Graphiti is unreachable and PostgreSQL retrieval still runs.
async fn graphiti_outage() -> DrillResult {
    const SCENARIO: &str = "graphiti-outage";
    let started = Instant::now();
    println!("--- Drill: Graphiti Outage ---");

    let config = load_config();
    if !config.graphiti_shadow_enabled && !config.graphiti_backend_enabled {
        return blocked_result(
            SCENARIO,
            started,
            "Blocked: Graphiti is disabled; no provider outage boundary is active.",
        );
    }

    let previous = set_env(&[("GRAPHITI_BASE_URL", Some(GRAPHITI_OUTAGE_URL))]);
    let outcome = async {
        let transport: Arc<dyn HttpTransport> =
            Arc::new(crate::model_hub_transport::ReqwestTransport::new());
        let graphiti = GraphitiRestClient::from_env(transport);
        let health = graphiti.health().await;
        let executor = connect_lazy_executor(&config).map_err(|error| error.into_message())?;
        let deps = RetrievalDeps {
            executor: &executor,
            embedder: &ConfiguredQueryEmbedder,
            timeline: &PgEventTimeline,
            graphiti: &graphiti,
        };
        let input = RetrieveContextInput {
            user_id: "drill-user".into(),
            persona_id: "drill-persona".into(),
            workspace_id: Some(String::new()),
            query: "graphiti outage fallback".into(),
            limit: Some(5),
            as_of_known_time: None,
            as_of_valid_time: None,
        };
        let fallback = retrieve_context(&config, &deps, &input).await;
        executor.close().await;
        Ok::<_, String>((health.reachable, fallback))
    }
    .await;
    restore_env(previous);

    match outcome {
        Err(message) => error_result(SCENARIO, started, &message),
        Ok((reachable, fallback)) => DrillResult {
            scenario: SCENARIO.to_string(),
            passed: !reachable && fallback.enabled,
            details: format!(
                "Graphiti reachable={reachable}; PostgreSQL fallback enabled={}, source={}",
                fallback.enabled,
                source_name(&fallback)
            ),
            duration_ms: started.elapsed().as_millis(),
        },
    }
}

/// The hidden child of the restart scenario: `drill-lease-child <owner> <ttl_ms>`.
/// It prints `{"claimed":...,"owner":...}` on stdout, then holds the process open
/// until it is terminated. Exit 1 when the lease was not claimed.
pub async fn lease_child(args: &[String]) -> i32 {
    let Some(owner) = args.first().filter(|value| !value.is_empty()) else {
        eprintln!("owner is required");
        return 2;
    };
    let ttl_ms = js_number(args.get(1).map(String::as_str))
        .map(|value| value as i64)
        .unwrap_or(LEASE_TTL_MS);
    let database_path = env_or("AUTOMATION_DB_PATH", ".local/automation.db");
    let service =
        match betaclaw_core::automation::sqlite_repository::SqliteAutomationRepository::open(
            &database_path,
        ) {
            Ok(repository) => AutomationService::new(repository, UnwiredPromptRunner),
            Err(error) => {
                eprintln!("{error}");
                return 1;
            }
        };
    let claimed = match service.acquire_lease(owner, ttl_ms, &iso_now()) {
        Ok(claimed) => claimed,
        Err(error) => {
            eprintln!("{error}");
            return 1;
        }
    };
    println!("{}", json!({ "claimed": claimed, "owner": owner }));
    if !claimed {
        return 1;
    }
    std::future::pending::<()>().await;
    0
}
