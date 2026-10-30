//! Port of `app/api/workspaces/route.ts` and `app/api/workspaces/[id]/route.ts`.
//!
//! A workspace groups tasks and agents. Its members decide who sees it. The owner
//! of a new workspace is its creator.

use std::collections::HashMap;
use std::sync::Arc;

use axum::body::Bytes;
use axum::extract::{Extension, Path as AxumPath, Query, State};
use axum::http::HeaderMap;
use axum::response::Response;
use rusqlite::types::Value as SqlValue;
use rusqlite::{params, params_from_iter, Connection};
use serde_json::{json, Map, Value};

use super::access::{grant_workspace_owner, resolve, Access};
use super::wire::{
    body_or_null, error, internal, new_id, query_first, query_rows, reply, validation_failed,
    Field, Fields, Issue, Outcome, TextRule,
};
use super::Services;
use crate::auth_gate::unauthorized_response;
use crate::state::SharedState;

const TASK_STATUSES: [&str; 8] = [
    "pending_dispatch",
    "planning",
    "inbox",
    "assigned",
    "in_progress",
    "testing",
    "review",
    "done",
];
const DEFAULT_ICON: &str = "📁";
const DEFAULT_WORKSPACE: &str = "default";

/// `generateSlug`: lowercase, every run of other characters becomes one `-`, no leading or trailing `-`.
fn generate_slug(name: &str) -> String {
    let mut slug = String::new();
    let mut in_gap = false;
    for character in name.to_lowercase().chars() {
        if character.is_ascii_lowercase() || character.is_ascii_digit() {
            slug.push(character);
            in_gap = false;
        } else if !in_gap {
            slug.push('-');
            in_gap = true;
        }
    }
    slug.trim_matches('-').to_string()
}

/// `CreateWorkspaceSchema`.
struct NewWorkspace {
    name: String,
    description: Option<String>,
    icon: Option<String>,
}

fn decode_create(body: &Value) -> Result<NewWorkspace, Vec<Issue>> {
    let mut fields = Fields::default();
    let Some(map) = fields.object(body) else {
        return Err(fields.into_issues());
    };
    let name = fields.text(map, "name", TextRule::required().trimmed().length(1, 120));
    let description = fields.text(
        map,
        "description",
        TextRule::optional().nullable().length(0, 2000),
    );
    let icon = fields.text(map, "icon", TextRule::optional().trimmed().length(1, 16));
    fields.finish(NewWorkspace {
        name: name.into_option().unwrap_or_default(),
        description: description.into_option(),
        icon: icon.into_option(),
    })
}

/// `UpdateWorkspaceSchema`. The fields keep `null` apart from an absent key.
struct WorkspacePatch {
    name: Field<String>,
    description: Field<String>,
    icon: Field<String>,
}

fn decode_update(body: &Value) -> Result<WorkspacePatch, Vec<Issue>> {
    let mut fields = Fields::default();
    let Some(map) = fields.object(body) else {
        return Err(fields.into_issues());
    };
    let name = fields.text(map, "name", TextRule::optional().trimmed().length(1, 120));
    let description = fields.text(
        map,
        "description",
        TextRule::optional().nullable().length(0, 2000),
    );
    let icon = fields.text(map, "icon", TextRule::optional().trimmed().length(1, 16));
    fields.finish(WorkspacePatch {
        name,
        description,
        icon,
    })
}

/// A text value for a nullable column: the empty string is stored as NULL.
fn text_or_null(text: &str) -> SqlValue {
    if text.is_empty() {
        SqlValue::Null
    } else {
        SqlValue::Text(text.to_string())
    }
}

fn workspace_by_id(connection: &Connection, id: &str) -> rusqlite::Result<Option<Value>> {
    query_first(connection, "SELECT * FROM workspaces WHERE id = ?", [id])
}

fn workspace_id_of(row: &Value) -> &str {
    row.get("id").and_then(Value::as_str).unwrap_or("")
}

// ------------------------------------------------------------ /api/workspaces

/// `GET /api/workspaces`, with `?stats=true` for the task and agent counts.
pub async fn list_workspaces(
    State(state): State<SharedState>,
    Extension(services): Extension<Arc<Services>>,
    headers: HeaderMap,
    Query(query): Query<HashMap<String, String>>,
) -> Response {
    let Some(access) = resolve(&state, &headers) else {
        return unauthorized_response();
    };
    list_inner(&services, &access, &query)
        .unwrap_or_else(|fault| internal("Failed to fetch workspaces", fault))
}

