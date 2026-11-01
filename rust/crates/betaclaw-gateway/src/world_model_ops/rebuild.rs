//! `betaclaw-scheduler rebuild-projections` replaces
//! `pnpm run world-model:rebuild-projections` (`scripts/world-model-rebuild-projections.ts`,
//! Phase 13).
//!
//! It rebuilds the derived projections of one scope from PostgreSQL: the embeddings
//! (delete, then embed again in batches) and the Graphiti graph (clear the group,
//! then project again). Without a scope a live run is refused, so RLS cannot turn an
//! unscoped run into a false success.
//!
//! Usage:
//!   betaclaw-scheduler rebuild-projections --dry-run
//!   betaclaw-scheduler rebuild-projections --type embeddings --scope u:p:w
//!   betaclaw-scheduler rebuild-projections --type graphiti --scope u:p:w --resume
//!
//! Flags: `--type all|embeddings|graphiti` (default `all`; other values run nothing),
//! `--scope`, `--resume`, `--batch-size` (1 to 500, default 50), `--include-observations`,
//! `--output`. Exit status 0 on success, 1 on failure, which also writes the failure
//! report when `--output` is given.

use std::collections::HashMap;
use std::sync::Arc;

use betaclaw_core::model_hub::http::HttpTransport;
use betaclaw_core::world_model::db::{
    scoped_query, NormalizedScope, PgError, PgStatement, PgValue,
};
use betaclaw_core::world_model::driver::SqlxPgExecutor;
use betaclaw_core::world_model::embeddings::embedding_worker::{
    collect_embedding_targets, process_embedding_batch, EmbeddingWorkerDeps,
};
use betaclaw_core::world_model::embeddings::provider::configured_embedding_provider;
use betaclaw_core::world_model::graphiti::client::GraphitiRestClient;
use betaclaw_core::world_model::graphiti::projector::{
    rebuild_graphiti_from_postgres, RebuildGraphitiInput, RebuildResult,
};
use betaclaw_core::world_model::scope::WorldModelScope;
use serde_json::{json, Map, Value};

use super::{connect_lazy_executor, load_config, migrate, parse_scope, process_env};
use crate::model_hub_embedding::model_hub_embedding_provider;
use crate::model_hub_transport::ReqwestTransport;

/// `Math.min(10_000, …)` of the collection (`rebuild-projections.ts:131`).
const EMBEDDING_TARGET_LIMIT: f64 = 10_000.0;
const DEFAULT_BATCH_SIZE: i64 = 50;

/// The flags (`parseArgs`, `rebuild-projections.ts:47-71`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RebuildOptions {
    pub dry_run: bool,
    pub kind: String,
    pub scope: Option<String>,
    pub resume: bool,
    pub batch_size: i64,
    pub include_observations: bool,
    pub output: Option<String>,
}

impl Default for RebuildOptions {
    fn default() -> Self {
        Self {
            dry_run: false,
            kind: "all".to_string(),
            scope: None,
            resume: false,
            batch_size: DEFAULT_BATCH_SIZE,
            include_observations: false,
            output: None,
        }
    }
}

/// `Math.max(1, Math.min(500, Number(v) || 50))`: a value that is not a number, or
/// zero, gives the default.
pub fn parse_batch_size(value: Option<&str>) -> i64 {
    let number = value
        .and_then(|text| text.trim().parse::<f64>().ok())
        .filter(|number| *number != 0.0 && !number.is_nan())
        .unwrap_or(DEFAULT_BATCH_SIZE as f64);
    (number as i64).clamp(1, 500)
}

/// Reads the arguments the way the script does, `args[++i]` included.
pub fn parse_args(args: &[String]) -> RebuildOptions {
    let mut options = RebuildOptions::default();
    let mut index = 0;
    let value_at = |index: usize| args.get(index).map(String::as_str);
    while index < args.len() {
        match args[index].as_str() {
            "--dry-run" => options.dry_run = true,
            "--type" => {
                index += 1;
                options.kind = value_at(index).unwrap_or("all").to_string();
            }
            "--scope" => {
                index += 1;
                options.scope = value_at(index).map(str::to_string);
            }
            "--resume" => options.resume = true,
            "--batch-size" => {
                index += 1;
                options.batch_size = parse_batch_size(value_at(index));
            }
            "--include-observations" => options.include_observations = true,
            "--output" => {
                index += 1;
                options.output = value_at(index).map(str::to_string);
            }
            _ => {}
        }
        index += 1;
    }
    options
}

