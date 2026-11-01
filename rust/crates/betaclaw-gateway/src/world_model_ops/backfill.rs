//! `betaclaw-scheduler backfill` replaces `pnpm run world-model:backfill`
//! (`scripts/world-model-backfill.ts`, Phase 13).
//!
//! It moves the history of the TypeScript-era stores into the World Model:
//! 1. the chat messages (`messages.db`) as observations, through the ingestion bridge;
//! 2. the knowledge episodes and meeting ledgers (`knowledge` tables) as projections;
//! 3. the Mission-Control tasks (`mission-control.db`) as canonical tasks;
//! 4. the master action ledger (`master.db`) as observations and action attempts.
//!
//! Each phase keeps its progress in `world_model_rebuild_checkpoints` (projection type
//! `backfill`), so `--resume` continues where a run stopped. Nothing is executed:
//! the ledger rows are only mirrored.
//!
//! Usage:
//!   betaclaw-scheduler backfill --dry-run
//!   betaclaw-scheduler backfill --scope user1:persona1:workspace1
//!   betaclaw-scheduler backfill --batch-size 100 --resume --from 2026-01-01T00:00:00Z
//!
//! Flags: `--dry-run`, `--scope userId:personaId:workspaceId`, `--batch-size` (default
//! 50), `--resume`, `--output`, `--from`, `--to`. The exit status is 1 when a phase
//! recorded an error, 0 otherwise.
//!
//! Deliberate differences from the script: a batch size below 1 is raised to 1 (the
//! script would loop forever on a negative value), and the `options` object of the
//! report lists its optional keys in a fixed order instead of argument order.
use super::{
    master_db_path as master_path, messages_db_path as messages_path, mission_control_path,
};

use betaclaw_core::knowledge::repository::{
    KnowledgeEpisode, KnowledgeRepository, KnowledgeSourceRef, ListKnowledgeFilter,
    MeetingLedgerEntry,
};
use betaclaw_core::knowledge::sqlite_knowledge_repository::{
    default_knowledge_db_path, SqliteKnowledgeRepository,
};
use betaclaw_core::world_model::bridge::{
    bridge_chat_messages, BridgeChatMessage, BridgeChatMessagesInput,
};
use betaclaw_core::world_model::config::WorldModelConfig;
use betaclaw_core::world_model::db::{
    scoped_query, NormalizedScope, PgError, PgExecutor, PgStatement, PgValue,
};
use betaclaw_core::world_model::projector::project_window::{project_window, ProjectWindowInput};
use betaclaw_core::world_model::projector::types::{
    ConfidenceSummary, ProjectedAssertion, ProjectedEntity, ProjectedEvent, ProjectedOpenLoop,
    ProjectedOpenLoopType, ProjectedTask, WorldModelProjection,
};
use betaclaw_core::world_model::repositories::action_attempt_repository::{
    finish_action_attempt, start_action_attempt, ActionAttemptInput, ActionAttemptOutcome,
    ToolActionResult,
};
use betaclaw_core::world_model::repositories::task_repository::{insert_task, WorldModelTaskInput};
use betaclaw_core::world_model::scope::WorldModelScope;
use betaclaw_core::world_model::services::mission_control_bridge::{
    to_world_model_task_status, MissionControlTaskStatus,
};
use betaclaw_core::world_model::services::observation_service::record_observation;
use betaclaw_core::world_model::types::{
    EventStatus, Modality, ObservationInput, ObservationSourceType,
};
use rusqlite::Connection;
use serde_json::{json, Map, Value};

use super::reconcile::open_readonly;
use super::{connect_lazy_executor, iso_now, load_config, migrate, parse_scope, process_env};

/// `limit: 100_000` of the knowledge reads (`limit: 100_000`).
const KNOWLEDGE_LIMIT: i64 = 100_000;
const DEFAULT_BATCH_SIZE: i64 = 50;
const DEFAULT_FROM: &str = "2020-01-01";

/// `timeRange` of the options (`--from`, `--to`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TimeRange {
    pub from: String,
    pub to: String,
}

/// The flags (`parseArgs`, `backfill.ts:76-120`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BackfillOptions {
    pub dry_run: bool,
    pub scope: Option<String>,
    pub batch_size: i64,
    pub resume: bool,
    pub output: Option<String>,
    pub time_range: Option<TimeRange>,
}

/// `Number(args[++i]) || 50`, raised to at least 1 (see the module comment).
pub fn parse_batch_size(value: Option<&str>) -> i64 {
    let number = value
        .and_then(|text| text.trim().parse::<f64>().ok())
        .filter(|number| *number != 0.0 && !number.is_nan())
        .unwrap_or(DEFAULT_BATCH_SIZE as f64);
    (number as i64).max(1)
}

/// Reads the arguments as the script does. `--from` and `--to` each fill the other end
/// of the range with their default.
pub fn parse_args(args: &[String]) -> BackfillOptions {
    let mut options = BackfillOptions {
        dry_run: false,
        scope: None,
        batch_size: DEFAULT_BATCH_SIZE,
        resume: false,
        output: None,
        time_range: None,
    };
    let mut index = 0;
    let value_at = |index: usize| args.get(index).cloned().unwrap_or_default();
    while index < args.len() {
        match args[index].as_str() {
            "--dry-run" => options.dry_run = true,
            "--scope" => {
                index += 1;
                options.scope = args.get(index).cloned();
            }
            "--batch-size" => {
                index += 1;
                options.batch_size = parse_batch_size(args.get(index).map(String::as_str));
            }
            "--resume" => options.resume = true,
            "--output" => {
                index += 1;
                options.output = args.get(index).cloned();
            }
            "--from" => {
                index += 1;
                let to = options
                    .time_range
                    .as_ref()
                    .map(|range| range.to.clone())
                    .unwrap_or_else(iso_now);
                options.time_range = Some(TimeRange {
                    from: value_at(index),
                    to,
                });
            }
            "--to" => {
                index += 1;
                let from = options
                    .time_range
                    .as_ref()
                    .map(|range| range.from.clone())
                    .unwrap_or_else(|| DEFAULT_FROM.to_string());
                options.time_range = Some(TimeRange {
                    from,
                    to: value_at(index),
                });
            }
            _ => {}
        }
        index += 1;
    }
    options
}

/// `{ selected, processed, skipped, failed }` of one phase.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct Phase {
    pub selected: i64,
    pub processed: i64,
    pub skipped: i64,
    pub failed: i64,
}

impl Phase {
    fn json(&self) -> Value {
        json!({
            "selected": self.selected,
            "processed": self.processed,
            "skipped": self.skipped,
            "failed": self.failed,
        })
    }
}

/// The counters and the phases of a run (`BackfillStats`, `backfill.ts:31-41`). The
/// phases keep the order in which the script first sets them.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct BackfillStats {
    pub observations_written: i64,
    pub observations_skipped: i64,
    pub assertions_created: i64,
    pub events_created: i64,
    pub entities_upserted: i64,
    pub tasks_mirrored: i64,
    pub action_attempts_mirrored: i64,
    pub errors: Vec<String>,
    pub generated_at: String,
    pub phases: Vec<(String, Phase)>,
}

