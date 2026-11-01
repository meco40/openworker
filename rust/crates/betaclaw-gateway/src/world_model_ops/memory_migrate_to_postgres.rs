//! `betaclaw-scheduler memory-migrate-to-postgres` replaces
//! `pnpm run memory:migrate-to-postgres` (`scripts/memory-migrate-to-postgres.ts`).
//!
//! A one-way, idempotent copy of the legacy Mem0 memories of the given scopes into the
//! canonical PostgreSQL memory store. Mem0 has no provider-wide list endpoint, so the
//! scopes come from `--scope userId:personaId[:workspaceId]`, from
//! `WORLD_MODEL_MIGRATION_SCOPES` and from the World-Model tables; the report says so.
//!
//! Flags: `--scope <value>|all`, `--apply` (without it nothing is written),
//! `--output <file>` (the JSON report is also written there). Exit 1 when a memory
//! could not be copied or the run failed; failures print `Memory migration failed: ...`
//! on stderr.

use std::collections::{HashMap, HashSet};
use std::sync::Arc;

use betaclaw_core::memory::mem0::Mem0HttpClient;
use betaclaw_core::memory::postgres::PostgresMemoryClient;
use betaclaw_core::memory::types::{Mem0ListInput, Mem0MemoryInput, Mem0MemoryRecord};
use betaclaw_core::world_model::db::{PgExecutor, PgStatement};
use betaclaw_core::world_model::driver::SqlxPgExecutor;
use serde_json::{json, Map, Value as Json};

use super::{
    connect_lazy_executor, connect_url, env_trimmed, flag_value, load_config, mem0_client, migrate,
    process_env, text_of,
};
use crate::model_hub_embedding::canonical_memory_client;

/// `pageSize: 200` of the listing.
const PAGE_SIZE: i64 = 200;
/// `page <= 10_000` safety limit of the listing.
const MAX_PAGES: i64 = 10_000;
/// The pool of the discovery query on the admin URL (`max: 1, idleTimeoutMillis: 5000`).
const ADMIN_POOL_MAX: i64 = 1;
const ADMIN_POOL_IDLE_MS: i64 = 5_000;

const COVERAGE_LIMITATION: &str =
    "Mem0 has no provider-wide list endpoint; only explicit or application-discovered scopes are covered.";

/// The World-Model tables the discovery reads (`discoverScopes`).
const DISCOVERY_SQL: &str = "
        SELECT DISTINCT user_id, persona_id, workspace_id FROM world_model_observations
        UNION
        SELECT DISTINCT user_id, persona_id, workspace_id FROM world_model_entities
        UNION
        SELECT DISTINCT user_id, persona_id, workspace_id FROM world_model_tasks
        UNION
        SELECT DISTINCT user_id, persona_id, workspace_id
        FROM world_model_memory_items WHERE deleted_at IS NULL";

/// One scope of the migration (`MigrationScope`).
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub struct MigrationScope {
    pub user_id: String,
    pub persona_id: String,
    pub workspace_id: String,
}

impl MigrationScope {
    fn to_json(&self) -> Json {
        json!({
            "userId": self.user_id,
            "personaId": self.persona_id,
            "workspaceId": self.workspace_id,
        })
    }
}

/// Counts and errors of one scope (`ScopeReport`).
#[derive(Debug)]
pub struct ScopeReport {
    pub scope: MigrationScope,
    pub source_memories: i64,
    pub migrated: i64,
    pub already_present: i64,
    pub errors: Vec<String>,
}

impl ScopeReport {
    fn new(scope: MigrationScope) -> Self {
        Self {
            scope,
            source_memories: 0,
            migrated: 0,
            already_present: 0,
            errors: Vec::new(),
        }
    }
}

/// The parsed flags of the command.
#[derive(Debug, PartialEq)]
pub struct Options {
    pub apply: bool,
    pub requested_scope: Option<String>,
    pub output: Option<String>,
}

/// Reads `--apply`, `--scope` and `--output` (`hasFlag` and `arg` of the script).
pub fn parse_options(args: &[String]) -> Options {
    Options {
        apply: args.iter().any(|arg| arg == "--apply"),
        requested_scope: flag_value(args, "--scope"),
        output: flag_value(args, "--output"),
    }
}

/// `parseScope` (`memory-migrate-to-postgres.ts:50-59`): the user and the persona are
/// required, the workspace may contain `:`.
pub fn parse_scope(value: &str) -> Result<MigrationScope, String> {
    let parts: Vec<&str> = value.split(':').collect();
    let user_id = parts.first().map(|part| part.trim()).unwrap_or("");
    let persona_id = parts.get(1).map(|part| part.trim()).unwrap_or("");
    let workspace_id = parts
        .iter()
        .skip(2)
        .copied()
        .collect::<Vec<_>>()
        .join(":")
        .trim()
        .to_string();
    if user_id.is_empty() || persona_id.is_empty() {
        return Err(format!(
            "Invalid scope '{value}'. Expected userId:personaId[:workspaceId]."
        ));
    }
    Ok(MigrationScope {
        user_id: user_id.to_string(),
        persona_id: persona_id.to_string(),
        workspace_id,
    })
}

