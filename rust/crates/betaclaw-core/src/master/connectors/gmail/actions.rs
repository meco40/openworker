//! Port of `src/server/master/connectors/gmail/actions.ts:1-91`.
//!
//! `executeGmailAction` runs `read`, `search`, `draft` and `send`. `send` is
//! always approval-gated. It runs as one idempotent action through the S6
//! [`MasterActionBridge`] (OP-S9-4), and its effect runs under
//! [`MasterActionLedgerService::execute_exactly_once_async`].
//!
//! # Errors
//!
//! The source throws when the OAuth row cannot be read, when the Gmail client
//! cannot be built, and when `read`, `search` or `draft` fail at the API. Those
//! are `Err` here. A failure around the bridged `send` is caught and reported as
//! `ok: false`, as the source does at `actions.ts:90-96`.

use std::sync::Arc;

use serde::Serialize;
use serde_json::Value;

use crate::master::action_bridge::{
    boxed, MasterActionBridge, MasterActionBridgeInput, MasterActionRun,
};
use crate::master::connectors::gmail::client::GmailClient;
use crate::master::connectors::gmail::oauth::{load_gmail_oauth_state, DEFAULT_GMAIL_KEY_REF};
use crate::master::connectors::gmail::types::GmailDraftInput;
use crate::master::connectors::secret_store::SecretKeyResolver;
use crate::master::execution::action_ledger::MasterActionLedgerService;
use crate::master::execution::idempotency::build_idempotency_key;
use crate::master::feature_flags::MasterEnv;
use crate::master::orchestrator::BuildIdempotencyKeyInput;
use crate::master::repository::MasterRepository;
use crate::master::types::{ApprovalDecision, WorkspaceScope};
use crate::model_hub::http::HttpTransport;

/// `GmailAction` from `actions.ts:10`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum GmailAction {
    Read,
    Search,
    Draft,
    Send,
}

/// The `action_type` of the send path (`actions.ts:65`, `:75`, `:82`).
const SEND_ACTION_TYPE: &str = "gmail.send";

/// The collaborators of `executeGmailAction`.
pub struct GmailActionDeps<'a> {
    pub repo: &'a dyn MasterRepository,
    pub bridge: &'a dyn MasterActionBridge,
    pub resolver: &'a SecretKeyResolver,
    /// The S4 `HttpTransport` of the Gmail client.
    pub transport: Arc<dyn HttpTransport>,
    /// `process.env` as the Gmail client reads it.
    pub env: &'a MasterEnv,
}

/// `input` of `executeGmailAction` — `actions.ts:12-23`.
pub struct GmailActionInput<'a> {
    pub scope: &'a WorkspaceScope,
    pub run_id: &'a str,
    pub step_id: &'a str,
    pub action: GmailAction,
    pub query: Option<&'a str>,
    pub draft: Option<&'a GmailDraftInput>,
    pub decision: Option<ApprovalDecision>,
    pub fingerprint: Option<&'a str>,
}

/// `{ ok, approvalRequired?, result?, error? }` — `actions.ts:24`.
#[derive(Debug, Clone, PartialEq)]
pub struct GmailActionOutcome {
    pub ok: bool,
    pub approval_required: bool,
    pub result: Option<Value>,
    pub error: Option<String>,
}

