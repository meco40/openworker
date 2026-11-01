//! `betaclaw-scheduler memory-backfill-channel-scope` replaces
//! `pnpm run memory:backfill-channel-scope` (`scripts/memory-backfill-channel-scope.ts`).
//!
//! The legacy webchat-scoped rows of the messages database are copied to the channel
//! scope `channel:<type>:<externalChatId>` of each non-webchat conversation:
//! `knowledge_episodes` and `knowledge_meeting_ledger` rows in one transaction, then
//! the Mem0 memories of the legacy scope that the channel scope does not hold yet.
//! The command has no dry run; it writes when it runs. The arguments are ignored.
//!
//! Output: one JSON report on stdout. Mem0 errors are reported in the report and
//! exit 1; other failures print `{ "ok": false, "error": ... }` on stderr (exit 1).

use std::collections::{HashMap, HashSet};
use std::path::Path;

use betaclaw_core::memory::mem0::Mem0HttpClient;
use betaclaw_core::memory::types::{Mem0ListInput, Mem0ListMemoryResult, Mem0MemoryInput};
use rusqlite::{types::Value, Connection, OptionalExtension};
use serde_json::{json, Map, Value as Json};

use super::memory_reset::{error_json, pretty};
use super::{
    has_table, mem0_client, messages_db_path, process_env, sql_text, LEGACY_LOCAL_USER_ID,
};

/// `MEMORY_PAGE_SIZE` of the script.
const MEMORY_PAGE_SIZE: i64 = 200;
/// `busy_timeout = 8000` of the script's connection.
const BUSY_TIMEOUT: std::time::Duration = std::time::Duration::from_millis(8_000);

/// A non-webchat conversation with its channel scope (`ConversationScope`).
#[derive(Debug, Clone, PartialEq)]
pub struct ConversationScope {
    pub conversation_id: String,
    pub persona_id: String,
    pub channel_type: String,
    pub external_chat_id: String,
    pub target_user_id: String,
}

/// Counts of the knowledge tables (`KnowledgeBackfillStats`).
#[derive(Debug, Default, PartialEq)]
pub struct KnowledgeBackfillStats {
    pub conversations: i64,
    pub episodes_copied: i64,
    pub ledger_copied: i64,
}

/// Counts of the Mem0 pass (`Mem0BackfillStats`).
#[derive(Debug, Default, PartialEq)]
pub struct Mem0BackfillStats {
    pub scopes_processed: i64,
    pub source_memories: i64,
    pub target_memories_before: i64,
    pub inserted: i64,
    pub skipped_existing: i64,
    pub errors: Vec<String>,
}

/// Runs the backfill. Returns the exit status.
pub async fn run(_args: &[String]) -> i32 {
    match backfill().await {
        Ok((report, failed)) => {
            println!("{}", pretty(&report));
            if failed {
                1
            } else {
                0
            }
        }
        Err(message) => {
            eprintln!("{}", error_json(&message));
            1
        }
    }
}

/// The order of `main()` in the script. Returns the report and whether Mem0 failed.
async fn backfill() -> Result<(Json, bool), String> {
    let env = process_env();
    let messages_path = messages_db_path();
    if !Path::new(&messages_path).exists() {
        return Err(format!("Messages DB not found: {messages_path}"));
    }

    let mut db = Connection::open(&messages_path).map_err(|error| error.to_string())?;
    db.busy_timeout(BUSY_TIMEOUT)
        .map_err(|error| error.to_string())?;
    db.pragma_update(None, "journal_mode", "WAL")
        .map_err(|error| error.to_string())?;

    let scopes = list_conversation_scopes(&db)?;
    let knowledge = backfill_knowledge_tables(&mut db, &scopes)?;

    let client = mem0_client(&env)?;
    let mem0 = backfill_mem0_scopes(client.as_ref(), &scopes).await;
    let failed = !mem0.errors.is_empty();

    let report = json!({
        "ok": !failed,
        "messagesDbPath": messages_path,
        "scopes": scopes.len(),
        "knowledge": {
            "conversations": knowledge.conversations,
            "episodesCopied": knowledge.episodes_copied,
            "ledgerCopied": knowledge.ledger_copied,
        },
        "mem0": {
            "scopesProcessed": mem0.scopes_processed,
            "sourceMemories": mem0.source_memories,
            "targetMemoriesBefore": mem0.target_memories_before,
            "inserted": mem0.inserted,
            "skippedExisting": mem0.skipped_existing,
            "errors": mem0.errors,
        },
    });
    Ok((report, failed))
}

