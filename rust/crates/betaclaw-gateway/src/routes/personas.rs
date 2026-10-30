//! Persona routes.
//!
//! Port of `app/api/personas/route.ts` (GET, POST),
//! `app/api/personas/[id]/route.ts` (GET, PUT, DELETE),
//! `app/api/personas/[id]/files/[filename]/route.ts` (GET, PUT) and
//! `app/api/personas/templates/route.ts` (GET). The template list is the
//! `{ id, name, emoji, vibe }` projection of `PERSONA_TEMPLATES` from
//! `src/lib/persona-templates.ts`.
//!
//! `preferredModelId` is validated against the active entries of the model-hub
//! pipeline `p1`, exactly like `isPreferredModelAvailable` calls
//! `modelHub.listPipeline('p1')`. The store is opened per request on
//! `MODEL_HUB_DB_PATH`, the same path the model-hub route uses.
//!
//! Reachable part of `deletePersonaDependencies`: the persona's conversations are
//! removed from the shared messages store. The World-Model, Mem0, Knowledge and
//! Telegram dependencies live in slices S5–S7 and are not reachable here yet; see
//! the OP register of `docs/RUST_MIGRATION.md`.

use axum::body::Bytes;
use axum::extract::{Path, State};
use axum::http::{HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::get;
use axum::{Json, Router};
use betaclaw_core::model_hub::env::EnvOverrides;
use betaclaw_core::model_hub::repository::ModelHubRepository;
use betaclaw_core::model_hub::sqlite::SqliteModelHubRepository;
use betaclaw_core::model_hub::types::PipelineStatus;
use betaclaw_core::personas::repository::{
    PersonaRepository, PersonaRepositoryError, PersonaUpdate,
};
use betaclaw_core::personas::types::{
    CreatePersonaInput, MemoryPersonaType, PersonaFileName, PersonaProfile, PersonaWithFiles,
    MEMORY_PERSONA_TYPES, PERSONA_FILE_NAMES,
};
use serde::Serialize;
use serde_json::{json, Map, Value};

use crate::auth_gate::{unauthorized_response, user_id_from_headers};
use crate::proxy::proxy_to_upstream;
use crate::state::SharedState;

pub fn router() -> Router<SharedState> {
    Router::new()
        // A static segment beats `{id}` in matchit, so the templates route keeps
        // its path instead of being answered as "Not found".
        .route(
            "/api/personas/templates",
            get(list_templates).fallback(proxy_to_upstream),
        )
        .route(
            "/api/personas",
            get(list_personas)
                .post(create_persona)
                .fallback(proxy_to_upstream),
        )
        .route(
            "/api/personas/{id}",
            get(get_persona)
                .put(update_persona)
                .delete(delete_persona)
                .fallback(proxy_to_upstream),
        )
        .route(
            "/api/personas/{id}/files/{filename}",
            get(get_file).put(put_file).fallback(proxy_to_upstream),
        )
}

/// One `PERSONA_TEMPLATES` entry as `GET /api/personas/templates` returns it
/// (`templates/route.ts:9-14`). Only the four projected fields are kept.
#[derive(Serialize)]
struct TemplateEntry {
    id: &'static str,
    name: &'static str,
    emoji: &'static str,
    vibe: &'static str,
}

/// `PERSONA_TEMPLATES` (`src/lib/persona-templates.ts`), project order 1:1.
const PERSONA_TEMPLATES: [TemplateEntry; 5] = [
    TemplateEntry {
        id: "nextjs-dev",
        name: "Next.js Dev",
        emoji: "👨‍💻",
        vibe: "Professionell, präzise, lösungsorientiert",
    },
    TemplateEntry {
        id: "best-friend",
        name: "Best Friend",
        emoji: "🤗",
        vibe: "Warmherzig, locker, immer da",
    },
    TemplateEntry {
        id: "translator",
        name: "Übersetzer",
        emoji: "🌍",
        vibe: "Neutral, kulturbewusst, sprachgewandt",
    },
    TemplateEntry {
        id: "code-reviewer",
        name: "Code Reviewer",
        emoji: "🔍",
        vibe: "Kritisch, konstruktiv, sicherheitsbewusst",
    },
    TemplateEntry {
        id: "creative",
        name: "Kreativ-Assistent",
        emoji: "🎨",
        vibe: "Inspirierend, assoziativ, experimentierfreudig",
    },
];

/// `GET /api/personas/templates`
async fn list_templates(headers: HeaderMap) -> Response {
    let Some(_user_id) = user_id_from_headers(&headers) else {
        return unauthorized_response();
    };
    Json(json!({ "ok": true, "templates": PERSONA_TEMPLATES })).into_response()
}

/// `GET /api/personas`
async fn list_personas(State(state): State<SharedState>, headers: HeaderMap) -> Response {
    let Some(user_id) = user_id_from_headers(&headers) else {
        return unauthorized_response();
    };
    let outcome = state.personas.lock().await.list_personas(&user_id);
    match outcome {
        Ok(personas) => Json(json!({ "ok": true, "personas": personas })).into_response(),
        Err(error) => internal_error(&error.to_string()),
    }
}

/// `POST /api/personas`
///
/// Body: `{ name, emoji?, vibe?, preferredModelId?, modelHubProfileId?,
/// memoryPersonaType?, files? }`. Answers 201 with the created persona and all
/// six files.
async fn create_persona(
    State(state): State<SharedState>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let Some(user_id) = user_id_from_headers(&headers) else {
        return unauthorized_response();
    };
    let value: Value = match serde_json::from_slice(&body) {
        Ok(value) => value,
        // ponytail: the parser text differs from V8's JSON.parse message. Status 500 matches (OP-3).
        Err(error) => return internal_error(&error.to_string()),
    };
    let fields = match &value {
        Value::Object(fields) => fields,
        Value::Null => return internal_error("Cannot read properties of null (reading 'name')"),
        // Arrays and primitives have no `name`, so `!body.name` is true -> 400.
        _ => return error_response(StatusCode::BAD_REQUEST, "name is required"),
    };

    let name = match fields.get("name") {
        Some(Value::String(text)) => text.trim(),
        // `!body.name` is true for an absent or null name.
        None | Some(Value::Null) => {
            return error_response(StatusCode::BAD_REQUEST, "name is required")
        }
        // `body.name.trim()` on a non-string throws -> 500.
        Some(_) => return internal_error("body.name.trim is not a function"),
    };
    if name.is_empty() {
        return error_response(StatusCode::BAD_REQUEST, "name is required");
    }

    let emoji = match fields.get("emoji") {
        Some(Value::String(text)) => text.trim(),
        None | Some(Value::Null) => "🤖",
        Some(_) => return internal_error("body.emoji.trim is not a function"),
    };
    let emoji = if emoji.is_empty() { "🤖" } else { emoji };

    let vibe = match fields.get("vibe") {
        Some(Value::String(text)) => text.trim(),
        None | Some(Value::Null) => "",
        Some(_) => return internal_error("body.vibe.trim is not a function"),
    };

    let preferred_model_id = match fields.get("preferredModelId") {
        Some(Value::String(text)) if !text.trim().is_empty() => {
            let normalized = text.trim();
            match preferred_model_available(normalized) {
                Ok(true) => Some(normalized.to_string()),
                Ok(false) => {
                    return error_response(
                        StatusCode::BAD_REQUEST,
                        &format!("preferredModelId \"{normalized}\" is not available."),
                    )
                }
                Err(error) => return internal_error(&error),
            }
        }
        _ => None,
    };

    let model_hub_profile_id = match fields.get("modelHubProfileId") {
        None | Some(Value::Null) => None,
        Some(Value::String(text)) if is_valid_model_hub_profile_id(text) => {
            Some(text.trim().to_string())
        }
        Some(_) => {
            return error_response(
                StatusCode::BAD_REQUEST,
                "modelHubProfileId must be a non-empty string (letters, numbers, \".\", \"_\" or \"-\").",
            )
        }
    };

    let memory_persona_type = match fields.get("memoryPersonaType") {
        None => None,
        Some(Value::String(text)) => match MemoryPersonaType::parse(text) {
            Some(parsed) => Some(parsed),
            None => return memory_persona_type_error(),
        },
        Some(_) => return memory_persona_type_error(),
    };

    let mut files: Vec<(String, String)> = Vec::new();
    if let Some(Value::Object(entries)) = fields.get("files") {
        for (filename, content) in entries {
            if let Value::String(text) = content {
                if PERSONA_FILE_NAMES
                    .iter()
                    .any(|known| known.as_str() == filename)
                {
                    files.push((filename.clone(), text.clone()));
                }
            }
        }
    }

    let input = CreatePersonaInput {
        name: name.to_string(),
        emoji: emoji.to_string(),
        vibe: vibe.to_string(),
        user_id: user_id.clone(),
        preferred_model_id,
        model_hub_profile_id,
        memory_persona_type,
        files: if files.is_empty() { None } else { Some(files) },
        ..Default::default()
    };

    let repository = state.personas.lock().await;
    let created = match repository.create_persona(&input) {
        Ok(persona) => persona,
        // The message is `Persona slug already exists: "<slug>".`, which the
        // TypeScript `/slug already exists/i` branch maps to 409.
        Err(error @ PersonaRepositoryError::SlugConflict { .. }) => {
            return error_response(StatusCode::CONFLICT, &error.to_string())
        }
        Err(error) => return internal_error(&error.to_string()),
    };
    let full = match repository.get_persona_with_files(&created.id) {
        Ok(Some(full)) => full,
        Ok(None) => return internal_error("Persona not found after create"),
        Err(error) => return internal_error(&error.to_string()),
    };
    drop(repository);

    (
        StatusCode::CREATED,
        Json(json!({ "ok": true, "persona": persona_json(full) })),
    )
        .into_response()
}

/// `PUT /api/personas/{id}`. Body: the editable persona fields.
async fn update_persona(
    State(state): State<SharedState>,
    headers: HeaderMap,
    Path(id): Path<String>,
    body: Bytes,
) -> Response {
    let Some(user_id) = user_id_from_headers(&headers) else {
        return unauthorized_response();
    };
    let repository = state.personas.lock().await;
    let persona = match owned_persona(&repository, &id, &user_id) {
        Ok(Some(persona)) => persona,
        Ok(None) => return not_found(),
        Err(error) => return internal_error(&error.to_string()),
    };
    if persona.system_persona_key.is_some() {
        return error_response(
            StatusCode::FORBIDDEN,
            "System persona identity is managed by Master settings.",
        );
    }

    let value: Value = match serde_json::from_slice(&body) {
        Ok(value) => value,
        Err(error) => return internal_error(&error.to_string()),
    };
    let fields = match &value {
        Value::Object(fields) => fields,
        Value::Null => return internal_error("Cannot read properties of null (reading 'name')"),
        // Arrays and primitives carry no keys, so no update is applied.
        _ => return error_response(StatusCode::BAD_REQUEST, "No updates provided"),
    };

    let mut updates = PersonaUpdate::default();
    let mut any = false;

    if let Some(value) = fields.get("name") {
        let name = match value {
            Value::String(text) => text.trim().to_string(),
            _ => return internal_error("body.name.trim is not a function"),
        };
        if name.is_empty() {
            return error_response(StatusCode::BAD_REQUEST, "name must not be empty");
        }
        updates.name = Some(name);
        any = true;
    }
    if let Some(value) = fields.get("emoji") {
        match value {
            Value::String(text) => updates.emoji = Some(text.trim().to_string()),
            _ => return internal_error("body.emoji.trim is not a function"),
        }
        any = true;
    }
    if let Some(value) = fields.get("vibe") {
        match value {
            Value::String(text) => updates.vibe = Some(text.trim().to_string()),
            _ => return internal_error("body.vibe.trim is not a function"),
        }
        any = true;
    }
    if let Some(value) = fields.get("preferredModelId") {
        match value {
            Value::Null => updates.preferred_model_id = Some(None),
            Value::String(text) if !text.trim().is_empty() => {
                let normalized = text.trim();
                match preferred_model_available(normalized) {
                    Ok(true) => updates.preferred_model_id = Some(Some(normalized.to_string())),
                    Ok(false) => {
                        return error_response(
                            StatusCode::BAD_REQUEST,
                            &format!("preferredModelId \"{normalized}\" is not available."),
                        )
                    }
                    Err(error) => return internal_error(&error),
                }
            }
            _ => {
                return error_response(
                    StatusCode::BAD_REQUEST,
                    "preferredModelId must be a non-empty string or null",
                )
            }
        }
        any = true;
    }
    if let Some(value) = fields.get("modelHubProfileId") {
        match value {
            Value::Null => updates.model_hub_profile_id = Some(None),
            Value::String(text) if is_valid_model_hub_profile_id(text) => {
                updates.model_hub_profile_id = Some(Some(text.trim().to_string()));
            }
            _ => {
                return error_response(
                    StatusCode::BAD_REQUEST,
                    "modelHubProfileId must be a non-empty string (letters, numbers, \".\", \"_\" or \"-\") or null",
                )
            }
        }
        any = true;
    }
    if let Some(value) = fields.get("memoryPersonaType") {
        match value {
            Value::String(text) => match MemoryPersonaType::parse(text) {
                Some(parsed) => updates.memory_persona_type = Some(parsed),
                None => return memory_persona_type_error(),
            },
            _ => return memory_persona_type_error(),
        }
        any = true;
    }
    if let Some(value) = fields.get("isAutonomous") {
        updates.is_autonomous = Some(js_truthy(value));
        any = true;
    }
    if let Some(value) = fields.get("maxToolCalls") {
        let number = js_number(value).floor();
        if !number.is_finite() || !(3.0..=500.0).contains(&number) {
            return error_response(
                StatusCode::BAD_REQUEST,
                "maxToolCalls must be an integer between 3 and 500",
            );
        }
        updates.max_tool_calls = Some(number as i64);
        any = true;
    }

    if !any {
        return error_response(StatusCode::BAD_REQUEST, "No updates provided");
    }

    match repository.update_persona(&id, &updates) {
        Ok(true) => {}
        Ok(false) => return not_found(),
        Err(error @ PersonaRepositoryError::SlugConflict { .. }) => {
            return error_response(StatusCode::CONFLICT, &error.to_string())
        }
        Err(error) => return internal_error(&error.to_string()),
    }
    let updated = match repository.get_persona_with_files(&id) {
        Ok(Some(updated)) => updated,
        Ok(None) => return not_found(),
        Err(error) => return internal_error(&error.to_string()),
    };
    drop(repository);

    Json(json!({ "ok": true, "persona": persona_json(updated) })).into_response()
}

/// `DELETE /api/personas/{id}`
async fn delete_persona(
    State(state): State<SharedState>,
    headers: HeaderMap,
    Path(id): Path<String>,
) -> Response {
    let Some(user_id) = user_id_from_headers(&headers) else {
        return unauthorized_response();
    };
    let repository = state.personas.lock().await;
    let persona = match owned_persona(&repository, &id, &user_id) {
        Ok(Some(persona)) => persona,
        Ok(None) => return not_found(),
        Err(error) => return internal_error(&error.to_string()),
    };
    if persona.system_persona_key.is_some() {
        return error_response(StatusCode::FORBIDDEN, "System personas cannot be deleted.");
    }

    // Reachable half of `deletePersonaDependencies`: remove the persona's
    // conversations. World-Model, Mem0, Knowledge and Telegram are S5–S7 and not
    // reachable from the gateway process yet.
    {
        let store = state.messages.lock().await;
        let conversations = match store.list_conversations_by_persona(&id, &user_id, 10_000) {
            Ok(conversations) => conversations,
            Err(error) => return internal_error(&error.to_string()),
        };
        for conversation in conversations {
            if let Err(error) = store.delete_conversation(&conversation.id, &user_id) {
                return internal_error(&error.to_string());
            }
        }
    }

    match repository.delete_persona(&id) {
        Ok(true) => {}
        Ok(false) => return not_found(),
        Err(error) => return internal_error(&error.to_string()),
    }
    drop(repository);

    Json(json!({ "ok": true })).into_response()
}

/// `isPreferredModelAvailable` (`app/api/personas/route.ts:14-21` and
/// `app/api/personas/[id]/route.ts:12-19`): an active entry of pipeline `p1`
/// carries the requested `modelName`.
fn preferred_model_available(model_id: &str) -> Result<bool, String> {
    let env = EnvOverrides::new();
    let path = env
        .get("MODEL_HUB_DB_PATH")
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| "model-hub.db".to_string());
    let repository = SqliteModelHubRepository::open(&path).map_err(|error| error.to_string())?;
    let pipeline = repository
        .list_pipeline_models("p1")
        .map_err(|error| error.to_string())?;
    Ok(pipeline
        .iter()
        .any(|entry| entry.status == PipelineStatus::Active && entry.model_name == model_id))
}

