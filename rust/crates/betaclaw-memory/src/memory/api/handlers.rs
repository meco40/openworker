//! The five `/api/memory` handlers as methods of [`MemoryApi`]. Port of
//! `api/getHandler.ts`, `postHandler.ts`, `putHandler.ts`, `patchHandler.ts` and
//! `deleteHandler.ts`. The checks run in the order of the source, so the first
//! failing check decides the message. The parsing rules live in
//! [`super::shared`]; the status mapping lives in [`super::MemoryApiError`].

use http::StatusCode;
use serde_json::{json, Map, Value};

use crate::memory::service::{
    MemoryPageRequest, MemoryPagination, MemoryRestoreInput, MemoryStoreInput, MemoryUpdateInput,
};

use super::shared::{
    is_delete_all_confirmed, js_text, parse_bounded_int_or_fallback, parse_bulk_body, parse_flag,
    parse_optional_type, parse_optional_workspace_id, parse_persona_id, parse_recall_args,
    parse_store_args, parse_update_body, resolve_memory_read_user_scopes, BulkAction,
    DELETE_ALL_CONFIRM_TOKEN,
};
use super::{ApiResponse, MemoryApi, MemoryApiError};

/// The pagination ceiling of `getHandler.ts:43-47`.
const PAGINATION_CEILING: i64 = 10_000;

/// `URLSearchParams.get(key)`: the first pair with this key, or `None` (`null`).
fn param(query: &[(String, String)], key: &str) -> Option<Value> {
    query
        .iter()
        .find(|(name, _)| name.as_str() == key)
        .map(|(_, value)| Value::String(value.clone()))
}

/// `await request.json()`: a malformed body is a `SyntaxError`, answered with 400.
fn parse_json_body(body: &str) -> Result<Value, MemoryApiError> {
    serde_json::from_str(body).map_err(|error| MemoryApiError::Validation(error.to_string()))
}

/// The object a handler reads its fields from. A `null` body makes the first
/// property read throw in the source; any other non-object reads as `{}`.
fn body_fields(body: &Value, first_field: &str) -> Result<Map<String, Value>, MemoryApiError> {
    match body {
        Value::Object(fields) => Ok(fields.clone()),
        Value::Null => Err(MemoryApiError::Internal(format!(
            "Cannot read properties of null (reading '{first_field}')"
        ))),
        _ => Ok(Map::new()),
    }
}

fn pagination_json(pagination: MemoryPagination) -> Value {
    json!({
        "page": pagination.page,
        "pageSize": pagination.page_size,
        "total": pagination.total,
        "totalPages": pagination.total_pages,
    })
}

/// The GET answer while the runtime is degraded (`getHandler.ts:52-69`). It is a
/// 200 with `degraded: true`, shaped after the request, not an error.
fn degraded_get(include_history: bool, paged: bool, page: i64, page_size: i64) -> ApiResponse {
    if include_history {
        return ApiResponse::ok(json!({
            "ok": true,
            "node": null,
            "history": [],
            "degraded": true,
        }));
    }
    if paged {
        return ApiResponse::ok(json!({
            "ok": true,
            "nodes": [],
            "pagination": { "page": page, "pageSize": page_size, "total": 0, "totalPages": 1 },
            "degraded": true,
        }));
    }
    ApiResponse::ok(json!({ "ok": true, "nodes": [], "degraded": true }))
}

impl<'a> MemoryApi<'a> {
    /// `handleMemoryGet` — `getHandler.ts:15-110`.
    pub fn get(&self, user_id: &str, query: &[(String, String)]) -> ApiResponse {
        self.run_get(user_id, query)
            .unwrap_or_else(ApiResponse::failure)
    }

