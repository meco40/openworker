//! `betaclaw-scheduler knowledge-ingest` replaces `pnpm run knowledge:ingest`
//! (`scripts/trigger-knowledge-ingestion.ts`): a one-shot run of the knowledge
//! ingestion, the same pass the scheduler loop runs (`IngestionPass` in
//! `knowledge_runtime.rs`).
//!
//! Flags: `--dry-run` (list the pending windows only), `--persona <id|name>` (window by
//! window instead of the pass), `--limit <n>` (windows listed, default 200),
//! `--concurrency <n>` or `-j <n>` (windows per batch with `--persona`, 1 to 10,
//! default 4). Prerequisites: `KNOWLEDGE_LAYER_ENABLED` and one of the episode or
//! ledger flags; the model hub and the extraction model are needed to write facts.
//!
//! Exit 0 when the run completes, also when single windows failed (they are listed);
//! exit 1 on a configuration error or a fatal failure.

use std::collections::HashMap;

use std::time::Instant;

use betaclaw_core::knowledge::config::{resolve_knowledge_config, KnowledgeConfig};
use betaclaw_core::knowledge::ingestion_cursor::IngestionWindow;
use betaclaw_core::knowledge::repository::{KnowledgeRepository, ListKnowledgeFilter};
use betaclaw_core::knowledge::sqlite_knowledge_repository::{
    default_knowledge_db_path, SqliteKnowledgeRepository,
};
use rusqlite::types::Value;

use super::reconcile::open_readonly;
use super::{js_number, messages_db_path, process_env, sql_text};
use crate::knowledge_runtime::IngestionPass;

const DEFAULT_LIMIT: i64 = 200;
const DEFAULT_CONCURRENCY: usize = 4;
const MAX_CONCURRENCY: usize = 10;
const PERSONAS_FALLBACK: &str = ".local/personas.db";

/// The parsed flags (`parseArgs`, `trigger-knowledge-ingestion.ts:55-86`).
#[derive(Debug, PartialEq)]
pub struct Options {
    pub dry_run: bool,
    pub persona_filter: Option<String>,
    pub limit: i64,
    pub concurrency: usize,
}

/// `parseArgs`. A flag with a value takes the next argument even when it is a flag;
/// an invalid number keeps the default.
pub fn parse_args(args: &[String]) -> Options {
    let mut options = Options {
        dry_run: false,
        persona_filter: None,
        limit: DEFAULT_LIMIT,
        concurrency: DEFAULT_CONCURRENCY,
    };
    let mut index = 0;
    while index < args.len() {
        match args[index].as_str() {
            "--dry-run" => options.dry_run = true,
            "--persona" => {
                options.persona_filter = Some(
                    args.get(index + 1)
                        .map(|value| value.trim().to_string())
                        .unwrap_or_default(),
                );
                index += 1;
            }
            "--limit" => {
                if let Some(parsed) = positive_number(args, index) {
                    options.limit = parsed.floor() as i64;
                }
                index += 1;
            }
            "--concurrency" | "-j" => {
                if let Some(parsed) = positive_number(args, index) {
                    options.concurrency = (parsed.floor() as usize).min(MAX_CONCURRENCY);
                }
                index += 1;
            }
            _ => {}
        }
        index += 1;
    }
    options
}

/// The number after the flag at `index`, when it is finite and above zero.
fn positive_number(args: &[String], index: usize) -> Option<f64> {
    js_number(args.get(index + 1).map(String::as_str)).filter(|value| *value > 0.0)
}

/// `loadPersonaNameMap`: the names by persona id, empty when the file is missing.
fn load_persona_names(path: &str) -> Result<HashMap<String, String>, String> {
    let mut names = HashMap::new();
    if !std::path::Path::new(path).exists() {
        return Ok(names);
    }
    let db = open_readonly(path)?;
    let mut statement = db
        .prepare("SELECT id, name FROM personas")
        .map_err(|error| error.to_string())?;
    let rows = statement
        .query_map([], |row| {
            Ok((row.get::<_, Value>(0)?, row.get::<_, Value>(1)?))
        })
        .map_err(|error| error.to_string())?;
    for row in rows {
        let (id, name) = row.map_err(|error| error.to_string())?;
        names.insert(sql_text(id), sql_text(name));
    }
    Ok(names)
}

