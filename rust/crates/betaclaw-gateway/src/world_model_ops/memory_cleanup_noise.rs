//! `betaclaw-scheduler memory-cleanup-noise` replaces `pnpm run memory:cleanup-noise`
//! (`scripts/memory-cleanup-noise.ts`).
//!
//! It lists the Mem0 memories of every user x persona scope found in the local
//! databases and selects noise: artifact teasers and episodes, facts whose text is
//! not meaningful, and oversized ingestion facts. Without `--apply` nothing is
//! deleted (dry run, the default).
//!
//! Flags: `--apply`, `--persona <id|name>`, `--user <userId>`, `--max-delete <n>`,
//! `--help` / `-h`. Output: one JSON summary on stdout. Errors print
//! `{ "ok": false, "error": ... }` on stderr with exit 1; failed deletes are listed in
//! the summary (`deleteErrors`) and keep exit 0, as the script does.

use std::collections::HashMap;
use std::path::Path;

use betaclaw_core::knowledge::text_quality::is_noise_memory_fact;
use betaclaw_core::memory::mem0::Mem0HttpClient;
use betaclaw_core::memory::types::Mem0ListInput;
use rusqlite::{types::Value, Connection};
use serde_json::{json, Map, Value as Json};

use super::memory_reset::{error_json, pretty};
use super::reconcile::open_readonly;
use super::{
    has_table, js_number, mem0_client, messages_db_path, personas_db_path, process_env, sql_text,
    LEGACY_LOCAL_USER_ID,
};

/// `PAGE_SIZE` of the script.
const PAGE_SIZE: i64 = 200;
/// The number of planned deletes printed in `sample`.
const SAMPLE_SIZE: usize = 25;
/// `content.length > 500` of the oversized-ingestion rule, counted in UTF-16 units.
const OVERSIZED_INGESTION_UNITS: usize = 500;

const USAGE: &str = "Usage: pnpm run memory:cleanup-noise -- [--apply] [--persona <id|name>] [--user <userId>] [--max-delete <n>]\n\nDefaults to dry-run. Use --apply to delete matched memories.";

/// The parsed flags (`parseArgs`, `memory-cleanup-noise.ts:33-72`).
#[derive(Debug, Default, PartialEq)]
pub struct CliOptions {
    pub apply: bool,
    pub persona_filter: Option<String>,
    pub user_filter: Option<String>,
    pub max_delete: Option<i64>,
    pub help: bool,
}

/// A user x persona scope of the local data.
#[derive(Debug, Clone, PartialEq)]
pub struct ScopePair {
    pub user_id: String,
    pub persona_id: String,
}

/// A memory selected for deletion.
#[derive(Debug, Clone, PartialEq)]
pub struct NoiseCandidate {
    pub user_id: String,
    pub persona_id: String,
    pub id: String,
    pub content: String,
    pub reason: String,
}

/// `parseArgs`. A flag that takes a value consumes the next argument even when that
/// argument is another flag, as the script does.
pub fn parse_args(args: &[String]) -> CliOptions {
    let mut options = CliOptions::default();
    let mut index = 0;
    while index < args.len() {
        let arg = args[index].as_str();
        match arg {
            "--apply" => options.apply = true,
            "--persona" => {
                options.persona_filter = Some(trimmed_value(args, index));
                index += 1;
            }
            "--user" => {
                options.user_filter = Some(trimmed_value(args, index));
                index += 1;
            }
            "--max-delete" => {
                if let Some(parsed) = js_number(args.get(index + 1).map(String::as_str)) {
                    if parsed > 0.0 {
                        options.max_delete = Some(parsed.floor() as i64);
                    }
                }
                index += 1;
            }
            "--help" | "-h" => options.help = true,
            _ => {}
        }
        index += 1;
    }
    options
}

/// `String(argv[index + 1] || '').trim()`.
fn trimmed_value(args: &[String], index: usize) -> String {
    args.get(index + 1)
        .map(|value| value.trim().to_string())
        .unwrap_or_default()
}

/// `JSON.stringify` of an optional string, with an empty string counted as absent
/// (`options.personaFilter || null`).
fn or_null(value: &Option<String>) -> Json {
    match value {
        Some(text) if !text.is_empty() => json!(text),
        _ => Json::Null,
    }
}

/// Runs the cleanup. Returns the exit status.
pub async fn run(args: &[String]) -> i32 {
    let options = parse_args(args);
    if options.help {
        println!("{USAGE}");
        return 0;
    }
    match cleanup(&options).await {
        Ok(summary) => {
            println!("{}", pretty(&summary));
            0
        }
        Err(message) => {
            eprintln!("{}", error_json(&message));
            1
        }
    }
}

