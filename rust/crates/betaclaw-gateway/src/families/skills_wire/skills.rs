//! Port of `app/api/skills/route.ts` (GET), `app/api/skills/[id]/route.ts` (PATCH,
//! DELETE), `app/api/skills/runtime-config/route.ts` (GET, PUT, DELETE) and
//! `app/api/skills/execute/route.ts` (POST).
//!
//! The rows come from `SkillRepository` (`skillRepository.ts`), the config from
//! `SkillRuntimeConfigStore` (`runtimeConfig.ts`). The core structs have no serde
//! derive, so the JSON shape is written field by field here. A secret leaves the
//! store only as its masked form.
//!
//! The execute route dispatches through [`crate::families::master::skills::SkillDispatcher`],
//! after `assertSkillActive` (`skillActivation.ts`). The exec handlers keep the exec-approval
//! gate and the workspace path guard inside the core handlers.

use std::collections::HashMap;
use std::sync::Arc;

use axum::body::Bytes;
use axum::extract::{Extension, Path};
use axum::http::{HeaderMap, StatusCode, Uri};
use axum::response::{IntoResponse, Response};
use axum::Json;
use betaclaw_core::skills::activation::assert_skill_active;
use betaclaw_core::skills::runtime_config::{
    resolve_skill_runtime_config_status, ConfigSource, ConfigValueKind, SkillRuntimeConfigStatus,
};
use betaclaw_core::skills::store::{InstallSkillInput, SkillRow};
use betaclaw_core::skills::types::{js_trim, SkillError};
use betaclaw_core::stats::util::js_truthy;
use serde_json::{json, Map, Value};

use super::{error_response, js_text, query_param, Services};
use crate::auth_gate::{unauthorized_response, user_id_from_headers};
use crate::families::master::skills::SkillInvocation;

/// `POST /api/skills` (`app/api/skills/route.ts`).
///
/// Enforces `areExternalSkillsEnabled()` for non-manual sources and installs
/// manual skill manifests into `SkillRepository`.
pub(super) async fn install(
    Extension(services): Extension<Arc<Services>>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    if user_id_from_headers(&headers).is_none() {
        return unauthorized_response();
    }
    let body: Value = match serde_json::from_slice(&body) {
        Ok(value) => value,
        Err(error) => return error_response(StatusCode::BAD_REQUEST, &error.to_string()),
    };
    let Some(obj) = body.as_object() else {
        return error_response(
            StatusCode::BAD_REQUEST,
            "Cannot read properties of null (reading 'source')",
        );
    };
    let source = obj
        .get("source")
        .and_then(Value::as_str)
        .unwrap_or_default();
    if source != "manual" && std::env::var("EXTERNAL_SKILLS_ENABLED").as_deref() != Ok("true") {
        return error_response(
            StatusCode::FORBIDDEN,
            "External skill installation is disabled. Set EXTERNAL_SKILLS_ENABLED=true after review.",
        );
    }
    match source {
        "manual" => {
            let Some(manifest) = obj.get("value").and_then(Value::as_object) else {
                return error_response(
                    StatusCode::BAD_REQUEST,
                    "Manual install requires a manifest object.",
                );
            };
            match install_from_manifest(&services, manifest) {
                Ok(skill) => {
                    Json(json!({ "ok": true, "skill": skill_json(&skill) })).into_response()
                }
                Err(message) => error_response(StatusCode::BAD_REQUEST, &message),
            }
        }
        "github" => {
            if !obj.get("value").is_some_and(Value::is_string) {
                return error_response(
                    StatusCode::BAD_REQUEST,
                    "GitHub install requires a URL string.",
                );
            }
            error_response(
                StatusCode::BAD_REQUEST,
                "External skill installation is disabled in the Rust gateway.",
            )
        }
        "npm" => {
            if !obj.get("value").is_some_and(Value::is_string) {
                return error_response(
                    StatusCode::BAD_REQUEST,
                    "npm install requires a package name string.",
                );
            }
            error_response(
                StatusCode::BAD_REQUEST,
                "External skill installation is disabled in the Rust gateway.",
            )
        }
        other => error_response(
            StatusCode::BAD_REQUEST,
            &format!(
                "Unknown install source: \"{other}\". Use \"github\", \"npm\", or \"manual\"."
            ),
        ),
    }
}

