//! Port of `app/api/master/gmail/route.ts` (POST) and of `executeGmailAction` in
//! `src/server/master/connectors/gmail/actions.ts`, over the core Gmail connector
//! (`connectors::gmail`) and the core connector secret store.
//!
//! `connect` and `revoke` write the connector secret. The actions run through the S6
//! bridge: read, search and draft as one bridged action, and send as a ledgered effect
//! inside it. A send that still awaits approval, or was denied, skips the bridge, as
//! the route does.
//!
//! Deviation: the source nests a second bridge around a send that carries a decision.
//! The port keeps the route's bridge and the ledger, and drops the inner bridge.
//!
//! The repository is synchronous and must not be held across an await point, so the
//! action runs on a blocking thread, and the connector calls are driven there.

use std::sync::Arc;

use axum::body::Bytes;
use axum::extract::Extension;
use axum::http::{HeaderMap, StatusCode, Uri};
use axum::response::IntoResponse;
use axum::Json;
use betaclaw_core::master::connectors::gmail::client::GmailClient;
use betaclaw_core::master::connectors::gmail::oauth::load_gmail_oauth_state;
use betaclaw_core::master::connectors::gmail::types::GmailDraftInput;
use betaclaw_core::master::connectors::secret_policies::{
    revoke_connector_secret, RevokeConnectorSecretInput,
};
use betaclaw_core::master::connectors::secret_store::{
    store_connector_secret, SecretKeyResolver, StoreConnectorSecretInput,
};
use betaclaw_core::master::feature_flags::MasterEnv;
use betaclaw_core::master::repository::MasterRepository;
use betaclaw_core::master::types::WorkspaceScope;
use betaclaw_core::model_hub::http::HttpTransport;
use betaclaw_core::world_model::db::drive_sync;
use betaclaw_core::world_model::services::master_action_bridge::{
    MasterActionBridgeInput, MasterActionRunOutput,
};
use serde::Serialize;
use serde_json::{json, Value};

use super::action_bridge::{ledger_key, ledger_once, ActionBridge, LedgeredAction};
use super::support::{
    bad_request, filled_field, json_body, query_of, scope_body, server_error, string_field,
    user_or_401, ApiError, Reply,
};
use super::Services;

/// The Gmail actions of `executeGmailAction` (`actions.ts:10`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum GmailAction {
    Read,
    Search,
    Draft,
    Send,
}

impl GmailAction {
    fn parse(text: &str) -> Option<Self> {
        match text {
            "read" => Some(Self::Read),
            "search" => Some(Self::Search),
            "draft" => Some(Self::Draft),
            "send" => Some(Self::Send),
            _ => None,
        }
    }

    fn as_str(self) -> &'static str {
        match self {
            Self::Read => "read",
            Self::Search => "search",
            Self::Draft => "draft",
            Self::Send => "send",
        }
    }
}

/// One `executeGmailAction` call (`actions.ts:12-23`).
pub struct GmailCall<'a> {
    pub scope: &'a WorkspaceScope,
    pub run_id: &'a str,
    pub step_id: &'a str,
    pub action: GmailAction,
    pub query: Option<&'a str>,
    pub draft: Option<&'a GmailDraftInput>,
    /// `approve_once`, `approve_always` or `deny`; `None` while awaiting approval.
    pub decision: Option<&'a str>,
    pub fingerprint: Option<&'a str>,
}

/// The `{ ok, approvalRequired?, result?, error? }` answer of an action.
#[derive(Debug, Clone, PartialEq)]
pub struct GmailOutcome {
    pub ok: bool,
    pub approval_required: bool,
    pub result: Option<Value>,
    pub error: Option<String>,
}

impl GmailOutcome {
    fn ok(result: Value) -> Self {
        Self {
            ok: true,
            approval_required: false,
            result: Some(result),
            error: None,
        }
    }

    fn failed(error: impl Into<String>) -> Self {
        Self {
            ok: false,
            approval_required: false,
            result: None,
            error: Some(error.into()),
        }
    }

    fn awaiting_approval() -> Self {
        Self {
            ok: false,
            approval_required: true,
            result: None,
            error: Some("Approval required for gmail.send".to_string()),
        }
    }

    /// The JSON body of the route. Fields that are unset are left out, as `undefined`
    /// is in the TypeScript answer.
    fn into_json(self) -> Value {
        let mut body = json!({ "ok": self.ok });
        if self.approval_required {
            body["approvalRequired"] = json!(true);
        }
        if let Some(result) = self.result {
            body["result"] = result;
        }
        if let Some(error) = self.error {
            body["error"] = json!(error);
        }
        body
    }
}