/// `buildChannelScope` (`memory-backfill-channel-scope.ts:33-35`).
pub fn build_channel_scope(channel_type: &str, external_chat_id: &str) -> String {
    format!(
        "channel:{}:{}",
        channel_type.trim().to_lowercase(),
        external_chat_id.trim()
    )
}

/// `listConversationScopes` (`memory-backfill-channel-scope.ts:37-80`): the legacy
/// user's conversations with a persona and a chat id, except webchat.
pub fn list_conversation_scopes(db: &Connection) -> Result<Vec<ConversationScope>, String> {
    if !has_table(db, "conversations") {
        return Ok(Vec::new());
    }
    let mut statement = db
        .prepare(
            "SELECT id, persona_id, channel_type, external_chat_id, user_id
             FROM conversations
             WHERE user_id = ?1
               AND persona_id IS NOT NULL
               AND COALESCE(external_chat_id, '') <> ''
               AND LOWER(channel_type) <> 'webchat'",
        )
        .map_err(|error| error.to_string())?;
    let rows = statement
        .query_map([LEGACY_LOCAL_USER_ID], |row| {
            Ok((
                row.get::<_, Value>(0)?,
                row.get::<_, Value>(1)?,
                row.get::<_, Value>(2)?,
                row.get::<_, Value>(3)?,
            ))
        })
        .map_err(|error| error.to_string())?;

    let mut scopes = Vec::new();
    for row in rows {
        let (id, persona_id, channel_type, external_chat_id) =
            row.map_err(|error| error.to_string())?;
        let scope = ConversationScope {
            conversation_id: sql_text(id),
            persona_id: sql_text(persona_id).trim().to_string(),
            channel_type: sql_text(channel_type.clone()).trim().to_string(),
            external_chat_id: sql_text(external_chat_id.clone()).trim().to_string(),
            target_user_id: build_channel_scope(
                &sql_text(channel_type),
                &sql_text(external_chat_id),
            ),
        };
        if !scope.conversation_id.is_empty()
            && !scope.persona_id.is_empty()
            && !scope.channel_type.is_empty()
            && !scope.external_chat_id.is_empty()
        {
            scopes.push(scope);
        }
    }
    Ok(scopes)
}

/// `backfillKnowledgeTables` (`memory-backfill-channel-scope.ts:82-266`). All copies
/// run in one transaction; a failure leaves the database as it was.
pub fn backfill_knowledge_tables(
    db: &mut Connection,
    scopes: &[ConversationScope],
) -> Result<KnowledgeBackfillStats, String> {
    let mut stats = KnowledgeBackfillStats {
        conversations: scopes.len() as i64,
        ..Default::default()
    };
    if scopes.is_empty() {
        return Ok(stats);
    }
    let has_episodes = has_table(db, "knowledge_episodes");
    let has_ledger = has_table(db, "knowledge_meeting_ledger");
    if !has_episodes && !has_ledger {
        return Ok(stats);
    }

    let transaction = db.transaction().map_err(|error| error.to_string())?;
    for scope in scopes {
        if has_episodes {
            let rows = select_rows(
                &transaction,
                "SELECT * FROM knowledge_episodes WHERE user_id = ?1 AND conversation_id = ?2 AND persona_id = ?3",
                &scope.conversation_id,
                &scope.persona_id,
            )?;
            for row in rows {
                copy_episode(&transaction, scope, &row)?;
                stats.episodes_copied += 1;
            }
        }
        if has_ledger {
            let rows = select_rows(
                &transaction,
                "SELECT * FROM knowledge_meeting_ledger WHERE user_id = ?1 AND conversation_id = ?2 AND persona_id = ?3",
                &scope.conversation_id,
                &scope.persona_id,
            )?;
            for row in rows {
                copy_ledger_entry(&transaction, scope, &row)?;
                stats.ledger_copied += 1;
            }
        }
    }
    transaction.commit().map_err(|error| error.to_string())?;
    Ok(stats)
}