/// The persona name, or `fallback` when the persona is unknown or unnamed.
fn persona_name(names: &HashMap<String, String>, persona_id: &str, fallback: &str) -> String {
    names
        .get(persona_id)
        .filter(|name| !name.is_empty())
        .cloned()
        .unwrap_or_else(|| fallback.to_string())
}

/// `window.personaId` or its name contains the filter, ignoring case.
fn matches_persona(
    window: &IngestionWindow,
    names: &HashMap<String, String>,
    filter: &str,
) -> bool {
    let needle = filter.to_lowercase();
    window.persona_id.to_lowercase().contains(&needle)
        || names
            .get(&window.persona_id)
            .map(|name| name.to_lowercase())
            .unwrap_or_default()
            .contains(&needle)
}

/// `seq=<from+1>..<to>`.
fn seq_range(window: &IngestionWindow) -> String {
    format!(
        "seq={}..{}",
        window.from_seq_exclusive + 1,
        window.to_seq_inclusive
    )
}

/// `resolveKnowledgeConfig()` printed as the script prints it.
fn print_configuration(config: &KnowledgeConfig) {
    println!("\n[knowledge-ingestion] Configuration:");
    println!("  layerEnabled     = {}", config.layer_enabled);
    println!("  episodeEnabled   = {}", config.episode_enabled);
    println!("  ledgerEnabled    = {}", config.ledger_enabled);
    println!(
        "  contradictionDet = {}",
        config.contradiction_detection_enabled
    );
    println!("  ingestIntervalMs = {}", config.ingest_interval_ms);
}

/// Runs the command. Returns the exit status.
pub async fn run(args: &[String]) -> i32 {
    let options = parse_args(args);
    let env = process_env();
    let config = resolve_knowledge_config(&env);
    print_configuration(&config);

    if !config.layer_enabled {
        eprintln!(
            "\n[knowledge-ingestion] KNOWLEDGE_LAYER_ENABLED is false. Set it to true in .env and retry."
        );
        return 1;
    }
    if !config.episode_enabled && !config.ledger_enabled {
        eprintln!(
            "\n[knowledge-ingestion] Neither KNOWLEDGE_EPISODE_ENABLED nor KNOWLEDGE_LEDGER_ENABLED is true. Enable at least one."
        );
        return 1;
    }

    match ingest(&options, &env, &config).await {
        Ok(()) => 0,
        Err(message) => {
            eprintln!("[knowledge-ingestion] Fatal error: {message}");
            1
        }
    }
}

/// The discovery, the run and the summary of the script.
async fn ingest(
    options: &Options,
    env: &HashMap<String, String>,
    config: &KnowledgeConfig,
) -> Result<(), String> {
    let messages_path = messages_db_path();
    let pass = IngestionPass::open(&messages_path, config)?;
    let personas_path = env
        .get("PERSONAS_DB_PATH")
        .filter(|value| !value.is_empty())
        .cloned()
        .unwrap_or_else(|| PERSONAS_FALLBACK.to_string());
    let persona_names = load_persona_names(&personas_path)?;

    let all_windows = pass.pending_windows(options.limit)?;
    let filter = options
        .persona_filter
        .as_deref()
        .filter(|value| !value.is_empty());
    let windows: Vec<IngestionWindow> = match filter {
        Some(filter) => all_windows
            .into_iter()
            .filter(|window| matches_persona(window, &persona_names, filter))
            .collect(),
        None => all_windows,
    };

    println!(
        "\n[knowledge-ingestion] Found {} pending conversation window(s):",
        windows.len()
    );
    for window in &windows {
        println!(
            "  • {}  persona={} ({})  msgs={}  {}",
            window.conversation_id,
            persona_name(&persona_names, &window.persona_id, "?"),
            window.persona_id,
            window.messages.len(),
            seq_range(window),
        );
    }

    if windows.is_empty() {
        println!("\n[knowledge-ingestion] Nothing to ingest. All conversations are up to date.");
        return Ok(());
    }
    if options.dry_run {
        println!("\n[knowledge-ingestion] --dry-run active. Exiting without changes.");
        return Ok(());
    }

    let state = crate::state::GatewayRuntime::init_state(
        betaclaw_core::config::GatewayConfig::from_env().map_err(|error| error.to_string())?,
    )
    .map_err(|error| error.to_string())?;

    let concurrency = options.concurrency;
    println!("\n[knowledge-ingestion] Starting ingestion (concurrency={concurrency})...\n");
    let started = Instant::now();

    if filter.is_some() {
        let mut ok = 0usize;
        let mut fail = 0usize;
        for batch in windows.chunks(concurrency) {
            let outcomes = pass.ingest_windows(&state, env, batch, concurrency).await?;
            for (window, outcome) in batch.iter().zip(outcomes) {
                let elapsed = format!("{:.1}", started.elapsed().as_secs_f64());
                match outcome {
                    Ok(()) => {
                        ok += 1;
                        println!(
                            "  ✓ [{elapsed}s] {} ({} msgs)",
                            seq_range(window),
                            window.messages.len()
                        );
                    }
                    Err(message) => {
                        fail += 1;
                        eprintln!("  ✗ {}: {message}", seq_range(window));
                    }
                }
            }
        }
        let total = format!("{:.1}", started.elapsed().as_secs_f64());
        println!("\n[knowledge-ingestion] Done in {total}s. ok={ok} failed={fail}");
    } else {
        let result = pass.run_once(&state, env).await?;
        println!(
            "\n[knowledge-ingestion] Done. conversations={} messages={} errors={}",
            result.processed_conversations,
            result.processed_messages,
            result.errors.len()
        );
        if !result.errors.is_empty() {
            println!("\nErrors:");
            for error in &result.errors {
                println!(
                    "  ✗ {} ({}): {}",
                    error.conversation_id, error.persona_id, error.reason
                );
            }
        }
    }

    print_repository_totals();
    Ok(())
}