/// Runs the rebuild and prints its progress. Returns the exit status.
pub async fn run(args: &[String]) -> i32 {
    let options = parse_args(args);
    println!("=== World Model Rebuild Projections ===");
    println!("Mode: {}", if options.dry_run { "DRY RUN" } else { "LIVE" });
    println!("Type: {}", options.kind);
    println!("Scope: {}", options.scope.as_deref().unwrap_or("all"));
    println!("Resume: {}", options.resume);
    println!("Batch size: {}", options.batch_size);
    println!("Include raw observations: {}", options.include_observations);
    println!();

    let mut report: Option<Map<String, Value>> = None;
    match rebuild(&options, &mut report).await {
        Ok(()) => 0,
        Err(message) => {
            if let (Some(output), Some(report)) = (&options.output, report.as_mut()) {
                report.insert("ok".into(), Value::Bool(false));
                report.insert("error".into(), Value::String(message.clone()));
                report.insert("finishedAt".into(), Value::String(super::iso_now()));
                if std::fs::write(output, pretty(report)).is_ok() {
                    eprintln!("Failure report written to {output}");
                }
            }
            eprintln!("Rebuild failed: {message}");
            1
        }
    }
}

fn pretty(report: &Map<String, Value>) -> String {
    serde_json::to_string_pretty(report).unwrap_or_default()
}

/// The body of `run(options)`. `report` is set as soon as the report exists, so a
/// failure after that point still writes the failure report.
async fn rebuild(
    options: &RebuildOptions,
    report_slot: &mut Option<Map<String, Value>>,
) -> Result<(), String> {
    let config = load_config();
    if !config.enabled && !config.e2e_enabled {
        return Err(
            "World Model is disabled; refusing to report a rebuild as complete.".to_string(),
        );
    }
    let executor = connect_lazy_executor(&config).map_err(|error| error.into_message())?;
    migrate(&executor)
        .await
        .map_err(|error| error.into_message())?;
    let scope = match options.scope.as_deref() {
        Some(value) => Some(parse_scope(value)?),
        None => None,
    };
    if !options.dry_run && scope.is_none() {
        return Err(
            "A live rebuild requires --scope userId:personaId:workspaceId so RLS cannot turn an unscoped run into a false success."
                .to_string(),
        );
    }

    let mut report = Map::new();
    report.insert("generatedAt".into(), Value::String(super::iso_now()));
    report.insert("type".into(), Value::String(options.kind.clone()));
    report.insert(
        "scope".into(),
        options
            .scope
            .clone()
            .map(Value::String)
            .unwrap_or(Value::Null),
    );
    report.insert("dryRun".into(), Value::Bool(options.dry_run));
    report.insert("resume".into(), Value::Bool(options.resume));
    report.insert("batchSize".into(), json!(options.batch_size));
    report.insert(
        "includeObservations".into(),
        Value::Bool(options.include_observations),
    );
    report.insert("phases".into(), Value::Object(Map::new()));
    report.insert("ok".into(), Value::Bool(false));
    *report_slot = Some(report);

    let env = process_env();
    if options.kind == "all" || options.kind == "embeddings" {
        embeddings_phase(
            options,
            scope.as_ref(),
            &executor,
            &config,
            &env,
            report_slot,
        )
        .await?;
    }
    if options.kind == "all" || options.kind == "graphiti" {
        graphiti_phase(options, scope.as_ref(), &executor, report_slot).await?;
    }

    let report = report_slot.as_mut().expect("report exists");
    report.insert("ok".into(), Value::Bool(true));
    report.insert("finishedAt".into(), Value::String(super::iso_now()));
    if let Some(output) = &options.output {
        std::fs::write(output, pretty(report)).map_err(|error| error.to_string())?;
        println!("Report written to {output}");
    }
    println!();
    println!("Rebuild complete.");
    Ok(())
}