/// A row of `SELECT *`, by column name.
type Row = HashMap<String, Value>;

/// The rows of the legacy user for one conversation and persona.
fn select_rows(
    db: &Connection,
    sql: &str,
    conversation_id: &str,
    persona_id: &str,
) -> Result<Vec<Row>, String> {
    let mut statement = db.prepare(sql).map_err(|error| error.to_string())?;
    let names: Vec<String> = statement.column_names().map(str::to_string).collect();
    let rows = statement
        .query_map(
            rusqlite::params![LEGACY_LOCAL_USER_ID, conversation_id, persona_id],
            |row| {
                (0..names.len())
                    .map(|index| row.get::<_, Value>(index))
                    .collect::<Result<Vec<Value>, _>>()
            },
        )
        .map_err(|error| error.to_string())?;
    let mut result = Vec::new();
    for values in rows {
        let values = values.map_err(|error| error.to_string())?;
        result.push(names.iter().cloned().zip(values).collect());
    }
    Ok(result)
}

/// `String(row[column] || fallback)`: NULL and empty text take the fallback.
fn text_or(row: &Row, column: &str, fallback: &str) -> String {
    let text = row
        .get(column)
        .map(|value| sql_text(value.clone()))
        .unwrap_or_default();
    if text.is_empty() {
        fallback.to_string()
    } else {
        text
    }
}

/// `row.column ? String(row.column) : null`.
fn text_or_null(row: &Row, column: &str) -> Option<String> {
    let text = row
        .get(column)
        .map(|value| sql_text(value.clone()))
        .unwrap_or_default();
    (!text.is_empty()).then_some(text)
}

/// `Number(value)` of a column: NULL is 0, text is parsed like JavaScript does, and
/// anything that is not a number is NaN.
pub fn js_number_of(value: Option<&Value>) -> f64 {
    match value {
        None | Some(Value::Null) => 0.0,
        Some(Value::Integer(number)) => *number as f64,
        Some(Value::Real(number)) => *number,
        Some(Value::Text(text)) => {
            let trimmed = text.trim();
            if trimmed.is_empty() {
                0.0
            } else {
                super::js_number(Some(trimmed)).unwrap_or(f64::NAN)
            }
        }
        Some(Value::Blob(_)) => f64::NAN,
    }
}

/// `Math.max(0, Math.floor(Number(row[column] || 0)))`. A NaN stays NaN, as in the script.
fn non_negative_floor(row: &Row, column: &str) -> f64 {
    let number = js_number_of(row.get(column));
    let number = if number.is_nan() { 0.0 } else { number };
    number.floor().max(0.0)
}