fn install_from_manifest(
    services: &Services,
    manifest: &Map<String, Value>,
) -> Result<SkillRow, String> {
    for key in [
        "id",
        "name",
        "description",
        "version",
        "category",
        "functionName",
        "tool",
    ] {
        if !js_truthy(manifest.get(key)) {
            return Err(format!(
                "Invalid manifest: missing required field \"{key}\"."
            ));
        }
    }
    for key in [
        "id",
        "name",
        "description",
        "version",
        "category",
        "functionName",
    ] {
        let Some(text) = manifest.get(key).and_then(Value::as_str) else {
            return Err(format!(
                "Invalid manifest: \"{key}\" must be a non-empty string."
            ));
        };
        if text.trim().is_empty() {
            return Err(format!(
                "Invalid manifest: \"{key}\" must be a non-empty string."
            ));
        }
    }
    let id = manifest["id"].as_str().unwrap_or_default();
    if !is_valid_manifest_id(id) {
        return Err("Invalid manifest: \"id\" contains unsupported characters.".to_string());
    }
    let Some(tool) = manifest.get("tool") else {
        return Err(
            "Invalid manifest: \"tool\" must be a valid ToolDefinition or BuiltInToolDefinition."
                .to_string(),
        );
    };
    if !is_valid_tool_def(tool) {
        return Err(
            "Invalid manifest: \"tool\" must be a valid ToolDefinition or BuiltInToolDefinition."
                .to_string(),
        );
    }
    services
        .skills
        .install_skill(&InstallSkillInput {
            id: Some(id.to_string()),
            name: manifest["name"].as_str().unwrap_or_default().to_string(),
            description: manifest["description"]
                .as_str()
                .unwrap_or_default()
                .to_string(),
            category: manifest["category"]
                .as_str()
                .unwrap_or_default()
                .to_string(),
            version: manifest["version"].as_str().unwrap_or_default().to_string(),
            function_name: manifest["functionName"]
                .as_str()
                .unwrap_or_default()
                .to_string(),
            source: "manual".to_string(),
            source_url: None,
            tool_definition: tool.clone(),
            handler_path: None,
        })
        .map_err(|error| error.to_string())
}

fn is_valid_manifest_id(id: &str) -> bool {
    let mut chars = id.chars();
    let Some(first) = chars.next() else {
        return false;
    };
    if !first.is_ascii_alphanumeric() || id.len() > 128 {
        return false;
    }
    chars.all(|ch| ch.is_ascii_alphanumeric() || matches!(ch, '.' | '_' | '-'))
}

fn is_valid_tool_def(tool: &Value) -> bool {
    let Some(obj) = tool.as_object() else {
        return false;
    };
    if obj.get("builtIn") == Some(&Value::Bool(true))
        && obj.get("providerConfig").is_some_and(Value::is_object)
    {
        return true;
    }
    obj.get("name").is_some_and(Value::is_string)
        && obj.get("description").is_some_and(Value::is_string)
        && obj.get("parameters").is_some_and(Value::is_object)
}

/// `GET /api/skills/external-host` (`app/api/skills/external-host/route.ts`).
pub(super) async fn external_host_get(headers: HeaderMap) -> Response {
    if user_id_from_headers(&headers).is_none() {
        return unauthorized_response();
    }
    Json(json!({
        "ok": true,
        "status": external_host_status(),
    }))
    .into_response()
}