    fn run_get(
        &self,
        user_id: &str,
        query: &[(String, String)],
    ) -> Result<ApiResponse, MemoryApiError> {
        let persona_id = parse_persona_id(param(query, "personaId").as_ref())?;
        let workspace_id = parse_optional_workspace_id(param(query, "workspaceId").as_ref())?;
        let node_id = js_text(param(query, "id").as_ref()).trim().to_string();
        let include_history = parse_flag(param(query, "history").as_ref());
        let preview = parse_flag(param(query, "preview").as_ref());
        let preview_limit =
            parse_bounded_int_or_fallback(param(query, "limit").as_ref(), 50, 1, 200);
        let page_param = param(query, "page");
        let page_size_param = param(query, "pageSize");
        let user_scopes = resolve_memory_read_user_scopes(user_id, &persona_id, self.conversations);
        let primary = user_scopes
            .first()
            .cloned()
            .unwrap_or_else(|| user_id.to_string());
        let page = parse_bounded_int_or_fallback(page_param.as_ref(), 1, 1, 1_000_000);
        let page_size = parse_bounded_int_or_fallback(page_size_param.as_ref(), 25, 1, 200);
        if (page - 1) * page_size + page_size > PAGINATION_CEILING {
            return Err(MemoryApiError::Validation(
                "Memory pagination is limited to the first 10,000 results. Narrow the query or filters."
                    .to_string(),
            ));
        }
        let paged = page_param.is_some() || page_size_param.is_some();
        let scopes = if user_scopes.is_empty() {
            vec![primary.clone()]
        } else {
            user_scopes.clone()
        };
        let workspace = workspace_id.as_deref();

        let service = match self.ready_service() {
            Ok(service) => service,
            Err(MemoryApiError::Unavailable) => {
                return Ok(degraded_get(include_history, paged, page, page_size));
            }
            Err(error) => return Err(error),
        };

        if include_history {
            if node_id.is_empty() {
                return Err(MemoryApiError::Validation(
                    "id is required when history is requested.".to_string(),
                ));
            }
            return Ok(
                match service.history(&persona_id, &node_id, Some(primary.as_str()), workspace)? {
                    None => ApiResponse::not_found(),
                    Some(history) => ApiResponse::ok(json!({
                        "ok": true,
                        "node": history.node,
                        "history": history.entries,
                    })),
                },
            );
        }

        if preview {
            let result = service.list_preview_across_scopes(
                &persona_id,
                &scopes,
                preview_limit,
                workspace,
            )?;
            return Ok(ApiResponse::ok(json!({
                "ok": true,
                "nodes": result.nodes,
                "truncated": result.truncated,
            })));
        }

        if paged {
            let query_text = js_text(param(query, "query").as_ref()).trim().to_string();
            let input = MemoryPageRequest {
                page,
                page_size,
                query: (!query_text.is_empty()).then_some(query_text),
                node_type: parse_optional_type(param(query, "type").as_ref())?,
            };
            let result = if user_scopes.len() > 1 {
                service.list_page_across_scopes(&persona_id, &user_scopes, &input, workspace)?
            } else {
                service.list_page(&persona_id, &input, Some(primary.as_str()), workspace)?
            };
            return Ok(ApiResponse::ok(json!({
                "ok": true,
                "nodes": result.nodes,
                "pagination": pagination_json(result.pagination),
            })));
        }

        // The unpaged read is bounded as well (`getHandler.ts:101-108`).
        let snapshot = service.list_preview_across_scopes(&persona_id, &scopes, 200, workspace)?;
        Ok(ApiResponse::ok(json!({
            "ok": true,
            "nodes": snapshot.nodes,
            "truncated": snapshot.truncated,
        })))
    }

    /// `handleMemoryPost` — `postHandler.ts:11-56`: the `core_memory_store` and
    /// `core_memory_recall` function calls.
    pub fn post(&self, user_id: &str, body: &str) -> ApiResponse {
        self.run_post(user_id, body)
            .unwrap_or_else(ApiResponse::failure)
    }