/// The scopes in insertion order; a repeated scope keeps its first place (`addScope`).
#[derive(Default)]
struct ScopeSet {
    order: Vec<MigrationScope>,
    seen: HashSet<MigrationScope>,
}

impl ScopeSet {
    fn add(&mut self, scope: MigrationScope) {
        if self.seen.insert(scope.clone()) {
            self.order.push(scope);
        }
    }
}

/// `discoverScopes` (`memory-migrate-to-postgres.ts:61-100`): the configured scopes,
/// then the scopes of the World-Model tables. The table query is best effort.
async fn discover_scopes(
    app: &SqlxPgExecutor,
    env: &HashMap<String, String>,
) -> Result<Vec<MigrationScope>, String> {
    let mut scopes = ScopeSet::default();
    let configured = env
        .get("WORLD_MODEL_MIGRATION_SCOPES")
        .map(|value| value.trim().to_string())
        .unwrap_or_default();
    for value in configured
        .split(',')
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        scopes.add(parse_scope(value)?);
    }

    // `catch {}` of the script: the explicit scopes stay usable when the database is
    // not reachable or not provisioned yet.
    let _ = discover_from_database(app, env, &mut scopes).await;
    Ok(scopes.order)
}

/// The table query of the discovery. The admin URL, when set, gets its own pool.
async fn discover_from_database(
    app: &SqlxPgExecutor,
    env: &HashMap<String, String>,
    scopes: &mut ScopeSet,
) -> Result<(), String> {
    let rows = match env_trimmed(env, "WORLD_MODEL_ADMIN_DATABASE_URL") {
        Some(url) => {
            let admin = connect_url(&url, ADMIN_POOL_MAX, ADMIN_POOL_IDLE_MS)
                .await
                .map_err(|error| error.into_message())?;
            let result = admin.query(PgStatement::new(DISCOVERY_SQL)).await;
            admin.close().await;
            result.map_err(|error| error.into_message())?.rows
        }
        None => {
            app.query(PgStatement::new(DISCOVERY_SQL))
                .await
                .map_err(|error| error.into_message())?
                .rows
        }
    };
    for row in rows {
        scopes.add(MigrationScope {
            user_id: text_of(row.get("user_id")).unwrap_or_default(),
            persona_id: text_of(row.get("persona_id")).unwrap_or_default(),
            workspace_id: text_of(row.get("workspace_id")).unwrap_or_default(),
        });
    }
    Ok(())
}

/// `listAllMemories` (`memory-migrate-to-postgres.ts:102-116`). The listing ignores the
/// workspace of the scope, as the script does.
async fn list_all_memories(
    source: &Mem0HttpClient,
    scope: &MigrationScope,
) -> Result<Vec<Mem0MemoryRecord>, String> {
    let mut memories: Vec<Mem0MemoryRecord> = Vec::new();
    let mut page = 1i64;
    while page <= MAX_PAGES {
        let result = source
            .list_memories(&Mem0ListInput {
                user_id: scope.user_id.clone(),
                persona_id: Some(scope.persona_id.clone()),
                workspace_id: None,
                page,
                page_size: PAGE_SIZE,
                query: None,
                node_type: None,
            })
            .await
            .map_err(|error| error.to_string())?;
        let empty = result.memories.is_empty();
        memories.extend(result.memories);
        if empty || memories.len() as i64 >= result.total {
            break;
        }
        page += 1;
    }
    if page > MAX_PAGES {
        return Err("Mem0 pagination exceeded the migration safety limit.".to_string());
    }
    Ok(memories)
}

/// `migrateScope` (`memory-migrate-to-postgres.ts:118-151`). Without `--apply` only the
/// source count is reported.
async fn migrate_scope(
    source: &Mem0HttpClient,
    destination: &PostgresMemoryClient,
    scope: &MigrationScope,
    apply: bool,
) -> Result<ScopeReport, String> {
    let memories = list_all_memories(source, scope).await?;
    let mut report = ScopeReport::new(scope.clone());
    report.source_memories = memories.len() as i64;
    if !apply {
        return Ok(report);
    }

    for record in memories {
        // `{ ...record.metadata, workspaceId, source, ... }`: keys of the record keep
        // their place when the migration overrides them.
        let mut metadata: Map<String, Json> = record.metadata.clone();
        metadata.insert("workspaceId".into(), json!(scope.workspace_id));
        metadata.insert("source".into(), json!("mem0-migration"));
        metadata.insert("memoryProvider".into(), json!("postgres"));
        metadata.insert("legacyProvider".into(), json!("mem0"));
        metadata.insert("legacyMem0Id".into(), json!(record.id));
        metadata.insert("migratedAt".into(), json!(super::iso_now()));

        let result = destination
            .add_memory(&Mem0MemoryInput {
                user_id: scope.user_id.clone(),
                persona_id: scope.persona_id.clone(),
                workspace_id: Some(scope.workspace_id.clone()),
                content: record.content.clone(),
                metadata,
            })
            .await;
        match result {
            Ok(added) if !added.created => report.already_present += 1,
            Ok(_) => report.migrated += 1,
            Err(error) => report.errors.push(format!("{}: {error}", record.id)),
        }
    }
    Ok(report)
}