fn list_inner(services: &Services, access: &Access, query: &HashMap<String, String>) -> Outcome {
    let connection = services.tasks.connection();
    let ids = access.accessible_workspace_ids(&connection)?;
    let workspaces = if ids.is_empty() {
        Vec::new()
    } else {
        let sql = format!(
            "SELECT * FROM workspaces WHERE id IN ({}) ORDER BY name",
            vec!["?"; ids.len()].join(", ")
        );
        query_rows(&connection, &sql, params_from_iter(ids.iter()))?
    };
    if query.get("stats").map(String::as_str) != Some("true") {
        return Ok(reply(200, Value::Array(workspaces)));
    }

    let mut stats = Vec::with_capacity(workspaces.len());
    for workspace in &workspaces {
        let id = workspace_id_of(workspace);
        let mut task_counts = Map::new();
        for status in TASK_STATUSES {
            task_counts.insert(status.to_string(), json!(0));
        }
        let mut total: i64 = 0;
        let rows = query_rows(
            &connection,
            "SELECT status, COUNT(*) AS count FROM tasks WHERE workspace_id = ? GROUP BY status",
            [id],
        )?;
        for row in rows {
            let count = row.get("count").and_then(Value::as_i64).unwrap_or(0);
            if let Some(status) = row.get("status").and_then(Value::as_str) {
                task_counts.insert(status.to_string(), json!(count));
            }
            total += count;
        }
        task_counts.insert("total".to_string(), json!(total));

        let agent_count = query_first(
            &connection,
            "SELECT COUNT(*) AS count FROM agents WHERE workspace_id = ?",
            [id],
        )?
        .and_then(|row| row.get("count").and_then(Value::as_i64))
        .unwrap_or(0);
        stats.push(json!({
            "id": workspace["id"],
            "name": workspace["name"],
            "slug": workspace["slug"],
            "icon": workspace["icon"],
            "taskCounts": task_counts,
            "agentCount": agent_count,
        }));
    }
    Ok(reply(200, Value::Array(stats)))
}

/// `POST /api/workspaces`
pub async fn create_workspace(
    State(state): State<SharedState>,
    Extension(services): Extension<Arc<Services>>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let Some(access) = resolve(&state, &headers) else {
        return unauthorized_response();
    };
    create_inner(&services, &access, &body)
        .unwrap_or_else(|fault| internal("Failed to create workspace", fault))
}

fn create_inner(services: &Services, access: &Access, body: &Bytes) -> Outcome {
    let input = match decode_create(&body_or_null(body)) {
        Ok(input) => input,
        Err(issues) => return Ok(validation_failed(&issues)),
    };
    let slug = generate_slug(&input.name);
    let description = input
        .description
        .map(|text| text.trim().to_string())
        .filter(|text| !text.is_empty());
    let icon = input.icon.unwrap_or_else(|| DEFAULT_ICON.to_string());

    let connection = services.tasks.connection();
    if query_first(
        &connection,
        "SELECT id FROM workspaces WHERE slug = ?",
        [slug.as_str()],
    )?
    .is_some()
    {
        return Ok(error(400, "A workspace with this name already exists"));
    }
    let id = new_id();
    connection.execute(
        "INSERT INTO workspaces (id, name, slug, description, icon) VALUES (?, ?, ?, ?, ?)",
        params![id, input.name, slug, description, icon],
    )?;
    grant_workspace_owner(&connection, &id, &access.user_id)?;
    let row = workspace_by_id(&connection, &id)?.unwrap_or(Value::Null);
    Ok(reply(201, row))
}

// ---------------------------------------------------------- /api/workspaces/{id}

/// `GET /api/workspaces/{id}`: by id or by slug.
pub async fn get_workspace(
    State(state): State<SharedState>,
    Extension(services): Extension<Arc<Services>>,
    headers: HeaderMap,
    AxumPath(id): AxumPath<String>,
) -> Response {
    let Some(access) = resolve(&state, &headers) else {
        return unauthorized_response();
    };
    get_inner(&services, &access, &id)
        .unwrap_or_else(|fault| internal("Failed to fetch workspace", fault))
}

fn get_inner(services: &Services, access: &Access, id: &str) -> Outcome {
    let connection = services.tasks.connection();
    let row = query_first(
        &connection,
        "SELECT * FROM workspaces WHERE id = ? OR slug = ?",
        params![id, id],
    )?;
    let Some(row) = row else {
        return Ok(error(404, "Workspace not found"));
    };
    if !access.has_workspace(&connection, workspace_id_of(&row))? {
        return Ok(error(404, "Workspace not found"));
    }
    Ok(reply(200, row))
}

