//! Port of `app/api/clawhub/**`: `install/route.ts` (POST), `update/route.ts` (POST),
//! `installed/route.ts` (GET), `prompt/route.ts` (GET), `search/route.ts` (GET) and
//! `[slug]/route.ts` (PATCH enable, DELETE uninstall). The service is
//! `clawhubService.ts`, ported in core, and runs the `clawhub` CLI.
//!
//! Install and update need `EXTERNAL_SKILLS_ENABLED=true`, read per request as
//! `areExternalSkillsEnabled()` does. Service errors map through
//! `toClawHubHttpStatus`: 400 for input, 404 for an unknown skill, 500 otherwise.

use std::sync::Arc;

use axum::body::Bytes;
use axum::extract::{Extension, Path};
use axum::http::{HeaderMap, StatusCode, Uri};
use axum::response::{IntoResponse, Response};
use axum::Json;
use betaclaw_core::clawhub::errors::{is_valid_slug, ClawHubError};
use betaclaw_core::clawhub::service::{InstallInput, UpdateInput};
use betaclaw_core::skills::types::js_trim;
use betaclaw_core::stats::util::{js_parse_int, js_truthy};
use serde_json::{json, Value};

use super::{error_response, query_param, Services};
use crate::auth_gate::{unauthorized_response, user_id_from_headers};

/// `POST /api/clawhub/install`. Body: `{ slug, version?, force? }`.
pub(super) async fn install(
    Extension(services): Extension<Arc<Services>>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    if user_id_from_headers(&headers).is_none() {
        return unauthorized_response();
    }
    if !external_skills_enabled() {
        return error_response(
            StatusCode::FORBIDDEN,
            "External skill installation is disabled.",
        );
    }
    let body = match parse_body(&body) {
        Ok(body) => body,
        Err(message) => return error_response(StatusCode::INTERNAL_SERVER_ERROR, &message),
    };
    let slug = match slug_field(&body) {
        Ok(slug) => slug,
        Err(message) => return error_response(StatusCode::INTERNAL_SERVER_ERROR, &message),
    };
    if slug.is_empty() {
        return error_response(
            StatusCode::BAD_REQUEST,
            "Install requires non-empty \"slug\".",
        );
    }
    if !is_valid_slug(&slug) {
        return error_response(
            StatusCode::BAD_REQUEST,
            &format!("Invalid ClawHub skill slug: {slug}"),
        );
    }
    let input = InstallInput {
        slug,
        version: string_field(&body, "version"),
        force: js_truthy(body.get("force")),
    };
    match services.clawhub.install(&input).await {
        Ok(skills) => Json(json!({ "ok": true, "skills": skills, "warnings": [] })).into_response(),
        Err(error) => clawhub_error(&error),
    }
}

/// `POST /api/clawhub/update`. Body: `{ slug?, all?, version?, force? }`.
pub(super) async fn update(
    Extension(services): Extension<Arc<Services>>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    if user_id_from_headers(&headers).is_none() {
        return unauthorized_response();
    }
    if !external_skills_enabled() {
        return error_response(
            StatusCode::FORBIDDEN,
            "External skill updates are disabled.",
        );
    }
    let body = match parse_body(&body) {
        Ok(body) => body,
        Err(message) => return error_response(StatusCode::INTERNAL_SERVER_ERROR, &message),
    };
    let slug = match slug_field(&body) {
        Ok(slug) => slug,
        Err(message) => return error_response(StatusCode::INTERNAL_SERVER_ERROR, &message),
    };
    let all = js_truthy(body.get("all"));
    if !all && slug.is_empty() {
        return error_response(
            StatusCode::BAD_REQUEST,
            "Update requires either \"slug\" or \"all=true\".",
        );
    }
    if !all && !is_valid_slug(&slug) {
        return error_response(
            StatusCode::BAD_REQUEST,
            &format!("Invalid ClawHub skill slug: {slug}"),
        );
    }
    let version = string_field(&body, "version");
    if all
        && version
            .as_deref()
            .is_some_and(|text| !text.trim().is_empty())
    {
        return error_response(
            StatusCode::BAD_REQUEST,
            "Update with \"all=true\" cannot specify \"version\".",
        );
    }
    let input = UpdateInput {
        slug: (!slug.is_empty()).then_some(slug),
        all,
        version,
        force: js_truthy(body.get("force")),
    };
    match services.clawhub.update(&input).await {
        Ok(skills) => Json(json!({ "ok": true, "skills": skills, "warnings": [] })).into_response(),
        Err(error) => clawhub_error(&error),
    }
}