impl BackfillStats {
    fn phase(&self, name: &str) -> Option<Phase> {
        self.phases
            .iter()
            .find(|(key, _)| key == name)
            .map(|(_, phase)| *phase)
    }

    fn set_phase(&mut self, name: &str, phase: Phase) {
        match self.phases.iter_mut().find(|(key, _)| key == name) {
            Some(entry) => entry.1 = phase,
            None => self.phases.push((name.to_string(), phase)),
        }
    }

    /// The `stats` object of the report.
    fn json(&self) -> Value {
        let mut phases = Map::new();
        for (name, phase) in &self.phases {
            phases.insert(name.clone(), phase.json());
        }
        json!({
            "observationsWritten": self.observations_written,
            "observationsSkipped": self.observations_skipped,
            "assertionsCreated": self.assertions_created,
            "eventsCreated": self.events_created,
            "entitiesUpserted": self.entities_upserted,
            "tasksMirrored": self.tasks_mirrored,
            "actionAttemptsMirrored": self.action_attempts_mirrored,
            "errors": self.errors,
            "generatedAt": self.generated_at,
            "phases": Value::Object(phases),
        })
    }
}

/// Runs the backfill, prints the summary and writes the report. Returns the exit status.
pub async fn run(args: &[String]) -> i32 {
    let options = parse_args(args);
    // The script parses the scope before its try block, so an invalid value ends the
    // process without a summary.
    let scope = match options.scope.as_deref() {
        Some(value) => match parse_scope(value) {
            Ok(scope) => Some(scope),
            Err(message) => {
                eprintln!("{message}");
                return 1;
            }
        },
        None => None,
    };

    println!("=== World Model Backfill ===");
    println!("Mode: {}", if options.dry_run { "DRY RUN" } else { "LIVE" });
    println!("Scope: {}", options.scope.as_deref().unwrap_or("all"));
    println!("Batch size: {}", options.batch_size);
    println!("Resume: {}", options.resume);
    if let Some(range) = &options.time_range {
        println!("Time range: {} - {}", range.from, range.to);
    }
    println!();

    let mut stats = BackfillStats {
        generated_at: iso_now(),
        ..BackfillStats::default()
    };
    if let Err(message) = backfill(&options, scope.as_ref(), &mut stats).await {
        stats.errors.push(format!("Fatal: {message}"));
        eprintln!("Backfill failed: {message}");
    }

    println!();
    println!("=== Backfill Summary ===");
    println!(
        "Observations: {} written, {} skipped",
        stats.observations_written, stats.observations_skipped
    );
    println!("Assertions: {} created", stats.assertions_created);
    println!("Events: {} created", stats.events_created);
    println!("Entities: {} upserted", stats.entities_upserted);
    println!("Tasks: {} mirrored", stats.tasks_mirrored);
    println!("Tool actions: {} mirrored", stats.action_attempts_mirrored);
    println!("Errors: {}", stats.errors.len());
    if !stats.errors.is_empty() {
        println!("Error details:");
        for error in &stats.errors {
            println!("  - {error}");
        }
    }
    if let Some(output) = &options.output {
        let report = json!({
            "generatedAt": stats.generated_at,
            "options": options_json(&options),
            "stats": stats.json(),
        });
        match std::fs::write(
            output,
            serde_json::to_string_pretty(&report).unwrap_or_default(),
        ) {
            Ok(()) => println!("Report written to {output}"),
            Err(error) => eprintln!("Report not written to {output}: {error}"),
        }
    }
    if stats.errors.is_empty() {
        0
    } else {
        1
    }
}

/// The `options` object of the report: the script's keys, optional ones when set.
fn options_json(options: &BackfillOptions) -> Value {
    let mut object = Map::new();
    object.insert("dryRun".into(), Value::Bool(options.dry_run));
    object.insert("batchSize".into(), json!(options.batch_size));
    object.insert("resume".into(), Value::Bool(options.resume));
    if let Some(scope) = &options.scope {
        object.insert("scope".into(), json!(scope));
    }
    if let Some(output) = &options.output {
        object.insert("output".into(), json!(output));
    }
    if let Some(range) = &options.time_range {
        object.insert(
            "timeRange".into(),
            json!({ "from": range.from, "to": range.to }),
        );
    }
    Value::Object(object)
}

/// The body of `runBackfill`: a config or setup error is recorded as `Fatal` by the
/// caller, a phase error as the phase's own error.
async fn backfill(
    options: &BackfillOptions,
    scope: Option<&NormalizedScope>,
    stats: &mut BackfillStats,
) -> Result<(), String> {
    let config = load_config();
    if !config.enabled && !config.e2e_enabled {
        stats.errors.push(
            "World Model is disabled; backfill was not executed. Set WORLD_MODEL_ENABLED=true or WORLD_MODEL_E2E=true."
                .to_string(),
        );
        return Ok(());
    }
    let executor = connect_lazy_executor(&config).map_err(|error| error.into_message())?;
    migrate(&executor)
        .await
        .map_err(|error| error.into_message())?;

    if options.dry_run {
        return dry_run(options, scope, stats).await;
    }

    let messages_db = open_readonly(&messages_path())?;
    let mission_db = open_readonly(&mission_control_path())?;
    let master_db = open_readonly(&master_path())?;
    let knowledge = SqliteKnowledgeRepository::open(&default_knowledge_db_path())
        .map_err(|error| error.to_string())?;

    let env = process_env();
    let ctx = Context {
        executor: &executor,
        config: &config,
        options,
        scope,
        default_persona: env
            .get("WORLD_MODEL_DEFAULT_PERSONA_ID")
            .cloned()
            .unwrap_or_else(|| "default".into()),
        backfill_user: env
            .get("WORLD_MODEL_BACKFILL_USER_ID")
            .cloned()
            .unwrap_or_else(|| "default".into()),
    };

    println!("Phase 1: Backfilling observations from chat messages...");
    match phase_messages(&ctx, &messages_db, stats).await {
        Ok(()) => {}
        Err(message) => {
            let previous = stats.phase("messages").unwrap_or_default();
            stats.set_phase(
                "messages",
                Phase {
                    failed: previous.failed + 1,
                    ..previous
                },
            );
            stats
                .errors
                .push(format!("Observation backfill: {message}"));
        }
    }

    println!("Phase 2: Backfilling knowledge artifacts...");
    match phase_knowledge(&ctx, &knowledge, stats).await {
        Ok(()) => {}
        Err(message) => {
            let previous = stats.phase("knowledge").unwrap_or_default();
            stats.set_phase(
                "knowledge",
                Phase {
                    failed: previous.failed + 1,
                    ..previous
                },
            );
            stats.errors.push(format!("Knowledge backfill: {message}"));
        }
    }

    println!("Phase 3: Mirroring existing Mission Control tasks...");
    match phase_tasks(&ctx, &mission_db, stats).await {
        Ok(()) => {}
        Err(message) => {
            let previous = stats.phase("tasks").unwrap_or_default();
            stats.set_phase(
                "tasks",
                Phase {
                    failed: previous.failed + 1,
                    ..previous
                },
            );
            stats.errors.push(format!("Task mirror: {message}"));
        }
    }

    println!("Phase 4: Mirroring historical tool actions...");
    match phase_tool_actions(&ctx, &master_db, stats).await {
        Ok(()) => {}
        Err(message) => {
            let previous = stats.phase("toolActions").unwrap_or_default();
            stats.set_phase(
                "toolActions",
                Phase {
                    failed: previous.failed + 1,
                    ..previous
                },
            );
            stats
                .errors
                .push(format!("Tool action backfill: {message}"));
        }
    }

    println!();
    println!("Backfill complete. Run with real data sources for production backfill.");
    Ok(())
}

