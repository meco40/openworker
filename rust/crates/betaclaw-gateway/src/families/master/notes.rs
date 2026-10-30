//! Port of `app/api/master/notes/route.ts` (GET, POST, PATCH, DELETE) over
//! `src/server/master/repository/notes.store.ts` through the repository facade.

use std::sync::Arc;

use axum::body::Bytes;
use axum::extract::Extension;
use axum::http::{HeaderMap, StatusCode, Uri};
use axum::response::IntoResponse;
use axum::Json;
use betaclaw_core::master::notes::DEFAULT_NOTE_LIMIT;
use betaclaw_core::master::repository::notes_store::{MasterNoteInput, NotePatch};
use serde_json::json;

use super::support::{
    bad_request, filled_field, json_body, query_of, scope_body, string_field, string_list,
    user_or_401, ApiError, Reply,
};
use super::Services;

/// `GET /api/master/notes` (`notes/route.ts:18-31`).
pub(super) async fn list(
    Extension(services): Extension<Arc<Services>>,
    headers: HeaderMap,
    uri: Uri,
) -> Reply {
    let user = user_or_401(&headers)?;
    let repos = services.repos().await;
    let scope = repos.scope(&query_of(&uri), &user, None)?;
    let notes = repos
        .master
        .list_notes(&scope, DEFAULT_NOTE_LIMIT)
        .map_err(bad_request)?;
    Ok(Json(json!({ "ok": true, "notes": notes })).into_response())
}

/// `POST /api/master/notes` (`notes/route.ts:33-57`). Answers `201`.
pub(super) async fn create(
    Extension(services): Extension<Arc<Services>>,
    headers: HeaderMap,
    uri: Uri,
    body: Bytes,
) -> Reply {
    let user = user_or_401(&headers)?;
    let body = json_body(&body)?;
    let (Some(title), Some(content)) =
        (filled_field(&body, "title"), filled_field(&body, "content"))
    else {
        return Err(ApiError::new(
            StatusCode::BAD_REQUEST,
            "title and content are required",
        ));
    };
    let repos = services.repos().await;
    let scope = repos.scope(&query_of(&uri), &user, Some(&scope_body(&body)))?;
    let note = repos
        .master
        .create_note(
            &scope,
            &MasterNoteInput {
                title,
                content,
                tags: string_list(&body, "tags").unwrap_or_default(),
            },
        )
        .map_err(bad_request)?;
    Ok((
        StatusCode::CREATED,
        Json(json!({ "ok": true, "note": note })),
    )
        .into_response())
}

/// `PATCH /api/master/notes` (`notes/route.ts:59-83`).
pub(super) async fn update(
    Extension(services): Extension<Arc<Services>>,
    headers: HeaderMap,
    uri: Uri,
    body: Bytes,
) -> Reply {
    let user = user_or_401(&headers)?;
    let body = json_body(&body)?;
    let note_id = filled_field(&body, "noteId")
        .ok_or_else(|| ApiError::new(StatusCode::BAD_REQUEST, "noteId is required"))?;
    let repos = services.repos().await;
    let scope = repos.scope(&query_of(&uri), &user, Some(&scope_body(&body)))?;
    let patch = NotePatch {
        title: string_field(&body, "title"),
        content: string_field(&body, "content"),
        tags: string_list(&body, "tags"),
    };
    let note = repos
        .master
        .update_note(&scope, &note_id, &patch)
        .map_err(bad_request)?
        .ok_or_else(|| ApiError::new(StatusCode::NOT_FOUND, "Note not found"))?;
    Ok(Json(json!({ "ok": true, "note": note })).into_response())
}

/// `DELETE /api/master/notes` (`notes/route.ts:85-102`).
pub(super) async fn delete(
    Extension(services): Extension<Arc<Services>>,
    headers: HeaderMap,
    uri: Uri,
    body: Bytes,
) -> Reply {
    let user = user_or_401(&headers)?;
    let body = json_body(&body)?;
    let note_id = filled_field(&body, "noteId")
        .ok_or_else(|| ApiError::new(StatusCode::BAD_REQUEST, "noteId is required"))?;
    let repos = services.repos().await;
    let scope = repos.scope(&query_of(&uri), &user, Some(&scope_body(&body)))?;
    let deleted = repos
        .master
        .delete_note(&scope, &note_id)
        .map_err(bad_request)?;
    Ok(Json(json!({ "ok": true, "deleted": deleted })).into_response())
}

#[cfg(test)]
mod tests {
    use axum::http::{Method, StatusCode};

    use crate::families::master::test_support::{Harness, OWNER, SCOPE};

    #[tokio::test]
    async fn notes_round_trip_through_the_four_methods() {
        let harness = Harness::new();
        let (status, body) = harness
            .send(
                Method::POST,
                "/api/master/notes",
                Some(OWNER),
                Some(r#"{"workspaceId":"main","title":"T","content":"C","tags":["a"]}"#),
            )
            .await;
        assert_eq!(status, StatusCode::CREATED);
        assert_eq!(body["note"]["title"], "T");
        let note_id = body["note"]["id"].as_str().expect("note id").to_string();

        let (status, body) = harness
            .send(
                Method::GET,
                &format!("/api/master/notes{SCOPE}"),
                Some(OWNER),
                None,
            )
            .await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(body["notes"].as_array().expect("notes").len(), 1);

        let patch = format!(r#"{{"workspaceId":"main","noteId":"{note_id}","content":"D"}}"#);
        let (status, body) = harness
            .send(
                Method::PATCH,
                "/api/master/notes",
                Some(OWNER),
                Some(&patch),
            )
            .await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(body["note"]["content"], "D");

        let delete = format!(r#"{{"workspaceId":"main","noteId":"{note_id}"}}"#);
        let (status, body) = harness
            .send(
                Method::DELETE,
                "/api/master/notes",
                Some(OWNER),
                Some(&delete),
            )
            .await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(body["deleted"], true);
    }

    #[tokio::test]
    async fn notes_validate_fields_and_the_caller() {
        let harness = Harness::new();
        let (status, body) = harness
            .send(
                Method::POST,
                "/api/master/notes",
                Some(OWNER),
                Some(r#"{"workspaceId":"main","title":"only a title"}"#),
            )
            .await;
        assert_eq!(status, StatusCode::BAD_REQUEST);
        assert_eq!(body["error"], "title and content are required");

        let (status, body) = harness
            .send(
                Method::GET,
                &format!("/api/master/notes{SCOPE}"),
                None,
                None,
            )
            .await;
        assert_eq!(status, StatusCode::UNAUTHORIZED);
        assert_eq!(body["error"], "Unauthorized");
    }
}
