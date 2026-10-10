//! Persona read routes and persona file read/write.
//!
//! Port of `app/api/personas/route.ts` (GET), `app/api/personas/[id]/route.ts`
//! (GET) and `app/api/personas/[id]/files/[filename]/route.ts` (GET, PUT).
//! Create, update and delete stay in TypeScript because they need the model hub
//! to validate `preferredModelId`. The templates list is deferred with them by
//! the slice plan. All of these are proxied, see `router()`.

use axum::body::Bytes;
use axum::extract::{Path, State};
use axum::http::{HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::{any, get};
use axum::{Json, Router};
use betaclaw_core::personas::repository::{PersonaRepository, PersonaRepositoryError};
use betaclaw_core::personas::types::{
    PersonaFileName, PersonaProfile, PersonaWithFiles, PERSONA_FILE_NAMES,
};
use serde_json::{json, Map, Value};

use crate::auth_gate::{unauthorized_response, user_id_from_headers};
use crate::proxy::proxy_to_upstream;
use crate::state::SharedState;

pub fn router() -> Router<SharedState> {
    Router::new()
        // A static segment beats `{id}` in matchit, so the TypeScript templates
        // route keeps its path instead of being answered as "Not found".
        .route("/api/personas/templates", any(proxy_to_upstream))
        .route(
            "/api/personas",
            get(list_personas).fallback(proxy_to_upstream),
        )
        .route(
            "/api/personas/{id}",
            get(get_persona).fallback(proxy_to_upstream),
        )
        .route(
            "/api/personas/{id}/files/{filename}",
            get(get_file).put(put_file).fallback(proxy_to_upstream),
        )
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
        let cases: [(Method, &str, Option<&str>); 4] = [
            (Method::PUT, "/api/personas/abc", Some("{}")),
            (Method::DELETE, "/api/personas/abc", None),
            (Method::POST, "/api/personas", Some("{}")),
            (Method::GET, "/api/personas/templates", None),
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
}