/// The collaborators one Gmail call needs.
pub struct GmailDeps<'a> {
    pub repo: &'a dyn MasterRepository,
    pub env: &'a MasterEnv,
    pub transport: Arc<dyn HttpTransport + Send + Sync>,
    pub bridge: &'a ActionBridge,
    /// The process working directory, which the secret key is derived from.
    pub cwd: &'a str,
}

/// The owned form of a route body, so the action can run on a blocking thread.
struct GmailRequest {
    scope: WorkspaceScope,
    run_id: String,
    step_id: String,
    action: GmailAction,
    query: Option<String>,
    draft: Option<GmailDraftInput>,
    decision: Option<String>,
    fingerprint: Option<String>,
}

impl GmailRequest {
    fn call(&self) -> GmailCall<'_> {
        GmailCall {
            scope: &self.scope,
            run_id: &self.run_id,
            step_id: &self.step_id,
            action: self.action,
            query: self.query.as_deref(),
            draft: self.draft.as_ref(),
            decision: self.decision.as_deref(),
            fingerprint: self.fingerprint.as_deref(),
        }
    }

    /// `action === 'send' && !decision`, or a denied send: the two cases the route runs
    /// without the bridge.
    fn skips_bridge(&self) -> bool {
        self.action == GmailAction::Send && matches!(self.decision.as_deref(), None | Some("deny"))
    }
}

/// `executeGmailAction` — `actions.ts:12-98`.
async fn execute(deps: &GmailDeps<'_>, call: &GmailCall<'_>) -> GmailOutcome {
    let resolver = SecretKeyResolver::new(deps.env, deps.cwd);
    let oauth = match load_gmail_oauth_state(deps.repo, call.scope, &resolver, "default") {
        Ok(Some(oauth)) => oauth,
        Ok(None) => return GmailOutcome::failed("Gmail connector is not configured."),
        Err(error) => return GmailOutcome::failed(error.to_string()),
    };
    let client =
        match GmailClient::new(oauth.access_token, deps.transport.clone(), deps.env.clone()) {
            Ok(client) => client,
            Err(error) => return GmailOutcome::failed(error.to_string()),
        };
    let mailbox = format!("{}:{}", call.scope.user_id, call.scope.workspace_id);

    match call.action {
        GmailAction::Read => outcome(client.list_messages(&mailbox).await),
        GmailAction::Search => outcome(
            client
                .search_messages(&mailbox, call.query.unwrap_or(""))
                .await,
        ),
        GmailAction::Draft => match call.draft {
            Some(draft) => outcome(client.create_draft(draft).await),
            None => GmailOutcome::failed("draft payload is required"),
        },
        GmailAction::Send => send(deps, call, &client, &mailbox).await,
    }
}

/// The send branch of `actions.ts:43-96`: approval first, then the ledgered send.
async fn send(
    deps: &GmailDeps<'_>,
    call: &GmailCall<'_>,
    client: &GmailClient,
    mailbox: &str,
) -> GmailOutcome {
    match call.decision {
        None => return GmailOutcome::awaiting_approval(),
        Some("deny") => return GmailOutcome::failed("Action denied by operator."),
        Some(_) => {}
    }
    let Some(draft) = call.draft else {
        return GmailOutcome::failed("draft payload is required");
    };
    if call.decision == Some("approve_always") {
        let fingerprint = call
            .fingerprint
            .map(str::to_string)
            .unwrap_or_else(|| format!("{}:{}", draft.to, draft.subject));
        if let Err(error) =
            deps.repo
                .upsert_approval_rule(call.scope, "gmail.send", &fingerprint, "approve_always")
        {
            return GmailOutcome::failed(error.to_string());
        }
    }

    let payload = serde_json::to_string(draft).unwrap_or_default();
    let key = ledger_key(call.run_id, call.step_id, "gmail.send", &payload);
    let action = LedgeredAction {
        repo: deps.repo,
        scope: call.scope,
        run_id: call.run_id,
        step_id: call.step_id,
        action_type: "gmail.send",
        idempotency_key: &key,
    };
    let effect = async {
        client
            .send_message(mailbox, draft)
            .await
            .map(|message| json!(message))
            .map_err(|error| error.to_string())
    };
    match ledger_once(&action, effect).await {
        Ok(value) => GmailOutcome::ok(value),
        Err(error) => GmailOutcome::failed(error),
    }
}

/// Turns a connector result into the action answer.
fn outcome<T: Serialize, E: std::fmt::Display>(result: Result<T, E>) -> GmailOutcome {
    match result {
        Ok(value) => match serde_json::to_value(value) {
            Ok(value) => GmailOutcome::ok(value),
            Err(error) => GmailOutcome::failed(error.to_string()),
        },
        Err(error) => GmailOutcome::failed(error.to_string()),
    }
}