    fn run_post(&self, user_id: &str, body: &str) -> Result<ApiResponse, MemoryApiError> {
        let body = parse_json_body(body)?;
        let fields = body_fields(&body, "fcName")?;
        let fc_name = js_text(fields.get("fcName")).trim().to_string();
        // `body.args || {}`: a non-object reads as an empty object, because every
        // field read on it is `undefined`.
        let args = match fields.get("args") {
            Some(Value::Object(args)) => args.clone(),
            _ => Map::new(),
        };
        let service = self.ready_service()?;

        match fc_name.as_str() {
            "core_memory_store" => {
                let parsed = parse_store_args(&args)?;
                let node = service.store_memory(&MemoryStoreInput {
                    persona_id: parsed.persona_id,
                    workspace_id: parsed.workspace_id,
                    node_type: parsed.node_type,
                    content: parsed.content,
                    importance: parsed.importance,
                    user_id: Some(user_id.to_string()),
                    metadata: Map::new(),
                })?;
                Ok(ApiResponse::ok(json!({
                    "ok": true,
                    "result": { "action": "store", "data": node },
                })))
            }
            "core_memory_recall" => {
                let parsed = parse_recall_args(&args)?;
                let context = service.recall(
                    &parsed.persona_id,
                    &parsed.query,
                    Some(parsed.limit),
                    Some(user_id),
                    parsed.workspace_id.as_deref(),
                )?;
                Ok(ApiResponse::ok(json!({
                    "ok": true,
                    "result": { "action": "recall", "data": context },
                })))
            }
            _ => {
                let name = if fc_name.is_empty() {
                    "undefined"
                } else {
                    fc_name.as_str()
                };
                Ok(ApiResponse {
                    status: StatusCode::BAD_REQUEST,
                    body: json!({
                        "ok": false,
                        "error": format!("Unsupported function call: {name}"),
                    }),
                })
            }
        }
    }

    /// `handleMemoryPut` — `putHandler.ts:11-56`: an edit or a restore of one node.
    pub fn put(&self, user_id: &str, body: &str) -> ApiResponse {
        self.run_put(user_id, body)
            .unwrap_or_else(ApiResponse::failure)
    }

    fn run_put(&self, user_id: &str, body: &str) -> Result<ApiResponse, MemoryApiError> {
        let body = parse_json_body(body)?;
        let fields = body_fields(&body, "personaId")?;
        let parsed = parse_update_body(&fields)?;
        let service = self.ready_service()?;
        let workspace = parsed.workspace_id.as_deref();

        let node = match parsed.restore_index {
            Some(restore_index) => service.restore_from_history(
                &parsed.persona_id,
                &parsed.id,
                &MemoryRestoreInput {
                    restore_index,
                    expected_version: parsed.expected_version,
                },
                Some(user_id),
                workspace,
            )?,
            None => service.update(
                &parsed.persona_id,
                &parsed.id,
                &MemoryUpdateInput {
                    node_type: parsed.node_type,
                    content: parsed.content,
                    importance: parsed.importance,
                    expected_version: parsed.expected_version,
                    metadata: Map::new(),
                },
                Some(user_id),
                workspace,
            )?,
        };

        Ok(match node {
            None => ApiResponse::not_found(),
            Some(node) => ApiResponse::ok(json!({ "ok": true, "node": node })),
        })
    }

    /// `handleMemoryPatch` — `patchHandler.ts:10-44`: bulk delete or bulk update.
    pub fn patch(&self, user_id: &str, body: &str) -> ApiResponse {
        self.run_patch(user_id, body)
            .unwrap_or_else(ApiResponse::failure)
    }