/// `POST /api/skills/external-host` (`app/api/skills/external-host/route.ts`).
pub(super) async fn external_host_post(headers: HeaderMap, body: Bytes) -> Response {
    if user_id_from_headers(&headers).is_none() {
        return unauthorized_response();
    }
    let body: Value = match serde_json::from_slice(&body) {
        Ok(value) => value,
        Err(error) => return error_response(StatusCode::BAD_REQUEST, &error.to_string()),
    };
    if body.is_null() {
        return error_response(
            StatusCode::BAD_REQUEST,
            "Cannot read properties of null (reading 'action')",
        );
    }
    let action = js_text(body.get("action")).trim().to_ascii_lowercase();
    if action != "stop" {
        return error_response(
            StatusCode::BAD_REQUEST,
            "Unsupported action. Use action=\"stop\".",
        );
    }
    Json(json!({
        "ok": true,
        "status": external_host_status(),
    }))
    .into_response()
}

fn external_host_status() -> Value {
    let timeout_ms = std::env::var("EXTERNAL_SKILL_HOST_TIMEOUT_MS")
        .ok()
        .and_then(|raw| raw.trim().parse::<i64>().ok())
        .filter(|&val| val > 0)
        .map_or(30_000, |val| val.clamp(1_000, 10 * 60 * 1_000));
    let idle_ms = std::env::var("EXTERNAL_SKILL_HOST_IDLE_MS")
        .ok()
        .and_then(|raw| raw.trim().parse::<i64>().ok())
        .filter(|&val| val >= 0)
        .map_or(60_000, |val| val.min(60 * 60 * 1_000));
    json!({
        "running": false,
        "pid": null,
        "connected": false,
        "pendingRequests": 0,
        "timeoutMs": timeout_ms,
        "idleMs": idle_ms,
        "startedAt": null,
        "totalRequests": 0,
    })
}

/// `POST /api/skills/execute` (`app/api/skills/execute/route.ts`).
///
/// Mirrors the TypeScript route: the body carries `name` and optional `args`/`context`.
/// Activation is always enforced here, and the exec handlers keep the exec-approval and
/// path-guard boundaries inside the dispatcher. The error status mirrors the TypeScript
/// mapping (`Unsupported skill:` -> 400, `Skill is not active:` -> 403, else 500).
pub(super) async fn execute(
    Extension(services): Extension<Arc<Services>>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    if user_id_from_headers(&headers).is_none() {
        return unauthorized_response();
    }
    let body: Value = match serde_json::from_slice(&body) {
        Ok(value) => value,
        Err(error) => return error_response(StatusCode::INTERNAL_SERVER_ERROR, &error.to_string()),
    };
    if body.is_null() {
        return error_response(
            StatusCode::INTERNAL_SERVER_ERROR,
            "Cannot read properties of null (reading 'context')",
        );
    }
    let name = match body.get("name") {
        Some(Value::String(name)) => name.clone(),
        Some(Value::Null) => {
            return error_response(
                StatusCode::INTERNAL_SERVER_ERROR,
                "Cannot read properties of null (reading 'trim')",
            );
        }
        Some(_) => {
            return error_response(
                StatusCode::INTERNAL_SERVER_ERROR,
                "functionName.trim is not a function",
            );
        }
        None => {
            return error_response(
                StatusCode::INTERNAL_SERVER_ERROR,
                "Cannot read properties of undefined (reading 'trim')",
            );
        }
    };

    // `context.enforceSkillActivation` is always true on this route.
    if let Err(error) = assert_skill_active(&services.skills, &name) {
        return error_response(StatusCode::FORBIDDEN, &error.to_string());
    }

    let args = normalize_skill_args(body.get("args"));
    let workspace_cwd = context_workspace_cwd(&body);
    match run_dispatch(services, name, args, workspace_cwd).await {
        Ok(result) => Json(json!({ "ok": true, "result": result })).into_response(),
        Err(message) => {
            let status = if message.starts_with("Unsupported skill:") {
                StatusCode::BAD_REQUEST
            } else if message.starts_with("Skill is not active:") {
                StatusCode::FORBIDDEN
            } else {
                StatusCode::INTERNAL_SERVER_ERROR
            };
            error_response(status, &message)
        }
    }
}