/// The order of `main()` in the script.
async fn cleanup(options: &CliOptions) -> Result<Json, String> {
    let env = process_env();
    let messages_path = messages_db_path();
    let personas_path = personas_db_path();
    let mem0 = mem0_client(&env)?.ok_or_else(|| {
        "Mem0 not configured. Set MEMORY_PROVIDER=mem0 and MEM0_* env vars.".to_string()
    })?;

    let persona_ids = select_persona_ids(
        &personas_path,
        &messages_path,
        options.persona_filter.as_deref(),
    )?;
    if persona_ids.is_empty() {
        return Err("No persona scopes found for cleanup.".to_string());
    }
    let pairs = collect_scope_pairs(&messages_path, &persona_ids, options.user_filter.as_deref())?;
    if pairs.is_empty() {
        return Err("No user/persona scope pairs found for cleanup.".to_string());
    }

    let mut all_candidates = Vec::new();
    for pair in &pairs {
        all_candidates.extend(collect_noise_candidates(&mem0, pair).await?);
    }
    let unique_candidates = unique_by_id(all_candidates);

    let planned: Vec<NoiseCandidate> = match options.max_delete {
        Some(limit) if limit > 0 => unique_candidates
            .iter()
            .take(limit as usize)
            .cloned()
            .collect(),
        _ => unique_candidates.clone(),
    };

    let mut deleted = 0i64;
    let mut delete_errors: Vec<Json> = Vec::new();
    if options.apply {
        for candidate in &planned {
            match mem0.delete_memory(&candidate.id).await {
                Ok(()) => deleted += 1,
                Err(error) => delete_errors.push(json!({
                    "id": candidate.id,
                    "reason": error.to_string(),
                })),
            }
        }
    }

    let sample: Vec<Json> = planned
        .iter()
        .take(SAMPLE_SIZE)
        .map(|entry| {
            json!({
                "id": entry.id,
                "userId": entry.user_id,
                "personaId": entry.persona_id,
                "reason": entry.reason,
                "content": utf16_prefix(&entry.content, 200),
            })
        })
        .collect();

    Ok(json!({
        "ok": delete_errors.is_empty(),
        "mode": if options.apply { "apply" } else { "dry-run" },
        "filters": {
            "persona": or_null(&options.persona_filter),
            "user": or_null(&options.user_filter),
            "maxDelete": options.max_delete.filter(|value| *value > 0),
        },
        "scopePairs": pairs.iter().map(|pair| json!({
            "userId": pair.user_id,
            "personaId": pair.persona_id,
        })).collect::<Vec<_>>(),
        "scannedCandidates": unique_candidates.len(),
        "plannedDeletes": planned.len(),
        "deleted": deleted,
        "deleteErrors": delete_errors,
        "sample": sample,
    }))
}

/// `selectPersonaIds` (`memory-cleanup-noise.ts:74-130`). The result keeps the
/// insertion order of the script's `Set`.
pub fn select_persona_ids(
    personas_path: &str,
    messages_path: &str,
    filter: Option<&str>,
) -> Result<Vec<String>, String> {
    let filter = filter.unwrap_or("").trim();
    let mut ids = Vec::new();

    if Path::new(personas_path).exists() {
        let db = open_readonly(personas_path)?;
        if has_table(&db, "personas") {
            let rows: Vec<Value> = if filter.is_empty() {
                query_column(&db, "SELECT id FROM personas", &[])?
            } else {
                query_column(
                    &db,
                    "SELECT id FROM personas WHERE id = ? OR lower(name) LIKE lower(?)",
                    &[filter.to_string(), format!("%{filter}%")],
                )?
            };
            for id in rows.into_iter().map(sql_text) {
                if !id.is_empty() {
                    super::push_unique(&mut ids, id);
                }
            }
        }
    }

    if Path::new(messages_path).exists() {
        let db = open_readonly(messages_path)?;
        if has_table(&db, "conversations") {
            let rows: Vec<Value> = if filter.is_empty() {
                query_column(
                    &db,
                    "SELECT DISTINCT persona_id as personaId FROM conversations",
                    &[],
                )?
            } else {
                query_column(
                    &db,
                    "SELECT DISTINCT persona_id as personaId FROM conversations WHERE persona_id = ?",
                    &[filter.to_string()],
                )?
            };
            for id in rows.into_iter().map(sql_text) {
                if !id.is_empty() {
                    super::push_unique(&mut ids, id);
                }
            }
        }
    }

    // An explicit id is used even when no local table knows it.
    if !filter.is_empty() && ids.is_empty() {
        ids.push(filter.to_string());
    }
    Ok(ids)
}

