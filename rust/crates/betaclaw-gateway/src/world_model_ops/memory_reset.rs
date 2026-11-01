//! `betaclaw-scheduler memory-reset` replaces `pnpm run memory:reset`
//! (`scripts/memory-reset.ts`).
//!
//! It collects the users and personas of the local databases, deletes every row of
//! `memory_nodes` in the messages database (`MESSAGES_DB_PATH`) and deletes the Mem0
//! memories of every user x persona scope. Like the script it has no confirmation
//! flag and no dry run: running the command is the reset. The arguments are ignored.
//!
//! Output: one JSON report on stdout (exit 0). A failure prints
//! `{ "ok": false, "error": ... }` on stderr (exit 1), as the script does.

use std::path::Path;

use betaclaw_core::memory::types::{Mem0DeleteByFilterInput, Mem0ListInput};
use rusqlite::{types::Value, Connection};
use serde_json::{json, Value as Json};

use super::reconcile::open_readonly;
use super::{
    has_table, mem0_client, messages_db_path, personas_db_path, process_env, push_unique, sql_text,
    LEGACY_LOCAL_USER_ID,
};

/// `busy_timeout = 8000` of the script's writable connection.
const BUSY_TIMEOUT: std::time::Duration = std::time::Duration::from_millis(8_000);

/// The users and personas of the local databases (`collectScopes`).
#[derive(Debug, Default, PartialEq)]
pub struct ScopeSummary {
    pub users: Vec<String>,
    pub personas: Vec<String>,
}

/// Runs the reset. Returns the exit status.
pub async fn run(_args: &[String]) -> i32 {
    match reset().await {
        Ok(report) => {
            println!("{}", pretty(&report));
            0
        }
        Err(message) => {
            eprintln!("{}", error_json(&message));
            1
        }
    }
}

/// `JSON.stringify(value, null, 2)`.
pub fn pretty(value: &Json) -> String {
    serde_json::to_string_pretty(value).unwrap_or_default()
}

/// `JSON.stringify({ ok: false, error }, null, 2)`.
pub fn error_json(message: &str) -> String {
    pretty(&json!({ "ok": false, "error": message }))
}

/// The order of `reset()` in the script: scope discovery, local delete, Mem0 client,
/// Mem0 delete and verification. The local rows are deleted before Mem0 is checked.
async fn reset() -> Result<Json, String> {
    let env = process_env();
    let messages_path = messages_db_path();
    let personas_path = personas_db_path();
    let scopes = collect_scopes(&messages_path, &personas_path)?;
    if scopes.personas.is_empty() {
        return Err("No personas available for mem0 reset scope discovery.".to_string());
    }

    let local = reset_local_memory(&messages_path)?;
    let client = mem0_client(&env)?.ok_or_else(|| {
        "Mem0 not configured. Set MEMORY_PROVIDER=mem0 and MEM0_BASE_URL before running memory reset."
            .to_string()
    })?;
    let mem0 = reset_mem0(&client, &scopes).await?;

    if !mem0.non_empty_scopes.is_empty() {
        return Err(format!(
            "Mem0 reset incomplete: {} scope(s) still contain memory.",
            mem0.non_empty_scopes.len()
        ));
    }

    Ok(json!({
        "ok": true,
        "messagesDbPath": messages_path,
        "personasDbPath": personas_path,
        "scopes": { "users": scopes.users, "personas": scopes.personas },
        "local": { "before": local.before, "deleted": local.deleted, "remaining": local.remaining },
        "mem0": {
            "deleted": mem0.deleted,
            "checkedScopes": mem0.checked_scopes,
            "nonEmptyScopes": mem0.non_empty_scopes.iter().map(|scope| json!({
                "userId": scope.user_id,
                "personaId": scope.persona_id,
                "remaining": scope.remaining,
            })).collect::<Vec<_>>(),
        },
    }))
}