/// Runs one dispatch to completion off the reactor.
///
/// [`SkillFuture`](crate::families::master::skills::SkillFuture) is deliberately not `Send`,
/// because the core handlers borrow their transport. A blocking thread with its own
/// current-thread runtime drives it, exactly as core's `drive_sync` does outside a runtime.
async fn run_dispatch(
    services: Arc<Services>,
    name: String,
    args: Map<String, Value>,
    workspace_cwd: Option<String>,
) -> Result<Value, String> {
    let task = tokio::task::spawn_blocking(move || {
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .map_err(|error| format!("Skill execution runtime failed: {error}"))?;
        runtime.block_on(services.dispatcher.dispatch(SkillInvocation {
            name: &name,
            args: &args,
            bypass_approval: false,
            workspace_cwd: workspace_cwd.as_deref(),
        }))
    });
    match task.await {
        Ok(result) => result,
        Err(error) => Err(format!("Skill execution task failed: {error}")),
    }
}

/// `normalizeSkillArgs` (`normalizeArgs.ts`): a JSON string is parsed, anything that is not a
/// plain object becomes `{}`.
fn normalize_skill_args(value: Option<&Value>) -> Map<String, Value> {
    match value {
        Some(Value::String(text)) => serde_json::from_str::<Value>(text)
            .ok()
            .and_then(|parsed| parsed.as_object().cloned())
            .unwrap_or_default(),
        Some(Value::Object(map)) => map.clone(),
        _ => Map::new(),
    }
}

/// `readOptionalString(context.workspaceCwd)`: only a non-blank string, trimmed. The
/// conversation fields the subagent handlers read are not part of the ported context.
fn context_workspace_cwd(body: &Value) -> Option<String> {
    let from_context = body
        .get("context")
        .filter(|value| value.is_object())
        .and_then(|context| context.get("workspaceCwd"));
    from_context
        .or_else(|| body.get("workspaceCwd"))
        .and_then(|value| match value {
            Value::String(text) => Some(text.trim().to_string()),
            _ => None,
        })
        .filter(|text| !text.is_empty())
}

/// `GET /api/skills`
pub(super) async fn list(
    Extension(services): Extension<Arc<Services>>,
    headers: HeaderMap,
) -> Response {
    if user_id_from_headers(&headers).is_none() {
        return unauthorized_response();
    }
    match services.skills.list_skills() {
        Ok(rows) => {
            let skills: Vec<Value> = rows.iter().map(skill_json).collect();
            Json(json!({ "ok": true, "skills": skills })).into_response()
        }
        Err(error) => error_response(StatusCode::INTERNAL_SERVER_ERROR, &error.to_string()),
    }
}

/// `PATCH /api/skills/{id}`. Body: `{ installed }`, read with JavaScript truthiness,
/// as `setInstalled(id, body.installed)` does. A missing flag therefore disables.
pub(super) async fn patch_skill(
    Extension(services): Extension<Arc<Services>>,
    headers: HeaderMap,
    Path(id): Path<String>,
    body: Bytes,
) -> Response {
    if user_id_from_headers(&headers).is_none() {
        return unauthorized_response();
    }
    // ponytail: serde's parser text differs from V8's JSON.parse. The 500 matches.
    let body: Value = match serde_json::from_slice(&body) {
        Ok(value) => value,
        Err(error) => return error_response(StatusCode::INTERNAL_SERVER_ERROR, &error.to_string()),
    };
    if body.is_null() {
        return error_response(
            StatusCode::INTERNAL_SERVER_ERROR,
            "Cannot read properties of null (reading 'installed')",
        );
    }
    let installed = js_truthy(body.get("installed"));
    match services.skills.set_installed(&id, installed) {
        Ok(true) => {}
        Ok(false) => {
            return error_response(StatusCode::NOT_FOUND, &format!("Skill \"{id}\" not found."))
        }
        Err(error) => return error_response(StatusCode::INTERNAL_SERVER_ERROR, &error.to_string()),
    }
    match services.skills.get_skill(&id) {
        Ok(skill) => Json(json!({
            "ok": true,
            "skill": skill.as_ref().map(skill_json),
        }))
        .into_response(),
        Err(error) => error_response(StatusCode::INTERNAL_SERVER_ERROR, &error.to_string()),
    }
}