impl GmailActionOutcome {
    fn succeeded(result: Value) -> Self {
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

    fn approval_required() -> Self {
        Self {
            ok: false,
            approval_required: true,
            result: None,
            error: Some("Approval required for gmail.send".to_string()),
        }
    }
}

/// `executeGmailAction` — `actions.ts:12-98`.
pub async fn execute_gmail_action(
    deps: &GmailActionDeps<'_>,
    input: GmailActionInput<'_>,
) -> Result<GmailActionOutcome, String> {
    let Some(oauth) =
        load_gmail_oauth_state(deps.repo, input.scope, deps.resolver, DEFAULT_GMAIL_KEY_REF)
            .map_err(|error| error.to_string())?
    else {
        return Ok(GmailActionOutcome::failed(
            "Gmail connector is not configured.",
        ));
    };
    let client = GmailClient::new(oauth.access_token, deps.transport.clone(), deps.env.clone())
        .map_err(|error| error.to_string())?;
    let mailbox_key = format!("{}:{}", input.scope.user_id, input.scope.workspace_id);

    match input.action {
        GmailAction::Read => {
            let messages = client
                .list_messages(&mailbox_key)
                .await
                .map_err(|error| error.to_string())?;
            Ok(GmailActionOutcome::succeeded(to_value(&messages)?))
        }
        GmailAction::Search => {
            let messages = client
                .search_messages(&mailbox_key, input.query.unwrap_or(""))
                .await
                .map_err(|error| error.to_string())?;
            Ok(GmailActionOutcome::succeeded(to_value(&messages)?))
        }
        GmailAction::Draft => {
            let Some(draft) = input.draft else {
                return Ok(GmailActionOutcome::failed("draft payload is required"));
            };
            let message = client
                .create_draft(draft)
                .await
                .map_err(|error| error.to_string())?;
            Ok(GmailActionOutcome::succeeded(to_value(&message)?))
        }
        GmailAction::Send => send(deps, client, &mailbox_key, input).await,
    }
}

/// The `send` branch — `actions.ts:43-96`.
async fn send(
    deps: &GmailActionDeps<'_>,
    client: GmailClient,
    mailbox_key: &str,
    input: GmailActionInput<'_>,
) -> Result<GmailActionOutcome, String> {
    // send is always approval-gated (`actions.ts:43`).
    let Some(decision) = input.decision else {
        return Ok(GmailActionOutcome::approval_required());
    };
    if matches!(decision, ApprovalDecision::Deny) {
        return Ok(GmailActionOutcome::failed("Action denied by operator."));
    }
    let Some(draft) = input.draft else {
        return Ok(GmailActionOutcome::failed("draft payload is required"));
    };
    if matches!(decision, ApprovalDecision::ApproveAlways) {
        let fingerprint = input
            .fingerprint
            .filter(|value| !value.is_empty())
            .map_or_else(|| format!("{}:{}", draft.to, draft.subject), str::to_string);
        deps.repo
            .upsert_approval_rule(
                input.scope,
                SEND_ACTION_TYPE,
                &fingerprint,
                ApprovalDecision::ApproveAlways.as_str(),
            )
            .map_err(|error| error.to_string())?;
    }

    let payload = serde_json::to_string(draft).map_err(|error| error.to_string())?;
    let idempotency_key = build_idempotency_key(&BuildIdempotencyKeyInput {
        run_id: input.run_id,
        step_id: input.step_id,
        action_type: SEND_ACTION_TYPE,
        action_payload: &payload,
    });
    let ledger = MasterActionLedgerService::new(deps.repo);
    let scope = input.scope;
    let run_id = input.run_id;
    let step_id = input.step_id;

    let bridged = deps
        .bridge
        .bridge_master_action(MasterActionBridgeInput {
            user_id: input.scope.user_id.clone(),
            persona_id: None,
            workspace_id: Some(input.scope.workspace_id.clone()),
            task_id: input.run_id.to_string(),
            action_type: SEND_ACTION_TYPE.to_string(),
            idempotency_key: idempotency_key.clone(),
            correlation_id: None,
            run: Box::new(move || {
                boxed(async move {
                    let executed = ledger
                        .execute_exactly_once_async(
                            scope,
                            run_id,
                            step_id,
                            SEND_ACTION_TYPE,
                            &idempotency_key,
                            move || async move {
                                let sent = client
                                    .send_message(mailbox_key, draft)
                                    .await
                                    .map_err(|error| error.to_string())?;
                                to_value(&sent)
                            },
                        )
                        .await?;
                    Ok::<_, String>(MasterActionRun {
                        ok: true,
                        error: None,
                        result: executed.result,
                        receipt: None,
                    })
                })
            }),
        })
        .await;

    match bridged {
        Ok(bridged) => Ok(GmailActionOutcome {
            ok: bridged.succeeded,
            approval_required: false,
            result: bridged.result,
            error: bridged.error,
        }),
        Err(error) => Ok(GmailActionOutcome::failed(format!(
            "Canonical World-Model bridge failed; Gmail send was not executed: {error}"
        ))),
    }
}

fn to_value<T: Serialize>(value: &T) -> Result<Value, String> {
    serde_json::to_value(value).map_err(|error| error.to_string())
}

#[cfg(test)]
mod tests {
    use futures_util::future::BoxFuture;