/// Shared inputs of the phases.
struct Context<'a> {
    executor: &'a dyn PgExecutor,
    config: &'a WorldModelConfig,
    options: &'a BackfillOptions,
    scope: Option<&'a NormalizedScope>,
    default_persona: String,
    backfill_user: String,
}

impl Context<'_> {
    /// `scope?.workspaceId ?? ''`.
    fn workspace(&self) -> String {
        self.scope
            .map(|scope| scope.workspace_id.clone())
            .unwrap_or_default()
    }

    /// `options.timeRange` as the `(from, to)` pair a SQL condition needs.
    fn range(&self) -> Option<(&str, &str)> {
        self.options
            .time_range
            .as_ref()
            .map(|range| (range.from.as_str(), range.to.as_str()))
    }

    fn filter(&self, user_id: &str, persona_id: &str) -> ListKnowledgeFilter {
        ListKnowledgeFilter {
            user_id: user_id.to_string(),
            persona_id: persona_id.to_string(),
            counterpart: None,
            topic_key: None,
            from: self
                .options
                .time_range
                .as_ref()
                .map(|range| range.from.clone()),
            to: self
                .options
                .time_range
                .as_ref()
                .map(|range| range.to.clone()),
            limit: Some(KNOWLEDGE_LIMIT),
        }
    }
}

/// `WHERE` text and parameters of optional conditions, built the way the script does.
fn where_clause(conditions: &[&str]) -> String {
    conditions.join(" AND ")
}

fn nn(value: &Option<String>) -> String {
    value.clone().unwrap_or_default()
}

/// Phase 1: the chat messages of the selected conversations, in batches.
async fn phase_messages(
    ctx: &Context<'_>,
    messages_db: &Connection,
    stats: &mut BackfillStats,
) -> Result<(), String> {
    let mut conditions = vec!["1=1"];
    let mut params: Vec<String> = Vec::new();
    if let Some(scope) = ctx.scope {
        conditions.push("user_id = ?");
        params.push(scope.user_id.clone());
        conditions.push("persona_id = ?");
        params.push(scope.persona_id.clone());
    }
    let conversations: Vec<(String, Option<String>, String, Option<String>)> = {
        let mut statement = messages_db
            .prepare(&format!(
                "SELECT id, channel_type, external_chat_id, user_id, title, created_at, updated_at, persona_id
                 FROM conversations WHERE {} ORDER BY created_at ASC",
                where_clause(&conditions)
            ))
            .map_err(|error| error.to_string())?;
        let rows = statement
            .query_map(rusqlite::params_from_iter(params.iter()), |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, Option<String>>(1)?,
                    row.get::<_, String>(3)?,
                    row.get::<_, Option<String>>(7)?,
                ))
            })
            .map_err(|error| error.to_string())?;
        rows.collect::<Result<_, _>>()
            .map_err(|error| error.to_string())?
    };
    println!(
        "  -> {} conversation(s) selected for backfill",
        conversations.len()
    );

    let workspace_id = ctx.workspace();
    for (conversation_id, channel_type, user_id, persona) in &conversations {
        let persona_id = persona.clone().unwrap_or_else(|| "default".to_string());
        let message_scope = NormalizedScope {
            user_id: user_id.clone(),
            persona_id: persona_id.clone(),
            workspace_id: workspace_id.clone(),
        };
        let phase_name = format!("messages:{conversation_id}");
        let mut processed_seq = read_progress(ctx, &message_scope, &phase_name).await?;

        let mut conditions = vec!["conversation_id = ?"];
        let mut params: Vec<String> = vec![conversation_id.clone()];
        if let Some((from, to)) = ctx.range() {
            conditions.push("created_at >= ? AND created_at <= ?");
            params.push(from.to_string());
            params.push(to.to_string());
        }
        let messages: Vec<MessageRow> = {
            let mut statement = messages_db
                .prepare(&format!(
                    "SELECT id, conversation_id, seq, role, content, platform, external_msg_id, sender_name, metadata, created_at, client_message_id
                     FROM messages WHERE {} ORDER BY seq ASC",
                    where_clause(&conditions)
                ))
                .map_err(|error| error.to_string())?;
            let rows = statement
                .query_map(rusqlite::params_from_iter(params.iter()), |row| {
                    Ok(MessageRow {
                        id: row.get(0)?,
                        seq: row.get(2)?,
                        role: row.get(3)?,
                        content: row.get(4)?,
                        created_at: row.get(9)?,
                        sender_name: row.get(7)?,
                    })
                })
                .map_err(|error| error.to_string())?;
            rows.collect::<Result<Vec<_>, _>>()
                .map_err(|error| error.to_string())?
                .into_iter()
                .filter(|message| message.seq > processed_seq)
                .collect()
        };

        for batch in messages.chunks(ctx.options.batch_size as usize) {
            let input = BridgeChatMessagesInput {
                conversation_id: conversation_id.clone(),
                user_id: user_id.clone(),
                persona_id: persona_id.clone(),
                workspace_id: Some(workspace_id.clone()),
                messages: batch
                    .iter()
                    .map(|message| BridgeChatMessage {
                        id: Some(message.id.clone()),
                        user_id: user_id.clone(),
                        persona_id: persona_id.clone(),
                        conversation_id: conversation_id.clone(),
                        seq: message.seq,
                        role: message.role.clone(),
                        content: message.content.clone(),
                        text: None,
                        created_at: message.created_at.clone(),
                        source_id: Some(message.id.clone()),
                        channel_type: channel_type.clone(),
                        sender_id: message.sender_name.clone(),
                    })
                    .collect(),
            };
            let result = bridge_chat_messages(ctx.executor, ctx.config, &input, None)
                .await
                .map_err(|error| error.into_message())?;
            stats.observations_written += result.written as i64;
            stats.observations_skipped += result.skipped as i64;
            processed_seq = batch
                .last()
                .map(|message| message.seq)
                .unwrap_or(processed_seq);
            save_progress(ctx, &message_scope, &phase_name, processed_seq).await?;
        }
        let previous = stats.phase("messages").unwrap_or_default();
        stats.set_phase(
            "messages",
            Phase {
                selected: previous.selected + messages.len() as i64,
                processed: previous.processed + messages.len() as i64,
                skipped: previous.skipped,
                failed: previous.failed,
            },
        );
    }
    println!(
        "  -> {} observation(s) written, {} skipped",
        stats.observations_written, stats.observations_skipped
    );
    Ok(())
}