/// `collectScopes` (`memory-reset.ts:44-100`). The legacy user always comes first.
pub fn collect_scopes(messages_path: &str, personas_path: &str) -> Result<ScopeSummary, String> {
    let mut users = vec![LEGACY_LOCAL_USER_ID.to_string()];
    let mut personas = Vec::new();

    if Path::new(personas_path).exists() {
        let db = open_readonly(personas_path)?;
        if has_table(&db, "personas") {
            let mut statement = db
                .prepare("SELECT id, user_id as userId FROM personas")
                .map_err(|error| error.to_string())?;
            let rows = statement
                .query_map([], |row| {
                    Ok((row.get::<_, Value>(0)?, row.get::<_, Value>(1)?))
                })
                .map_err(|error| error.to_string())?;
            for row in rows {
                let (id, user_id) = row.map_err(|error| error.to_string())?;
                let id = sql_text(id);
                if !id.is_empty() {
                    push_unique(&mut personas, id);
                }
                let user_id = sql_text(user_id);
                if !user_id.is_empty() {
                    push_unique(&mut users, user_id);
                }
            }
        }
    }

    if Path::new(messages_path).exists() {
        let db = open_readonly(messages_path)?;
        if has_table(&db, "conversations") {
            collect_pairs(
                &db,
                "SELECT user_id as userId, persona_id as personaId FROM conversations",
                &mut users,
                &mut personas,
            )?;
        }
        if has_table(&db, "memory_nodes") {
            collect_pairs(
                &db,
                "SELECT user_id as userId, persona_id as personaId FROM memory_nodes",
                &mut users,
                &mut personas,
            )?;
        }
    }

    Ok(ScopeSummary { users, personas })
}

/// Adds the non-empty `userId` and `personaId` columns of a query, in row order.
fn collect_pairs(
    db: &Connection,
    sql: &str,
    users: &mut Vec<String>,
    personas: &mut Vec<String>,
) -> Result<(), String> {
    let mut statement = db.prepare(sql).map_err(|error| error.to_string())?;
    let rows = statement
        .query_map([], |row| {
            Ok((row.get::<_, Value>(0)?, row.get::<_, Value>(1)?))
        })
        .map_err(|error| error.to_string())?;
    for row in rows {
        let (user_id, persona_id) = row.map_err(|error| error.to_string())?;
        let user_id = sql_text(user_id);
        if !user_id.is_empty() {
            push_unique(users, user_id);
        }
        let persona_id = sql_text(persona_id);
        if !persona_id.is_empty() {
            push_unique(personas, persona_id);
        }
    }
    Ok(())
}

/// Counts of `resetLocalMemory`.
#[derive(Debug, PartialEq)]
pub struct LocalResetSummary {
    pub before: i64,
    pub deleted: i64,
    pub remaining: i64,
}

/// `resetLocalMemory` (`memory-reset.ts:102-125`): a missing file or table counts as empty.
pub fn reset_local_memory(messages_path: &str) -> Result<LocalResetSummary, String> {
    let empty = LocalResetSummary {
        before: 0,
        deleted: 0,
        remaining: 0,
    };
    if !Path::new(messages_path).exists() {
        return Ok(empty);
    }

    let db = Connection::open(messages_path).map_err(|error| error.to_string())?;
    db.busy_timeout(BUSY_TIMEOUT)
        .map_err(|error| error.to_string())?;
    if !has_table(&db, "memory_nodes") {
        return Ok(empty);
    }

    let count = |db: &Connection| -> Result<i64, String> {
        db.query_row("SELECT COUNT(*) FROM memory_nodes", [], |row| row.get(0))
            .map_err(|error| error.to_string())
    };
    let before = count(&db)?;
    let deleted = db
        .execute("DELETE FROM memory_nodes", [])
        .map_err(|error| error.to_string())? as i64;
    let remaining = count(&db)?;
    Ok(LocalResetSummary {
        before,
        deleted,
        remaining,
    })
}

/// One scope that still has memories after the delete.
#[derive(Debug, PartialEq)]
pub struct NonEmptyScope {
    pub user_id: String,
    pub persona_id: String,
    pub remaining: i64,
}

/// Counts of `resetMem0`.
#[derive(Debug, PartialEq)]
pub struct Mem0ResetSummary {
    pub deleted: i64,
    pub checked_scopes: i64,
    pub non_empty_scopes: Vec<NonEmptyScope>,
}