/// Runs the migration. Returns the exit status.
pub async fn run(args: &[String]) -> i32 {
    match migrate_memories(args).await {
        Ok(failed) => {
            if failed {
                1
            } else {
                0
            }
        }
        Err(message) => {
            eprintln!("Memory migration failed: {message}");
            1
        }
    }
}

/// The order of the script. Returns whether a memory failed to copy.
async fn migrate_memories(args: &[String]) -> Result<bool, String> {
    let options = parse_options(args);
    let env = process_env();
    let app =
        Arc::new(connect_lazy_executor(&load_config()).map_err(|error| error.into_message())?);
    let outcome = migrate_with(&app, &env, &options).await;
    app.close().await;
    outcome
}

/// The scope discovery, the source client, the migration and the report.
async fn migrate_with(
    app: &Arc<SqlxPgExecutor>,
    env: &HashMap<String, String>,
    options: &Options,
) -> Result<bool, String> {
    let scopes = match options.requested_scope.as_deref() {
        Some(value) if value != "all" => vec![parse_scope(value)?],
        _ => discover_scopes(app, env).await?,
    };
    if scopes.is_empty() {
        return Err("No migration scopes discovered. Provide --scope userId:personaId[:workspaceId] or set WORLD_MODEL_MIGRATION_SCOPES.".to_string());
    }

    // The source is always Mem0, whatever MEMORY_PROVIDER says.
    let mut source_env = env.clone();
    source_env.insert("MEMORY_PROVIDER".to_string(), "mem0".to_string());
    let source = mem0_client(&source_env)?.ok_or_else(|| {
        "Mem0 source is not configured; set MEM0_BASE_URL and MEM0_API_KEY.".to_string()
    })?;

    if options.apply {
        migrate(app.as_ref())
            .await
            .map_err(|error| error.into_message())?;
    }
    let destination = canonical_memory_client(app.clone());

    let mut reports = Vec::new();
    for scope in &scopes {
        println!(
            "Migrating {}:{}:{}",
            scope.user_id, scope.persona_id, scope.workspace_id
        );
        reports.push(migrate_scope(&source, &destination, scope, options.apply).await?);
    }

    let source_memories: i64 = reports.iter().map(|report| report.source_memories).sum();
    let migrated: i64 = reports.iter().map(|report| report.migrated).sum();
    let already_present: i64 = reports.iter().map(|report| report.already_present).sum();
    let errors: usize = reports.iter().map(|report| report.errors.len()).sum();

    let report = json!({
        "generatedAt": super::iso_now(),
        "mode": if options.apply { "apply" } else { "dry-run" },
        "sourceProvider": "mem0",
        "destinationProvider": "postgres",
        "providerWideListSupported": false,
        "coverage": {
            "discoveredScopes": scopes.len(),
            "limitation": COVERAGE_LIMITATION,
        },
        "scopes": reports.iter().map(|entry| json!({
            "scope": entry.scope.to_json(),
            "sourceMemories": entry.source_memories,
            "migrated": entry.migrated,
            "alreadyPresent": entry.already_present,
            "errors": entry.errors,
        })).collect::<Vec<_>>(),
        "totals": {
            "sourceMemories": source_memories,
            "migrated": migrated,
            "alreadyPresent": already_present,
            "errors": errors,
        },
    });
    let text = serde_json::to_string_pretty(&report).unwrap_or_default();
    println!("{text}");

    if let Some(path) = &options.output {
        std::fs::write(path, &text).map_err(|error| error.to_string())?;
    }
    Ok(errors > 0)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_scope_needs_a_user_and_a_persona_and_keeps_colons_in_the_workspace() {
        assert_eq!(
            parse_scope(" u : p : a:b ").unwrap(),
            MigrationScope {
                user_id: "u".into(),
                persona_id: "p".into(),
                workspace_id: "a:b".into(),
            }
        );
        assert_eq!(parse_scope("u:p").unwrap().workspace_id, "");
        assert_eq!(
            parse_scope("u:").unwrap_err(),
            "Invalid scope 'u:'. Expected userId:personaId[:workspaceId]."
        );
        assert!(parse_scope(":p").is_err());
    }

    #[test]
    fn the_flags_are_read_like_the_script_reads_them() {
        let args: Vec<String> = ["--scope", "all", "--apply", "--output", "r.json"]
            .iter()
            .map(|value| value.to_string())
            .collect();
        assert_eq!(
            parse_options(&args),
            Options {
                apply: true,
                requested_scope: Some("all".into()),
                output: Some("r.json".into()),
            }
        );
    }

    #[test]
    fn a_scope_set_keeps_the_first_place_of_a_repeated_scope() {
        let mut set = ScopeSet::default();
        let first = parse_scope("u:p:w").unwrap();
        set.add(parse_scope("u:q").unwrap());
        set.add(first.clone());
        set.add(first.clone());
        assert_eq!(set.order, vec![parse_scope("u:q").unwrap(), first]);
    }
}