/// `DELETE /api/skills/{id}`. Built-in rows are kept; they can only be deactivated.
pub(super) async fn delete_skill(
    Extension(services): Extension<Arc<Services>>,
    headers: HeaderMap,
    Path(id): Path<String>,
) -> Response {
    if user_id_from_headers(&headers).is_none() {
        return unauthorized_response();
    }
    let skill = match services.skills.get_skill(&id) {
        Ok(Some(skill)) => skill,
        Ok(None) => {
            return error_response(StatusCode::NOT_FOUND, &format!("Skill \"{id}\" not found."))
        }
        Err(error) => return error_response(StatusCode::INTERNAL_SERVER_ERROR, &error.to_string()),
    };
    if skill.source == "built-in" {
        return error_response(
            StatusCode::BAD_REQUEST,
            "Cannot remove built-in skills. Deactivate instead.",
        );
    }
    // The TypeScript route ignores whether a row was removed, so this does too.
    match services.skills.remove_skill(&id) {
        Ok(_) => Json(json!({ "ok": true })).into_response(),
        Err(error) => error_response(StatusCode::INTERNAL_SERVER_ERROR, &error.to_string()),
    }
}

/// `GET /api/skills/runtime-config`
pub(super) async fn get_runtime_config(
    Extension(services): Extension<Arc<Services>>,
    headers: HeaderMap,
) -> Response {
    if user_id_from_headers(&headers).is_none() {
        return unauthorized_response();
    }
    match resolve_configs(&services) {
        Ok(statuses) => {
            let configs: Vec<Value> = statuses.iter().map(config_json).collect();
            Json(json!({ "ok": true, "configs": configs })).into_response()
        }
        Err(error) => error_response(StatusCode::INTERNAL_SERVER_ERROR, &error.to_string()),
    }
}

/// `PUT /api/skills/runtime-config`. Body: `{ id, value }`, or `id` in the query.
pub(super) async fn put_runtime_config(
    Extension(services): Extension<Arc<Services>>,
    headers: HeaderMap,
    uri: Uri,
    body: Bytes,
) -> Response {
    if user_id_from_headers(&headers).is_none() {
        return unauthorized_response();
    }
    // Every failure of this route is a 400 in TypeScript, parse errors included.
    let body: Value = match serde_json::from_slice(&body) {
        Ok(value) => value,
        Err(error) => return error_response(StatusCode::BAD_REQUEST, &error.to_string()),
    };
    let Some(id) = config_id(&uri, Some(&body)) else {
        return error_response(StatusCode::BAD_REQUEST, "id is required.");
    };
    if body.is_null() {
        return error_response(
            StatusCode::BAD_REQUEST,
            "Cannot read properties of null (reading 'value')",
        );
    }
    let value = js_trim(&js_text(body.get("value"))).to_string();
    if value.is_empty() {
        return error_response(StatusCode::BAD_REQUEST, "value is required.");
    }
    if let Err(error) = services.runtime_config.set_value(&id, &value) {
        return error_response(StatusCode::BAD_REQUEST, &error.to_string());
    }
    config_reply(&services, &id)
}

/// `DELETE /api/skills/runtime-config`. The body is optional: an empty or unparsable
/// body is no error here, as in TypeScript, and the `id` query parameter applies.
pub(super) async fn delete_runtime_config(
    Extension(services): Extension<Arc<Services>>,
    headers: HeaderMap,
    uri: Uri,
    body: Bytes,
) -> Response {
    if user_id_from_headers(&headers).is_none() {
        return unauthorized_response();
    }
    let body: Option<Value> = serde_json::from_slice(&body).ok();
    let Some(id) = config_id(&uri, body.as_ref()) else {
        return error_response(StatusCode::BAD_REQUEST, "id is required.");
    };
    if let Err(error) = services.runtime_config.delete_value(&id) {
        return error_response(StatusCode::BAD_REQUEST, &error.to_string());
    }
    config_reply(&services, &id)
}