    fn run_patch(&self, user_id: &str, body: &str) -> Result<ApiResponse, MemoryApiError> {
        let body = parse_json_body(body)?;
        let fields = body_fields(&body, "personaId")?;
        let parsed = parse_bulk_body(&fields)?;
        let service = self.ready_service()?;
        let workspace = parsed.workspace_id.as_deref();

        match parsed.action {
            BulkAction::Delete => {
                let affected = service.bulk_delete(
                    &parsed.persona_id,
                    &parsed.ids,
                    Some(user_id),
                    workspace,
                )?;
                Ok(ApiResponse::ok(json!({
                    "ok": true,
                    "action": "delete",
                    "affected": affected,
                })))
            }
            BulkAction::Update => {
                let affected = service.bulk_update(
                    &parsed.persona_id,
                    &parsed.ids,
                    parsed.updates,
                    Some(user_id),
                    workspace,
                )?;
                Ok(ApiResponse::ok(json!({
                    "ok": true,
                    "action": "update",
                    "affected": affected,
                })))
            }
        }
    }

    /// `handleMemoryDelete` — `deleteHandler.ts:13-46`: one node by `id`, or every
    /// node of a persona with `confirm=delete-all-memory`.
    pub fn delete(&self, user_id: &str, query: &[(String, String)]) -> ApiResponse {
        self.run_delete(user_id, query)
            .unwrap_or_else(ApiResponse::failure)
    }