struct MessageRow {
    id: String,
    seq: i64,
    role: Option<String>,
    content: Option<String>,
    created_at: Option<String>,
    sender_name: Option<String>,
}

/// Phase 2: the knowledge episodes and meeting ledgers of each knowledge scope.
async fn phase_knowledge(
    ctx: &Context<'_>,
    knowledge: &SqliteKnowledgeRepository,
    stats: &mut BackfillStats,
) -> Result<(), String> {
    let scopes: Vec<(String, String)> = match ctx.scope {
        Some(scope) => vec![(scope.user_id.clone(), scope.persona_id.clone())],
        None => knowledge
            .list_knowledge_scopes()
            .map_err(|error| error.to_string())?
            .into_iter()
            .map(|scope| (scope.user_id, scope.persona_id))
            .collect(),
    };
    let workspace_id = ctx.workspace();
    let mut selected = 0_i64;
    let mut processed = 0_i64;

    for (user_id, persona_id) in &scopes {
        let world_scope = NormalizedScope {
            user_id: user_id.clone(),
            persona_id: persona_id.clone(),
            workspace_id: workspace_id.clone(),
        };
        let episode_phase = format!("knowledge:episodes:{user_id}:{persona_id}");
        let ledger_phase = format!("knowledge:ledger:{user_id}:{persona_id}");
        let mut episode_offset = read_progress(ctx, &world_scope, &episode_phase).await?;
        let mut ledger_offset = read_progress(ctx, &world_scope, &ledger_phase).await?;
        let filter = ctx.filter(user_id, persona_id);

        let episodes: Vec<KnowledgeEpisode> = knowledge
            .list_episodes(&filter)
            .map_err(|error| error.to_string())?
            .into_iter()
            .skip(episode_offset as usize)
            .collect();
        selected += episodes.len() as i64;
        for episode in &episodes {
            let projection = episode_projection(episode, persona_id);
            let observation = ObservationInput {
                user_id: user_id.clone(),
                persona_id: persona_id.clone(),
                workspace_id: Some(workspace_id.clone()),
                source_type: ObservationSourceType::Automation,
                source_id: format!("backfill:knowledge:episode:{}", episode.id),
                occurred_at: episode
                    .event_at
                    .clone()
                    .unwrap_or_else(|| episode.updated_at.clone()),
                payload: payload_of("knowledge_episode", episode_json(episode)),
                source_authority: Some("backfill".into()),
            };
            let result = project(ctx, &world_scope, projection, observation).await?;
            stats.assertions_created += result.assertions_created as i64;
            stats.events_created += result.events_created as i64;
            stats.entities_upserted += result.entities_upserted as i64;
            processed += 1;
            episode_offset += 1;
            save_progress(ctx, &world_scope, &episode_phase, episode_offset).await?;
        }

        let ledger: Vec<MeetingLedgerEntry> = knowledge
            .list_meeting_ledger(&filter)
            .map_err(|error| error.to_string())?
            .into_iter()
            .skip(ledger_offset as usize)
            .collect();
        selected += ledger.len() as i64;
        for entry in &ledger {
            let projection = ledger_projection(entry, user_id, persona_id);
            let observation = ObservationInput {
                user_id: user_id.clone(),
                persona_id: persona_id.clone(),
                workspace_id: Some(workspace_id.clone()),
                source_type: ObservationSourceType::Automation,
                source_id: format!("backfill:knowledge:ledger:{}", entry.id),
                occurred_at: entry
                    .event_at
                    .clone()
                    .unwrap_or_else(|| entry.updated_at.clone()),
                payload: payload_of("knowledge_meeting_ledger", ledger_json(entry)),
                source_authority: Some("backfill".into()),
            };
            let result = project(ctx, &world_scope, projection, observation).await?;
            stats.assertions_created += result.assertions_created as i64;
            stats.events_created += result.events_created as i64;
            stats.entities_upserted += result.entities_upserted as i64;
            stats.tasks_mirrored += entry.action_items.len() as i64;
            processed += 1;
            ledger_offset += 1;
            save_progress(ctx, &world_scope, &ledger_phase, ledger_offset).await?;
        }
    }
    stats.set_phase(
        "knowledge",
        Phase {
            selected,
            processed,
            skipped: 0,
            failed: 0,
        },
    );
    println!("  -> {processed} Knowledge-Artefakt(e) verarbeitet");
    Ok(())
}

/// `projectWindow({ scope, projection, observation })` of the script.
async fn project(
    ctx: &Context<'_>,
    scope: &NormalizedScope,
    projection: WorldModelProjection,
    observation: ObservationInput,
) -> Result<betaclaw_core::world_model::projector::project_window::ProjectWindowOutput, String> {
    project_window(
        ctx.executor,
        ProjectWindowInput {
            scope: world_scope(scope),
            projection,
            observation,
            extraction: None,
            completed_task_evidence: Vec::new(),
        },
    )
    .await
    .map_err(|error| error.into_message())
}

/// The projection of one episode (`backfill.ts:287-318`).
fn episode_projection(episode: &KnowledgeEpisode, persona_id: &str) -> WorldModelProjection {
    let source_seq = episode.source_seq_start;
    WorldModelProjection {
        assertions: episode
            .facts
            .iter()
            .enumerate()
            .map(|(index, fact)| ProjectedAssertion {
                subject: persona_id.to_string(),
                predicate: "knowledge_fact".into(),
                object_value: Some(fact.clone()),
                modality: Modality::Reported,
                confidence: 0.7,
                source_message_seq: source_seq + index as i64,
            })
            .collect(),
        events: match &episode.event_at {
            Some(event_at) => vec![ProjectedEvent {
                title: if episode.teaser.is_empty() {
                    episode.topic_key.clone()
                } else {
                    episode.teaser.clone()
                },
                event_type: "knowledge_episode".into(),
                scheduled_for: Some(event_at.clone()),
                ends_at: None,
                status: EventStatus::Planned,
                replaces_event_id: None,
                source_message_seq: source_seq,
            }],
            None => Vec::new(),
        },
        entities: match non_empty(&episode.counterpart) {
            Some(counterpart) => vec![person_entity(counterpart, source_seq)],
            None => Vec::new(),
        },
        relations: Vec::new(),
        open_loops: Vec::new(),
        tasks: Vec::new(),
        confidence_summary: ConfidenceSummary {
            total: episode.facts.len(),
            confident: 0,
        },
    }
}

