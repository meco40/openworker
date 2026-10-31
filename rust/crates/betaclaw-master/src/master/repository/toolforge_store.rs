//! Port of `src/server/master/repository/toolforge.store.ts:1-101`.
//!
//! Toolforge artifacts over `master_toolforge_artifacts`, scoped by
//! `(user_id, workspace_id)`. `published_globally` is stored as `1`/`0`
//! (`artifact.publishedGlobally ? 1 : 0`), and the global listing filters
//! `published_globally = 1 AND status = 'published'`.
//!
//! `createToolForgeArtifact` returns by scanning `listToolForgeArtifacts` for the
//! new id (the TypeScript `!` becomes [`required`]); `updateToolForgeArtifact`
//! returns the scanned row or `null` when the patch is empty.

use rusqlite::types::Value;
use rusqlite::{params, params_from_iter, Connection};

use crate::master::repository::helpers::now_iso;
use crate::master::repository::mappers::to_toolforge_artifact;
use crate::master::repository::{push_text, required};
use crate::master::types::{MasterToolForgeArtifact, WorkspaceScope};

/// `Omit<MasterToolForgeArtifact, 'id' | 'userId' | 'workspaceId' | 'createdAt' | 'updatedAt'>`
/// — `toolforge.store.ts:10-13`.
pub struct MasterToolForgeArtifactInput {
    pub name: String,
    pub spec: String,
    pub manifest: String,
    pub test_summary: String,
    pub risk_report: String,
    pub status: String,
    pub published_globally: bool,
}

/// `Partial<MasterToolForgeArtifact>` — `toolforge.store.ts:42`.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct ToolForgePatch {
    pub name: Option<String>,
    pub spec: Option<String>,
    pub manifest: Option<String>,
    pub test_summary: Option<String>,
    pub risk_report: Option<String>,
    pub status: Option<String>,
    pub published_globally: Option<bool>,
}

/// `createToolForgeArtifact` from `toolforge.store.ts:7-36`.
pub fn create_toolforge_artifact(
    connection: &Connection,
    scope: &WorkspaceScope,
    artifact: &MasterToolForgeArtifactInput,
) -> rusqlite::Result<MasterToolForgeArtifact> {
    let id = uuid::Uuid::new_v4().to_string();
    let now = now_iso();
    connection.execute(
        "INSERT INTO master_toolforge_artifacts (
           id, user_id, workspace_id, name, spec, manifest, test_summary, risk_report, status, published_globally, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        params![
            id,
            scope.user_id,
            scope.workspace_id,
            artifact.name,
            artifact.spec,
            artifact.manifest,
            artifact.test_summary,
            artifact.risk_report,
            artifact.status,
            artifact.published_globally as i64,
            now,
            now,
        ],
    )?;
    let found = list_toolforge_artifacts(connection, scope)?
        .into_iter()
        .find(|entry| entry.id == id);
    required(found)
}

/// `listToolForgeArtifacts` from `toolforge.store.ts:74-86`.
pub fn list_toolforge_artifacts(
    connection: &Connection,
    scope: &WorkspaceScope,
) -> rusqlite::Result<Vec<MasterToolForgeArtifact>> {
    let mut statement = connection.prepare(
        "SELECT * FROM master_toolforge_artifacts
         WHERE user_id = ? AND workspace_id = ?
         ORDER BY updated_at DESC",
    )?;
    let rows = statement.query_map(
        params![scope.user_id, scope.workspace_id],
        to_toolforge_artifact,
    )?;
    rows.collect()
}

/// `listGlobalToolForgeArtifacts` from `toolforge.store.ts:88-101`.
pub fn list_global_toolforge_artifacts(
    connection: &Connection,
    limit: i64,
) -> rusqlite::Result<Vec<MasterToolForgeArtifact>> {
    let mut statement = connection.prepare(
        "SELECT * FROM master_toolforge_artifacts
         WHERE published_globally = 1 AND status = 'published'
         ORDER BY updated_at DESC
         LIMIT ?",
    )?;
    let rows = statement.query_map(params![limit], to_toolforge_artifact)?;
    rows.collect()
}