/// `INSERT ... ON CONFLICT ... DO UPDATE` of one episode (`memory-backfill-channel-scope.ts:112-160`).
fn copy_episode(db: &Connection, scope: &ConversationScope, row: &Row) -> Result<(), String> {
    let now = super::iso_now();
    let id = text_or(row, "id", "");
    let id = if id.is_empty() {
        uuid::Uuid::new_v4().to_string()
    } else {
        id
    };
    db.execute(
        "INSERT INTO knowledge_episodes (
            id, user_id, persona_id, conversation_id, topic_key, counterpart, teaser, episode,
            facts_json, source_seq_start, source_seq_end, source_refs_json, event_at, created_at, updated_at
         ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15)
         ON CONFLICT(conversation_id, persona_id, source_seq_start, source_seq_end)
         DO UPDATE SET
            user_id = excluded.user_id,
            topic_key = excluded.topic_key,
            counterpart = excluded.counterpart,
            teaser = excluded.teaser,
            episode = excluded.episode,
            facts_json = excluded.facts_json,
            source_refs_json = excluded.source_refs_json,
            event_at = excluded.event_at,
            updated_at = excluded.updated_at",
        rusqlite::params![
            id,
            scope.target_user_id,
            scope.persona_id,
            scope.conversation_id,
            text_or(row, "topic_key", "general"),
            text_or_null(row, "counterpart"),
            text_or(row, "teaser", ""),
            text_or(row, "episode", ""),
            text_or(row, "facts_json", "[]"),
            non_negative_floor(row, "source_seq_start"),
            non_negative_floor(row, "source_seq_end"),
            text_or(row, "source_refs_json", "[]"),
            text_or_null(row, "event_at"),
            text_or(row, "created_at", &now),
            now,
        ],
    )
    .map_err(|error| error.to_string())?;
    Ok(())
}

/// The update of a ledger entry without `event_at`, or the upsert of any other one
/// (`memory-backfill-channel-scope.ts:162-257`).
fn copy_ledger_entry(db: &Connection, scope: &ConversationScope, row: &Row) -> Result<(), String> {
    let topic_key = text_or(row, "topic_key", "general-meeting");
    let event_at = text_or_null(row, "event_at");
    let participants = text_or(row, "participants_json", "[]");
    let decisions = text_or(row, "decisions_json", "[]");
    let negotiated = text_or(row, "negotiated_terms_json", "[]");
    let open_points = text_or(row, "open_points_json", "[]");
    let action_items = text_or(row, "action_items_json", "[]");
    let source_refs = text_or(row, "source_refs_json", "[]");
    let confidence = {
        let number = js_number_of(row.get("confidence"));
        if number.is_finite() {
            number
        } else {
            0.5
        }
    };
    let now = super::iso_now();
    let counterpart = text_or_null(row, "counterpart");

    if event_at.is_none() {
        let existing: Option<String> = db
            .query_row(
                "SELECT id FROM knowledge_meeting_ledger
                 WHERE conversation_id = ?1 AND persona_id = ?2 AND topic_key = ?3 AND event_at IS NULL
                 LIMIT 1",
                rusqlite::params![scope.conversation_id, scope.persona_id, topic_key],
                |found| found.get::<_, Value>(0).map(sql_text),
            )
            .optional()
            .map_err(|error| error.to_string())?
            .filter(|id| !id.is_empty());
        if let Some(existing_id) = existing {
            db.execute(
                "UPDATE knowledge_meeting_ledger
                 SET user_id = ?1, counterpart = ?2, participants_json = ?3, decisions_json = ?4,
                     negotiated_terms_json = ?5, open_points_json = ?6, action_items_json = ?7,
                     source_refs_json = ?8, confidence = ?9, updated_at = ?10
                 WHERE id = ?11",
                rusqlite::params![
                    scope.target_user_id,
                    counterpart,
                    participants,
                    decisions,
                    negotiated,
                    open_points,
                    action_items,
                    source_refs,
                    confidence,
                    now,
                    existing_id,
                ],
            )
            .map_err(|error| error.to_string())?;
            return Ok(());
        }
    }

    let id = text_or(row, "id", "");
    let id = if id.is_empty() {
        uuid::Uuid::new_v4().to_string()
    } else {
        id
    };
    db.execute(
        "INSERT INTO knowledge_meeting_ledger (
            id, user_id, persona_id, conversation_id, topic_key, counterpart, event_at,
            participants_json, decisions_json, negotiated_terms_json, open_points_json, action_items_json,
            source_refs_json, confidence, created_at, updated_at
         ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16)
         ON CONFLICT(conversation_id, persona_id, topic_key, event_at)
         DO UPDATE SET
            user_id = excluded.user_id,
            counterpart = excluded.counterpart,
            participants_json = excluded.participants_json,
            decisions_json = excluded.decisions_json,
            negotiated_terms_json = excluded.negotiated_terms_json,
            open_points_json = excluded.open_points_json,
            action_items_json = excluded.action_items_json,
            source_refs_json = excluded.source_refs_json,
            confidence = excluded.confidence,
            updated_at = excluded.updated_at",
        rusqlite::params![
            id,
            scope.target_user_id,
            scope.persona_id,
            scope.conversation_id,
            topic_key,
            counterpart,
            event_at,
            participants,
            decisions,
            negotiated,
            open_points,
            action_items,
            source_refs,
            confidence,
            text_or(row, "created_at", &now),
            now,
        ],
    )
    .map_err(|error| error.to_string())?;
    Ok(())
}