/// The projection of one meeting ledger entry (`backfill.ts:341-392`).
fn ledger_projection(
    entry: &MeetingLedgerEntry,
    user_id: &str,
    persona_id: &str,
) -> WorldModelProjection {
    let source_seq = entry.source_refs.first().map(|r| r.seq).unwrap_or(0);
    let assertion_values: Vec<&String> = entry
        .decisions
        .iter()
        .chain(entry.negotiated_terms.iter())
        .collect();
    let mut entity_names: Vec<&String> = entry.participants.iter().collect();
    let counterpart = non_empty(&entry.counterpart);
    if let Some(counterpart) = counterpart {
        entity_names.push(counterpart);
    }
    WorldModelProjection {
        assertions: assertion_values
            .iter()
            .enumerate()
            .map(|(index, value)| ProjectedAssertion {
                subject: persona_id.to_string(),
                predicate: "meeting_decision".into(),
                object_value: Some((*value).clone()),
                modality: Modality::Reported,
                confidence: entry.confidence.clamp(0.0, 1.0),
                source_message_seq: source_seq + index as i64,
            })
            .collect(),
        events: match &entry.event_at {
            Some(event_at) => vec![ProjectedEvent {
                title: entry.topic_key.clone(),
                event_type: "meeting_ledger".into(),
                scheduled_for: Some(event_at.clone()),
                ends_at: None,
                status: EventStatus::Planned,
                replaces_event_id: None,
                source_message_seq: source_seq,
            }],
            None => Vec::new(),
        },
        entities: entity_names
            .into_iter()
            .map(|name| person_entity(name, source_seq))
            .collect(),
        relations: Vec::new(),
        open_loops: entry
            .open_points
            .iter()
            .enumerate()
            .map(|(index, question)| ProjectedOpenLoop {
                loop_type: ProjectedOpenLoopType::MissingContext,
                question: Some(question.clone()),
                deduplication_key: question.clone(),
                source_message_seq: source_seq + index as i64,
            })
            .collect(),
        tasks: entry
            .action_items
            .iter()
            .enumerate()
            .map(|(index, title)| ProjectedTask {
                title: title.clone(),
                requester: user_id.to_string(),
                assignee: persona_id.to_string(),
                source_message_seq: source_seq + index as i64,
            })
            .collect(),
        confidence_summary: ConfidenceSummary {
            total: entry.decisions.len() + entry.negotiated_terms.len() + entry.action_items.len(),
            confident: 0,
        },
    }
}

fn person_entity(name: &str, source_seq: i64) -> ProjectedEntity {
    ProjectedEntity {
        canonical_name: name.to_string(),
        category: "person".into(),
        owner: "shared".into(),
        aliases: Vec::new(),
        source_message_seq: source_seq,
    }
}

/// `value || undefined` for the optional names of the script: an empty string is absent.
fn non_empty(value: &Option<String>) -> Option<&String> {
    value.as_ref().filter(|text| !text.is_empty())
}

fn payload_of(artifact_type: &str, source: Value) -> Map<String, Value> {
    let mut payload = Map::new();
    payload.insert("artifactType".into(), json!(artifact_type));
    payload.insert("source".into(), source);
    payload
}

/// The episode as `JSON.stringify` writes the TypeScript object (`null` for the
/// absent `counterpart` and `eventAt`, `memoryIds` always present).
fn episode_json(episode: &KnowledgeEpisode) -> Value {
    json!({
        "id": episode.id,
        "userId": episode.user_id,
        "personaId": episode.persona_id,
        "conversationId": episode.conversation_id,
        "topicKey": episode.topic_key,
        "counterpart": episode.counterpart,
        "teaser": episode.teaser,
        "episode": episode.episode,
        "facts": episode.facts,
        "sourceSeqStart": episode.source_seq_start,
        "sourceSeqEnd": episode.source_seq_end,
        "sourceRefs": source_refs_json(&episode.source_refs),
        "memoryIds": episode.memory_ids,
        "eventAt": episode.event_at,
        "updatedAt": episode.updated_at,
    })
}

fn ledger_json(entry: &MeetingLedgerEntry) -> Value {
    json!({
        "id": entry.id,
        "userId": entry.user_id,
        "personaId": entry.persona_id,
        "conversationId": entry.conversation_id,
        "topicKey": entry.topic_key,
        "counterpart": entry.counterpart,
        "eventAt": entry.event_at,
        "participants": entry.participants,
        "decisions": entry.decisions,
        "negotiatedTerms": entry.negotiated_terms,
        "openPoints": entry.open_points,
        "actionItems": entry.action_items,
        "sourceRefs": source_refs_json(&entry.source_refs),
        "confidence": entry.confidence,
        "memoryIds": entry.memory_ids,
        "updatedAt": entry.updated_at,
    })
}

fn source_refs_json(refs: &[KnowledgeSourceRef]) -> Value {
    Value::Array(
        refs.iter()
            .map(|reference| json!({ "seq": reference.seq, "quote": reference.quote }))
            .collect(),
    )
}

