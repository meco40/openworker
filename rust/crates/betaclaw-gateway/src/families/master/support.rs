//! Shared plumbing of the master routes.
//!
//! Ports the request-side helpers of `src/server/master/http.ts` and the repeated
//! answer shape of the `app/api/master/**/route.ts` handlers: the identity check,
//! the `{ ok: false, error }` body, the JSON body fields, the scope resolution
//! (`resolveScopeFromRequest`) and the live-event publish.
//!
//! A field helper answers `None` for an absent or non-matching JSON value, which is
//! the `undefined` branch of the TypeScript `??` checks. Where the TypeScript test
//! is truthiness (`!body.title`), [`filled_field`] is used.

use std::fmt::Display;

use axum::http::{HeaderMap, StatusCode, Uri};
use axum::response::{IntoResponse, Response};
use axum::Json;
use betaclaw_core::master::feature_flags::MasterEnv;
use betaclaw_core::master::http::{
    resolve_scope_from_request, MasterWorkspaceScopeResolver, QueryParams, ScopeBody,
    ScopeResolutionInput,
};
use betaclaw_core::master::live_events::{
    publish_master_updated, MasterInvalidationResource, PublishMasterUpdatedInput,
};
use betaclaw_core::master::repository::sqlite_master_repository::SqliteMasterRepository;
use betaclaw_core::master::types::WorkspaceScope;
use betaclaw_core::master::workspace_scope::{
    self, MasterWorkspaceScopeError, MasterWorkspaceScopeInput,
};
use betaclaw_core::personas::repository::PersonaRepository;
use serde_json::{json, Value};
use tokio::sync::MutexGuard;

use super::Services;
use crate::auth_gate::user_id_from_headers;

/// A failed master route: the status and the `{ ok: false, error }` body.
#[derive(Debug)]
pub(super) struct ApiError {
    status: StatusCode,
    message: String,
}

impl ApiError {
    pub(super) fn new(status: StatusCode, message: impl Display) -> Self {
        Self {
            status,
            message: message.to_string(),
        }
    }
}

impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        (
            self.status,
            Json(json!({ "ok": false, "error": self.message })),
        )
            .into_response()
    }
}

/// What every master handler returns.
pub(super) type Reply = Result<Response, ApiError>;

/// Maps a repository or validation failure to `400`, the `catch` answer of the
/// master routes.
pub(super) fn bad_request<E: Display>(error: E) -> ApiError {
    ApiError::new(StatusCode::BAD_REQUEST, error)
}

/// Maps a failure to `500`, the answer of the settings and voice routes.
pub(super) fn server_error<E: Display>(error: E) -> ApiError {
    ApiError::new(StatusCode::INTERNAL_SERVER_ERROR, error)
}

/// `resolveMasterUserId`: the identity the auth gate attached, if non-empty.
/// Missing identity answers the `withUserContext` 401.
pub(super) fn user_or_401(headers: &HeaderMap) -> Result<String, ApiError> {
    user_id_from_headers(headers)
        .filter(|user| !user.is_empty())
        .ok_or_else(|| ApiError::new(StatusCode::UNAUTHORIZED, "Unauthorized"))
}

/// `new URL(request.url).searchParams`.
pub(super) fn query_of(uri: &Uri) -> QueryParams {
    QueryParams::parse(uri.query().unwrap_or(""))
}

/// `await request.json()`. A malformed body is a `400`, like the `catch` of the
/// TypeScript routes.
pub(super) fn json_body(bytes: &[u8]) -> Result<Value, ApiError> {
    serde_json::from_slice(bytes).map_err(bad_request)
}

/// A JSON string field, `None` when absent or not a string.
pub(super) fn string_field(body: &Value, key: &str) -> Option<String> {
    body.get(key)?.as_str().map(str::to_string)
}

/// A JSON string field that is also truthy (`!body.key` is false).
pub(super) fn filled_field(body: &Value, key: &str) -> Option<String> {
    string_field(body, key).filter(|text| !text.is_empty())
}

/// A field that may be JSON `null`: `None` when absent, `Some(None)` for `null`.
pub(super) fn nullable_field(body: &Value, key: &str) -> Option<Option<String>> {
    match body.get(key)? {
        Value::Null => Some(None),
        Value::String(text) => Some(Some(text.clone())),
        other => Some(Some(other.to_string())),
    }
}

/// An array field read as strings, each entry through JavaScript `String(entry)`.
pub(super) fn string_list(body: &Value, key: &str) -> Option<Vec<String>> {
    body.get(key)?.as_array().map(|items| {
        items
            .iter()
            .map(|item| {
                item.as_str()
                    .map_or_else(|| item.to_string(), str::to_string)
            })
            .collect()
    })
}

/// The `personaId`, `workspaceId` and `workspaceCwd` strings of a body.
pub(super) fn scope_body(body: &Value) -> ScopeBody {
    ScopeBody {
        persona_id: string_field(body, "personaId"),
        workspace_id: string_field(body, "workspaceId"),
        workspace_cwd: string_field(body, "workspaceCwd"),
    }
}

/// JavaScript `Number(value)` for an optional JSON value. `NaN` when there is
/// no numeric reading, so a range check rejects it.
pub(super) fn js_number(value: Option<&Value>) -> f64 {
    match value {
        None => f64::NAN,
        Some(Value::Null) => 0.0,
        Some(Value::Bool(flag)) => f64::from(u8::from(*flag)),
        Some(Value::Number(number)) => number.as_f64().unwrap_or(f64::NAN),
        Some(Value::String(text)) => {
            let trimmed = text.trim();
            if trimmed.is_empty() {
                0.0
            } else {
                trimmed.parse().unwrap_or(f64::NAN)
            }
        }
        Some(_) => f64::NAN,
    }
}