/// The `--type embeddings` (or `all`) block of the script.
async fn embeddings_phase(
    options: &RebuildOptions,
    scope: Option<&NormalizedScope>,
    executor: &SqlxPgExecutor,
    config: &betaclaw_core::world_model::config::WorldModelConfig,
    env: &HashMap<String, String>,
    report_slot: &mut Option<Map<String, Value>>,
) -> Result<(), String> {
    println!("--- Rebuilding Embeddings ---");
    if options.dry_run {
        println!(
            "[DRY RUN] Would delete and regenerate {}",
            match &options.scope {
                Some(value) if scope.is_some() => format!("embeddings for {value}"),
                _ => "all embeddings".to_string(),
            }
        );
        return Ok(());
    }

    let transport: Arc<dyn HttpTransport> = Arc::new(ReqwestTransport::new());
    let fallback = || model_hub_embedding_provider(reqwest::Client::new());
    let provider =
        configured_embedding_provider(env, transport, Some(&fallback)).ok_or_else(|| {
            "No configured embedding provider is available; existing embeddings were not rebuilt."
                .to_string()
        })?;
    // Live runs always have a scope (checked before the phases), so the delete is scoped.
    let scope = scope.ok_or("A live rebuild requires --scope")?;
    let deleted = scoped_query::<PgError>(
        executor,
        scope,
        PgStatement::with_params(
            "DELETE FROM world_model_embeddings
             WHERE user_id = $1 AND persona_id = $2 AND workspace_id = $3",
            vec![
                PgValue::text(scope.user_id.as_str()),
                PgValue::text(scope.persona_id.as_str()),
                PgValue::text(scope.workspace_id.as_str()),
            ],
        ),
    )
    .await
    .map_err(|error| error.into_message())?;
    println!(
        "  Deleted existing embeddings: {}",
        deleted.row_count.max(0)
    );

    // Drain all available batches for the scope; a provider failure stops the drain.
    let world_scope = WorldModelScope::new(
        scope.user_id.clone(),
        scope.persona_id.clone(),
        Some(scope.workspace_id.clone()),
    );
    let targets =
        collect_embedding_targets(executor, Some(&world_scope), EMBEDDING_TARGET_LIMIT).await;
    let deps = EmbeddingWorkerDeps {
        generate_embedding: None,
        model: Some(provider.model().to_string()),
        model_version: Some(provider.model_version().to_string()),
    };
    let batch_size = options.batch_size as usize;
    let mut collected = 0_usize;
    let mut processed = 0_usize;
    let mut created = 0_usize;
    for offset in (0..targets.len()).step_by(batch_size) {
        let end = (offset + batch_size).min(targets.len());
        let results = process_embedding_batch(
            executor,
            &targets[offset..end],
            config,
            Some(Arc::clone(&provider)),
            &deps,
            env,
        )
        .await;
        collected += end - offset;
        processed += results.len();
        created += results.iter().filter(|entry| entry.created).count();
    }
    let phase = json!({ "collected": collected, "processed": processed, "created": created });
    set_phase(report_slot, "embeddings", phase.clone());
    println!("  Embedded: {phase}");
    if collected > processed {
        return Err(format!(
            "Embedding rebuild incomplete: collected={collected}, processed={processed}."
        ));
    }
    Ok(())
}

/// The `--type graphiti` (or `all`) block of the script.
async fn graphiti_phase(
    options: &RebuildOptions,
    scope: Option<&NormalizedScope>,
    executor: &SqlxPgExecutor,
    report_slot: &mut Option<Map<String, Value>>,
) -> Result<(), String> {
    println!("--- Rebuilding Graphiti ---");
    if options.dry_run {
        println!("[DRY RUN] Would clear graphiti scope and re-project from PostgreSQL");
        return Ok(());
    }
    let Some(scope) = scope else {
        println!("  [SKIP] Graphiti rebuild requires --scope userId:personaId:workspaceId");
        return Ok(());
    };
    let transport: Arc<dyn HttpTransport> = Arc::new(ReqwestTransport::new());
    let client = GraphitiRestClient::from_env(transport);
    if !options.resume {
        client
            .clear_scope(&scope.user_id, &scope.persona_id, &scope.workspace_id)
            .await
            .map_err(|error| error.into_message())?;
    }
    let result = rebuild_graphiti_from_postgres(
        executor,
        &client,
        &RebuildGraphitiInput {
            user_id: scope.user_id.clone(),
            persona_id: scope.persona_id.clone(),
            workspace_id: scope.workspace_id.clone(),
            batch_size: Some(options.batch_size),
            resume: Some(options.resume),
            include_observations: Some(options.include_observations),
        },
    )
    .await
    .map_err(|error| error.into_message())?;
    let value = graphiti_result_json(&result);
    set_phase(report_slot, "graphiti", value.clone());
    println!("  Rebuilt: {value}");
    Ok(())
}