/// `GET /api/clawhub/installed`: re-reads the lockfile into the table first.
pub(super) async fn installed(
    Extension(services): Extension<Arc<Services>>,
    headers: HeaderMap,
) -> Response {
    if user_id_from_headers(&headers).is_none() {
        return unauthorized_response();
    }
    match services.clawhub.sync_installed_from_lockfile() {
        Ok(skills) => Json(json!({ "ok": true, "skills": skills })).into_response(),
        Err(error) => error_response(StatusCode::INTERNAL_SERVER_ERROR, &error.to_string()),
    }
}

/// `GET /api/clawhub/prompt`
pub(super) async fn prompt(
    Extension(services): Extension<Arc<Services>>,
    headers: HeaderMap,
) -> Response {
    if user_id_from_headers(&headers).is_none() {
        return unauthorized_response();
    }
    match services.clawhub.prompt_block() {
        Ok(prompt) => Json(json!({ "ok": true, "prompt": prompt })).into_response(),
        Err(error) => error_response(StatusCode::INTERNAL_SERVER_ERROR, &error.to_string()),
    }
}

/// `GET /api/clawhub/search?q=&limit=`. `limit` follows `parseInt` and defaults to 25;
/// the service clamps it to 1 through 200. Any service failure is a 500 here.
pub(super) async fn search(
    Extension(services): Extension<Arc<Services>>,
    headers: HeaderMap,
    uri: Uri,
) -> Response {
    if user_id_from_headers(&headers).is_none() {
        return unauthorized_response();
    }
    let query = js_trim(&query_param(&uri, "q").unwrap_or_default()).to_string();
    if query.is_empty() {
        return error_response(StatusCode::BAD_REQUEST, "Missing query parameter \"q\".");
    }
    let limit = query_param(&uri, "limit")
        .and_then(|raw| js_parse_int(&raw))
        .unwrap_or(25);
    match services.clawhub.search(&query, limit).await {
        Ok(result) => Json(json!({
            "ok": true,
            "items": result.items,
            "parseWarnings": result.parse_warnings,
            "source": "search-text",
        }))
        .into_response(),
        Err(error) => error_response(StatusCode::INTERNAL_SERVER_ERROR, &error.to_string()),
    }
}

/// `PATCH /api/clawhub/{slug}`. Body: `{ enabled: boolean }`. The slug is checked
/// before the body is read, as in TypeScript.
pub(super) async fn set_enabled(
    Extension(services): Extension<Arc<Services>>,
    headers: HeaderMap,
    Path(slug): Path<String>,
    body: Bytes,
) -> Response {
    if user_id_from_headers(&headers).is_none() {
        return unauthorized_response();
    }
    let slug = match path_slug(&slug) {
        Ok(slug) => slug,
        Err(message) => return error_response(StatusCode::BAD_REQUEST, &message),
    };
    let body = match parse_body(&body) {
        Ok(body) => body,
        Err(message) => return error_response(StatusCode::INTERNAL_SERVER_ERROR, &message),
    };
    if body.is_null() {
        return error_response(
            StatusCode::INTERNAL_SERVER_ERROR,
            "Cannot read properties of null (reading 'enabled')",
        );
    }
    let Some(&Value::Bool(enabled)) = body.get("enabled") else {
        return error_response(
            StatusCode::BAD_REQUEST,
            "PATCH requires boolean \"enabled\" in request body.",
        );
    };
    match services.clawhub.set_enabled(&slug, enabled) {
        Ok(skill) => Json(json!({ "ok": true, "skill": skill })).into_response(),
        Err(error) => clawhub_error(&error),
    }
}

/// `DELETE /api/clawhub/{slug}`: removes the lock entry, the folder and the row.
pub(super) async fn uninstall(
    Extension(services): Extension<Arc<Services>>,
    headers: HeaderMap,
    Path(slug): Path<String>,
) -> Response {
    if user_id_from_headers(&headers).is_none() {
        return unauthorized_response();
    }
    let slug = match path_slug(&slug) {
        Ok(slug) => slug,
        Err(message) => return error_response(StatusCode::BAD_REQUEST, &message),
    };
    match services.clawhub.uninstall(&slug) {
        Ok(skills) => Json(json!({ "ok": true, "skills": skills, "warnings": [] })).into_response(),
        Err(error) => clawhub_error(&error),
    }
}

/// `areExternalSkillsEnabled()`: `EXTERNAL_SKILLS_ENABLED` must be exactly `true`.
fn external_skills_enabled() -> bool {
    std::env::var("EXTERNAL_SKILLS_ENABLED").is_ok_and(|value| value == "true")
}

/// The JSON body. A body that does not parse is a 500 in these routes, as in TypeScript.
/// The error text is serde's, which differs from V8's wording.
fn parse_body(bytes: &[u8]) -> Result<Value, String> {
    serde_json::from_slice(bytes).map_err(|error| error.to_string())
}