/// `resetMem0` (`memory-reset.ts:127-156`): every user x persona scope is deleted and
/// then listed once. Errors of all scopes are collected and reported together.
pub async fn reset_mem0(
    client: &betaclaw_core::memory::mem0::Mem0HttpClient,
    scopes: &ScopeSummary,
) -> Result<Mem0ResetSummary, String> {
    let mut summary = Mem0ResetSummary {
        deleted: 0,
        checked_scopes: 0,
        non_empty_scopes: Vec::new(),
    };
    let mut errors: Vec<String> = Vec::new();

    for user_id in &scopes.users {
        for persona_id in &scopes.personas {
            summary.checked_scopes += 1;
            let outcome = async {
                let deleted = client
                    .delete_memories_by_filter(&Mem0DeleteByFilterInput {
                        user_id: user_id.clone(),
                        persona_id: persona_id.clone(),
                        workspace_id: None,
                    })
                    .await
                    .map_err(|error| error.to_string())?;
                let listed = client
                    .list_memories(&Mem0ListInput {
                        user_id: user_id.clone(),
                        persona_id: Some(persona_id.clone()),
                        workspace_id: None,
                        page: 1,
                        page_size: 1,
                        query: None,
                        node_type: None,
                    })
                    .await
                    .map_err(|error| error.to_string())?;
                Ok::<(i64, i64), String>((deleted, listed.total))
            }
            .await;
            match outcome {
                Ok((deleted, total)) => {
                    summary.deleted += deleted;
                    if total > 0 {
                        summary.non_empty_scopes.push(NonEmptyScope {
                            user_id: user_id.clone(),
                            persona_id: persona_id.clone(),
                            remaining: total,
                        });
                    }
                }
                Err(message) => errors.push(format!("[{user_id}/{persona_id}] {message}")),
            }
        }
    }

    if !errors.is_empty() {
        return Err(format!(
            "Mem0 reset failed for {} scope(s): {}",
            errors.len(),
            errors.join(" | ")
        ));
    }
    Ok(summary)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn database(statements: &[&str]) -> tempfile_path::TempDb {
        let db = tempfile_path::TempDb::new();
        let connection = Connection::open(&db.path).unwrap();
        for statement in statements {
            connection.execute_batch(statement).unwrap();
        }
        db
    }

    /// A throwaway database file in the system temp directory.
    mod tempfile_path {
        use std::path::PathBuf;

        pub struct TempDb {
            pub path: String,
        }

        impl TempDb {
            pub fn new() -> Self {
                let name = format!("betaclaw-memory-reset-{}.db", uuid::Uuid::new_v4());
                let path: PathBuf = std::env::temp_dir().join(name);
                Self {
                    path: path.to_string_lossy().into_owned(),
                }
            }
        }

        impl Drop for TempDb {
            fn drop(&mut self) {
                let _ = std::fs::remove_file(&self.path);
            }
        }
    }

    #[test]
    fn the_legacy_user_comes_first_and_scopes_keep_their_order() {
        let personas = database(&["CREATE TABLE personas (id TEXT, user_id TEXT);
             INSERT INTO personas VALUES ('p1', 'u1'), ('p2', 'u1'), ('', 'u2');"]);
        let messages = database(
            &["CREATE TABLE conversations (user_id TEXT, persona_id TEXT);
             INSERT INTO conversations VALUES ('u3', 'p3'), (NULL, 'p9'), ('u1', 'p1');"],
        );
        let scopes = collect_scopes(&messages.path, &personas.path).unwrap();
        assert_eq!(
            scopes,
            ScopeSummary {
                users: vec![
                    LEGACY_LOCAL_USER_ID.to_string(),
                    "u1".into(),
                    "u2".into(),
                    "u3".into()
                ],
                personas: vec!["p1".into(), "p2".into(), "p3".into(), "p9".into()],
            }
        );
    }

    #[test]
    fn missing_files_give_empty_scopes_and_empty_local_counts() {
        let missing = "/nonexistent-betaclaw-dir/none.db";
        assert_eq!(
            collect_scopes(missing, missing).unwrap().personas,
            Vec::<String>::new()
        );
        assert_eq!(
            reset_local_memory(missing).unwrap(),
            LocalResetSummary {
                before: 0,
                deleted: 0,
                remaining: 0
            }
        );
    }

    #[test]
    fn local_reset_counts_before_and_after() {
        let messages = database(&["CREATE TABLE memory_nodes (id TEXT);
             INSERT INTO memory_nodes VALUES ('a'), ('b'), ('c');"]);
        assert_eq!(
            reset_local_memory(&messages.path).unwrap(),
            LocalResetSummary {
                before: 3,
                deleted: 3,
                remaining: 0
            }
        );
    }

    #[test]
    fn the_error_report_has_the_script_shape() {
        assert_eq!(
            error_json("boom"),
            "{\n  \"ok\": false,\n  \"error\": \"boom\"\n}"
        );
    }
}