/// `isValidModelHubProfileId` (`app/api/personas/route.ts:23-26`): the trimmed
/// value matches `/^[a-zA-Z0-9._-]{1,64}$/`.
fn is_valid_model_hub_profile_id(value: &str) -> bool {
    let trimmed = value.trim();
    let valid_char =
        |character: char| character.is_ascii_alphanumeric() || matches!(character, '.' | '_' | '-');
    !trimmed.is_empty() && trimmed.len() <= 64 && trimmed.chars().all(valid_char)
}

fn memory_persona_type_error() -> Response {
    error_response(
        StatusCode::BAD_REQUEST,
        &format!(
            "Invalid memoryPersonaType. Allowed: {}",
            MEMORY_PERSONA_TYPES.join(", ")
        ),
    )
}

/// JavaScript `Boolean(value)` for the `isAutonomous` coercion.
fn js_truthy(value: &Value) -> bool {
    match value {
        Value::Null => false,
        Value::Bool(flag) => *flag,
        Value::Number(number) => number.as_f64().map(|value| value != 0.0).unwrap_or(true),
        Value::String(text) => !text.is_empty(),
        Value::Array(_) | Value::Object(_) => true,
    }
}

/// JavaScript `Number(value)` for the `maxToolCalls` coercion. `Math.floor` is
/// applied by the caller.
fn js_number(value: &Value) -> f64 {
    match value {
        Value::Null => 0.0,
        Value::Bool(true) => 1.0,
        Value::Bool(false) => 0.0,
        Value::Number(number) => number.as_f64().unwrap_or(f64::NAN),
        Value::String(text) => text.trim().parse::<f64>().unwrap_or(f64::NAN),
        Value::Array(items) => match items.as_slice() {
            [] => 0.0,
            [single] => js_number(single),
            _ => f64::NAN,
        },
        Value::Object(_) => f64::NAN,
    }
}