/// `(body.slug || '').trim()`. A null body throws in TypeScript, and so does a
/// non-string value, which the caller reports as a 500.
fn slug_field(body: &Value) -> Result<String, String> {
    if body.is_null() {
        return Err("Cannot read properties of null (reading 'slug')".to_string());
    }
    match body.get("slug") {
        None | Some(Value::Null | Value::Bool(false)) => Ok(String::new()),
        Some(Value::String(text)) => Ok(text.trim().to_string()),
        Some(_) => Err("(body.slug || '').trim is not a function".to_string()),
    }
}

/// `typeof body.<key> === 'string' ? body.<key> : undefined`.
fn string_field(body: &Value, key: &str) -> Option<String> {
    match body.get(key) {
        Some(Value::String(text)) => Some(text.clone()),
        _ => None,
    }
}

/// The `[slug]` route check: trimmed, not empty, and a valid slug.
fn path_slug(raw: &str) -> Result<String, String> {
    let slug = raw.trim();
    if slug.is_empty() {
        return Err("Skill slug is required.".to_string());
    }
    if !is_valid_slug(slug) {
        return Err(format!("Invalid ClawHub skill slug: {slug}"));
    }
    Ok(slug.to_string())
}

/// `toClawHubHttpStatus` for the typed errors, with the service message.
fn clawhub_error(error: &ClawHubError) -> Response {
    let status =
        StatusCode::from_u16(error.http_status()).unwrap_or(StatusCode::INTERNAL_SERVER_ERROR);
    error_response(status, &error.to_string())
}

#[cfg(test)]
mod tests {
    use std::path::Path;

    use axum::http::{Method, StatusCode};
    use serde_json::json;

    use crate::families::skills_wire::test_support::{
        assert_keys, harness, send, write_file, OWNER,
    };

    /// A lockfile with one installed skill, `weather`, and its folder title.
    fn seed_weather(root: &Path) {
        write_file(
            &root.join(".clawhub").join("lock.json"),
            r#"{"version":1,"skills":{"weather":{"version":"2.0.0","installedAt":1700000000000}}}"#,
        );
        write_file(
            &root.join("skills").join("weather").join("_meta.json"),
            r#"{"title":"Weather"}"#,
        );
    }

    #[tokio::test]
    async fn installed_mirrors_the_lockfile() {
        let h = harness();
        seed_weather(&h.scratch.path());

        let reply = send(&h, Method::GET, "/api/clawhub/installed", Some(OWNER), None).await;

        assert_eq!(reply.status, StatusCode::OK);
        let body = reply.json();
        assert_keys(&body, &["ok", "skills"]);
        let skill = &body["skills"][0];
        assert_keys(
            skill,
            &[
                "enabled",
                "installedAt",
                "lastActionAt",
                "lastError",
                "localPath",
                "slug",
                "status",
                "title",
                "updatedAt",
                "version",
            ],
        );
        assert_eq!(skill["slug"], "weather");
        assert_eq!(skill["title"], "Weather");
        assert_eq!(skill["status"], "installed");
        assert_eq!(skill["installedAt"], "2023-11-14T22:13:20.000Z");
        assert_eq!(skill["localPath"], "skills/weather");
    }

