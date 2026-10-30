//! Port of `app/api/files/preview/route.ts` (GET) and `app/api/files/reveal/route.ts`
//! (POST). The path check is `resolveAllowedExistingPath` (`fileAccess.ts`), ported in
//! core: the file must exist and its real location must sit under `WORKSPACE_BASE_PATH`
//! or `PROJECTS_PATH`. Both routes answer `{ error }` without an `ok` key, as the
//! TypeScript routes do.

use std::ffi::OsString;
use std::fs;
use std::path::Path;

use axum::body::Bytes;
use axum::http::{HeaderMap, StatusCode, Uri};
use axum::response::{IntoResponse, Response};
use axum::Json;
use betaclaw_core::security::file_access::resolve_allowed_existing_path;
use serde_json::{json, Value};

use super::{plain_error, query_param};
use crate::auth_gate::{unauthorized_response, user_id_from_headers};

/// `MAX_PREVIEW_BYTES` in `preview/route.ts`.
const MAX_PREVIEW_BYTES: u64 = 2 * 1024 * 1024;

/// The headers of the preview response, `preview/route.ts:41-47`. The content is
/// sandboxed, so an HTML file cannot run scripts or load remote resources.
const PREVIEW_HEADERS: [(&str, &str); 6] = [
    ("content-type", "text/html; charset=utf-8"),
    ("x-content-type-options", "nosniff"),
    (
        "content-security-policy",
        "sandbox; default-src 'none'; img-src data: blob: https:; style-src 'unsafe-inline'",
    ),
    ("x-frame-options", "DENY"),
    ("content-disposition", "inline"),
    ("cache-control", "no-store"),
];

/// `GET /api/files/preview?path=`: serves one HTML file inside the allowed roots.
pub(super) async fn preview(headers: HeaderMap, uri: Uri) -> Response {
    if user_id_from_headers(&headers).is_none() {
        return unauthorized_response();
    }
    let Some(path) = query_param(&uri, "path").filter(|path| !path.is_empty()) else {
        return plain_error(StatusCode::BAD_REQUEST, "path is required");
    };
    let lowered = path.to_lowercase();
    if !lowered.ends_with(".html") && !lowered.ends_with(".htm") {
        return plain_error(StatusCode::BAD_REQUEST, "Only HTML files can be previewed");
    }
    let resolved = match resolve_allowed_existing_path(&path) {
        Ok(resolved) => resolved,
        Err(rejected) => {
            let status =
                StatusCode::from_u16(rejected.status).unwrap_or(StatusCode::INTERNAL_SERVER_ERROR);
            return plain_error(status, rejected.error);
        }
    };
    let size = match fs::metadata(&resolved) {
        Ok(metadata) => metadata.len(),
        Err(_) => return plain_error(StatusCode::INTERNAL_SERVER_ERROR, "Failed to read file"),
    };
    if size > MAX_PREVIEW_BYTES {
        return plain_error(StatusCode::PAYLOAD_TOO_LARGE, "Preview file is too large.");
    }
    match fs::read(&resolved) {
        // Node's utf-8 decoding replaces invalid sequences, as `from_utf8_lossy` does.
        Ok(bytes) => (
            StatusCode::OK,
            PREVIEW_HEADERS,
            String::from_utf8_lossy(&bytes).into_owned(),
        )
            .into_response(),
        Err(_) => plain_error(StatusCode::INTERNAL_SERVER_ERROR, "Failed to read file"),
    }
}

/// `POST /api/files/reveal`. Body: `{ filePath }`. Opens the file's folder in the
/// system file manager.
pub(super) async fn reveal(headers: HeaderMap, body: Bytes) -> Response {
    if user_id_from_headers(&headers).is_none() {
        return unauthorized_response();
    }
    // `request.json().catch(() => null)`: a body that does not parse names no path.
    let file_path = serde_json::from_slice::<Value>(&body)
        .ok()
        .and_then(|body| {
            body.get("filePath")
                .and_then(Value::as_str)
                .map(str::to_string)
        })
        .unwrap_or_default();
    if file_path.is_empty() {
        return plain_error(StatusCode::BAD_REQUEST, "filePath is required");
    }
    let resolved = match resolve_allowed_existing_path(&file_path) {
        Ok(resolved) => resolved,
        Err(rejected) => {
            let status =
                StatusCode::from_u16(rejected.status).unwrap_or(StatusCode::INTERNAL_SERVER_ERROR);
            return plain_error(status, rejected.error);
        }
    };
    match reveal_in_file_manager(&resolved).await {
        Ok(true) => Json(json!({
            "success": true,
            "path": resolved.to_string_lossy(),
        }))
        .into_response(),
        // A non-zero exit is a failure here, as `execFileAsync` rejects it. explorer.exe
        // can exit non-zero even after it opened the folder, so this may report a
        // failure for a folder that did open.
        Ok(false) | Err(_) => {
            plain_error(StatusCode::INTERNAL_SERVER_ERROR, "Failed to reveal file")
        }
    }
}

/// The platform launcher of `reveal/route.ts`: `open -R` on macOS, `explorer.exe
/// /select,` on Windows, `xdg-open` on the folder elsewhere. The arguments are passed
/// as an argument vector, never through a shell.
async fn reveal_in_file_manager(path: &Path) -> std::io::Result<bool> {
    let (program, args): (&str, Vec<OsString>) = if cfg!(target_os = "macos") {
        ("open", vec!["-R".into(), path.into()])
    } else if cfg!(windows) {
        (
            "explorer.exe",
            vec![format!("/select,{}", path.display()).into()],
        )
    } else {
        ("xdg-open", vec![path.parent().unwrap_or(path).into()])
    };
    let output = tokio::process::Command::new(program)
        .args(&args)
        .output()
        .await?;
    Ok(output.status.success())
}