    fn run_delete(
        &self,
        user_id: &str,
        query: &[(String, String)],
    ) -> Result<ApiResponse, MemoryApiError> {
        let persona_id = parse_persona_id(param(query, "personaId").as_ref())?;
        let workspace_id = parse_optional_workspace_id(param(query, "workspaceId").as_ref())?;
        let node_id = js_text(param(query, "id").as_ref()).trim().to_string();
        let service = self.ready_service()?;
        let workspace = workspace_id.as_deref();

        if !node_id.is_empty() {
            let deleted = service.delete(&persona_id, &node_id, Some(user_id), workspace)?;
            return Ok(ApiResponse::ok(json!({
                "ok": true,
                "deleted": if deleted { 1 } else { 0 },
            })));
        }

        if !is_delete_all_confirmed(param(query, "confirm").as_ref()) {
            return Err(MemoryApiError::Validation(format!(
                "confirm={DELETE_ALL_CONFIRM_TOKEN} is required to delete all memory entries for a persona."
            )));
        }
        let deleted = service.delete_by_persona(&persona_id, Some(user_id), workspace)?;
        Ok(ApiResponse::ok(json!({ "ok": true, "deleted": deleted })))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::memory::api::ConversationDirectory;
    use crate::memory::runtime::{ConfiguredProvider, MemoryRuntime};
    use crate::memory::service::MemoryServiceDependencies;
    use crate::memory::sqlite::client::SqliteMemoryClient;
    use crate::messages_store::types::Conversation;

    /// No conversations: the legacy scope is the only one a read sees.
    struct NoConversations;

    impl ConversationDirectory for NoConversations {
        fn list_user_conversations(
            &self,
            _limit: i64,
            _user_id: &str,
        ) -> Result<Vec<Conversation>, String> {
            Ok(Vec::new())
        }
    }

    /// A runtime over an in-memory SQLite store, so the handlers run end to end.
    fn runtime() -> MemoryRuntime {
        MemoryRuntime::new(
            ConfiguredProvider::Sqlite,
            Box::new(SqliteMemoryClient::open(":memory:").expect("in-memory store")),
        )
    }

    fn query(pairs: &[(&str, &str)]) -> Vec<(String, String)> {
        pairs
            .iter()
            .map(|(key, value)| (key.to_string(), value.to_string()))
            .collect()
    }

    fn store(api: &MemoryApi<'_>, content: &str) -> String {
        let stored = api.post(
            "user-1",
            &json!({
                "fcName": "core_memory_store",
                "args": { "personaId": "p1", "type": "fact", "content": content, "importance": 4.4 },
            })
            .to_string(),
        );
        assert_eq!(stored.status, StatusCode::OK, "{}", stored.body);
        stored.body["result"]["data"]["id"]
            .as_str()
            .expect("the stored node has an id")
            .to_string()
    }

    #[test]
    fn a_stored_memory_is_listed_and_its_history_is_read_back() {
        let runtime = runtime();
        let directory = NoConversations;
        let api = MemoryApi::new(&runtime, MemoryServiceDependencies::for_test(), &directory);

        let node_id = store(&api, "Ich mag Tee");
        let listed = api.get("user-1", &query(&[("personaId", "p1"), ("preview", "1")]));
        assert_eq!(listed.body["nodes"].as_array().map(Vec::len), Some(1));

        let history = api.get(
            "user-1",
            &query(&[
                ("personaId", "p1"),
                ("history", "1"),
                ("id", node_id.as_str()),
            ]),
        );
        assert_eq!(history.status, StatusCode::OK);
        assert_eq!(history.body["node"]["id"], json!(node_id));
        assert_eq!(history.body["node"]["importance"], json!(4.0));
    }

    #[test]
    fn a_degraded_runtime_answers_the_empty_shapes_with_200() {
        let mut runtime = runtime();
        runtime.set_ready_state(Some(false));
        let directory = NoConversations;
        let api = MemoryApi::new(&runtime, MemoryServiceDependencies::for_test(), &directory);

        let plain = api.get("user-1", &query(&[("personaId", "p1")]));
        assert_eq!(plain.status, StatusCode::OK);
        assert_eq!(
            plain.body,
            json!({ "ok": true, "nodes": [], "degraded": true })
        );

        let paged = api.get(
            "user-1",
            &query(&[("personaId", "p1"), ("page", "2"), ("pageSize", "10")]),
        );
        assert_eq!(
            paged.body["pagination"],
            json!({ "page": 2, "pageSize": 10, "total": 0, "totalPages": 1 })
        );

        let write = api.post(
            "user-1",
            r#"{"fcName":"core_memory_store","args":{"personaId":"p1","type":"fact","content":"x"}}"#,
        );
        assert_eq!(write.status, StatusCode::SERVICE_UNAVAILABLE);
        assert_eq!(
            write.body["error"],
            json!("Memory runtime unavailable: the configured provider is not ready.")
        );
    }

    #[test]
    fn the_reads_validate_before_they_answer() {
        let runtime = runtime();
        let directory = NoConversations;
        let api = MemoryApi::new(&runtime, MemoryServiceDependencies::for_test(), &directory);

        let missing = api.get("user-1", &query(&[]));
        assert_eq!(missing.status, StatusCode::BAD_REQUEST);
        assert_eq!(missing.body["error"], json!("personaId is required."));

        let too_deep = api.get(
            "user-1",
            &query(&[
                ("personaId", "p1"),
                ("page", "1000000"),
                ("pageSize", "200"),
            ]),
        );
        assert_eq!(too_deep.status, StatusCode::BAD_REQUEST);

        let no_id = api.get("user-1", &query(&[("personaId", "p1"), ("history", "1")]));
        assert_eq!(
            no_id.body["error"],
            json!("id is required when history is requested.")
        );

        let unknown = api.get(
            "user-1",
            &query(&[("personaId", "p1"), ("history", "1"), ("id", "missing")]),
        );
        assert_eq!(unknown.status, StatusCode::NOT_FOUND);
        assert_eq!(
            unknown.body,
            json!({ "ok": false, "error": "Memory node not found." })
        );
    }

    #[test]
    fn post_answers_unknown_calls_and_bad_bodies_with_their_statuses() {
        let runtime = runtime();
        let directory = NoConversations;
        let api = MemoryApi::new(&runtime, MemoryServiceDependencies::for_test(), &directory);

        let unknown = api.post("user-1", r#"{"fcName":"nope"}"#);
        assert_eq!(unknown.status, StatusCode::BAD_REQUEST);
        assert_eq!(
            unknown.body["error"],
            json!("Unsupported function call: nope")
        );

        let unnamed = api.post("user-1", "{}");
        assert_eq!(
            unnamed.body["error"],
            json!("Unsupported function call: undefined")
        );

        let null_body = api.post("user-1", "null");
        assert_eq!(null_body.status, StatusCode::INTERNAL_SERVER_ERROR);
        assert_eq!(
            null_body.body["error"],
            json!("Cannot read properties of null (reading 'fcName')")
        );

        let malformed = api.post("user-1", "{not json");
        assert_eq!(malformed.status, StatusCode::BAD_REQUEST);
    }

    #[test]
    fn put_maps_a_stale_version_to_409_and_refuses_a_restore_with_an_edit() {
        let runtime = runtime();
        let directory = NoConversations;
        let api = MemoryApi::new(&runtime, MemoryServiceDependencies::for_test(), &directory);
        let node_id = store(&api, "Ich mag Tee");

        let stale = api.put(
            "user-1",
            &json!({ "personaId": "p1", "id": node_id, "content": "neu", "expectedVersion": 99 })
                .to_string(),
        );
        assert_eq!(stale.status, StatusCode::CONFLICT);
        assert_eq!(
            stale.body["error"],
            json!("Memory version conflict. Reload and retry.")
        );

        let mixed = api.put(
            "user-1",
            &json!({ "personaId": "p1", "id": node_id, "restoreIndex": 0, "content": "x" })
                .to_string(),
        );
        assert_eq!(mixed.status, StatusCode::BAD_REQUEST);

        let edited = api.put(
            "user-1",
            &json!({ "personaId": "p1", "id": node_id, "content": "neu" }).to_string(),
        );
        assert_eq!(edited.status, StatusCode::OK);
        assert_eq!(edited.body["node"]["content"], json!("neu"));
    }

    #[test]
    fn patch_counts_the_changed_nodes_and_needs_a_field_for_an_update() {
        let runtime = runtime();
        let directory = NoConversations;
        let api = MemoryApi::new(&runtime, MemoryServiceDependencies::for_test(), &directory);
        let node_id = store(&api, "Ich mag Tee");

        let updated = api.patch(
            "user-1",
            &json!({
                "personaId": "p1",
                "ids": [node_id, node_id, " "],
                "action": "update",
                "importance": 2,
            })
            .to_string(),
        );
        assert_eq!(
            updated.body,
            json!({ "ok": true, "action": "update", "affected": 1 })
        );

        let empty = api.patch(
            "user-1",
            &json!({ "personaId": "p1", "ids": [node_id], "action": "update", "type": "all" })
                .to_string(),
        );
        assert_eq!(empty.status, StatusCode::BAD_REQUEST);
        assert_eq!(
            empty.body["error"],
            json!("Bulk update requires at least one update field.")
        );
    }

    #[test]
    fn delete_removes_one_node_or_a_whole_persona_only_with_the_token() {
        let runtime = runtime();
        let directory = NoConversations;
        let api = MemoryApi::new(&runtime, MemoryServiceDependencies::for_test(), &directory);
        let node_id = store(&api, "Ich mag Tee");

        let unconfirmed = api.delete("user-1", &query(&[("personaId", "p1")]));
        assert_eq!(unconfirmed.status, StatusCode::BAD_REQUEST);
        assert_eq!(
            unconfirmed.body["error"],
            json!(
                "confirm=delete-all-memory is required to delete all memory entries for a persona."
            )
        );

        let one = api.delete(
            "user-1",
            &query(&[("personaId", "p1"), ("id", node_id.as_str())]),
        );
        assert_eq!(one.body, json!({ "ok": true, "deleted": 1 }));
        let again = api.delete(
            "user-1",
            &query(&[("personaId", "p1"), ("id", node_id.as_str())]),
        );
        assert_eq!(again.body, json!({ "ok": true, "deleted": 0 }));

        store(&api, "Ich trinke Kaffee");
        let all = api.delete(
            "user-1",
            &query(&[("personaId", "p1"), ("confirm", "delete-all-memory")]),
        );
        assert_eq!(all.body, json!({ "ok": true, "deleted": 1 }));
    }
}