    #[tokio::test]
    async fn enable_and_uninstall_act_on_the_synced_skill() {
        let h = harness();
        seed_weather(&h.scratch.path());
        send(&h, Method::GET, "/api/clawhub/installed", Some(OWNER), None).await;

        let reply = send(
            &h,
            Method::PATCH,
            "/api/clawhub/weather",
            Some(OWNER),
            Some(r#"{"enabled":true}"#),
        )
        .await;
        assert_eq!(reply.status, StatusCode::OK);
        assert_eq!(reply.json()["skill"]["enabled"].as_bool(), Some(true));

        let reply = send(
            &h,
            Method::DELETE,
            "/api/clawhub/weather",
            Some(OWNER),
            None,
        )
        .await;
        assert_eq!(reply.status, StatusCode::OK);
        assert_keys(&reply.json(), &["ok", "skills", "warnings"]);
        assert_eq!(reply.json()["skills"], json!([]));
        assert!(!h.scratch.path().join("skills").join("weather").exists());

        let reply = send(
            &h,
            Method::DELETE,
            "/api/clawhub/weather",
            Some(OWNER),
            None,
        )
        .await;
        assert_eq!(reply.status, StatusCode::NOT_FOUND);
        assert_eq!(reply.json()["error"], "ClawHub skill not found: weather");
    }

    #[tokio::test]
    async fn slug_routes_check_the_slug_and_the_enabled_flag() {
        let h = harness();

        let reply = send(
            &h,
            Method::PATCH,
            "/api/clawhub/-leading",
            Some(OWNER),
            Some(r#"{"enabled":true}"#),
        )
        .await;
        assert_eq!(reply.status, StatusCode::BAD_REQUEST);
        assert_eq!(
            reply.json()["error"],
            "Invalid ClawHub skill slug: -leading"
        );

        let reply = send(
            &h,
            Method::PATCH,
            "/api/clawhub/weather",
            Some(OWNER),
            Some(r#"{"enabled":"yes"}"#),
        )
        .await;
        assert_eq!(reply.status, StatusCode::BAD_REQUEST);
        assert_eq!(
            reply.json()["error"],
            "PATCH requires boolean \"enabled\" in request body."
        );

        let reply = send(
            &h,
            Method::PATCH,
            "/api/clawhub/weather",
            Some(OWNER),
            Some(r#"{"enabled":true}"#),
        )
        .await;
        assert_eq!(reply.status, StatusCode::NOT_FOUND);
        assert_eq!(reply.json()["error"], "ClawHub skill not found: weather");
    }

    /// Changes `EXTERNAL_SKILLS_ENABLED`, so every case lives in this one test. The
    /// cases stop before the CLI: none reaches a valid slug with the gate open.
    #[tokio::test]
    async fn install_and_update_check_the_flag_and_the_input_before_the_cli_runs() {
        let h = harness();
        std::env::remove_var("EXTERNAL_SKILLS_ENABLED");
        let reply = send(
            &h,
            Method::POST,
            "/api/clawhub/install",
            Some(OWNER),
            Some(r#"{"slug":"weather"}"#),
        )
        .await;
        assert_eq!(reply.status, StatusCode::FORBIDDEN);
        assert_eq!(
            reply.json()["error"],
            "External skill installation is disabled."
        );
        let reply = send(
            &h,
            Method::POST,
            "/api/clawhub/update",
            Some(OWNER),
            Some(r#"{"slug":"weather"}"#),
        )
        .await;
        assert_eq!(reply.status, StatusCode::FORBIDDEN);
        assert_eq!(
            reply.json()["error"],
            "External skill updates are disabled."
        );

        std::env::set_var("EXTERNAL_SKILLS_ENABLED", "true");
        let cases = [
            (
                "/api/clawhub/install",
                r#"{"slug":"  "}"#,
                StatusCode::BAD_REQUEST,
                "Install requires non-empty \"slug\".",
            ),
            (
                "/api/clawhub/install",
                r#"{"slug":"bad/slug"}"#,
                StatusCode::BAD_REQUEST,
                "Invalid ClawHub skill slug: bad/slug",
            ),
            (
                "/api/clawhub/install",
                r#"{"slug":5}"#,
                StatusCode::INTERNAL_SERVER_ERROR,
                "(body.slug || '').trim is not a function",
            ),
            (
                "/api/clawhub/update",
                "{}",
                StatusCode::BAD_REQUEST,
                "Update requires either \"slug\" or \"all=true\".",
            ),
            (
                "/api/clawhub/update",
                r#"{"all":true,"version":"1.0.0"}"#,
                StatusCode::BAD_REQUEST,
                "Update with \"all=true\" cannot specify \"version\".",
            ),
            (
                "/api/clawhub/update",
                r#"{"slug":"bad/slug"}"#,
                StatusCode::BAD_REQUEST,
                "Invalid ClawHub skill slug: bad/slug",
            ),
        ];
        for (uri, body, status, message) in cases {
            let reply = send(&h, Method::POST, uri, Some(OWNER), Some(body)).await;
            assert_eq!(reply.status, status, "{body}");
            assert_eq!(reply.json()["error"], message, "{body}");
        }
        std::env::remove_var("EXTERNAL_SKILLS_ENABLED");
    }

    #[tokio::test]
    async fn search_needs_a_query_and_the_prompt_builds_without_skills() {
        let h = harness();
        for uri in ["/api/clawhub/search", "/api/clawhub/search?q=%20%20"] {
            let reply = send(&h, Method::GET, uri, Some(OWNER), None).await;
            assert_eq!(reply.status, StatusCode::BAD_REQUEST, "{uri}");
            assert_eq!(reply.json()["error"], "Missing query parameter \"q\".");
        }

        let reply = send(&h, Method::GET, "/api/clawhub/prompt", Some(OWNER), None).await;

        assert_eq!(reply.status, StatusCode::OK);
        assert_keys(&reply.json(), &["ok", "prompt"]);
        assert!(reply.json()["prompt"].is_string());
        let reply = send(&h, Method::GET, "/api/clawhub/installed", None, None).await;
        assert_eq!(reply.status, StatusCode::UNAUTHORIZED);
    }
}