/// `GET /api/personas/{id}`
async fn get_persona(
    State(state): State<SharedState>,
    headers: HeaderMap,
    Path(id): Path<String>,
) -> Response {
    let Some(user_id) = user_id_from_headers(&headers) else {
        return unauthorized_response();
    };
    let outcome = state.personas.lock().await.get_persona_with_files(&id);
    match outcome {
        Ok(Some(persona)) if persona.persona.user_id == user_id => {
            Json(json!({ "ok": true, "persona": persona_json(persona) })).into_response()
        }
        Ok(_) => not_found(),
        Err(error) => internal_error(&error.to_string()),
    }
}

/// `GET /api/personas/{id}/files/{filename}`
async fn get_file(
    State(state): State<SharedState>,
    headers: HeaderMap,
    Path((id, filename)): Path<(String, String)>,
) -> Response {
    let Some(user_id) = user_id_from_headers(&headers) else {
        return unauthorized_response();
    };
    let Some(name) = PersonaFileName::parse(&filename) else {
        return invalid_filename();
    };
    let repository = state.personas.lock().await;
    match owned_persona(&repository, &id, &user_id) {
        Ok(Some(_)) => {}
        Ok(None) => return not_found(),
        Err(error) => return internal_error(&error.to_string()),
    }
    match repository.get_file(&id, name) {
        Ok(content) => Json(json!({
            "ok": true,
            "filename": filename,
            "content": content.unwrap_or_default(),
        }))
        .into_response(),
        Err(error) => internal_error(&error.to_string()),
    }
}