/// `resolveConfigId`: the body's `id` when it is not blank, else the `id` query parameter.
fn config_id(uri: &Uri, body: Option<&Value>) -> Option<String> {
    let from_body = js_trim(&js_text(body.and_then(|body| body.get("id")))).to_string();
    if !from_body.is_empty() {
        return Some(from_body);
    }
    let from_query = js_trim(&query_param(uri, "id").unwrap_or_default()).to_string();
    (!from_query.is_empty()).then_some(from_query)
}

fn resolve_configs(services: &Services) -> Result<Vec<SkillRuntimeConfigStatus>, SkillError> {
    resolve_skill_runtime_config_status(&services.runtime_config, &process_env())
}

/// The reply of PUT and DELETE: `{ ok, config }` for the id that was just written.
fn config_reply(services: &Services, id: &str) -> Response {
    match resolve_configs(services) {
        Ok(statuses) => {
            let mut body = json!({ "ok": true });
            if let Some(status) = statuses.iter().find(|status| status.field.id == id) {
                body["config"] = config_json(status);
            }
            Json(body).into_response()
        }
        Err(error) => error_response(StatusCode::BAD_REQUEST, &error.to_string()),
    }
}

/// `process.env`, as the status resolver reads it. Non-UTF-8 entries are skipped.
fn process_env() -> HashMap<String, String> {
    std::env::vars_os()
        .filter_map(|(key, value)| Some((key.into_string().ok()?, value.into_string().ok()?)))
        .collect()
}

fn skill_json(row: &SkillRow) -> Value {
    json!({
        "id": row.id,
        "name": row.name,
        "description": row.description,
        "category": row.category,
        "version": row.version,
        "installed": row.installed,
        "functionName": row.function_name,
        "source": row.source,
        "sourceUrl": row.source_url,
        "toolDefinition": row.tool_definition,
        "handlerPath": row.handler_path,
        "createdAt": row.created_at,
        "updatedAt": row.updated_at,
    })
}

/// `SkillRuntimeConfigStatus`: the field definition plus what is configured.
fn config_json(status: &SkillRuntimeConfigStatus) -> Value {
    let field = status.field;
    let kind = match field.kind {
        ConfigValueKind::Secret => "secret",
        ConfigValueKind::Text => "text",
    };
    let source = status.source.map(|source| match source {
        ConfigSource::Store => "store",
        ConfigSource::Env => "env",
    });
    json!({
        "id": field.id,
        "skillId": field.skill_id,
        "label": field.label,
        "description": field.description,
        "kind": kind,
        "required": field.required,
        "envVars": field.env_vars,
        "configured": status.configured,
        "source": source,
        "maskedValue": status.masked_value,
        "updatedAt": status.updated_at,
    })
}

#[cfg(test)]
mod tests {
    use axum::http::{Method, StatusCode};
    use betaclaw_core::skills::builtin_skills::built_in_skills;
    use betaclaw_core::skills::store::InstallSkillInput;
    use serde_json::json;

    use crate::families::skills_wire::test_support::{assert_keys, harness, send, OWNER};

    const SKILL_KEYS: &[&str] = &[
        "category",
        "createdAt",
        "description",
        "functionName",
        "handlerPath",
        "id",
        "installed",
        "name",
        "source",
        "sourceUrl",
        "toolDefinition",
        "updatedAt",
        "version",
    ];

    /// The execute route refuses an unknown name and an installed-but-inactive built-in with
    /// 403 and the TypeScript activation message.
    #[tokio::test]
    async fn execute_refuses_unknown_and_inactive_skills() {
        let h = harness();
        for name in ["no_such_skill", "github_query"] {
            let body = json!({ "name": name }).to_string();
            let reply = send(
                &h,
                Method::POST,
                "/api/skills/execute",
                Some(OWNER),
                Some(body.as_str()),
            )
            .await;
            assert_eq!(reply.status, StatusCode::FORBIDDEN, "{name}");
            assert_eq!(
                reply.json()["error"],
                format!("Skill is not active: {name}")
            );
        }
    }