/// Phase 3: the Mission-Control tasks, mirrored one by one.
async fn phase_tasks(
    ctx: &Context<'_>,
    mission_db: &Connection,
    stats: &mut BackfillStats,
) -> Result<(), String> {
    let mut conditions = vec!["1=1"];
    let mut params: Vec<String> = Vec::new();
    if let Some(scope) = ctx.scope {
        conditions.push("workspace_id = ?");
        params.push(scope.workspace_id.clone());
    }
    if let Some((from, to)) = ctx.range() {
        conditions.push("created_at >= ? AND created_at <= ?");
        params.push(from.to_string());
        params.push(to.to_string());
    }
    let tasks: Vec<MissionTask> = {
        let mut statement = mission_db
            .prepare(&format!(
                "SELECT id, title, description, status, assigned_agent_id, workspace_id, due_date, created_at
                 FROM tasks WHERE {} ORDER BY created_at ASC",
                where_clause(&conditions)
            ))
            .map_err(|error| error.to_string())?;
        let rows = statement
            .query_map(rusqlite::params_from_iter(params.iter()), |row| {
                Ok(MissionTask {
                    id: row.get(0)?,
                    title: row.get(1)?,
                    description: row.get(2)?,
                    status: row.get(3)?,
                    assigned_agent_id: row.get(4)?,
                    workspace_id: row.get(5)?,
                    due_date: row.get(6)?,
                    created_at: row.get(7)?,
                })
            })
            .map_err(|error| error.to_string())?;
        rows.collect::<Result<_, _>>()
            .map_err(|error| error.to_string())?
    };

    let task_scope = NormalizedScope {
        user_id: ctx
            .scope
            .map(|scope| scope.user_id.clone())
            .unwrap_or_else(|| ctx.backfill_user.clone()),
        persona_id: ctx
            .scope
            .map(|scope| scope.persona_id.clone())
            .unwrap_or_else(|| ctx.default_persona.clone()),
        workspace_id: ctx.workspace(),
    };
    let offset = read_progress(ctx, &task_scope, "tasks").await?;
    let mut processed = 0_i64;
    for task in tasks.iter().skip(offset as usize) {
        let task_workspace = match nn(&task.workspace_id) {
            value if value.is_empty() => task_scope.workspace_id.clone(),
            value => value,
        };
        let inner_scope = NormalizedScope {
            workspace_id: task_workspace.clone(),
            ..task_scope.clone()
        };
        let completed_evidence = if task.status == "done" {
            let result = record_observation(
                ctx.executor,
                ObservationInput {
                    user_id: task_scope.user_id.clone(),
                    persona_id: task_scope.persona_id.clone(),
                    workspace_id: Some(task_workspace.clone()),
                    source_type: ObservationSourceType::Automation,
                    source_id: format!("backfill:task-completion:{}", task.id),
                    occurred_at: task.created_at.clone(),
                    payload: match json!({
                        "artifactType": "mission_control_task_completion",
                        "taskId": task.id,
                        "title": task.title,
                    }) {
                        Value::Object(map) => map,
                        _ => Map::new(),
                    },
                    source_authority: Some("backfill".into()),
                },
                Some(&world_scope(&inner_scope)),
                ctx.config,
            )
            .await
            .map_err(|error| error.into_message())?;
            Some(result.observation.id)
        } else {
            None
        };
        let status =
            MissionControlTaskStatus::from_text(&task.status).map(to_world_model_task_status);
        let canonical = insert_task::<PgError>(
            ctx.executor,
            Some(&world_scope(&inner_scope)),
            &WorldModelTaskInput {
                user_id: task_scope.user_id.clone(),
                persona_id: task_scope.persona_id.clone(),
                workspace_id: task_workspace.clone(),
                title: task.title.clone(),
                description: task.description.clone(),
                requester: Some(task_scope.user_id.clone()),
                assignee: Some(
                    task.assigned_agent_id
                        .clone()
                        .unwrap_or_else(|| task_scope.persona_id.clone()),
                ),
                external_task_id: Some(task.id.clone()),
                origin: Some("mission_control_backfill".into()),
                status,
                due_at: task.due_date.clone(),
                idempotency_key: Some(format!("task-created:{}", task.id)),
                source_observation_id: None,
            },
        )
        .await
        .map_err(|error| error.into_message())?;
        if let Some(observation_id) = completed_evidence {
            scoped_query::<PgError>(
                ctx.executor,
                &inner_scope,
                PgStatement::with_params(
                    "UPDATE world_model_tasks
                       SET completion_evidence_id = $2,
                           evidence = evidence || $3::jsonb, updated_at = now()
                       WHERE id = $1",
                    vec![
                        PgValue::text(canonical.id.as_str()),
                        PgValue::text(observation_id.as_str()),
                        PgValue::text(json!({ "backfill": true }).to_string()),
                    ],
                ),
            )
            .await
            .map_err(|error| error.into_message())?;
        }
        processed += 1;
        save_progress(ctx, &task_scope, "tasks", offset + processed).await?;
    }
    stats.tasks_mirrored += processed;
    stats.set_phase(
        "tasks",
        Phase {
            selected: tasks.len() as i64,
            processed,
            skipped: 0,
            failed: 0,
        },
    );
    println!("  -> {processed} Mission-Control-Task(s) gespiegelt");
    Ok(())
}

struct MissionTask {
    id: String,
    title: String,
    description: Option<String>,
    status: String,
    assigned_agent_id: Option<String>,
    workspace_id: Option<String>,
    due_date: Option<String>,
    created_at: String,
}

/// Phase 4: the master action ledger, mirrored as observations and finished attempts.
async fn phase_tool_actions(
    ctx: &Context<'_>,
    master_db: &Connection,
    stats: &mut BackfillStats,
) -> Result<(), String> {
    let mut conditions = vec!["1=1"];
    let mut params: Vec<String> = Vec::new();
    if let Some(scope) = ctx.scope {
        conditions.push("user_id = ?");
        params.push(scope.user_id.clone());
        conditions.push("workspace_id = ?");
        params.push(scope.workspace_id.clone());
    }
    if let Some((from, to)) = ctx.range() {
        conditions.push("updated_at >= ? AND updated_at <= ?");
        params.push(from.to_string());
        params.push(to.to_string());
    }
    let ledger: Vec<LedgerRow> = {
        let mut statement = master_db
            .prepare(&format!(
                "SELECT id, run_id, user_id, workspace_id, step_id, action_type,
                        idempotency_key, state, result_payload, updated_at
                 FROM master_action_ledger
                 WHERE {} ORDER BY updated_at ASC",
                where_clause(&conditions)
            ))
            .map_err(|error| error.to_string())?;
        let rows = statement
            .query_map(rusqlite::params_from_iter(params.iter()), |row| {
                Ok(LedgerRow {
                    id: row.get(0)?,
                    run_id: row.get(1)?,
                    user_id: row.get(2)?,
                    workspace_id: row.get(3)?,
                    step_id: row.get(4)?,
                    action_type: row.get(5)?,
                    idempotency_key: row.get(6)?,
                    state: row.get(7)?,
                    result_payload: row.get(8)?,
                    updated_at: row.get(9)?,
                })
            })
            .map_err(|error| error.to_string())?;
        rows.collect::<Result<_, _>>()
            .map_err(|error| error.to_string())?
    };

    let progress_scope = NormalizedScope {
        user_id: ctx
            .scope
            .map(|scope| scope.user_id.clone())
            .unwrap_or_else(|| "backfill-all".into()),
        persona_id: ctx
            .scope
            .map(|scope| scope.persona_id.clone())
            .unwrap_or_else(|| ctx.default_persona.clone()),
        workspace_id: ctx.workspace(),
    };
    let offset = read_progress(ctx, &progress_scope, "tool-actions").await?;
    let mut processed = 0_i64;
    for action in ledger.iter().skip(offset as usize) {
        let action_scope = NormalizedScope {
            user_id: ctx
                .scope
                .map(|scope| scope.user_id.clone())
                .unwrap_or_else(|| action.user_id.clone()),
            persona_id: ctx
                .scope
                .map(|scope| scope.persona_id.clone())
                .unwrap_or_else(|| ctx.default_persona.clone()),
            workspace_id: ctx
                .scope
                .map(|scope| scope.workspace_id.clone())
                .unwrap_or_else(|| nn(&action.workspace_id)),
        };
        let parsed_result = parse_result_payload(action.result_payload.as_deref());
        let observation = record_observation(
            ctx.executor,
            ObservationInput {
                user_id: action_scope.user_id.clone(),
                persona_id: action_scope.persona_id.clone(),
                workspace_id: Some(action_scope.workspace_id.clone()),
                source_type: ObservationSourceType::ToolExecution,
                source_id: format!("backfill:tool:{}", action.idempotency_key),
                occurred_at: action.updated_at.clone(),
                payload: match json!({
                    "artifactType": "master_action_ledger",
                    "ledgerId": action.id,
                    "runId": action.run_id,
                    "stepId": action.step_id,
                    "actionType": action.action_type,
                    "state": action.state,
                    "result": parsed_result,
                }) {
                    Value::Object(map) => map,
                    _ => Map::new(),
                },
                source_authority: Some("backfill".into()),
            },
            Some(&world_scope(&action_scope)),
            ctx.config,
        )
        .await
        .map_err(|error| error.into_message())?;
        let attempt = start_action_attempt::<PgError>(
            ctx.executor,
            &world_scope(&action_scope),
            &ActionAttemptInput {
                task_id: None,
                action_type: action.action_type.clone(),
                idempotency_key: format!("backfill:tool-attempt:{}", action.idempotency_key),
                correlation_id: Some(action.run_id.clone()),
                result: None,
            },
        )
        .await
        .map_err(|error| error.into_message())?;
        if attempt.created {
            let outcome = match action.state.as_str() {
                "succeeded" => ActionAttemptOutcome::Succeeded,
                "failed" => ActionAttemptOutcome::Failed,
                _ => ActionAttemptOutcome::Aborted,
            };
            finish_action_attempt::<PgError>(
                ctx.executor,
                Some(&world_scope(&action_scope)),
                &attempt.attempt.id,
                outcome,
                Some(&ToolActionResult {
                    provider_id: Some("master_action_ledger".into()),
                    target: Some(action.action_type.clone()),
                    timestamp: Some(action.updated_at.clone()),
                    payload: Some(json!({
                        "ledgerId": action.id,
                        "observationId": observation.observation.id,
                        "result": parsed_result,
                    })),
                }),
            )
            .await
            .map_err(|error| error.into_message())?;
        }
        processed += 1;
        save_progress(ctx, &progress_scope, "tool-actions", offset + processed).await?;
    }
    stats.action_attempts_mirrored += processed;
    stats.set_phase(
        "toolActions",
        Phase {
            selected: ledger.len() as i64,
            processed,
            skipped: 0,
            failed: 0,
        },
    );
    println!("  -> {processed} Tool-Aktion(en) gespiegelt");
    Ok(())
}