/// `PUT /api/personas/{id}/files/{filename}`. Body: `{ content }`.
async fn put_file(
    State(state): State<SharedState>,
    headers: HeaderMap,
    Path((id, filename)): Path<(String, String)>,
    body: Bytes,
) -> Response {
    let Some(user_id) = user_id_from_headers(&headers) else {
        return unauthorized_response();
    };
    let Some(name) = PersonaFileName::parse(&filename) else {
        return invalid_filename();
    };
    let repository = state.personas.lock().await;
    let persona = match owned_persona(&repository, &id, &user_id) {
        Ok(Some(persona)) => persona,
        Ok(None) => return not_found(),
        Err(error) => return internal_error(&error.to_string()),
    };
    if persona.system_persona_key.is_some() {
        return error_response(
            StatusCode::FORBIDDEN,
            "System persona files are managed by Master settings.",
        );
    }
    // TypeScript parses the body only after the ownership and system checks.
    let content = match serde_json::from_slice::<Value>(&body) {
        Ok(Value::Null) => {
            return internal_error("Cannot read properties of null (reading 'content')")
        }
        Ok(value) => match value.get("content") {
            Some(Value::String(content)) => content.clone(),
            _ => return error_response(StatusCode::BAD_REQUEST, "content (string) is required"),
        },
        // ponytail: the parser text differs from V8's JSON.parse message. Status 500 matches.
        Err(error) => return internal_error(&error.to_string()),
    };
    match repository.save_file(&id, name, &content) {
        Ok(()) => Json(json!({ "ok": true })).into_response(),
        Err(error) => internal_error(&error.to_string()),
    }
}

/// The persona when it exists and belongs to `user_id`. A foreign persona is
/// reported as missing, as in TypeScript, so ids cannot be probed.
fn owned_persona(
    repository: &PersonaRepository,
    id: &str,
    user_id: &str,
) -> Result<Option<PersonaProfile>, PersonaRepositoryError> {
    Ok(repository
        .get_persona(id)?
        .filter(|persona| persona.user_id == user_id))
}