/// The first column of a query, as SQLite values.
fn query_column(db: &Connection, sql: &str, params: &[String]) -> Result<Vec<Value>, String> {
    let mut statement = db.prepare(sql).map_err(|error| error.to_string())?;
    let rows = statement
        .query_map(rusqlite::params_from_iter(params.iter()), |row| {
            row.get::<_, Value>(0)
        })
        .map_err(|error| error.to_string())?;
    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|error| error.to_string())
}

/// `collectScopePairs` (`memory-cleanup-noise.ts:132-192`): distinct user and persona
/// pairs of the local tables, then the legacy scope of the selected personas.
pub fn collect_scope_pairs(
    messages_path: &str,
    persona_ids: &[String],
    user_filter: Option<&str>,
) -> Result<Vec<ScopePair>, String> {
    let user_filter = user_filter.unwrap_or("").trim();
    let mut pairs: Vec<ScopePair> = Vec::new();

    let mut add = |user_raw: &str, persona_raw: &str| {
        let user_id = user_raw.trim();
        let persona_id = persona_raw.trim();
        if user_id.is_empty() || persona_id.is_empty() {
            return;
        }
        if !user_filter.is_empty() && user_id != user_filter {
            return;
        }
        if !persona_ids.is_empty() && !persona_ids.iter().any(|id| id == persona_id) {
            return;
        }
        if !pairs
            .iter()
            .any(|pair| pair.user_id == user_id && pair.persona_id == persona_id)
        {
            pairs.push(ScopePair {
                user_id: user_id.to_string(),
                persona_id: persona_id.to_string(),
            });
        }
    };

    if Path::new(messages_path).exists() {
        let db = open_readonly(messages_path)?;
        for table in [
            "conversations",
            "knowledge_episodes",
            "knowledge_meeting_ledger",
            "memory_nodes",
        ] {
            if !has_table(&db, table) {
                continue;
            }
            let sql =
                format!("SELECT DISTINCT user_id as userId, persona_id as personaId FROM {table}");
            let mut statement = db.prepare(&sql).map_err(|error| error.to_string())?;
            let rows = statement
                .query_map([], |row| {
                    Ok((row.get::<_, Value>(0)?, row.get::<_, Value>(1)?))
                })
                .map_err(|error| error.to_string())?;
            for row in rows {
                let (user, persona) = row.map_err(|error| error.to_string())?;
                add(&sql_text(user), &sql_text(persona));
            }
        }
    }

    // The legacy fallback scope of the selected personas.
    let legacy_user = if user_filter.is_empty() {
        LEGACY_LOCAL_USER_ID
    } else {
        user_filter
    };
    for persona_id in persona_ids {
        add(legacy_user, persona_id);
    }
    Ok(pairs)
}

/// `classifyNoiseReason` (`memory-cleanup-noise.ts:194-216`).
pub fn classify_noise_reason(metadata: &Map<String, Json>, content: &str) -> Option<String> {
    let field = |name: &str| super::js_string(metadata.get(name)).trim().to_lowercase();
    let memory_type = field("type");
    let source_type = field("sourceType");
    let artifact_type = field("artifactType");
    let content = content.trim();

    if artifact_type == "teaser" || artifact_type == "episode" {
        return Some(format!("artifact:{artifact_type}"));
    }
    if !memory_type.is_empty() && memory_type != "fact" {
        return None;
    }
    if is_noise_memory_fact(content) {
        return Some("noise-fact-text".to_string());
    }
    if source_type == "knowledge_ingestion"
        && content.encode_utf16().count() > OVERSIZED_INGESTION_UNITS
    {
        return Some("oversized-ingestion-fact".to_string());
    }
    None
}

/// `collectNoiseCandidates` (`memory-cleanup-noise.ts:218-252`): every page of the
/// scope, classified in order.
pub async fn collect_noise_candidates(
    mem0: &Mem0HttpClient,
    pair: &ScopePair,
) -> Result<Vec<NoiseCandidate>, String> {
    let mut found = Vec::new();
    let mut page = 1i64;
    loop {
        let listed = mem0
            .list_memories(&Mem0ListInput {
                user_id: pair.user_id.clone(),
                persona_id: Some(pair.persona_id.clone()),
                workspace_id: None,
                page,
                page_size: PAGE_SIZE,
                query: None,
                node_type: None,
            })
            .await
            .map_err(|error| error.to_string())?;

        for memory in &listed.memories {
            let content = memory.content.trim();
            if let Some(reason) = classify_noise_reason(&memory.metadata, content) {
                found.push(NoiseCandidate {
                    user_id: pair.user_id.clone(),
                    persona_id: pair.persona_id.clone(),
                    id: memory.id.clone(),
                    content: collapse_whitespace(&memory.content),
                    reason,
                });
            }
        }

        let reached_end = page * PAGE_SIZE >= listed.total || listed.memories.is_empty();
        if reached_end {
            break;
        }
        page += 1;
    }
    Ok(found)
}