/// `normalizeMemoryContent`: trimmed and lower-cased.
pub fn normalize_memory_content(content: &str) -> String {
    content.trim().to_lowercase()
}

/// `listAllMemories` (`memory-backfill-channel-scope.ts:293-310`), the page size of
/// the response decides when the list ends.
async fn list_all_memories(
    client: &Mem0HttpClient,
    user_id: &str,
    persona_id: &str,
) -> Result<Vec<betaclaw_core::memory::types::Mem0MemoryRecord>, String> {
    let mut memories = Vec::new();
    let mut page = 1i64;
    loop {
        let listed: Mem0ListMemoryResult = client
            .list_memories(&Mem0ListInput {
                user_id: user_id.to_string(),
                persona_id: Some(persona_id.to_string()),
                workspace_id: None,
                page,
                page_size: MEMORY_PAGE_SIZE,
                query: None,
                node_type: None,
            })
            .await
            .map_err(|error| error.to_string())?;
        let empty = listed.memories.is_empty();
        memories.extend(listed.memories);
        if empty {
            break;
        }
        let consumed = page * listed.page_size;
        if listed.total > 0 && consumed >= listed.total {
            break;
        }
        page += 1;
    }
    Ok(memories)
}

/// `backfillMem0Scopes` (`memory-backfill-channel-scope.ts:312-375`). Without a client
/// nothing is counted. Each channel scope is processed once.
pub async fn backfill_mem0_scopes(
    client: Option<&Mem0HttpClient>,
    scopes: &[ConversationScope],
) -> Mem0BackfillStats {
    let mut stats = Mem0BackfillStats::default();
    let Some(client) = client else {
        return stats;
    };

    let mut seen: HashSet<String> = HashSet::new();
    let unique: Vec<&ConversationScope> = scopes
        .iter()
        .filter(|scope| seen.insert(format!("{}::{}", scope.target_user_id, scope.persona_id)))
        .collect();

    for scope in unique {
        stats.scopes_processed += 1;
        let outcome = copy_scope_memories(client, scope).await;
        match outcome {
            Ok(counts) => {
                stats.source_memories += counts.source;
                stats.target_memories_before += counts.target_before;
                stats.inserted += counts.inserted;
                stats.skipped_existing += counts.skipped;
            }
            Err(message) => stats.errors.push(format!(
                "[{}/{}] {message}",
                scope.target_user_id, scope.persona_id
            )),
        }
    }
    stats
}

/// The counts of one scope of the Mem0 pass.
struct ScopeCounts {
    source: i64,
    target_before: i64,
    inserted: i64,
    skipped: i64,
}