struct LedgerRow {
    id: String,
    run_id: String,
    user_id: String,
    workspace_id: Option<String>,
    step_id: String,
    action_type: String,
    idempotency_key: String,
    state: String,
    result_payload: Option<String>,
    updated_at: String,
}

/// `JSON.parse(payload)` with the raw text as the fallback; an empty payload is `null`.
fn parse_result_payload(payload: Option<&str>) -> Value {
    match payload {
        None | Some("") => Value::Null,
        Some(text) => serde_json::from_str(text).unwrap_or_else(|_| Value::String(text.into())),
    }
}

/// The `WorldModelScope` of a normalized scope, with its workspace always set.
fn world_scope(scope: &NormalizedScope) -> WorldModelScope {
    WorldModelScope::new(
        scope.user_id.clone(),
        scope.persona_id.clone(),
        Some(scope.workspace_id.clone()),
    )
}

/// `getBackfillProgress` (`backfill.ts:121-141`): with `--resume` the stored count,
/// without it the checkpoint is deleted and the phase starts at 0.
async fn read_progress(
    ctx: &Context<'_>,
    scope: &NormalizedScope,
    phase: &str,
) -> Result<i64, String> {
    if !ctx.options.resume {
        scoped_query::<PgError>(
            ctx.executor,
            scope,
            PgStatement::with_params(
                "DELETE FROM world_model_rebuild_checkpoints
                 WHERE projection_type = 'backfill' AND user_id = $1 AND persona_id = $2
                   AND workspace_id = $3 AND phase = $4",
                checkpoint_params(scope, phase),
            ),
        )
        .await
        .map_err(|error| error.into_message())?;
        return Ok(0);
    }
    let result = scoped_query::<PgError>(
        ctx.executor,
        scope,
        PgStatement::with_params(
            "SELECT processed_count FROM world_model_rebuild_checkpoints
             WHERE projection_type = 'backfill' AND user_id = $1 AND persona_id = $2
               AND workspace_id = $3 AND phase = $4",
            checkpoint_params(scope, phase),
        ),
    )
    .await
    .map_err(|error| error.into_message())?;
    Ok(result
        .rows
        .first()
        .map(|row| super::number_of(row.get("processed_count")))
        .unwrap_or(0))
}

/// `saveBackfillProgress` (`backfill.ts:143-164`).
async fn save_progress(
    ctx: &Context<'_>,
    scope: &NormalizedScope,
    phase: &str,
    processed: i64,
) -> Result<(), String> {
    let mut params = checkpoint_params(scope, phase);
    params.push(PgValue::int(processed));
    scoped_query::<PgError>(
        ctx.executor,
        scope,
        PgStatement::with_params(
            "INSERT INTO world_model_rebuild_checkpoints
              (projection_type, user_id, persona_id, workspace_id, phase, processed_count)
             VALUES ('backfill', $1, $2, $3, $4, $5)
             ON CONFLICT (projection_type, user_id, persona_id, workspace_id, phase)
             DO UPDATE SET processed_count = EXCLUDED.processed_count, updated_at = now()",
            params,
        ),
    )
    .await
    .map_err(|error| error.into_message())?;
    Ok(())
}

fn checkpoint_params(scope: &NormalizedScope, phase: &str) -> Vec<PgValue> {
    vec![
        PgValue::text(scope.user_id.as_str()),
        PgValue::text(scope.persona_id.as_str()),
        PgValue::text(scope.workspace_id.as_str()),
        PgValue::text(phase),
    ]
}