/// The route's bridge around the action — `executeGmailActionThroughWorldModel`
/// (`route.ts:107-156`). Runs synchronously, driving the async chain once.
fn route_action(deps: &GmailDeps<'_>, request: &GmailRequest) -> GmailOutcome {
    let call = request.call();
    let driven = drive_sync(async {
        if request.skips_bridge() {
            return execute(deps, &call).await;
        }
        let action_type = format!("gmail.{}", request.action.as_str());
        let payload = json!({
            "action": request.action.as_str(),
            "query": request.query,
            "draft": request.draft,
            "decision": request.decision,
            "fingerprint": request.fingerprint,
        })
        .to_string();
        let key = ledger_key(&request.run_id, &request.step_id, &action_type, &payload);
        let input = MasterActionBridgeInput {
            user_id: request.scope.user_id.clone(),
            persona_id: None,
            workspace_id: Some(request.scope.workspace_id.clone()),
            task_id: request.run_id.clone(),
            action_type,
            idempotency_key: key,
            correlation_id: Some(request.run_id.clone()),
        };
        let bridged = deps
            .bridge
            .run(&input, || async {
                let outcome = execute(deps, &call).await;
                MasterActionRunOutput {
                    ok: outcome.ok,
                    error: outcome.error.clone(),
                    result: outcome.result.clone().unwrap_or(Value::Null),
                    receipt: None,
                }
            })
            .await;
        match bridged {
            Ok(bridged) => GmailOutcome {
                ok: bridged.succeeded,
                approval_required: false,
                result: bridged.result.filter(|value| !value.is_null()),
                error: bridged.error,
            },
            Err(error) => GmailOutcome::failed(format!(
                "Canonical World-Model bridge failed; Gmail action was not executed: {error}"
            )),
        }
    });
    match driven {
        Ok(outcome) => outcome,
        Err(error) => GmailOutcome::failed(error.into_message()),
    }
}

/// The working directory as the secret key is derived from it (`process.cwd()`).
fn working_directory() -> String {
    std::env::current_dir()
        .map(|path| path.display().to_string())
        .unwrap_or_default()
}

/// `POST /api/master/gmail` (`gmail/route.ts:30-105`).
pub(super) async fn post(
    Extension(services): Extension<Arc<Services>>,
    headers: HeaderMap,
    uri: Uri,
    body: Bytes,
) -> Reply {
    let user = user_or_401(&headers)?;
    let body = json_body(&body)?;
    let action = filled_field(&body, "action")
        .ok_or_else(|| ApiError::new(StatusCode::BAD_REQUEST, "action is required"))?;
    let scope = {
        let repos = services.repos().await;
        repos.scope(&query_of(&uri), &user, Some(&scope_body(&body)))?
    };

    match action.as_str() {
        "connect" => connect(&services, &scope, &body).await,
        "revoke" => revoke(&services, &scope, &body).await,
        other => {
            let Some(action) = GmailAction::parse(other) else {
                return Err(ApiError::new(
                    StatusCode::BAD_REQUEST,
                    format!("Unsupported gmail action: {other}"),
                ));
            };
            let (Some(run_id), Some(step_id)) =
                (filled_field(&body, "runId"), filled_field(&body, "stepId"))
            else {
                return Err(ApiError::new(
                    StatusCode::BAD_REQUEST,
                    "action, runId and stepId are required",
                ));
            };
            let request = GmailRequest {
                scope,
                run_id,
                step_id,
                action,
                query: string_field(&body, "query"),
                draft: body
                    .get("draft")
                    .and_then(|draft| serde_json::from_value(draft.clone()).ok()),
                decision: string_field(&body, "decision"),
                fingerprint: string_field(&body, "fingerprint"),
            };
            let blocking = Arc::clone(&services);
            let outcome = tokio::task::spawn_blocking(move || {
                let master = blocking.master.blocking_lock();
                let cwd = working_directory();
                let deps = GmailDeps {
                    repo: &*master,
                    env: &blocking.env,
                    transport: blocking.transport.clone(),
                    bridge: &blocking.action_bridge,
                    cwd: cwd.as_str(),
                };
                route_action(&deps, &request)
            })
            .await
            .map_err(server_error)?;
            let status = if outcome.approval_required {
                StatusCode::ACCEPTED
            } else if outcome.ok {
                StatusCode::OK
            } else {
                StatusCode::BAD_REQUEST
            };
            Ok((status, Json(outcome.into_json())).into_response())
        }
    }
}