/// The copy of one scope. The memories are added one by one; a failure stops the scope
/// and keeps the memories added so far, as the script does.
async fn copy_scope_memories(
    client: &Mem0HttpClient,
    scope: &ConversationScope,
) -> Result<ScopeCounts, String> {
    let sources = list_all_memories(client, LEGACY_LOCAL_USER_ID, &scope.persona_id).await?;
    let targets = list_all_memories(client, &scope.target_user_id, &scope.persona_id).await?;

    let mut counts = ScopeCounts {
        source: sources.len() as i64,
        target_before: targets.len() as i64,
        inserted: 0,
        skipped: 0,
    };
    let mut existing: HashSet<String> = targets
        .iter()
        .map(|row| normalize_memory_content(&row.content))
        .collect();

    for source in sources {
        let key = normalize_memory_content(&source.content);
        if key.is_empty() || existing.contains(&key) {
            counts.skipped += 1;
            continue;
        }
        let mut metadata: Map<String, Json> = source.metadata.clone();
        metadata.remove("mem0Id");

        client
            .add_memory(&Mem0MemoryInput {
                user_id: scope.target_user_id.clone(),
                persona_id: scope.persona_id.clone(),
                workspace_id: None,
                content: source.content.clone(),
                metadata,
            })
            .await
            .map_err(|error| error.to_string())?;

        existing.insert(key);
        counts.inserted += 1;
    }
    Ok(counts)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn database() -> Connection {
        let db = Connection::open_in_memory().unwrap();
        db.execute_batch(
            "CREATE TABLE conversations (id TEXT, persona_id TEXT, channel_type TEXT, external_chat_id TEXT, user_id TEXT);
             INSERT INTO conversations VALUES
               ('c1', 'p1', ' Telegram ', ' 42 ', 'legacy-local-user'),
               ('c2', 'p1', 'webchat', '43', 'legacy-local-user'),
               ('c3', NULL, 'telegram', '44', 'legacy-local-user'),
               ('c4', 'p2', 'whatsapp', '', 'legacy-local-user'),
               ('c5', 'p2', 'whatsapp', '45', 'someone-else');",
        )
        .unwrap();
        db
    }

    #[test]
    fn only_legacy_non_webchat_conversations_with_a_chat_id_count() {
        let scopes = list_conversation_scopes(&database()).unwrap();
        assert_eq!(scopes.len(), 1);
        assert_eq!(scopes[0].conversation_id, "c1");
        assert_eq!(scopes[0].channel_type, "Telegram");
        assert_eq!(scopes[0].target_user_id, "channel:telegram:42");
    }

    #[test]
    fn the_channel_scope_is_normalised() {
        assert_eq!(
            build_channel_scope(" WhatsApp ", " +49 "),
            "channel:whatsapp:+49"
        );
    }

    #[test]
    fn js_numbers_read_null_as_zero_and_text_by_javascript_rules() {
        assert_eq!(js_number_of(Some(&Value::Null)), 0.0);
        assert_eq!(js_number_of(Some(&Value::Text("0.7".into()))), 0.7);
        assert_eq!(js_number_of(Some(&Value::Text("".into()))), 0.0);
        assert!(js_number_of(Some(&Value::Text("abc".into()))).is_nan());
    }

    #[test]
    fn memory_contents_compare_trimmed_and_lower_case() {
        assert_eq!(normalize_memory_content("  Hallo Welt "), "hallo welt");
    }

    #[test]
    fn a_failed_transaction_leaves_the_rows_as_they_were() {
        let mut db = database();
        db.execute_batch(
            "CREATE TABLE knowledge_episodes (id TEXT, user_id TEXT, persona_id TEXT, conversation_id TEXT,
               topic_key TEXT, counterpart TEXT, teaser TEXT, episode TEXT, facts_json TEXT,
               source_seq_start INTEGER, source_seq_end INTEGER, source_refs_json TEXT, event_at TEXT,
               created_at TEXT, updated_at TEXT, UNIQUE(conversation_id, persona_id, source_seq_start, source_seq_end));
             INSERT INTO knowledge_episodes VALUES ('e1', 'legacy-local-user', 'p1', 'c1', 'topic', NULL,
               'teaser', 'episode', '[]', 1, 2, '[]', NULL, '2026-01-01', '2026-01-01');",
        )
        .unwrap();
        let scopes = list_conversation_scopes(&db).unwrap();
        let stats = backfill_knowledge_tables(&mut db, &scopes).unwrap();
        assert_eq!(stats.episodes_copied, 1);
        let copied: i64 = db
            .query_row(
                "SELECT COUNT(*) FROM knowledge_episodes WHERE user_id = 'channel:telegram:42'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(copied, 1);
    }
}