/// The `--dry-run` branch: counts what a live run would read, writes nothing.
async fn dry_run(
    options: &BackfillOptions,
    scope: Option<&NormalizedScope>,
    stats: &mut BackfillStats,
) -> Result<(), String> {
    let messages_db = open_readonly(&messages_path())?;
    let mission_db = open_readonly(&mission_control_path())?;
    let master_db = open_readonly(&master_path())?;
    let knowledge = SqliteKnowledgeRepository::open(&default_knowledge_db_path())
        .map_err(|error| error.to_string())?;

    let range = options
        .time_range
        .as_ref()
        .map(|range| (range.from.clone(), range.to.clone()));
    let mut conditions = vec!["1=1"];
    let mut params: Vec<String> = Vec::new();
    if let Some(scope) = scope {
        conditions.push("c.user_id = ?");
        params.push(scope.user_id.clone());
        conditions.push("c.persona_id = ?");
        params.push(scope.persona_id.clone());
    }
    if let Some((from, to)) = &range {
        conditions.push("m.created_at >= ? AND m.created_at <= ?");
        params.push(from.clone());
        params.push(to.clone());
    }
    let message_count: i64 = messages_db
        .query_row(
            &format!(
                "SELECT COUNT(*) AS count FROM messages m JOIN conversations c ON c.id = m.conversation_id
                 WHERE {}",
                where_clause(&conditions)
            ),
            rusqlite::params_from_iter(params.iter()),
            |row| row.get(0),
        )
        .map_err(|error| error.to_string())?;

    let knowledge_scopes: Vec<(String, String)> = match scope {
        Some(scope) => vec![(scope.user_id.clone(), scope.persona_id.clone())],
        None => knowledge
            .list_knowledge_scopes()
            .map_err(|error| error.to_string())?
            .into_iter()
            .map(|scope| (scope.user_id, scope.persona_id))
            .collect(),
    };
    let mut episode_count = 0_i64;
    let mut ledger_count = 0_i64;
    for (user_id, persona_id) in &knowledge_scopes {
        let filter = ListKnowledgeFilter {
            user_id: user_id.clone(),
            persona_id: persona_id.clone(),
            counterpart: None,
            topic_key: None,
            from: range.as_ref().map(|(from, _)| from.clone()),
            to: range.as_ref().map(|(_, to)| to.clone()),
            limit: Some(KNOWLEDGE_LIMIT),
        };
        episode_count += knowledge
            .list_episodes(&filter)
            .map_err(|error| error.to_string())?
            .len() as i64;
        ledger_count += knowledge
            .list_meeting_ledger(&filter)
            .map_err(|error| error.to_string())?
            .len() as i64;
    }

    let task_count: i64 = match scope {
        Some(scope) => mission_db.query_row(
            "SELECT COUNT(*) AS count FROM tasks WHERE workspace_id = ?",
            rusqlite::params![scope.workspace_id],
            |row| row.get(0),
        ),
        None => mission_db.query_row("SELECT COUNT(*) AS count FROM tasks", [], |row| row.get(0)),
    }
    .map_err(|error| error.to_string())?;

    let mut action_conditions = vec!["1=1"];
    let mut action_params: Vec<String> = Vec::new();
    if let Some(scope) = scope {
        action_conditions.push("user_id = ?");
        action_params.push(scope.user_id.clone());
        action_conditions.push("workspace_id = ?");
        action_params.push(scope.workspace_id.clone());
    }
    let action_count: i64 = master_db
        .query_row(
            &format!(
                "SELECT COUNT(*) AS count FROM master_action_ledger WHERE {}",
                where_clause(&action_conditions)
            ),
            rusqlite::params_from_iter(action_params.iter()),
            |row| row.get(0),
        )
        .map_err(|error| error.to_string())?;

    for (name, count) in [
        ("messages", message_count),
        ("knowledgeEpisodes", episode_count),
        ("knowledgeLedger", ledger_count),
        ("tasks", task_count),
        ("toolActions", action_count),
    ] {
        stats.set_phase(
            name,
            Phase {
                selected: count,
                ..Phase::default()
            },
        );
    }
    let phases: Map<String, Value> = stats
        .phases
        .iter()
        .map(|(name, phase)| (name.clone(), phase.json()))
        .collect();
    println!("[DRY RUN] Selection: {}", Value::Object(phases));
    println!("[DRY RUN] No data was written.");
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn args(values: &[&str]) -> Vec<String> {
        values.iter().map(|value| value.to_string()).collect()
    }

    #[test]
    fn the_defaults_match_the_script() {
        let options = parse_args(&args(&[]));
        assert_eq!(options.batch_size, 50);
        assert!(!options.dry_run && !options.resume);
        assert_eq!(options.time_range, None);
    }

    #[test]
    fn from_and_to_fill_the_other_end_of_the_range() {
        let only_from = parse_args(&args(&["--from", "2026-01-01T00:00:00.000Z"]));
        let range = only_from.time_range.expect("range");
        assert_eq!(range.from, "2026-01-01T00:00:00.000Z");
        assert!(range.to.ends_with('Z'), "to defaults to now: {}", range.to);

        let only_to = parse_args(&args(&["--to", "2026-02-01T00:00:00.000Z"]));
        let range = only_to.time_range.expect("range");
        assert_eq!(range.from, "2020-01-01");
        assert_eq!(range.to, "2026-02-01T00:00:00.000Z");
    }

    #[test]
    fn the_batch_size_falls_back_and_is_at_least_one() {
        assert_eq!(parse_batch_size(Some("100")), 100);
        assert_eq!(parse_batch_size(Some("0")), 50);
        assert_eq!(parse_batch_size(Some("nope")), 50);
        assert_eq!(parse_batch_size(Some("-4")), 1);
    }

    #[test]
    fn the_flags_are_read_with_their_values() {
        let options = parse_args(&args(&[
            "--dry-run",
            "--scope",
            "u:p:w",
            "--batch-size",
            "7",
            "--resume",
            "--output",
            "out.json",
        ]));
        assert!(options.dry_run && options.resume);
        assert_eq!(options.scope.as_deref(), Some("u:p:w"));
        assert_eq!(options.batch_size, 7);
        assert_eq!(options.output.as_deref(), Some("out.json"));
    }

    #[test]
    fn the_result_payload_is_parsed_or_kept_as_text() {
        assert_eq!(parse_result_payload(None), Value::Null);
        assert_eq!(parse_result_payload(Some("")), Value::Null);
        assert_eq!(parse_result_payload(Some("{\"a\":1}")), json!({ "a": 1 }));
        assert_eq!(parse_result_payload(Some("not json")), json!("not json"));
    }

    #[test]
    fn the_stats_keep_the_order_of_the_phases() {
        let mut stats = BackfillStats::default();
        stats.set_phase(
            "messages",
            Phase {
                selected: 1,
                ..Phase::default()
            },
        );
        stats.set_phase("tasks", Phase::default());
        stats.set_phase(
            "messages",
            Phase {
                selected: 2,
                ..Phase::default()
            },
        );
        let json = stats.json();
        let names: Vec<&str> = json["phases"]
            .as_object()
            .expect("phases")
            .keys()
            .map(String::as_str)
            .collect();
        assert_eq!(names, vec!["messages", "tasks"]);
        assert_eq!(json["phases"]["messages"]["selected"], 2);
    }

    #[test]
    fn an_episode_projection_mirrors_the_script() {
        let episode = KnowledgeEpisode {
            id: "e1".into(),
            user_id: "u".into(),
            persona_id: "p".into(),
            conversation_id: "c".into(),
            topic_key: "topic".into(),
            counterpart: Some("Ada".into()),
            teaser: String::new(),
            episode: "text".into(),
            facts: vec!["f1".into(), "f2".into()],
            source_seq_start: 10,
            source_seq_end: 12,
            source_refs: vec![],
            memory_ids: vec![],
            event_at: Some("2026-03-01T00:00:00.000Z".into()),
            updated_at: "2026-03-02T00:00:00.000Z".into(),
        };
        let projection = episode_projection(&episode, "p");
        assert_eq!(projection.assertions.len(), 2);
        assert_eq!(projection.assertions[1].source_message_seq, 11);
        assert_eq!(
            projection.events[0].title, "topic",
            "an empty teaser falls back"
        );
        assert_eq!(projection.entities[0].canonical_name, "Ada");
        assert_eq!(projection.confidence_summary.total, 2);
        let json = episode_json(&episode);
        assert_eq!(json["sourceSeqStart"], 10);
        assert_eq!(json["memoryIds"], json!([]));
    }

    #[test]
    fn the_checkpoint_parameters_are_the_scope_and_the_phase() {
        let scope = NormalizedScope {
            user_id: "u".into(),
            persona_id: "p".into(),
            workspace_id: String::new(),
        };
        let params = checkpoint_params(&scope, "tasks");
        assert_eq!(params.len(), 4);
    }
}