/// The totals line of the script. Its failure is ignored, as the script's `try` does.
fn print_repository_totals() {
    let Ok(repository) = SqliteKnowledgeRepository::open(&default_knowledge_db_path()) else {
        return;
    };
    let filter = ListKnowledgeFilter {
        user_id: String::new(),
        persona_id: String::new(),
        counterpart: None,
        topic_key: None,
        from: None,
        to: None,
        limit: Some(1000),
    };
    let (Ok(episodes), Ok(ledger)) = (
        repository.list_episodes(&filter),
        repository.list_meeting_ledger(&filter),
    ) else {
        return;
    };
    println!(
        "\n[knowledge-ingestion] Repository totals: episodes={} ledger={}",
        episodes.len(),
        ledger.len()
    );
}

#[cfg(test)]
mod tests {
    use super::*;
    use betaclaw_core::messages_store::StoredMessage;

    fn args(values: &[&str]) -> Vec<String> {
        values.iter().map(|value| value.to_string()).collect()
    }

    #[test]
    fn the_defaults_match_the_script() {
        assert_eq!(
            parse_args(&[]),
            Options {
                dry_run: false,
                persona_filter: None,
                limit: 200,
                concurrency: 4,
            }
        );
    }

    #[test]
    fn concurrency_is_capped_at_ten_and_invalid_numbers_keep_the_default() {
        assert_eq!(parse_args(&args(&["-j", "50"])).concurrency, 10);
        assert_eq!(parse_args(&args(&["--concurrency", "2.9"])).concurrency, 2);
        assert_eq!(parse_args(&args(&["--concurrency", "0"])).concurrency, 4);
        assert_eq!(parse_args(&args(&["--limit", "abc"])).limit, 200);
    }

    #[test]
    fn a_persona_flag_takes_the_next_argument_and_trims_it() {
        let options = parse_args(&args(&["--persona", " Lea ", "--dry-run"]));
        assert_eq!(options.persona_filter.as_deref(), Some("Lea"));
        assert!(options.dry_run);
        assert_eq!(
            parse_args(&args(&["--persona"])).persona_filter.as_deref(),
            Some("")
        );
    }

    #[test]
    fn the_persona_filter_matches_the_id_or_the_name() {
        let window = IngestionWindow {
            conversation_id: "c".into(),
            user_id: "u".into(),
            persona_id: "persona-7".into(),
            workspace_id: None,
            from_seq_exclusive: 0,
            to_seq_inclusive: 3,
            messages: Vec::<StoredMessage>::new(),
        };
        let names: HashMap<String, String> = [("persona-7".to_string(), "Lea".to_string())]
            .into_iter()
            .collect();
        assert!(matches_persona(&window, &names, "PERSONA-7"));
        assert!(matches_persona(&window, &names, "le"));
        assert!(!matches_persona(&window, &names, "max"));
        assert_eq!(seq_range(&window), "seq=1..3");
    }
}