/// The `connect` branch — `route.ts:42-54`.
async fn connect(services: &Services, scope: &WorkspaceScope, body: &Value) -> Reply {
    let access_token = string_field(body, "accessToken")
        .unwrap_or_default()
        .trim()
        .to_string();
    if access_token.is_empty() {
        return Err(ApiError::new(
            StatusCode::BAD_REQUEST,
            "accessToken is required",
        ));
    }
    let resolver = SecretKeyResolver::new(&services.env, working_directory());
    let repos = services.repos().await;
    store_connector_secret(
        &*repos.master,
        scope,
        &resolver,
        &StoreConnectorSecretInput {
            provider: "gmail".to_string(),
            key_ref: filled_field(body, "keyRef").unwrap_or_else(|| "default".to_string()),
            plain_text: access_token,
            expires_at: string_field(body, "expiresAt"),
        },
    )
    .map_err(bad_request)?;
    Ok(Json(json!({ "ok": true, "connected": true })).into_response())
}

/// The `revoke` branch — `route.ts:56-62`.
async fn revoke(services: &Services, scope: &WorkspaceScope, body: &Value) -> Reply {
    let repos = services.repos().await;
    revoke_connector_secret(
        &*repos.master,
        scope,
        &RevokeConnectorSecretInput {
            provider: "gmail".to_string(),
            key_ref: filled_field(body, "keyRef").unwrap_or_else(|| "default".to_string()),
        },
    )
    .map_err(bad_request)?;
    Ok(Json(json!({ "ok": true, "revoked": true })).into_response())
}

#[cfg(test)]
mod tests {
    use axum::http::{Method, StatusCode};
    use serde_json::{json, Value};

    use crate::families::master::test_support::{Harness, OWNER, SCOPE};

    /// The route runs its synchronous bridge on a blocking thread, which needs the
    /// multi-thread runtime the gateway runs on.
    async fn post(harness: &Harness, body: Value) -> (StatusCode, Value) {
        harness
            .send(
                Method::POST,
                &format!("/api/master/gmail{SCOPE}"),
                Some(OWNER),
                Some(&body.to_string()),
            )
            .await
    }

    async fn connect(harness: &Harness, token: &str) -> (StatusCode, Value) {
        post(
            harness,
            json!({ "action": "connect", "accessToken": token }),
        )
        .await
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn connect_needs_a_token() {
        let harness = Harness::new();
        let (status, body) = connect(&harness, "   ").await;
        assert_eq!(status, StatusCode::BAD_REQUEST);
        assert_eq!(body["error"], "accessToken is required");
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn read_without_a_connector_is_refused() {
        let harness = Harness::new();
        let (status, body) = post(
            &harness,
            json!({ "action": "read", "runId": "run-1", "stepId": "step-1" }),
        )
        .await;
        assert_eq!(status, StatusCode::BAD_REQUEST);
        assert_eq!(body["error"], "Gmail connector is not configured.");
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn a_connected_mock_mailbox_is_read() {
        let harness = Harness::new();
        let (status, body) = connect(&harness, "mock:token-1").await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(body["connected"], true);

        let (status, body) = post(
            &harness,
            json!({ "action": "read", "runId": "run-1", "stepId": "step-1" }),
        )
        .await;
        assert_eq!(status, StatusCode::OK, "{body}");
        assert_eq!(body["ok"], true);
        assert!(body["result"].is_array(), "{body}");
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn a_send_without_a_decision_awaits_approval() {
        let harness = Harness::new();
        connect(&harness, "mock:token-2").await;
        let (status, body) = post(
            &harness,
            json!({
                "action": "send",
                "runId": "run-1",
                "stepId": "step-1",
                "draft": { "to": "a@example.com", "subject": "Hi", "body": "Hello" }
            }),
        )
        .await;
        assert_eq!(status, StatusCode::ACCEPTED);
        assert_eq!(body["approvalRequired"], true);
        assert_eq!(body["error"], "Approval required for gmail.send");
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn an_approved_send_is_recorded_once() {
        let harness = Harness::new();
        connect(&harness, "mock:token-3").await;
        let send = json!({
            "action": "send",
            "runId": "run-7",
            "stepId": "step-7",
            "decision": "approve_once",
            "draft": { "to": "b@example.com", "subject": "Ping", "body": "Body" }
        });
        let (status, first) = post(&harness, send.clone()).await;
        assert_eq!(status, StatusCode::OK, "{first}");
        assert_eq!(first["ok"], true);
        let (status, second) = post(&harness, send).await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(
            first["result"], second["result"],
            "the replay reports the first send"
        );
    }
}
