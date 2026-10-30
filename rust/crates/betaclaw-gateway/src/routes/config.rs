//! Gateway config routes.
//!
//! Port of `app/api/config/route.ts`. `GET` returns the config with secrets
//! redacted. `PUT` saves it against the revision the client last read, so a
//! concurrent session cannot overwrite a change silently. Error bodies keep the
//! TypeScript shape `{ ok: false, error, code }`; a stale revision also carries
//! `currentRevision`. Other methods are proxied, so Next.js still answers them.

use axum::body::Bytes;
use axum::extract::State;
use axum::http::{HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::get;
use axum::{Json, Router};
use betaclaw_core::gateway_config::{
    redact_gateway_config_secrets, to_gateway_config_display_path, GatewayConfigError,
};
use serde_json::{json, Value};

use crate::auth_gate::{unauthorized_response, user_id_from_headers};
use crate::proxy::proxy_to_upstream;
use crate::state::SharedState;

const INVALID_BODY: &str = "Invalid JSON body. Expected object.";

pub fn router() -> Router<SharedState> {
    Router::new().route(
        "/api/config",
        get(get_config).put(put_config).fallback(proxy_to_upstream),
    )
}

/// `GET /api/config`
async fn get_config(State(state): State<SharedState>, headers: HeaderMap) -> Response {
    let Some(user_id) = user_id_from_headers(&headers) else {
        return unauthorized_response();
    };
    // ponytail: sync file or SQLite I/O on the reactor. Move to spawn_blocking if reads get hot.
    match state.gateway_config.load() {
        Ok(loaded) => {
            tracing::info!(
                user_id = %user_id,
                source = loaded.source.as_str(),
                warnings = loaded.warnings.len(),
                revision = %loaded.revision,
                "gateway config loaded"
            );
            Json(json!({
                "ok": true,
                "config": redact_gateway_config_secrets(&loaded.config),
                "source": loaded.source.as_str(),
                "displayPath": to_gateway_config_display_path(&loaded.path),
                "warnings": loaded.warnings,
                "revision": loaded.revision,
            }))
            .into_response()
        }
        Err(error) => {
            let (status, body) = failure(&error, "Unable to load config.");
            tracing::warn!(user_id = %user_id, status = status.as_u16(), "gateway config load failed");
            (status, Json(body)).into_response()
        }
    }
}

/// `PUT /api/config`. Body: `{ config, revision }`.
async fn put_config(State(state): State<SharedState>, headers: HeaderMap, body: Bytes) -> Response {
    let Some(user_id) = user_id_from_headers(&headers) else {
        return unauthorized_response();
    };
    let fields = match serde_json::from_slice::<Value>(&body) {
        Ok(Value::Object(fields)) => fields,
        _ => return respond(StatusCode::BAD_REQUEST, validation(INVALID_BODY)),
    };
    let Some(config) = fields.get("config") else {
        return respond(StatusCode::BAD_REQUEST, validation("config is required."));
    };
    let revision = revision_text(fields.get("revision"));
    if revision.is_empty() {
        let body = json!({
            "ok": false,
            "error": "config.revision is required to prevent stale writes.",
            "code": "CONFIG_STALE_REVISION",
        });
        return respond(StatusCode::CONFLICT, body);
    }

    match state.gateway_config.save(config, &revision) {
        Ok(saved) => {
            tracing::info!(
                user_id = %user_id,
                source = saved.source.as_str(),
                warnings = saved.warnings.len(),
                revision = %saved.revision,
                "gateway config saved"
            );
            Json(json!({
                "ok": true,
                "config": redact_gateway_config_secrets(&saved.config),
                "source": saved.source.as_str(),
                "displayPath": to_gateway_config_display_path(&saved.path),
                "warnings": saved.warnings,
                "revision": saved.revision,
            }))
            .into_response()
        }
        Err(error) => {
            let (status, body) = failure(&error, "Unable to save config.");
            tracing::warn!(user_id = %user_id, status = status.as_u16(), "gateway config save failed");
            (status, Json(body)).into_response()
        }
    }
}

/// `String(body.revision || '').trim()`. Null, false, 0 and the empty array are
/// falsy in JavaScript and therefore mean "no revision". Other values are
/// stringified, which only matters for the message text: a non-matching value
/// yields the same 409 either way.
fn revision_text(value: Option<&Value>) -> String {
    match value {
        None | Some(Value::Null) | Some(Value::Bool(false)) => String::new(),
        Some(Value::Array(items)) if items.is_empty() => String::new(),
        Some(Value::Number(number)) if number.as_f64() == Some(0.0) => String::new(),
        Some(Value::String(text)) => text.trim().to_string(),
        Some(other) => other.to_string().trim().to_string(),
    }
}

/// Maps a store error to the status and body of `toSafeErrorPayload`.
fn failure(error: &GatewayConfigError, fallback: &str) -> (StatusCode, Value) {
    match error {
        GatewayConfigError::Conflict {
            current_revision, ..
        } => (
            StatusCode::CONFLICT,
            json!({
                "ok": false,
                "error": GatewayConfigError::CONFLICT_MESSAGE,
                "code": "CONFIG_STALE_REVISION",
                "currentRevision": current_revision,
            }),
        ),
        // `Json` is the Rust counterpart of the TypeScript SyntaxError, which
        // the route also answers with 400.
        GatewayConfigError::Validation(message) | GatewayConfigError::Json(message) => {
            (StatusCode::BAD_REQUEST, validation(message))
        }
        _ => (
            StatusCode::INTERNAL_SERVER_ERROR,
            json!({ "ok": false, "error": fallback, "code": "CONFIG_INTERNAL_ERROR" }),
        ),
    }
}

fn validation(message: &str) -> Value {
    json!({ "ok": false, "error": message, "code": "CONFIG_VALIDATION_ERROR" })
}

fn respond(status: StatusCode, body: Value) -> Response {
    (status, Json(body)).into_response()
}

#[cfg(test)]
mod tests {
    use axum::http::{Method, StatusCode};
    use betaclaw_core::gateway_config::ConfigBackend;
    use serde_json::{json, Value};

    use crate::routes::test_support::{assert_keys, send, state_in, state_with, ScratchDir};
    use crate::state::SharedState;

    const USER: &str = "user-1";
    const CONFLICT: &str = "Config was changed by another session. Reload and review your changes.";
    const PAYLOAD_KEYS: &[&str] = &[
        "config",
        "displayPath",
        "ok",
        "revision",
        "source",
        "warnings",
    ];
    const ERROR_KEYS: &[&str] = &["code", "error", "ok"];

    async fn load(state: &SharedState) -> Value {
        let (status, body) = send(state, Method::GET, "/api/config", Some(USER), None).await;
        assert_eq!(status, StatusCode::OK);
        body
    }

    #[tokio::test]
    async fn get_returns_defaults_with_redacted_secrets() {
        let scratch = ScratchDir::new();
        let state = state_in(&scratch);

        let body = load(&state).await;

        assert_keys(&body, PAYLOAD_KEYS);
        assert_eq!(body["ok"], true);
        assert_eq!(body["source"], "default");
        assert_eq!(
            body["config"]["channels"]["telegram"]["token"],
            "__REDACTED__"
        );
        assert_eq!(body["revision"].as_str().map(str::len), Some(16));
    }

    #[tokio::test]
    async fn get_without_user_header_is_unauthorized() {
        let scratch = ScratchDir::new();
        let state = state_in(&scratch);

        let (status, body) = send(&state, Method::GET, "/api/config", None, None).await;

        assert_eq!(status, StatusCode::UNAUTHORIZED);
        assert_keys(&body, &["error", "ok"]);
        assert_eq!(body["error"], "Unauthorized");
    }

    #[tokio::test]
    async fn put_rejects_bodies_that_are_not_objects() {
        let scratch = ScratchDir::new();
        let state = state_in(&scratch);

        for raw in ["{not json", "[]", "\"text\""] {
            let (status, body) =
                send(&state, Method::PUT, "/api/config", Some(USER), Some(raw)).await;
            assert_eq!(status, StatusCode::BAD_REQUEST, "{raw}");
            assert_keys(&body, ERROR_KEYS);
            assert_eq!(body["error"], "Invalid JSON body. Expected object.");
            assert_eq!(body["code"], "CONFIG_VALIDATION_ERROR");
        }
    }

    #[tokio::test]
    async fn put_requires_the_config_key() {
        let scratch = ScratchDir::new();
        let state = state_in(&scratch);

        let (status, body) = send(
            &state,
            Method::PUT,
            "/api/config",
            Some(USER),
            Some(r#"{"revision":"abc"}"#),
        )
        .await;

        assert_eq!(status, StatusCode::BAD_REQUEST);
        assert_keys(&body, ERROR_KEYS);
        assert_eq!(body["error"], "config is required.");
    }

    #[tokio::test]
    async fn put_without_revision_is_a_stale_write_conflict() {
        let scratch = ScratchDir::new();
        let state = state_in(&scratch);

        let (status, body) = send(
            &state,
            Method::PUT,
            "/api/config",
            Some(USER),
            Some(r#"{"config":{},"revision":"   "}"#),
        )
        .await;

        assert_eq!(status, StatusCode::CONFLICT);
        assert_keys(&body, ERROR_KEYS);
        assert_eq!(body["code"], "CONFIG_STALE_REVISION");
        assert_eq!(
            body["error"],
            "config.revision is required to prevent stale writes."
        );
    }

    #[tokio::test]
    async fn put_with_a_stale_revision_reports_the_current_one() {
        let scratch = ScratchDir::new();
        let state = state_in(&scratch);
        let current = load(&state).await;
        let payload = json!({ "config": current["config"], "revision": "0123456789abcdef" });

        let (status, body) = send(
            &state,
            Method::PUT,
            "/api/config",
            Some(USER),
            Some(&payload.to_string()),
        )
        .await;

        assert_eq!(status, StatusCode::CONFLICT);
        assert_keys(&body, &["code", "currentRevision", "error", "ok"]);
        assert_eq!(body["code"], "CONFIG_STALE_REVISION");
        assert_eq!(body["error"], CONFLICT);
        assert_eq!(body["currentRevision"], current["revision"]);
    }

    #[tokio::test]
    async fn put_with_an_invalid_value_is_a_validation_error() {
        let scratch = ScratchDir::new();
        let state = state_in(&scratch);
        let mut current = load(&state).await;
        current["config"]["gateway"]["logLevel"] = json!("verbose");
        let payload = json!({ "config": current["config"], "revision": current["revision"] });

        let (status, body) = send(
            &state,
            Method::PUT,
            "/api/config",
            Some(USER),
            Some(&payload.to_string()),
        )
        .await;

        assert_eq!(status, StatusCode::BAD_REQUEST);
        assert_keys(&body, ERROR_KEYS);
        assert_eq!(body["code"], "CONFIG_VALIDATION_ERROR");
    }

    #[tokio::test]
    async fn put_round_trip_saves_under_the_read_revision() {
        let scratch = ScratchDir::new();
        let state = state_in(&scratch);
        let read = load(&state).await;
        let mut edited = read["config"].clone();
        edited["gateway"]["logLevel"] = json!("warn");
        let payload = json!({ "config": edited, "revision": read["revision"] });

        let (status, saved) = send(
            &state,
            Method::PUT,
            "/api/config",
            Some(USER),
            Some(&payload.to_string()),
        )
        .await;

        assert_eq!(status, StatusCode::OK);
        assert_keys(&saved, PAYLOAD_KEYS);
        assert_eq!(saved["source"], "db");
        assert_ne!(saved["revision"], read["revision"]);
        assert_eq!(
            saved["config"]["channels"]["telegram"]["token"],
            "__REDACTED__"
        );

        let reloaded = load(&state).await;
        assert_eq!(reloaded["config"]["gateway"]["logLevel"], "warn");
        assert_eq!(reloaded["revision"], saved["revision"]);
    }

    #[tokio::test]
    async fn file_backend_reads_and_writes_the_config_file_not_the_database() {
        let scratch = ScratchDir::new();
        let file = scratch.path_string("betaclaw.json");
        let state = state_with(&scratch, |config| {
            config.gateway_config_backend = ConfigBackend::File;
            config.gateway_config_path = file.clone();
        });
        let read = load(&state).await;
        assert_eq!(read["source"], "default");

        let mut edited = read["config"].clone();
        edited["gateway"]["logLevel"] = json!("warn");
        let payload = json!({ "config": edited, "revision": read["revision"] });
        let (status, saved) = send(
            &state,
            Method::PUT,
            "/api/config",
            Some(USER),
            Some(&payload.to_string()),
        )
        .await;

        assert_eq!(status, StatusCode::OK);
        assert_eq!(saved["source"], "file");
        let reloaded = load(&state).await;
        assert_eq!(reloaded["source"], "file");
        assert_eq!(reloaded["config"]["gateway"]["logLevel"], "warn");
        assert!(std::path::Path::new(&file).exists());
        assert!(
            !std::path::Path::new(&scratch.path_string("gateway-config.db")).exists(),
            "the file backend must not create or touch the database"
        );
    }

    #[tokio::test]
    async fn other_methods_fall_through_to_the_proxy() {
        let scratch = ScratchDir::new();
        let state = state_in(&scratch);

        let (status, _) = send(&state, Method::POST, "/api/config", Some(USER), Some("{}")).await;

        assert_eq!(status, StatusCode::BAD_GATEWAY);
    }
}