/// `replace(/\s+/g, ' ').trim()`, with the BOM counted as whitespace as in JavaScript.
pub fn collapse_whitespace(value: &str) -> String {
    value
        .split(|c: char| c.is_whitespace() || c == '\u{feff}')
        .filter(|part| !part.is_empty())
        .collect::<Vec<_>>()
        .join(" ")
}

/// The first `units` UTF-16 code units of `value` (`slice(0, units)`).
pub fn utf16_prefix(value: &str, units: usize) -> String {
    let encoded: Vec<u16> = value.encode_utf16().take(units).collect();
    String::from_utf16_lossy(&encoded)
}

/// Keeps the first position of every id and the last candidate for it, as a JS `Map`
/// built from the list does.
pub fn unique_by_id(candidates: Vec<NoiseCandidate>) -> Vec<NoiseCandidate> {
    let mut order: Vec<NoiseCandidate> = Vec::new();
    let mut position: HashMap<String, usize> = HashMap::new();
    for candidate in candidates {
        match position.get(&candidate.id) {
            Some(&index) => order[index] = candidate,
            None => {
                position.insert(candidate.id.clone(), order.len());
                order.push(candidate);
            }
        }
    }
    order
}

#[cfg(test)]
mod tests {
    use super::*;

    fn args(values: &[&str]) -> Vec<String> {
        values.iter().map(|value| value.to_string()).collect()
    }

    #[test]
    fn a_value_flag_consumes_the_next_argument_even_a_flag() {
        let options = parse_args(&args(&["--persona", "--apply"]));
        assert!(!options.apply);
        assert_eq!(options.persona_filter.as_deref(), Some("--apply"));
    }

    #[test]
    fn max_delete_needs_a_positive_number() {
        assert_eq!(
            parse_args(&args(&["--max-delete", "3.9"])).max_delete,
            Some(3)
        );
        assert_eq!(parse_args(&args(&["--max-delete", "0"])).max_delete, None);
        assert_eq!(parse_args(&args(&["--max-delete", "x"])).max_delete, None);
        assert_eq!(parse_args(&args(&["--max-delete"])).max_delete, None);
    }

    #[test]
    fn dry_run_is_the_default() {
        let options = parse_args(&args(&["--user", " u1 "]));
        assert!(!options.apply);
        assert_eq!(options.user_filter.as_deref(), Some("u1"));
    }

    #[test]
    fn noise_reasons_follow_the_script_rules() {
        let mut meta = Map::new();
        meta.insert("artifactType".into(), json!("Teaser"));
        assert_eq!(
            classify_noise_reason(&meta, "anything").as_deref(),
            Some("artifact:teaser")
        );

        let mut other_type = Map::new();
        other_type.insert("type".into(), json!("preference"));
        assert_eq!(classify_noise_reason(&other_type, ""), None);

        let mut ingestion = Map::new();
        ingestion.insert("sourceType".into(), json!("knowledge_ingestion"));
        let long = "a".repeat(501);
        assert_eq!(
            classify_noise_reason(&ingestion, &long).as_deref(),
            Some("oversized-ingestion-fact")
        );
        assert_eq!(classify_noise_reason(&ingestion, &"a".repeat(500)), None);
    }

    #[test]
    fn whitespace_is_collapsed_and_slices_count_utf16_units() {
        assert_eq!(collapse_whitespace("  a \n\t b\u{feff}c  "), "a b c");
        assert_eq!(utf16_prefix("abcdef", 3), "abc");
        assert_eq!(utf16_prefix("\u{1F600}x", 2), "\u{1F600}");
    }

    #[test]
    fn duplicate_ids_keep_the_first_place_and_the_last_value() {
        let candidate = |id: &str, reason: &str| NoiseCandidate {
            user_id: "u".into(),
            persona_id: "p".into(),
            id: id.into(),
            content: String::new(),
            reason: reason.into(),
        };
        let unique = unique_by_id(vec![
            candidate("a", "first"),
            candidate("b", "only"),
            candidate("a", "last"),
        ]);
        let reasons: Vec<(&str, &str)> = unique
            .iter()
            .map(|entry| (entry.id.as_str(), entry.reason.as_str()))
            .collect();
        assert_eq!(reasons, vec![("a", "last"), ("b", "only")]);
    }

    #[test]
    fn js_numbers_follow_number_coercion() {
        assert_eq!(js_number(Some("")), Some(0.0));
        assert_eq!(js_number(Some("0x10")), Some(16.0));
        assert_eq!(js_number(Some("Infinity")), None);
        assert_eq!(js_number(Some("NaN")), None);
        assert_eq!(js_number(None), None);
    }
}