    /// An active skill actually runs: the handler error travels back as a 500, not the
    /// 502 of the proxy, which proves the dispatcher executed it.
    #[tokio::test]
    async fn execute_runs_an_active_skill_and_surfaces_handler_errors() {
        let h = harness();
        let body = json!({ "name": "python_execute", "args": {} }).to_string();
        let reply = send(
            &h,
            Method::POST,
            "/api/skills/execute",
            Some(OWNER),
            Some(body.as_str()),
        )
        .await;
        assert_eq!(reply.status, StatusCode::INTERNAL_SERVER_ERROR);
        assert_eq!(reply.json()["error"], "python_execute requires code.");
    }

    #[tokio::test]
    async fn execute_requires_authentication() {
        let h = harness();
        let body = json!({ "name": "python_execute" }).to_string();
        let reply = send(
            &h,
            Method::POST,
            "/api/skills/execute",
            None,
            Some(body.as_str()),
        )
        .await;
        assert_eq!(reply.status, StatusCode::UNAUTHORIZED);
    }

    #[tokio::test]
    async fn execute_matches_typescript_errors_for_null_body_and_missing_name() {
        let h = harness();
        for (body, expected) in [
            ("null", "Cannot read properties of null (reading 'context')"),
            ("{}", "Cannot read properties of undefined (reading 'trim')"),
        ] {
            let reply = send(
                &h,
                Method::POST,
                "/api/skills/execute",
                Some(OWNER),
                Some(body),
            )
            .await;
            assert_eq!(reply.status, StatusCode::INTERNAL_SERVER_ERROR);
            assert_eq!(reply.json()["error"], expected);
        }
    }

    #[tokio::test]
    async fn list_returns_the_seeded_built_ins() {
        let h = harness();

        let reply = send(&h, Method::GET, "/api/skills", Some(OWNER), None).await;

        assert_eq!(reply.status, StatusCode::OK);
        let body = reply.json();
        assert_keys(&body, &["ok", "skills"]);
        let skills = body["skills"].as_array().expect("array");
        assert_eq!(skills.len(), built_in_skills().len());
        assert_keys(&skills[0], SKILL_KEYS);
        let browser = skills
            .iter()
            .find(|skill| skill["id"] == "browser")
            .expect("browser is seeded");
        assert_eq!(browser["installed"].as_bool(), Some(true));
        assert_eq!(browser["source"], "built-in");
    }

    #[tokio::test]
    async fn list_without_a_user_is_unauthorized() {
        let h = harness();

        let reply = send(&h, Method::GET, "/api/skills", None, None).await;

        assert_eq!(reply.status, StatusCode::UNAUTHORIZED);
        assert_keys(&reply.json(), &["error", "ok"]);
    }