/// JavaScript truthiness of an optional JSON value (`Boolean(value)`).
pub(super) fn js_truthy(value: Option<&Value>) -> bool {
    match value {
        None | Some(Value::Null) => false,
        Some(Value::Bool(flag)) => *flag,
        Some(Value::Number(number)) => number.as_f64().is_some_and(|n| n != 0.0 && !n.is_nan()),
        Some(Value::String(text)) => !text.is_empty(),
        Some(_) => true,
    }
}

/// `publishMasterUpdated({ scope, resources, runId })` on the family bus.
pub(super) fn publish(
    services: &Services,
    scope: &WorkspaceScope,
    resources: Vec<MasterInvalidationResource>,
    run_id: Option<&str>,
) {
    publish_master_updated(
        &services.events,
        &PublishMasterUpdatedInput {
            scope: scope.clone(),
            resources,
            run_id: run_id.map(str::to_string),
            approval_request_id: None,
            session_id: None,
            reminder_id: None,
        },
    );
}

/// Both repositories a master route reads, locked in one fixed order (personas
/// first, then master) so two requests cannot deadlock.
pub(super) struct Repos<'a> {
    pub(super) personas: MutexGuard<'a, PersonaRepository>,
    pub(super) master: MutexGuard<'a, SqliteMasterRepository>,
    pub(super) env: &'a MasterEnv,
}

impl Services {
    pub(super) async fn repos(&self) -> Repos<'_> {
        let personas = self.personas.lock().await;
        let master = self.master.lock().await;
        Repos {
            personas,
            master,
            env: &self.env,
        }
    }
}

impl Repos<'_> {
    /// `resolveScopeFromRequest` (`http.ts:18-33`). A body value wins over the
    /// query; the workspace resolver turns the result into the scope. A failure is
    /// a `400`, as the TypeScript `catch` answers.
    pub(super) fn scope(
        &self,
        query: &QueryParams,
        user: &str,
        body: Option<&ScopeBody>,
    ) -> Result<WorkspaceScope, ApiError> {
        let (scope, _) = self.binding(query, user, body)?;
        Ok(scope)
    }

    pub(super) fn binding(
        &self,
        query: &QueryParams,
        user: &str,
        body: Option<&ScopeBody>,
    ) -> Result<(WorkspaceScope, workspace_scope::MasterWorkspaceBinding), ApiError> {
        let resolver = ScopeResolver {
            master: &self.master,
            personas: &self.personas,
            env: self.env,
        };
        let resolved =
            resolve_scope_from_request(&resolver, query, user, body).map_err(bad_request)?;
        let scope = WorkspaceScope {
            user_id: resolved.user_id.clone(),
            workspace_id: resolved.workspace_id.clone(),
        };
        let binding = workspace_scope::MasterWorkspaceBinding {
            user_id: resolved.user_id,
            workspace_id: resolved.workspace_id,
            persona_id: resolved.persona_id,
            persona_workspace_root: resolved.persona_workspace_root,
            workspace_cwd: resolved.workspace_cwd,
        };
        Ok((scope, binding))
    }

    /// `resolveMasterWorkspaceScope({ userId, workspaceId: 'main' })`, the scope the
    /// settings route writes its tool policy and events under.
    pub(super) fn main_scope(&self, user: &str) -> Result<WorkspaceScope, ApiError> {
        let input = MasterWorkspaceScopeInput {
            user_id: user.to_string(),
            workspace_id: Some("main".to_string()),
            ..MasterWorkspaceScopeInput::default()
        };
        let binding = workspace_scope::resolve_master_workspace_scope(
            &input,
            &self.master,
            &self.personas,
            self.env,
        )
        .map_err(server_error)?;
        Ok(WorkspaceScope {
            user_id: binding.user_id,
            workspace_id: binding.workspace_id,
        })
    }
}

/// Adapter from the `http.ts` seam to `resolveMasterWorkspaceScope`. The two
/// modules each define a `MasterWorkspaceBinding`, so the fields are copied across.
struct ScopeResolver<'a> {
    master: &'a SqliteMasterRepository,
    personas: &'a PersonaRepository,
    env: &'a MasterEnv,
}

impl MasterWorkspaceScopeResolver for ScopeResolver<'_> {
    type Error = MasterWorkspaceScopeError;

    fn resolve_master_workspace_scope(
        &self,
        input: ScopeResolutionInput,
    ) -> Result<betaclaw_core::master::http::MasterWorkspaceBinding, Self::Error> {
        let binding = workspace_scope::resolve_master_workspace_scope(
            &MasterWorkspaceScopeInput {
                user_id: input.user_id,
                persona_id: input.persona_id,
                workspace_id: input.workspace_id,
                workspace_cwd: input.workspace_cwd,
            },
            self.master,
            self.personas,
            self.env,
        )?;
        Ok(betaclaw_core::master::http::MasterWorkspaceBinding {
            user_id: binding.user_id,
            workspace_id: binding.workspace_id,
            persona_id: binding.persona_id,
            persona_workspace_root: binding.persona_workspace_root,
            workspace_cwd: binding.workspace_cwd,
        })
    }
}