/// `{ nodesCreated, edgesCreated, processedEvents, byStage }` with all five stages,
/// as the script initialises them (`projector.ts:436-438`).
pub fn graphiti_result_json(result: &RebuildResult) -> Value {
    let stage = |name: &str| json!(result.by_stage.get(name).copied().unwrap_or(0));
    json!({
        "nodesCreated": result.nodes_created,
        "edgesCreated": result.edges_created,
        "processedEvents": result.processed_events,
        "byStage": {
            "observations": stage("observations"),
            "assertions": stage("assertions"),
            "events": stage("events"),
            "tasks": stage("tasks"),
            "relations": stage("relations"),
        },
    })
}

fn set_phase(report_slot: &mut Option<Map<String, Value>>, name: &str, value: Value) {
    if let Some(report) = report_slot.as_mut() {
        if let Some(Value::Object(phases)) = report.get_mut("phases") {
            phases.insert(name.to_string(), value);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn args(values: &[&str]) -> Vec<String> {
        values.iter().map(|value| value.to_string()).collect()
    }

    #[test]
    fn the_defaults_match_the_script() {
        assert_eq!(
            parse_args(&args(&[])),
            RebuildOptions {
                dry_run: false,
                kind: "all".into(),
                scope: None,
                resume: false,
                batch_size: 50,
                include_observations: false,
                output: None,
            }
        );
    }

    #[test]
    fn every_flag_is_read() {
        let options = parse_args(&args(&[
            "--dry-run",
            "--type",
            "graphiti",
            "--scope",
            "u:p:w",
            "--resume",
            "--batch-size",
            "900",
            "--include-observations",
            "--output",
            "r.json",
        ]));
        assert!(options.dry_run && options.resume && options.include_observations);
        assert_eq!(options.kind, "graphiti");
        assert_eq!(options.scope.as_deref(), Some("u:p:w"));
        assert_eq!(options.batch_size, 500, "clamped to 500");
        assert_eq!(options.output.as_deref(), Some("r.json"));
    }

    #[test]
    fn the_batch_size_is_clamped_and_falls_back_like_the_script() {
        assert_eq!(parse_batch_size(Some("0")), 50);
        assert_eq!(parse_batch_size(Some("abc")), 50);
        assert_eq!(parse_batch_size(None), 50);
        assert_eq!(parse_batch_size(Some("0.5")), 1, "Math.max(1, 0.5) is 1");
        assert_eq!(parse_batch_size(Some("7")), 7);
    }

    #[test]
    fn a_type_without_a_value_is_all() {
        assert_eq!(parse_args(&args(&["--type"])).kind, "all");
    }

    #[test]
    fn the_graphiti_result_has_all_five_stages() {
        let result = RebuildResult {
            nodes_created: 2,
            edges_created: 1,
            processed_events: 3,
            by_stage: [("events".to_string(), 3_usize)].into_iter().collect(),
        };
        let json = graphiti_result_json(&result);
        assert_eq!(json["byStage"]["events"], 3);
        assert_eq!(json["byStage"]["relations"], 0);
        assert_eq!(json["nodesCreated"], 2);
        assert_eq!(json["processedEvents"], 3);
    }

    #[test]
    fn a_phase_is_written_into_the_report_object() {
        let mut slot = Some(Map::from_iter([("phases".to_string(), json!({}))]));
        set_phase(&mut slot, "embeddings", json!({ "collected": 1 }));
        assert_eq!(slot.unwrap()["phases"]["embeddings"]["collected"], 1);
    }
}