    #[tokio::test]
    async fn patch_toggles_the_install_state_and_reports_unknown_ids() {
        let h = harness();

        let reply = send(
            &h,
            Method::PATCH,
            "/api/skills/github-manager",
            Some(OWNER),
            Some(r#"{"installed":true}"#),
        )
        .await;
        assert_eq!(reply.status, StatusCode::OK);
        assert_eq!(reply.json()["skill"]["installed"].as_bool(), Some(true));

        let reply = send(
            &h,
            Method::PATCH,
            "/api/skills/nope",
            Some(OWNER),
            Some(r#"{"installed":true}"#),
        )
        .await;
        assert_eq!(reply.status, StatusCode::NOT_FOUND);
        assert_eq!(reply.json()["error"], "Skill \"nope\" not found.");
    }

    #[tokio::test]
    async fn delete_keeps_built_ins_and_removes_installed_rows() {
        let h = harness();

        let reply = send(&h, Method::DELETE, "/api/skills/browser", Some(OWNER), None).await;
        assert_eq!(reply.status, StatusCode::BAD_REQUEST);
        assert_eq!(
            reply.json()["error"],
            "Cannot remove built-in skills. Deactivate instead."
        );

        h.services
            .skills
            .install_skill(&InstallSkillInput {
                id: Some("vendor-1".to_string()),
                name: "Vendor".to_string(),
                description: "Vendor tool".to_string(),
                category: "Custom".to_string(),
                version: "1.0.0".to_string(),
                function_name: "vendor_tool".to_string(),
                source: "manual".to_string(),
                source_url: None,
                tool_definition: json!({ "name": "vendor_tool" }),
                handler_path: None,
            })
            .expect("install");
        let reply = send(
            &h,
            Method::DELETE,
            "/api/skills/vendor-1",
            Some(OWNER),
            None,
        )
        .await;
        assert_eq!(reply.status, StatusCode::OK);
        assert_keys(&reply.json(), &["ok"]);
        let reply = send(
            &h,
            Method::DELETE,
            "/api/skills/vendor-1",
            Some(OWNER),
            None,
        )
        .await;
        assert_eq!(reply.status, StatusCode::NOT_FOUND);
    }

    #[tokio::test]
    async fn runtime_config_saves_masks_and_clears_a_value() {
        let h = harness();
        let secret = "sk-1234567890";
        let body =
            json!({ "id": "vision.gemini_api_key", "value": format!(" {secret} ") }).to_string();

        let reply = send(
            &h,
            Method::PUT,
            "/api/skills/runtime-config",
            Some(OWNER),
            Some(body.as_str()),
        )
        .await;
        assert_eq!(reply.status, StatusCode::OK);
        let saved = reply.json();
        assert_eq!(saved["config"]["source"], "store");
        assert_eq!(saved["config"]["maskedValue"], "*********7890");
        assert!(
            !reply.text.contains(secret),
            "the clear value never leaves the store"
        );

        let reply = send(
            &h,
            Method::GET,
            "/api/skills/runtime-config",
            Some(OWNER),
            None,
        )
        .await;
        let listed = reply.json();
        let configs = listed["configs"].as_array().expect("array");
        assert_eq!(configs.len(), 3);
        assert_keys(
            &configs[0],
            &[
                "configured",
                "description",
                "envVars",
                "id",
                "kind",
                "label",
                "maskedValue",
                "required",
                "skillId",
                "source",
                "updatedAt",
            ],
        );
        assert_eq!(configs[0]["kind"], "secret");

        let reply = send(
            &h,
            Method::DELETE,
            "/api/skills/runtime-config?id=vision.gemini_api_key",
            Some(OWNER),
            None,
        )
        .await;
        assert_eq!(reply.status, StatusCode::OK);
        // The environment may still supply the value, so only the store is ruled out.
        assert_ne!(reply.json()["config"]["source"], "store");
    }

    #[tokio::test]
    async fn runtime_config_refuses_unknown_ids_blank_values_and_missing_ids() {
        let h = harness();
        let cases = [
            (
                json!({ "id": "nope", "value": "x" }),
                "Unsupported runtime config id: nope",
            ),
            (
                json!({ "id": "vision.gemini_api_key", "value": "   " }),
                "value is required.",
            ),
            (json!({ "value": "x" }), "id is required."),
        ];

        for (body, message) in cases {
            let text = body.to_string();
            let reply = send(
                &h,
                Method::PUT,
                "/api/skills/runtime-config",
                Some(OWNER),
                Some(text.as_str()),
            )
            .await;
            assert_eq!(reply.status, StatusCode::BAD_REQUEST, "{text}");
            assert_eq!(reply.json()["error"], message);
        }
        let reply = send(
            &h,
            Method::DELETE,
            "/api/skills/runtime-config",
            Some(OWNER),
            None,
        )
        .await;
        assert_eq!(reply.status, StatusCode::BAD_REQUEST);
        assert_eq!(reply.json()["error"], "id is required.");
    }
}