/// `PersonaWithFiles` as TypeScript returns it: the profile fields plus a
/// `files` object keyed by file name. The core type keeps files as a vector of
/// pairs, which would serialize as an array of arrays.
fn persona_json(persona: PersonaWithFiles) -> Value {
    let files: Map<String, Value> = persona
        .files
        .into_iter()
        .map(|(name, content)| (name, Value::String(content)))
        .collect();
    let mut value = serde_json::to_value(&persona.persona).unwrap_or_default();
    if let Value::Object(fields) = &mut value {
        fields.insert("files".to_string(), Value::Object(files));
    }
    value
}

fn invalid_filename() -> Response {
    let allowed: Vec<&str> = PERSONA_FILE_NAMES
        .iter()
        .map(|name| name.as_str())
        .collect();
    error_response(
        StatusCode::BAD_REQUEST,
        &format!("Invalid filename. Allowed: {}", allowed.join(", ")),
    )
}

fn not_found() -> Response {
    error_response(StatusCode::NOT_FOUND, "Not found")
}

fn internal_error(message: &str) -> Response {
    error_response(StatusCode::INTERNAL_SERVER_ERROR, message)
}

fn error_response(status: StatusCode, message: &str) -> Response {
    (status, Json(json!({ "ok": false, "error": message }))).into_response()
}

#[cfg(test)]
mod tests {
    use axum::http::{Method, StatusCode};
    use betaclaw_core::personas::repository::PersonaRepository;
    use betaclaw_core::personas::types::{CreatePersonaInput, SystemPersonaKey};
    use betaclaw_core::personas::PersonaWorkspace;

    use crate::routes::test_support::{assert_keys, send, state_in, state_with, ScratchDir};

    const OWNER: &str = "user-1";
    const OTHER: &str = "user-2";
    const SUMMARY_KEYS: &[&str] = &[
        "allowedToolFunctionNames",
        "emoji",
        "id",
        "isAutonomous",
        "maxToolCalls",
        "memoryPersonaType",
        "modelHubProfileId",
        "name",
        "preferredModelId",
        "slug",
        "systemPersonaKey",
        "updatedAt",
        "vibe",
    ];
    const PROFILE_KEYS: &[&str] = &[
        "allowedToolFunctionNames",
        "createdAt",
        "emoji",
        "files",
        "id",
        "isAutonomous",
        "maxToolCalls",
        "memoryPersonaType",
        "modelHubProfileId",
        "name",
        "preferredModelId",
        "slug",
        "systemPersonaKey",
        "updatedAt",
        "userId",
        "vibe",
    ];
    const FILE_NAMES: &[&str] = &[
        "SOUL.md",
        "IDENTITY.md",
        "AGENTS.md",
        "USER.md",
        "TOOLS.md",
        "HEARTBEAT.md",
    ];
    const INVALID_FILENAME: &str = "Invalid filename. Allowed: SOUL.md, IDENTITY.md, AGENTS.md, USER.md, TOOLS.md, HEARTBEAT.md";

    /// Creates a persona directly in the store the routes read from.
    fn seed(scratch: &ScratchDir, user_id: &str, name: &str, system: bool) -> String {
        let repository = PersonaRepository::open_with_workspace(
            &scratch.path_string("personas.db"),
            PersonaWorkspace::new(scratch.path_string("personas")),
        )
        .expect("open persona store");
        let input = CreatePersonaInput {
            name: name.to_string(),
            emoji: "🤖".to_string(),
            user_id: user_id.to_string(),
            system_persona_key: system.then_some(SystemPersonaKey::Master),
            ..Default::default()
        };
        repository
            .create_persona(&input)
            .expect("create persona")
            .id
    }

    fn put_file_body(content: &str) -> String {
        serde_json::json!({ "content": content }).to_string()
    }

    #[tokio::test]
    async fn list_returns_only_the_callers_personas() {
        let scratch = ScratchDir::new();
        seed(&scratch, OWNER, "Alpha", false);
        seed(&scratch, OTHER, "Beta", false);
        let state = state_in(&scratch);

        let (status, body) = send(&state, Method::GET, "/api/personas", Some(OWNER), None).await;

        assert_eq!(status, StatusCode::OK);
        assert_keys(&body, &["ok", "personas"]);
        let personas = body["personas"].as_array().expect("array");
        assert_eq!(personas.len(), 1);
        assert_keys(&personas[0], SUMMARY_KEYS);
        assert_eq!(personas[0]["name"], "Alpha");
    }

    #[tokio::test]
    async fn list_without_user_header_is_unauthorized() {
        let scratch = ScratchDir::new();
        let state = state_in(&scratch);

        let (status, body) = send(&state, Method::GET, "/api/personas", None, None).await;

        assert_eq!(status, StatusCode::UNAUTHORIZED);
        assert_keys(&body, &["error", "ok"]);
    }

    #[tokio::test]
    async fn get_returns_the_profile_with_all_six_files() {
        let scratch = ScratchDir::new();
        let id = seed(&scratch, OWNER, "Alpha", false);
        let state = state_in(&scratch);

        let (status, body) = send(
            &state,
            Method::GET,
            &format!("/api/personas/{id}"),
            Some(OWNER),
            None,
        )
        .await;

        assert_eq!(status, StatusCode::OK);
        assert_keys(&body, &["ok", "persona"]);
        assert_keys(&body["persona"], PROFILE_KEYS);
        assert_eq!(body["persona"]["userId"], OWNER);
        assert_keys(&body["persona"]["files"], FILE_NAMES);
    }

