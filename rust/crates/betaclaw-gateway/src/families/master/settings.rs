//! Port of `app/api/master/settings/route.ts` (GET, PUT) over
//! `src/server/master/systemPersona.ts`, `toolPolicy/service.ts`, `workspaceScope.ts`
//! and the persona repository.
//!
//! Failures are `500`, as the `catch` of the source answers. The explicit validation
//! answers are `400`, and a disabled rollout is `404`. Identity is checked first,
//! because the source wraps this route in `withUserContext`.

use std::sync::Arc;

use axum::body::Bytes;
use axum::extract::Extension;
use axum::http::{HeaderMap, StatusCode};
use axum::response::IntoResponse;
use axum::Json;
use betaclaw_core::master::feature_flags::is_master_system_persona_enabled;
use betaclaw_core::master::live_events::MasterInvalidationResource::Settings;
use betaclaw_core::master::repository::tool_policy_store::MasterToolPolicyInput;
use betaclaw_core::master::system_persona::ensure_master_persona;
use betaclaw_core::master::tool_policy::service::{
    load_tool_policy, save_tool_policy, LoadToolPolicyInput, SaveToolPolicyInput,
};
use betaclaw_core::model_hub::repository::ModelHubRepository;
use betaclaw_core::model_hub::sqlite::SqliteModelHubRepository;
use betaclaw_core::model_hub::types::PipelineStatus;
use betaclaw_core::personas::repository::PersonaUpdate;
use betaclaw_core::personas::types::PERSONA_INSTRUCTION_FILES;
use serde_json::{json, Map, Value};

use super::support::{
    bad_request, js_number, js_truthy, publish, server_error, string_field, string_list,
    user_or_401, ApiError, Reply, Repos,
};
use super::Services;

/// The Model Hub pipeline a persona's `preferredModelId` must belong to.
const PREFERRED_PIPELINE: &str = "p1";
/// `defaultToolPolicy()` of `settings/route.ts:43-49`.
const DEFAULT_TOOL_SECURITY: &str = "allowlist";
const DEFAULT_TOOL_ASK: &str = "on_miss";

fn disabled() -> ApiError {
    ApiError::new(StatusCode::NOT_FOUND, "Master system persona is disabled.")
}

/// `GET /api/master/settings` (`settings/route.ts:90-104`).
pub(super) async fn get_settings(
    Extension(services): Extension<Arc<Services>>,
    headers: HeaderMap,
) -> Reply {
    let user = user_or_401(&headers)?;
    if !is_master_system_persona_enabled(&services.env) {
        return Err(disabled());
    }
    let repos = services.repos().await;
    let master =
        ensure_master_persona(Some(user.as_str()), &repos.personas).map_err(server_error)?;
    let payload = settings_payload(&repos, &master.id, &user)?;
    Ok(Json(payload).into_response())
}