    use super::*;
    use crate::master::action_bridge::MasterActionBridgeResult;
    use crate::master::connectors::secret_policies::{
        rotate_connector_secret, RotateConnectorSecretInput,
    };
    use crate::master::repository::sqlite_master_repository::SqliteMasterRepository;
    use crate::model_hub::http::UnreachableTransport;

    /// Runs the bridged `run` like the S6 bridge does. `fail` simulates a bridge
    /// that rejects before it runs anything.
    struct FakeBridge {
        fail: Option<String>,
    }

    impl MasterActionBridge for FakeBridge {
        fn bridge_master_action<'a>(
            &'a self,
            input: MasterActionBridgeInput<'a>,
        ) -> BoxFuture<'a, Result<MasterActionBridgeResult, String>> {
            let fail = self.fail.clone();
            boxed(async move {
                if let Some(error) = fail {
                    return Err(error);
                }
                let attempt_id = format!("attempt-{}", input.idempotency_key);
                let outcome = (input.run)().await?;
                Ok(MasterActionBridgeResult {
                    attempt_id,
                    succeeded: outcome.ok,
                    created: true,
                    error: outcome.error,
                    replayed: false,
                    result: Some(outcome.result),
                    receipt: outcome.receipt,
                })
            })
        }
    }

    fn scope() -> WorkspaceScope {
        WorkspaceScope {
            user_id: "u1".to_string(),
            workspace_id: "w1".to_string(),
        }
    }

    fn env() -> MasterEnv {
        let mut env = MasterEnv::new();
        env.insert(
            "BETACLAW_MASTER_SECRET_KEY".to_string(),
            "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef".to_string(),
        );
        env.insert("BETACLAW_MASTER_GMAIL_MODE".to_string(), "mock".to_string());
        env
    }

    fn draft() -> GmailDraftInput {
        GmailDraftInput {
            to: "a@example.com".to_string(),
            subject: "Hello".to_string(),
            body: "Body".to_string(),
        }
    }

    /// Stores a Gmail token, or none when `token` is `None`.
    fn repo_with_token(env: &MasterEnv, token: Option<&str>) -> SqliteMasterRepository {
        let repo = SqliteMasterRepository::open(":memory:").unwrap();
        if let Some(token) = token {
            let resolver = SecretKeyResolver::new(env, "/ws");
            rotate_connector_secret(
                &repo,
                &scope(),
                &resolver,
                &RotateConnectorSecretInput {
                    provider: "gmail".to_string(),
                    key_ref: DEFAULT_GMAIL_KEY_REF.to_string(),
                    next_plain_text: token.to_string(),
                    expires_at: None,
                },
            )
            .unwrap();
        }
        repo
    }

    fn deps<'a>(
        repo: &'a dyn MasterRepository,
        bridge: &'a dyn MasterActionBridge,
        resolver: &'a SecretKeyResolver,
        env: &'a MasterEnv,
    ) -> GmailActionDeps<'a> {
        GmailActionDeps {
            repo,
            bridge,
            resolver,
            transport: Arc::new(UnreachableTransport),
            env,
        }
    }

    fn input<'a>(
        scope: &'a WorkspaceScope,
        action: GmailAction,
        decision: Option<ApprovalDecision>,
        draft: Option<&'a GmailDraftInput>,
    ) -> GmailActionInput<'a> {
        GmailActionInput {
            scope,
            run_id: "run-1",
            step_id: "step-1",
            action,
            query: None,
            draft,
            decision,
            fingerprint: None,
        }
    }

    #[tokio::test]
    async fn a_missing_token_is_reported_not_thrown() {
        let env = env();
        let repo = repo_with_token(&env, None);
        let resolver = SecretKeyResolver::new(&env, "/ws");
        let bridge = FakeBridge { fail: None };
        let scope = scope();

        let outcome = execute_gmail_action(
            &deps(&repo, &bridge, &resolver, &env),
            input(&scope, GmailAction::Read, None, None),
        )
        .await
        .unwrap();
        assert!(!outcome.ok);
        assert_eq!(
            outcome.error.as_deref(),
            Some("Gmail connector is not configured.")
        );
    }

    #[tokio::test]
    async fn read_lists_messages_in_mock_mode() {
        let env = env();
        let repo = repo_with_token(&env, Some("token-1"));
        let resolver = SecretKeyResolver::new(&env, "/ws");
        let bridge = FakeBridge { fail: None };
        let scope = scope();

        let outcome = execute_gmail_action(
            &deps(&repo, &bridge, &resolver, &env),
            input(&scope, GmailAction::Read, None, None),
        )
        .await
        .unwrap();
        assert!(outcome.ok);
        assert!(outcome.result.unwrap().is_array());
    }

    #[tokio::test]
    async fn a_send_without_a_decision_asks_for_approval() {
        let env = env();
        let repo = repo_with_token(&env, Some("token-1"));
        let resolver = SecretKeyResolver::new(&env, "/ws");
        let bridge = FakeBridge { fail: None };
        let scope = scope();
        let draft = draft();

        let outcome = execute_gmail_action(
            &deps(&repo, &bridge, &resolver, &env),
            input(&scope, GmailAction::Send, None, Some(&draft)),
        )
        .await
        .unwrap();
        assert!(outcome.approval_required);
        assert!(!outcome.ok);
    }

    #[tokio::test]
    async fn a_denied_send_never_reaches_the_bridge() {
        let env = env();
        let repo = repo_with_token(&env, Some("token-1"));
        let resolver = SecretKeyResolver::new(&env, "/ws");
        // The bridge would fail with a different message if it were called.
        let bridge = FakeBridge {
            fail: Some("bridge must not run".to_string()),
        };
        let scope = scope();
        let draft = draft();

        let outcome = execute_gmail_action(
            &deps(&repo, &bridge, &resolver, &env),
            input(
                &scope,
                GmailAction::Send,
                Some(ApprovalDecision::Deny),
                Some(&draft),
            ),
        )
        .await
        .unwrap();
        assert_eq!(outcome.error.as_deref(), Some("Action denied by operator."));
    }

    #[tokio::test]
    async fn an_approved_send_runs_through_the_bridge() {
        let env = env();
        let repo = repo_with_token(&env, Some("token-1"));
        let resolver = SecretKeyResolver::new(&env, "/ws");
        let bridge = FakeBridge { fail: None };
        let scope = scope();
        let draft = draft();

        let outcome = execute_gmail_action(
            &deps(&repo, &bridge, &resolver, &env),
            input(
                &scope,
                GmailAction::Send,
                Some(ApprovalDecision::ApproveOnce),
                Some(&draft),
            ),
        )
        .await
        .unwrap();
        assert!(outcome.ok);
        assert!(outcome.result.is_some());
    }

    #[tokio::test]
    async fn a_bridge_rejection_is_reported_as_not_executed() {
        let env = env();
        let repo = repo_with_token(&env, Some("token-1"));
        let resolver = SecretKeyResolver::new(&env, "/ws");
        let bridge = FakeBridge {
            fail: Some("bridge down".to_string()),
        };
        let scope = scope();
        let draft = draft();

        let outcome = execute_gmail_action(
            &deps(&repo, &bridge, &resolver, &env),
            input(
                &scope,
                GmailAction::Send,
                Some(ApprovalDecision::ApproveOnce),
                Some(&draft),
            ),
        )
        .await
        .unwrap();
        assert!(!outcome.ok);
        assert_eq!(
            outcome.error.as_deref(),
            Some("Canonical World-Model bridge failed; Gmail send was not executed: bridge down")
        );
    }
}