    #[tokio::test]
    async fn get_reports_foreign_and_missing_personas_as_not_found() {
        let scratch = ScratchDir::new();
        let id = seed(&scratch, OWNER, "Alpha", false);
        let state = state_in(&scratch);

        let (foreign, foreign_body) = send(
            &state,
            Method::GET,
            &format!("/api/personas/{id}"),
            Some(OTHER),
            None,
        )
        .await;
        let (missing, missing_body) = send(
            &state,
            Method::GET,
            "/api/personas/does-not-exist",
            Some(OWNER),
            None,
        )
        .await;

        for (status, body) in [(foreign, foreign_body), (missing, missing_body)] {
            assert_eq!(status, StatusCode::NOT_FOUND);
            assert_keys(&body, &["error", "ok"]);
            assert_eq!(body["error"], "Not found");
        }
    }

    #[tokio::test]
    async fn put_then_get_file_round_trips_content() {
        let scratch = ScratchDir::new();
        let id = seed(&scratch, OWNER, "Alpha", false);
        let state = state_in(&scratch);
        let uri = format!("/api/personas/{id}/files/SOUL.md");

        let (put_status, put_body) = send(
            &state,
            Method::PUT,
            &uri,
            Some(OWNER),
            Some(&put_file_body("hello soul")),
        )
        .await;
        let (get_status, get_body) = send(&state, Method::GET, &uri, Some(OWNER), None).await;

        assert_eq!(put_status, StatusCode::OK);
        assert_keys(&put_body, &["ok"]);
        assert_eq!(get_status, StatusCode::OK);
        assert_keys(&get_body, &["content", "filename", "ok"]);
        assert_eq!(get_body["filename"], "SOUL.md");
        assert_eq!(get_body["content"], "hello soul");
    }

    #[tokio::test]
    async fn file_routes_reject_names_outside_the_whitelist() {
        let scratch = ScratchDir::new();
        let id = seed(&scratch, OWNER, "Alpha", false);
        let state = state_in(&scratch);
        let uri = format!("/api/personas/{id}/files/NOTES.md");

        let (get_status, get_body) = send(&state, Method::GET, &uri, Some(OWNER), None).await;
        let (put_status, put_body) = send(
            &state,
            Method::PUT,
            &uri,
            Some(OWNER),
            Some(&put_file_body("x")),
        )
        .await;

        for (status, body) in [(get_status, get_body), (put_status, put_body)] {
            assert_eq!(status, StatusCode::BAD_REQUEST);
            assert_keys(&body, &["error", "ok"]);
            assert_eq!(body["error"], INVALID_FILENAME);
        }
    }

    #[tokio::test]
    async fn file_routes_hide_foreign_personas() {
        let scratch = ScratchDir::new();
        let id = seed(&scratch, OWNER, "Alpha", false);
        let state = state_in(&scratch);
        let uri = format!("/api/personas/{id}/files/SOUL.md");

        let (get_status, get_body) = send(&state, Method::GET, &uri, Some(OTHER), None).await;
        let (put_status, put_body) = send(
            &state,
            Method::PUT,
            &uri,
            Some(OTHER),
            Some(&put_file_body("x")),
        )
        .await;

        for (status, body) in [(get_status, get_body), (put_status, put_body)] {
            assert_eq!(status, StatusCode::NOT_FOUND);
            assert_eq!(body["error"], "Not found");
        }
    }

    #[tokio::test]
    async fn put_file_on_a_system_persona_is_forbidden() {
        let scratch = ScratchDir::new();
        let id = seed(&scratch, OWNER, "Master", true);
        let state = state_in(&scratch);

        let (status, body) = send(
            &state,
            Method::PUT,
            &format!("/api/personas/{id}/files/SOUL.md"),
            Some(OWNER),
            Some(&put_file_body("x")),
        )
        .await;

        assert_eq!(status, StatusCode::FORBIDDEN);
        assert_keys(&body, &["error", "ok"]);
        assert_eq!(
            body["error"],
            "System persona files are managed by Master settings."
        );
    }