/// `PUT /api/master/settings` (`settings/route.ts:106-232`).
///
/// Validation runs before any write, so a rejected body changes nothing. Then the
/// persona, its allowed tools, the tool policy and the instruction files are
/// written, a `settings` event is published, and the settings payload is returned.
pub(super) async fn put_settings(
    Extension(services): Extension<Arc<Services>>,
    headers: HeaderMap,
    body: Bytes,
) -> Reply {
    let user = user_or_401(&headers)?;
    if !is_master_system_persona_enabled(&services.env) {
        return Err(disabled());
    }
    let repos = services.repos().await;
    let master =
        ensure_master_persona(Some(user.as_str()), &repos.personas).map_err(server_error)?;
    let body: Value = serde_json::from_slice(&body).map_err(server_error)?;

    let mut update = PersonaUpdate::default();
    let mut changed = false;
    if let Some(value) = body.get("preferredModelId") {
        update.preferred_model_id = Some(preferred_model(&services.model_hub_db_path, value)?);
        changed = true;
    }
    if let Some(value) = body.get("modelHubProfileId") {
        update.model_hub_profile_id = Some(model_hub_profile(value)?);
        changed = true;
    }
    if let Some(value) = body.get("isAutonomous") {
        update.is_autonomous = Some(js_truthy(Some(value)));
        changed = true;
    }
    if let Some(value) = body.get("maxToolCalls") {
        let number = js_number(Some(value)).floor();
        if !number.is_finite() || !(3.0..=500.0).contains(&number) {
            return Err(bad_request(
                "maxToolCalls must be an integer between 3 and 500",
            ));
        }
        update.max_tool_calls = Some(number as i64);
        changed = true;
    }

    if changed {
        repos
            .personas
            .update_persona(&master.id, &update)
            .map_err(server_error)?;
    }
    if let Some(names) = string_list(&body, "allowedToolFunctionNames") {
        repos
            .personas
            .set_allowed_tool_function_names(&master.id, &names)
            .map_err(server_error)?;
    }
    if let Some(policy) = body.get("toolPolicy").filter(|value| value.is_object()) {
        let scope = repos.main_scope(&user)?;
        save_tool_policy(&SaveToolPolicyInput {
            repo: &*repos.master,
            scope: &scope,
            policy: &MasterToolPolicyInput {
                security: string_field(policy, "security")
                    .unwrap_or_else(|| DEFAULT_TOOL_SECURITY.to_string()),
                ask: string_field(policy, "ask").unwrap_or_else(|| DEFAULT_TOOL_ASK.to_string()),
                allowlist: string_list(policy, "allowlist").unwrap_or_default(),
                updated_by: Some(user.clone()),
            },
        })
        .map_err(server_error)?;
    }
    if let Some(files) = body.get("files").filter(|value| value.is_object()) {
        for name in PERSONA_INSTRUCTION_FILES {
            if let Some(content) = files.get(name.as_str()).and_then(Value::as_str) {
                repos
                    .personas
                    .save_file(&master.id, *name, content)
                    .map_err(server_error)?;
            }
        }
    }

    let scope = repos.main_scope(&user)?;
    publish(&services, &scope, vec![Settings], None);
    let payload = settings_payload(&repos, &master.id, &user)?;
    Ok(Json(payload).into_response())
}

/// `preferredModelId` (`settings/route.ts:125-146`). `null` clears it. A non-empty
/// string must name an active model of pipeline `p1`.
fn preferred_model(db_path: &str, value: &Value) -> Result<Option<String>, ApiError> {
    match value {
        Value::Null => Ok(None),
        Value::String(model) if !model.trim().is_empty() => {
            let normalized = model.trim();
            if preferred_model_available(db_path, normalized).map_err(server_error)? {
                Ok(Some(normalized.to_string()))
            } else {
                Err(bad_request(format!(
                    "preferredModelId \"{normalized}\" is not available."
                )))
            }
        }
        _ => Err(bad_request(
            "preferredModelId must be a non-empty string or null",
        )),
    }
}

/// `modelHubProfileId` (`settings/route.ts:148-166`).
fn model_hub_profile(value: &Value) -> Result<Option<String>, ApiError> {
    match value {
        Value::Null => Ok(None),
        Value::String(profile) if is_valid_profile_id(profile) => {
            Ok(Some(profile.trim().to_string()))
        }
        _ => Err(bad_request(
            "modelHubProfileId must be a non-empty string (letters, numbers, \".\", \"_\" or \"-\") or null",
        )),
    }
}

/// `isPreferredModelAvailable` (`settings/route.ts:30-36`): an active `p1` entry
/// carries the requested model name.
fn preferred_model_available(db_path: &str, model_id: &str) -> Result<bool, String> {
    let repository = SqliteModelHubRepository::open(db_path).map_err(|error| error.to_string())?;
    let pipeline = repository
        .list_pipeline_models(PREFERRED_PIPELINE)
        .map_err(|error| error.to_string())?;
    Ok(pipeline
        .iter()
        .any(|entry| entry.status == PipelineStatus::Active && entry.model_name == model_id))
}

/// `isValidModelHubProfileId` (`settings/route.ts:38-41`): the trimmed value matches
/// `/^[a-zA-Z0-9._-]{1,64}$/`.
fn is_valid_profile_id(value: &str) -> bool {
    let trimmed = value.trim();
    let allowed = |c: char| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-');
    !trimmed.is_empty() && trimmed.len() <= 64 && trimmed.chars().all(allowed)
}