#[cfg(test)]
mod tests {
    use axum::http::{Method, StatusCode};

    use crate::families::skills_wire::test_support::{
        assert_keys, harness, preview_uri, send, write_file, OWNER,
    };

    #[tokio::test]
    async fn requests_are_refused_without_identity_or_valid_input() {
        let h = harness();
        let reply = send(
            &h,
            Method::GET,
            "/api/files/preview?path=%2Ftmp%2Fa.html",
            None,
            None,
        )
        .await;
        assert_eq!(reply.status, StatusCode::UNAUTHORIZED);
        assert_keys(&reply.json(), &["error", "ok"]);

        let cases = [
            (Method::GET, "/api/files/preview", None, "path is required"),
            (
                Method::GET,
                "/api/files/preview?path=",
                None,
                "path is required",
            ),
            (
                Method::GET,
                "/api/files/preview?path=%2Fetc%2Fpasswd",
                None,
                "Only HTML files can be previewed",
            ),
            (
                Method::POST,
                "/api/files/reveal",
                Some("{}"),
                "filePath is required",
            ),
            (
                Method::POST,
                "/api/files/reveal",
                Some("not json"),
                "filePath is required",
            ),
            (
                Method::POST,
                "/api/files/reveal",
                Some(r#"{"filePath":5}"#),
                "filePath is required",
            ),
        ];
        for (method, uri, body, message) in cases {
            let reply = send(&h, method, uri, Some(OWNER), body).await;
            assert_eq!(reply.status, StatusCode::BAD_REQUEST, "{uri}");
            assert_keys(&reply.json(), &["error"]);
            assert_eq!(reply.json()["error"], message, "{uri}");
        }
    }

    /// Changes `WORKSPACE_BASE_PATH`, so every root-dependent case lives in this one
    /// test. Only the root check decides these answers, not the file contents.
    #[tokio::test]
    async fn preview_and_reveal_stay_inside_the_configured_roots() {
        let h = harness();
        let root = h.scratch.path().join("root");
        let outside = h.scratch.path().join("outside");
        write_file(&root.join("page.html"), "<h1>hi</h1>");
        write_file(&outside.join("secret.html"), "<p>no</p>");
        write_file(&root.join("big.html"), &"x".repeat(2 * 1024 * 1024 + 1));
        #[cfg(unix)]
        std::os::unix::fs::symlink(&outside, root.join("link")).expect("symlink");
        let inside = root.join("page.html").to_string_lossy().into_owned();
        let secret = outside.join("secret.html").to_string_lossy().into_owned();
        let missing = root.join("nope.html").to_string_lossy().into_owned();
        let big = root.join("big.html").to_string_lossy().into_owned();

        std::env::remove_var("PROJECTS_PATH");
        std::env::remove_var("WORKSPACE_BASE_PATH");
        let reply = send(&h, Method::GET, &preview_uri(&inside), Some(OWNER), None).await;
        assert_eq!(reply.status, StatusCode::INTERNAL_SERVER_ERROR);
        assert_eq!(
            reply.json()["error"],
            "Allowed file roots are not configured"
        );

        std::env::set_var("WORKSPACE_BASE_PATH", &root);
        let reply = send(&h, Method::GET, &preview_uri(&inside), Some(OWNER), None).await;
        assert_eq!(reply.status, StatusCode::OK);
        assert_eq!(
            reply.headers["content-type"].to_str().expect("ascii"),
            "text/html; charset=utf-8"
        );
        assert!(reply.headers["content-security-policy"]
            .to_str()
            .expect("ascii")
            .starts_with("sandbox"));
        assert_eq!(reply.text, "<h1>hi</h1>");

        let reply = send(&h, Method::GET, &preview_uri(&secret), Some(OWNER), None).await;
        assert_eq!(reply.status, StatusCode::FORBIDDEN);
        assert_eq!(reply.json()["error"], "Path not allowed");

        let reply = send(&h, Method::GET, &preview_uri(&missing), Some(OWNER), None).await;
        assert_eq!(reply.status, StatusCode::NOT_FOUND);
        assert_eq!(reply.json()["error"], "File or directory not found");

        let reply = send(&h, Method::GET, &preview_uri(&big), Some(OWNER), None).await;
        assert_eq!(reply.status, StatusCode::PAYLOAD_TOO_LARGE);
        assert_eq!(reply.json()["error"], "Preview file is too large.");

        #[cfg(unix)]
        {
            let through_link = root
                .join("link")
                .join("secret.html")
                .to_string_lossy()
                .into_owned();
            let reply = send(
                &h,
                Method::GET,
                &preview_uri(&through_link),
                Some(OWNER),
                None,
            )
            .await;
            assert_eq!(
                reply.status,
                StatusCode::FORBIDDEN,
                "a symlink out of the root"
            );
        }

        let body = serde_json::json!({ "filePath": secret }).to_string();
        let reply = send(
            &h,
            Method::POST,
            "/api/files/reveal",
            Some(OWNER),
            Some(body.as_str()),
        )
        .await;
        assert_eq!(reply.status, StatusCode::FORBIDDEN);
        assert_eq!(reply.json()["error"], "Path not allowed");

        std::env::remove_var("WORKSPACE_BASE_PATH");
    }
}