/// `updateToolForgeArtifact` from `toolforge.store.ts:38-72`.
pub fn update_toolforge_artifact(
    connection: &Connection,
    scope: &WorkspaceScope,
    artifact_id: &str,
    patch: &ToolForgePatch,
) -> rusqlite::Result<Option<MasterToolForgeArtifact>> {
    let mut assignments: Vec<String> = Vec::new();
    let mut values: Vec<Value> = Vec::new();
    if let Some(value) = &patch.name {
        push_text(&mut assignments, &mut values, "name", value);
    }
    if let Some(value) = &patch.spec {
        push_text(&mut assignments, &mut values, "spec", value);
    }
    if let Some(value) = &patch.manifest {
        push_text(&mut assignments, &mut values, "manifest", value);
    }
    if let Some(value) = &patch.test_summary {
        push_text(&mut assignments, &mut values, "test_summary", value);
    }
    if let Some(value) = &patch.risk_report {
        push_text(&mut assignments, &mut values, "risk_report", value);
    }
    if let Some(value) = &patch.status {
        push_text(&mut assignments, &mut values, "status", value);
    }
    if let Some(value) = patch.published_globally {
        assignments.push("published_globally = ?".to_string());
        values.push(Value::Integer(value as i64));
    }
    if assignments.is_empty() {
        return Ok(None);
    }
    assignments.push("updated_at = ?".to_string());
    values.push(Value::Text(now_iso()));
    values.push(Value::Text(artifact_id.to_string()));
    values.push(Value::Text(scope.user_id.clone()));
    values.push(Value::Text(scope.workspace_id.clone()));
    let sql = format!(
        "UPDATE master_toolforge_artifacts SET {}
         WHERE id = ? AND user_id = ? AND workspace_id = ?",
        assignments.join(", ")
    );
    connection.execute(&sql, params_from_iter(values))?;
    Ok(list_toolforge_artifacts(connection, scope)?
        .into_iter()
        .find(|entry| entry.id == artifact_id))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::{open, OpenOptions};
    use crate::master::migrations::run_master_migrations;

    fn setup() -> (Connection, WorkspaceScope) {
        let connection = open(OpenOptions::new(":memory:")).unwrap();
        run_master_migrations(&connection).unwrap();
        let scope = WorkspaceScope {
            user_id: "u1".to_string(),
            workspace_id: "w1".to_string(),
        };
        (connection, scope)
    }

    fn input(status: &str, published: bool) -> MasterToolForgeArtifactInput {
        MasterToolForgeArtifactInput {
            name: "tool".to_string(),
            spec: "{}".to_string(),
            manifest: "{}".to_string(),
            test_summary: "ok".to_string(),
            risk_report: "{}".to_string(),
            status: status.to_string(),
            published_globally: published,
        }
    }

    #[test]
    fn create_and_global_listing() {
        let (connection, scope) = setup();
        let artifact =
            create_toolforge_artifact(&connection, &scope, &input("published", true)).unwrap();
        assert!(artifact.published_globally);
        assert_eq!(
            list_toolforge_artifacts(&connection, &scope).unwrap().len(),
            1
        );
        assert_eq!(
            list_global_toolforge_artifacts(&connection, 200)
                .unwrap()
                .len(),
            1
        );

        // A draft is not globally visible.
        create_toolforge_artifact(&connection, &scope, &input("draft", true)).unwrap();
        assert_eq!(
            list_global_toolforge_artifacts(&connection, 200)
                .unwrap()
                .len(),
            1
        );
    }

    #[test]
    fn update_publishes_an_artifact() {
        let (connection, scope) = setup();
        let artifact =
            create_toolforge_artifact(&connection, &scope, &input("draft", false)).unwrap();
        let updated = update_toolforge_artifact(
            &connection,
            &scope,
            &artifact.id,
            &ToolForgePatch {
                status: Some("published".to_string()),
                published_globally: Some(true),
                ..ToolForgePatch::default()
            },
        )
        .unwrap()
        .unwrap();
        assert_eq!(updated.status, "published");
        assert!(updated.published_globally);
    }
}