/// `buildSettingsPayload` (`settings/route.ts:51-88`).
fn settings_payload(repos: &Repos<'_>, master_id: &str, user: &str) -> Result<Value, ApiError> {
    let persona = repos
        .personas
        .get_persona_with_files(master_id)
        .map_err(server_error)?
        .ok_or_else(|| server_error("Master persona could not be loaded."))?;
    let scope = repos.main_scope(user)?;
    let policy = load_tool_policy(&LoadToolPolicyInput {
        repo: &*repos.master,
        scope: &scope,
        fallback_allowlist: None,
    })
    .map_err(server_error)?;
    let tool_policy = match policy {
        Some(policy) => serde_json::to_value(policy).map_err(server_error)?,
        None => json!({
            "security": DEFAULT_TOOL_SECURITY,
            "ask": DEFAULT_TOOL_ASK,
            "allowlist": [],
        }),
    };
    let profile = serde_json::to_value(&persona.persona).map_err(server_error)?;
    let instruction_files: Map<String, Value> = PERSONA_INSTRUCTION_FILES
        .iter()
        .map(|name| {
            let content = persona
                .files
                .iter()
                .find(|(file, _)| file.as_str() == name.as_str())
                .map(|(_, text)| text.clone())
                .unwrap_or_default();
            (name.as_str().to_string(), Value::String(content))
        })
        .collect();
    Ok(json!({
        "ok": true,
        "persona": {
            "id": profile["id"],
            "name": profile["name"],
            "slug": profile["slug"],
            "emoji": profile["emoji"],
            "systemPersonaKey": profile["systemPersonaKey"],
        },
        "runtimeSettings": {
            "preferredModelId": profile["preferredModelId"],
            "modelHubProfileId": profile["modelHubProfileId"],
            "isAutonomous": profile["isAutonomous"],
            "maxToolCalls": profile["maxToolCalls"],
        },
        "allowedToolFunctionNames": profile["allowedToolFunctionNames"],
        "toolPolicy": tool_policy,
        "instructionFiles": instruction_files,
    }))
}

#[cfg(test)]
mod tests {
    use axum::http::{Method, StatusCode};
    use betaclaw_core::master::feature_flags::MasterEnv;

    use crate::families::master::test_support::{Harness, OWNER};

    #[tokio::test]
    async fn settings_read_and_update_round_trip() {
        let harness = Harness::new();
        let (status, body) = harness
            .send(Method::GET, "/api/master/settings", Some(OWNER), None)
            .await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(body["persona"]["name"], "Master");
        assert_eq!(body["toolPolicy"]["security"], "allowlist");
        assert!(body["instructionFiles"]["SOUL.md"].is_string());

        let (status, body) = harness
            .send(
                Method::PUT,
                "/api/master/settings",
                Some(OWNER),
                Some(r#"{"maxToolCalls":2}"#),
            )
            .await;
        assert_eq!(status, StatusCode::BAD_REQUEST);
        assert_eq!(
            body["error"],
            "maxToolCalls must be an integer between 3 and 500"
        );

        let (status, body) = harness
            .send(
                Method::PUT,
                "/api/master/settings",
                Some(OWNER),
                Some(r#"{"preferredModelId":"nope"}"#),
            )
            .await;
        assert_eq!(status, StatusCode::BAD_REQUEST);
        assert_eq!(body["error"], "preferredModelId \"nope\" is not available.");

        let update = r#"{"maxToolCalls":42,"isAutonomous":true,"toolPolicy":{"security":"full"},"files":{"SOUL.md":"soul"}}"#;
        let (status, body) = harness
            .send(
                Method::PUT,
                "/api/master/settings",
                Some(OWNER),
                Some(update),
            )
            .await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(body["runtimeSettings"]["maxToolCalls"], 42);
        assert_eq!(body["runtimeSettings"]["isAutonomous"], true);
        assert_eq!(body["toolPolicy"]["security"], "full");
        assert_eq!(body["instructionFiles"]["SOUL.md"], "soul");

        let (status, body) = harness
            .send(Method::GET, "/api/master/settings", None, None)
            .await;
        assert_eq!(status, StatusCode::UNAUTHORIZED);
        assert_eq!(body["error"], "Unauthorized");
    }

    #[tokio::test]
    async fn settings_are_gated_by_the_system_persona_flag() {
        let env = MasterEnv::from([("MASTER_SYSTEM_PERSONA_ENABLED".to_string(), "0".to_string())]);
        let harness = Harness::with_env(env);
        let (status, body) = harness
            .send(Method::GET, "/api/master/settings", Some(OWNER), None)
            .await;
        assert_eq!(status, StatusCode::NOT_FOUND);
        assert_eq!(body["error"], "Master system persona is disabled.");
    }
}