/// `PATCH /api/workspaces/{id}`
pub async fn update_workspace(
    State(state): State<SharedState>,
    Extension(services): Extension<Arc<Services>>,
    headers: HeaderMap,
    AxumPath(id): AxumPath<String>,
    body: Bytes,
) -> Response {
    let Some(access) = resolve(&state, &headers) else {
        return unauthorized_response();
    };
    update_inner(&services, &access, &id, &body)
        .unwrap_or_else(|fault| internal("Failed to update workspace", fault))
}

fn update_inner(services: &Services, access: &Access, id: &str, body: &Bytes) -> Outcome {
    let patch = match decode_update(&body_or_null(body)) {
        Ok(patch) => patch,
        Err(issues) => return Ok(validation_failed(&issues)),
    };
    let connection = services.tasks.connection();
    let Some(existing) = workspace_by_id(&connection, id)? else {
        return Ok(error(404, "Workspace not found"));
    };
    if !access.has_workspace(&connection, workspace_id_of(&existing))? {
        return Ok(error(404, "Workspace not found"));
    }

    let mut sets: Vec<&str> = Vec::new();
    let mut values: Vec<SqlValue> = Vec::new();
    if let Field::Value(name) = patch.name {
        sets.push("name = ?");
        values.push(SqlValue::Text(name));
    }
    match patch.description {
        Field::Value(text) => {
            sets.push("description = ?");
            values.push(text_or_null(text.trim()));
        }
        Field::Null => {
            sets.push("description = ?");
            values.push(SqlValue::Null);
        }
        Field::Absent => {}
    }
    if let Field::Value(icon) = patch.icon {
        sets.push("icon = ?");
        values.push(SqlValue::Text(icon));
    }
    if sets.is_empty() {
        return Ok(error(400, "No fields to update"));
    }
    sets.push("updated_at = datetime('now')");
    values.push(SqlValue::Text(id.to_string()));

    let sql = format!("UPDATE workspaces SET {} WHERE id = ?", sets.join(", "));
    connection.execute(&sql, params_from_iter(values.iter()))?;
    let row = workspace_by_id(&connection, id)?.unwrap_or(Value::Null);
    Ok(reply(200, row))
}

/// `DELETE /api/workspaces/{id}`. The default workspace and workspaces that still hold
/// tasks or agents cannot be deleted.
pub async fn delete_workspace(
    State(state): State<SharedState>,
    Extension(services): Extension<Arc<Services>>,
    headers: HeaderMap,
    AxumPath(id): AxumPath<String>,
) -> Response {
    let Some(access) = resolve(&state, &headers) else {
        return unauthorized_response();
    };
    delete_inner(&services, &access, &id)
        .unwrap_or_else(|fault| internal("Failed to delete workspace", fault))
}