    #[tokio::test]
    async fn put_file_requires_string_content() {
        let scratch = ScratchDir::new();
        let id = seed(&scratch, OWNER, "Alpha", false);
        let state = state_in(&scratch);

        let (status, body) = send(
            &state,
            Method::PUT,
            &format!("/api/personas/{id}/files/SOUL.md"),
            Some(OWNER),
            Some(r#"{"content":5}"#),
        )
        .await;

        assert_eq!(status, StatusCode::BAD_REQUEST);
        assert_keys(&body, &["error", "ok"]);
        assert_eq!(body["error"], "content (string) is required");
    }

    #[tokio::test]
    async fn put_file_with_malformed_json_is_an_internal_error() {
        let scratch = ScratchDir::new();
        let id = seed(&scratch, OWNER, "Alpha", false);
        let state = state_in(&scratch);

        let (status, body) = send(
            &state,
            Method::PUT,
            &format!("/api/personas/{id}/files/SOUL.md"),
            Some(OWNER),
            Some("{"),
        )
        .await;

        assert_eq!(status, StatusCode::INTERNAL_SERVER_ERROR);
        assert_keys(&body, &["error", "ok"]);
    }

    #[tokio::test]
    async fn unported_persona_routes_fall_through_to_the_proxy() {
        let scratch = ScratchDir::new();
        let state = state_in(&scratch);
        // Create, update, delete and the template list are native now; only the
        // methods without a handler (PATCH) and the file sub-route's POST still
        // reach Next.js.
        let cases: [(Method, &str, Option<&str>); 3] = [
            (Method::PATCH, "/api/personas/abc", Some("{}")),
            (Method::POST, "/api/personas/abc/files/SOUL.md", Some("{}")),
            (Method::DELETE, "/api/personas/templates", None),
        ];

        for (method, uri, body) in cases {
            let (status, _) = send(&state, method, uri, Some(OWNER), body).await;
            assert_eq!(status, StatusCode::BAD_GATEWAY, "{uri}");
        }
    }

    #[tokio::test]
    async fn gate_strips_a_spoofed_identity_header_in_demo_mode() {
        use axum::body::Body;
        use axum::http::Request;
        use tower::ServiceExt;

        let scratch = ScratchDir::new();
        seed(&scratch, OWNER, "Alpha", false);
        // Demo mode admits anonymous reads even with REQUIRE_AUTH, and resolves
        // no identity for them. A client-supplied header must not pick the user.
        let state = state_with(&scratch, |config| {
            config.demo_mode = true;
            config.require_auth = true;
        });
        let request = Request::builder()
            .uri("/api/personas")
            .header("x-betaclaw-user-id", OWNER)
            .body(Body::empty())
            .expect("valid request");

        let response = crate::proxy::build_router(state)
            .oneshot(request)
            .await
            .expect("infallible service");

        assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
    }
    #[tokio::test]
    async fn templates_list_the_static_projection() {
        let scratch = ScratchDir::new();
        let state = state_in(&scratch);

        let (status, body) = send(
            &state,
            Method::GET,
            "/api/personas/templates",
            Some(OWNER),
            None,
        )
        .await;

        assert_eq!(status, StatusCode::OK);
        assert_keys(&body, &["ok", "templates"]);
        let templates = body["templates"].as_array().expect("array");
        assert_eq!(templates.len(), 5);
        for template in templates {
            assert_keys(template, &["emoji", "id", "name", "vibe"]);
        }
        assert_eq!(templates[0]["id"], "nextjs-dev");
        assert_eq!(templates[0]["name"], "Next.js Dev");
        assert_eq!(templates[4]["id"], "creative");
    }

    #[tokio::test]
    async fn templates_without_a_user_are_unauthorized() {
        let scratch = ScratchDir::new();
        let state = state_in(&scratch);

        let (status, body) = send(&state, Method::GET, "/api/personas/templates", None, None).await;

        assert_eq!(status, StatusCode::UNAUTHORIZED);
        assert_keys(&body, &["error", "ok"]);
    }

    #[tokio::test]
    async fn post_creates_a_persona_with_files() {
        let scratch = ScratchDir::new();
        let state = state_in(&scratch);

        let (status, body) = send(
            &state,
            Method::POST,
            "/api/personas",
            Some(OWNER),
            Some(r#"{"name":"  Alpha  ","emoji":"🐙","vibe":"curious","files":{"SOUL.md":"hello","NOPE.md":"x"}}"#),
        )
        .await;

        assert_eq!(status, StatusCode::CREATED);
        assert_keys(&body, &["ok", "persona"]);
        let persona = &body["persona"];
        assert_eq!(persona["name"], "Alpha");
        assert_eq!(persona["emoji"], "🐙");
        assert_eq!(persona["vibe"], "curious");
        assert_eq!(persona["userId"], OWNER);
        assert_eq!(persona["memoryPersonaType"], "general");
        assert_keys(&persona["files"], FILE_NAMES);
        assert_eq!(persona["files"]["SOUL.md"], "hello");
        assert_eq!(persona["files"]["IDENTITY.md"], "");
    }

    #[tokio::test]
    async fn put_updates_editable_fields_and_rejects_empty_and_out_of_range() {
        let scratch = ScratchDir::new();
        let id = seed(&scratch, OWNER, "Alpha", false);
        let state = state_in(&scratch);

        let (status, body) = send(
            &state,
            Method::PUT,
            &format!("/api/personas/{id}"),
            Some(OWNER),
            Some(r#"{"name":"Beta","isAutonomous":true,"maxToolCalls":42}"#),
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(body["persona"]["name"], "Beta");
        assert_eq!(body["persona"]["isAutonomous"], true);
        assert_eq!(body["persona"]["maxToolCalls"], 42);

        let (status, body) = send(
            &state,
            Method::PUT,
            &format!("/api/personas/{id}"),
            Some(OWNER),
            Some(r#"{"name":"   "}"#),
        )
        .await;
        assert_eq!(status, StatusCode::BAD_REQUEST);
        assert_eq!(body["error"], "name must not be empty");

        let (status, body) = send(
            &state,
            Method::PUT,
            &format!("/api/personas/{id}"),
            Some(OWNER),
            Some(r#"{"maxToolCalls":2}"#),
        )
        .await;
        assert_eq!(status, StatusCode::BAD_REQUEST);
        assert_eq!(
            body["error"],
            "maxToolCalls must be an integer between 3 and 500"
        );

        let (status, body) = send(
            &state,
            Method::PUT,
            &format!("/api/personas/{id}"),
            Some(OWNER),
            Some(r#"{}"#),
        )
        .await;
        assert_eq!(status, StatusCode::BAD_REQUEST);
        assert_eq!(body["error"], "No updates provided");
    }

    #[tokio::test]
    async fn put_on_a_system_persona_is_forbidden() {
        let scratch = ScratchDir::new();
        let id = seed(&scratch, OWNER, "Master", true);
        let state = state_in(&scratch);

        let (status, body) = send(
            &state,
            Method::PUT,
            &format!("/api/personas/{id}"),
            Some(OWNER),
            Some(r#"{"name":"Nope"}"#),
        )
        .await;

        assert_eq!(status, StatusCode::FORBIDDEN);
        assert_eq!(
            body["error"],
            "System persona identity is managed by Master settings."
        );
    }

    #[tokio::test]
    async fn delete_removes_the_persona_and_reports_ownership() {
        let scratch = ScratchDir::new();
        let id = seed(&scratch, OWNER, "Alpha", false);
        let state = state_in(&scratch);

        let (status, _) = send(
            &state,
            Method::DELETE,
            &format!("/api/personas/{id}"),
            Some(OTHER),
            None,
        )
        .await;
        assert_eq!(status, StatusCode::NOT_FOUND);

        let (status, body) = send(
            &state,
            Method::DELETE,
            &format!("/api/personas/{id}"),
            Some(OWNER),
            None,
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        assert_keys(&body, &["ok"]);

        let (status, _) = send(
            &state,
            Method::GET,
            &format!("/api/personas/{id}"),
            Some(OWNER),
            None,
        )
        .await;
        assert_eq!(status, StatusCode::NOT_FOUND);
    }

    #[tokio::test]
    async fn delete_on_a_system_persona_is_forbidden() {
        let scratch = ScratchDir::new();
        let id = seed(&scratch, OWNER, "Master", true);
        let state = state_in(&scratch);

        let (status, body) = send(
            &state,
            Method::DELETE,
            &format!("/api/personas/{id}"),
            Some(OWNER),
            None,
        )
        .await;

        assert_eq!(status, StatusCode::FORBIDDEN);
        assert_eq!(body["error"], "System personas cannot be deleted.");
    }

    #[tokio::test]
    async fn delete_also_removes_the_personas_conversations() {
        let scratch = ScratchDir::new();
        let id = seed(&scratch, OWNER, "Alpha", false);
        let state = state_in(&scratch);
        let conversation = state
            .messages
            .lock()
            .await
            .get_or_create_conversation("WebChat", "chat-persona", Some("Notes"), Some(OWNER))
            .expect("conversation");
        state
            .messages
            .lock()
            .await
            .update_persona_id(&conversation.id, Some(id.as_str()), OWNER)
            .expect("bind persona");

        let (status, _) = send(
            &state,
            Method::DELETE,
            &format!("/api/personas/{id}"),
            Some(OWNER),
            None,
        )
        .await;
        assert_eq!(status, StatusCode::OK);

        let remaining = state
            .messages
            .lock()
            .await
            .get_conversation(&conversation.id, Some(OWNER))
            .expect("lookup");
        assert!(remaining.is_none(), "the persona's conversations are gone");
    }

    #[tokio::test]
    async fn post_defaults_emoji_and_vibe_and_rejects_missing_name() {
        let scratch = ScratchDir::new();
        let state = state_in(&scratch);

        let (status, body) = send(
            &state,
            Method::POST,
            "/api/personas",
            Some(OWNER),
            Some(r#"{"name":"NoDefaults"}"#),
        )
        .await;
        assert_eq!(status, StatusCode::CREATED);
        assert_eq!(body["persona"]["emoji"], "🤖");
        assert_eq!(body["persona"]["vibe"], "");

        for body_text in [r#"{}"#, r#"{"name":"   "}"#, r#"{"name":null}"#] {
            let (status, body) = send(
                &state,
                Method::POST,
                "/api/personas",
                Some(OWNER),
                Some(body_text),
            )
            .await;
            assert_eq!(status, StatusCode::BAD_REQUEST, "{body_text}");
            assert_eq!(body["error"], "name is required");
        }
    }

    #[tokio::test]
    async fn post_rejects_invalid_profile_and_memory_type() {
        let scratch = ScratchDir::new();
        let state = state_in(&scratch);

        let (status, body) = send(
            &state,
            Method::POST,
            "/api/personas",
            Some(OWNER),
            Some(r#"{"name":"A","modelHubProfileId":"bad id"}"#),
        )
        .await;
        assert_eq!(status, StatusCode::BAD_REQUEST);
        assert_eq!(
            body["error"],
            "modelHubProfileId must be a non-empty string (letters, numbers, \".\", \"_\" or \"-\")."
        );

        let (status, body) = send(
            &state,
            Method::POST,
            "/api/personas",
            Some(OWNER),
            Some(r#"{"name":"A","memoryPersonaType":"wizard"}"#),
        )
        .await;
        assert_eq!(status, StatusCode::BAD_REQUEST);
        assert_eq!(
            body["error"],
            "Invalid memoryPersonaType. Allowed: general, roleplay, builder, assistant"
        );
    }

    #[tokio::test]
    async fn post_with_malformed_json_is_an_internal_error() {
        let scratch = ScratchDir::new();
        let state = state_in(&scratch);

        let (status, body) = send(
            &state,
            Method::POST,
            "/api/personas",
            Some(OWNER),
            Some("{"),
        )
        .await;

        assert_eq!(status, StatusCode::INTERNAL_SERVER_ERROR);
        assert_keys(&body, &["error", "ok"]);
    }

    #[tokio::test]
    async fn post_with_a_taken_name_is_a_slug_conflict() {
        let scratch = ScratchDir::new();
        seed(&scratch, OWNER, "Alpha", false);
        let state = state_in(&scratch);

        let (status, body) = send(
            &state,
            Method::POST,
            "/api/personas",
            Some(OWNER),
            Some(r#"{"name":"Alpha"}"#),
        )
        .await;

        assert_eq!(status, StatusCode::CONFLICT);
        assert!(body["error"]
            .as_str()
            .expect("message")
            .contains("slug already exists"));
    }
}