fn delete_inner(services: &Services, access: &Access, id: &str) -> Outcome {
    if id == DEFAULT_WORKSPACE {
        return Ok(error(400, "Cannot delete the default workspace"));
    }
    let connection = services.tasks.connection();
    let Some(existing) = workspace_by_id(&connection, id)? else {
        return Ok(error(404, "Workspace not found"));
    };
    if !access.has_workspace(&connection, workspace_id_of(&existing))? {
        return Ok(error(404, "Workspace not found"));
    }
    let count = |sql: &str| -> rusqlite::Result<i64> {
        Ok(query_first(&connection, sql, [id])?
            .and_then(|row| row.get("count").and_then(Value::as_i64))
            .unwrap_or(0))
    };
    let task_count = count("SELECT COUNT(*) AS count FROM tasks WHERE workspace_id = ?")?;
    let agent_count = count("SELECT COUNT(*) AS count FROM agents WHERE workspace_id = ?")?;
    if task_count > 0 || agent_count > 0 {
        return Ok(reply(
            400,
            json!({
                "error": "Cannot delete workspace with existing tasks or agents",
                "taskCount": task_count,
                "agentCount": agent_count,
            }),
        ));
    }
    connection.execute("DELETE FROM workspaces WHERE id = ?", [id])?;
    Ok(reply(200, json!({ "success": true })))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::families::tasks::ports::{NoSkills, UnwiredRuntime};
    use crate::families::tasks::test_support::{fixture, fixture_with, send};
    use axum::http::{Method, StatusCode};

    #[test]
    fn slugs_collapse_separators() {
        assert_eq!(generate_slug("Team  One!"), "team-one");
        assert_eq!(generate_slug("  --Lab--  "), "lab");
    }

    #[tokio::test]
    async fn create_slugs_the_name_and_rejects_a_duplicate() {
        let fixture = fixture();
        let body = r#"{"name":"  Team One ","description":"  core  "}"#;
        let (status, created) = send(
            &fixture,
            Method::POST,
            "/api/workspaces",
            Some("user-1"),
            Some(body),
        )
        .await;
        assert_eq!(status, StatusCode::CREATED);
        assert_eq!(created["slug"], "team-one");
        assert_eq!(created["name"], "Team One");
        assert_eq!(created["description"], "core");
        assert_eq!(created["icon"], DEFAULT_ICON);

        let (status, duplicate) = send(
            &fixture,
            Method::POST,
            "/api/workspaces",
            Some("user-1"),
            Some(body),
        )
        .await;
        assert_eq!(status, StatusCode::BAD_REQUEST);
        assert_eq!(
            duplicate["error"],
            "A workspace with this name already exists"
        );

        let (status, by_slug) = send(
            &fixture,
            Method::GET,
            "/api/workspaces/team-one",
            Some("user-1"),
            None,
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(by_slug["id"], created["id"]);
    }

    #[tokio::test]
    async fn stats_count_tasks_by_status_and_agents() {
        let fixture = fixture();
        send(
            &fixture,
            Method::POST,
            "/api/tasks",
            Some("user-1"),
            Some(r#"{"title":"A"}"#),
        )
        .await;
        let (status, stats) = send(
            &fixture,
            Method::GET,
            "/api/workspaces?stats=true",
            Some("user-1"),
            None,
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        let default = stats
            .as_array()
            .unwrap()
            .iter()
            .find(|workspace| workspace["id"] == DEFAULT_WORKSPACE)
            .unwrap();
        assert_eq!(default["taskCounts"]["inbox"], 1);
        assert_eq!(default["taskCounts"]["total"], 1);
        assert_eq!(default["taskCounts"]["done"], 0);
    }

    #[tokio::test]
    async fn patch_without_fields_is_a_bad_request() {
        let fixture = fixture();
        let (status, body) = send(
            &fixture,
            Method::PATCH,
            "/api/workspaces/default",
            Some("user-1"),
            Some("{}"),
        )
        .await;
        assert_eq!(status, StatusCode::BAD_REQUEST);
        assert_eq!(body["error"], "No fields to update");
    }

    #[tokio::test]
    async fn update_renames_and_clears_the_description() {
        let fixture = fixture();
        let (_, created) = send(
            &fixture,
            Method::POST,
            "/api/workspaces",
            Some("user-1"),
            Some(r#"{"name":"Lab","description":"old"}"#),
        )
        .await;
        let id = created["id"].as_str().unwrap().to_string();
        let (status, body) = send(
            &fixture,
            Method::PATCH,
            &format!("/api/workspaces/{id}"),
            Some("user-1"),
            Some(r#"{"name":"Lab Two","description":null}"#),
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(body["name"], "Lab Two");
        assert!(body["description"].is_null());
    }

    #[tokio::test]
    async fn an_empty_workspace_can_be_deleted() {
        let fixture = fixture();
        let (_, created) = send(
            &fixture,
            Method::POST,
            "/api/workspaces",
            Some("user-1"),
            Some(r#"{"name":"Scratch"}"#),
        )
        .await;
        let id = created["id"].as_str().unwrap().to_string();
        let (status, body) = send(
            &fixture,
            Method::DELETE,
            &format!("/api/workspaces/{id}"),
            Some("user-1"),
            None,
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(body["success"], true);
    }

    #[tokio::test]
    async fn the_default_workspace_cannot_be_deleted() {
        let fixture = fixture();
        let (status, body) = send(
            &fixture,
            Method::DELETE,
            "/api/workspaces/default",
            Some("user-1"),
            None,
        )
        .await;
        assert_eq!(status, StatusCode::BAD_REQUEST);
        assert_eq!(body["error"], "Cannot delete the default workspace");
    }

    #[tokio::test]
    async fn membership_hides_foreign_workspaces_under_required_auth() {
        let fixture = fixture_with(Arc::new(UnwiredRuntime), Arc::new(NoSkills), |config| {
            config.require_auth = true
        });
        let (status, created) = send(
            &fixture,
            Method::POST,
            "/api/workspaces",
            Some("owner"),
            Some(r#"{"name":"Private"}"#),
        )
        .await;
        assert_eq!(status, StatusCode::CREATED);
        let id = created["id"].as_str().unwrap().to_string();

        let (status, _) = send(
            &fixture,
            Method::GET,
            &format!("/api/workspaces/{id}"),
            Some("owner"),
            None,
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        let (status, body) = send(
            &fixture,
            Method::GET,
            &format!("/api/workspaces/{id}"),
            Some("stranger"),
            None,
        )
        .await;
        assert_eq!(status, StatusCode::NOT_FOUND);
        assert_eq!(body["error"], "Workspace not found");
        let (_, list) = send(
            &fixture,
            Method::GET,
            "/api/workspaces",
            Some("stranger"),
            None,
        )
        .await;
        assert!(list.as_array().unwrap().is_empty());
    }
}
