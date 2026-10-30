//! Family master, services and routes.
//!
//! Port of the 18 route files under `app/api/master/**/route.ts`. Every handler
//! module names the TypeScript files it mirrors. The integrator builds [`Services`]
//! once with [`build`] and attaches it as `Extension<Arc<Services>>`.
//!
//! # Migration surface
//!
//! A method is served here when every TypeScript call behind it has a Rust port.
//! Everything else falls through to the Next.js proxy, so the TypeScript handler
//! keeps answering it:
//!
//! * `POST /api/master/approvals/{id}/decision` and `POST /api/master/runs/{id}/actions`:
//!   they start or resume runs on the execution runtime. The seams they need
//!   ([`tool_runner::GatewayToolRunner`] and [`model::ModelHubDispatch`]) are attached
//!   to [`Services`], but the routes are not wired to them yet.
//!
//! Reminders are native: the writes sync the cron scheduler through
//! [`automation::CronBridge`], so they need the [`automation::AutomationRuntimePort`]
//! the integrator passes in [`RuntimeSeams`]. Gmail is native too ([`gmail`]).
//!
//! Partly migrated paths keep the proxy as the method fallback, the same way the
//! personas routes do. Otherwise axum would answer `405` for the unported method.

pub mod action_bridge;
pub mod automation;
pub mod events;
mod gmail;
pub mod model;
mod notes;
mod reminders;
mod runs;
mod settings;
pub mod skills;
mod subagents;
mod support;
pub mod tool_runner;
mod voice;

#[cfg(test)]
mod test_support;

use std::sync::Arc;

use axum::extract::Extension;
use axum::http::{HeaderMap, StatusCode, Uri};
use axum::response::IntoResponse;
use axum::routing::{get, post};
use axum::{Json, Router};
use betaclaw_core::gateway::registry::ClientRegistry;
use betaclaw_core::master::approvals::service::LIST_APPROVAL_REQUESTS_LIMIT;
use betaclaw_core::master::execution::runtime::capability_executor::MasterToolRunner;
use betaclaw_core::master::execution::runtime::execution_plan::MasterModelDispatch;
use betaclaw_core::master::feature_flags::{is_master_approval_control_plane_enabled, MasterEnv};
use betaclaw_core::master::metrics::collect_master_metrics;
use betaclaw_core::master::repository::sqlite_master_repository::SqliteMasterRepository;
use betaclaw_core::model_hub::env::EnvOverrides;
use betaclaw_core::model_hub::http::HttpTransport;
use betaclaw_core::personas::repository::{PersonaRepository, PersonaRepositoryError};
use betaclaw_core::personas::PersonaWorkspace;
use chrono::Utc;
use serde_json::json;
use tokio::sync::Mutex;

use crate::model_hub_transport::ReqwestTransport;
use crate::proxy::proxy_to_upstream;
use crate::state::SharedState;

use action_bridge::ActionBridge;
use automation::AutomationRuntimePort;
use model::ModelHubDispatch;
use skills::SkillDispatcher;
use support::{query_of, user_or_401, ApiError, Reply};
use tool_runner::GatewayToolRunner;

/// The state the master routes read and write, shared by every handler.
///
/// Each store sits behind a tokio mutex: `rusqlite::Connection` is synchronous.
/// Lock order is `personas`, then `master`; see [`support::Repos`].
pub struct Services {
    pub master: Mutex<SqliteMasterRepository>,
    pub personas: Mutex<PersonaRepository>,
    /// Model Hub database, opened per request as the personas route does.
    pub model_hub_db_path: String,
    /// Process environment snapshot for the feature flags.
    pub env: MasterEnv,
    pub events: events::MasterEventBus,
    /// Outbound HTTP for the voice-session token request.
    pub transport: Arc<dyn HttpTransport + Send + Sync>,
    /// The automation service the cron bridge writes rules through.
    pub automation: Arc<dyn AutomationRuntimePort>,
    /// `MasterModelDispatch` over the Model Hub, for the planner and the code generator.
    pub model: Arc<dyn MasterModelDispatch + Send + Sync>,
    /// `MasterToolRunner` over the skills and the S6 bridge.
    pub tool_runner: Arc<dyn MasterToolRunner>,
    /// The S6 bridge, shared by the tool runner and the Gmail route.
    pub action_bridge: Arc<ActionBridge>,
}

/// The runtime collaborators the integrator supplies to [`build`].
pub struct RuntimeSeams {
    /// The automation service behind the cron bridge (see [`automation::open_automation_port`]).
    pub automation: Arc<dyn AutomationRuntimePort>,
    /// The skill dispatcher the tool runner calls (see [`skills::CoreSkillDispatcher`]).
    pub skills: Arc<dyn SkillDispatcher>,
    /// The S6 bridge configuration and executor.
    pub action_bridge: Arc<ActionBridge>,
    /// The gateway client registry. `master.updated` is also sent to the user's
    /// connections through it. `None` keeps the events on the family bus.
    pub process_bus: Option<Arc<ClientRegistry>>,
}

/// Failures while opening the stores behind [`Services`].
#[derive(Debug, thiserror::Error)]
pub enum BuildError {
    #[error("failed to open the master store: {0}")]
    Master(#[from] rusqlite::Error),
    #[error("failed to open the persona store: {0}")]
    Personas(#[from] PersonaRepositoryError),
}

/// Opens the master and persona stores and builds the family services.
///
/// `personas_root` is the directory the persona workspaces live in. The Model
/// Hub database is opened per request, so only its path is kept.
pub fn build(
    master_db_path: &str,
    personas_db_path: &str,
    personas_root: &str,
    model_hub_db_path: &str,
    env: MasterEnv,
    runtime: RuntimeSeams,
) -> Result<Services, BuildError> {
    let RuntimeSeams {
        automation,
        skills,
        action_bridge,
        process_bus,
    } = runtime;
    let transport: Arc<dyn HttpTransport + Send + Sync> = Arc::new(ReqwestTransport::new());
    Ok(Services {
        master: Mutex::new(SqliteMasterRepository::open(master_db_path)?),
        personas: Mutex::new(PersonaRepository::open_with_workspace(
            personas_db_path,
            PersonaWorkspace::new(personas_root),
        )?),
        model_hub_db_path: model_hub_db_path.to_string(),
        env,
        events: events::MasterEventBus::new(process_bus),
        model: Arc::new(ModelHubDispatch::new(
            model_hub_db_path,
            transport.clone(),
            EnvOverrides::new(),
        )),
        transport,
        automation,
        tool_runner: Arc::new(GatewayToolRunner::new(skills, Arc::clone(&action_bridge))),
        action_bridge,
    })
}

/// The master routes. Methods without a native handler reach the proxy.
pub fn router() -> Router<SharedState> {
    Router::new()
        .route(
            "/api/master/approvals",
            get(list_approvals).fallback(proxy_to_upstream),
        )
        .route(
            "/api/master/events",
            get(events::stream).fallback(proxy_to_upstream),
        )
        .route(
            "/api/master/gmail",
            post(gmail::post).fallback(proxy_to_upstream),
        )
        .route(
            "/api/master/approvals/{id}/decision",
            post(runs::approval_decision).fallback(proxy_to_upstream),
        )
        .route(
            "/api/master/runs/{id}/actions",
            post(runs::run_actions).fallback(proxy_to_upstream),
        )
        .route(
            "/api/master/metrics",
            get(metrics).fallback(proxy_to_upstream),
        )
        .route(
            "/api/master/notes",
            get(notes::list)
                .post(notes::create)
                .patch(notes::update)
                .delete(notes::delete)
                .fallback(proxy_to_upstream),
        )
        .route(
            "/api/master/reminders",
            get(reminders::list)
                .post(reminders::create)
                .patch(reminders::patch_collection)
                .delete(reminders::delete_collection)
                .fallback(proxy_to_upstream),
        )
        .route(
            "/api/master/reminders/{id}",
            get(reminders::get_reminder)
                .patch(reminders::patch_one)
                .delete(reminders::delete_one)
                .fallback(proxy_to_upstream),
        )
        .route(
            "/api/master/reminders/{id}/fire",
            post(reminders::fire).fallback(proxy_to_upstream),
        )
        .route(
            "/api/master/runs",
            get(runs::list)
                .post(runs::create)
                .fallback(proxy_to_upstream),
        )
        .route(
            "/api/master/runs/{id}",
            get(runs::get_run)
                .patch(runs::update_run)
                .fallback(proxy_to_upstream),
        )
        .route(
            "/api/master/runs/{id}/delegations",
            get(runs::list_delegations)
                .post(runs::create_delegation)
                .fallback(proxy_to_upstream),
        )
        .route(
            "/api/master/runs/{id}/feedback",
            post(runs::feedback).fallback(proxy_to_upstream),
        )
        .route(
            "/api/master/settings",
            get(settings::get_settings)
                .put(settings::put_settings)
                .fallback(proxy_to_upstream),
        )
        .route(
            "/api/master/subagents",
            get(subagents::list).fallback(proxy_to_upstream),
        )
        .route(
            "/api/master/subagents/{id}",
            get(subagents::get_session)
                .patch(subagents::cancel_session)
                .fallback(proxy_to_upstream),
        )
        .route(
            "/api/master/voice-session",
            get(voice::session).fallback(proxy_to_upstream),
        )
}

/// `GET /api/master/approvals` (`approvals/route.ts:9-40`).
///
/// The flag check comes before the identity check, as in the source. Both
/// `approvals` and `approvalRequests` carry the same list.
async fn list_approvals(
    Extension(services): Extension<Arc<Services>>,
    headers: HeaderMap,
    uri: Uri,
) -> Reply {
    if !is_master_approval_control_plane_enabled(&services.env) {
        return Err(ApiError::new(
            StatusCode::NOT_FOUND,
            "Master approval control plane is disabled.",
        ));
    }
    let user = user_or_401(&headers)?;
    let query = query_of(&uri);
    let repos = services.repos().await;
    let scope = repos.scope(&query, &user, None)?;
    let run_id = query.get("runId").filter(|value| !value.is_empty());
    let status = query.get("status").filter(|value| !value.is_empty());
    let requests = repos
        .master
        .list_approval_requests(&scope, run_id.as_deref(), LIST_APPROVAL_REQUESTS_LIMIT)
        .map_err(support::bad_request)?;
    let approvals: Vec<_> = requests
        .into_iter()
        .filter(|request| {
            status
                .as_ref()
                .is_none_or(|wanted| &request.status == wanted)
        })
        .collect();
    Ok(Json(json!({
        "ok": true,
        "approvals": &approvals,
        "approvalRequests": &approvals,
    }))
    .into_response())
}

/// `GET /api/master/metrics` (`metrics/route.ts:9-23`).
async fn metrics(
    Extension(services): Extension<Arc<Services>>,
    headers: HeaderMap,
    uri: Uri,
) -> Reply {
    let user = user_or_401(&headers)?;
    let repos = services.repos().await;
    let scope = repos.scope(&query_of(&uri), &user, None)?;
    let metrics =
        collect_master_metrics(&*repos.master, &scope, Utc::now()).map_err(support::bad_request)?;
    Ok(Json(json!({ "ok": true, "metrics": metrics })).into_response())
}

#[cfg(test)]
mod tests {
    use axum::http::{Method, StatusCode};
    use betaclaw_core::master::feature_flags::MasterEnv;

    use super::test_support::{Harness, OWNER, SCOPE};

    fn disabled(name: &str) -> MasterEnv {
        MasterEnv::from([(name.to_string(), "0".to_string())])
    }

    #[tokio::test]
    async fn approvals_list_is_native_and_flag_gated() {
        let harness = Harness::new();
        let (status, body) = harness
            .send(
                Method::GET,
                &format!("/api/master/approvals{SCOPE}"),
                Some(OWNER),
                None,
            )
            .await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(body["ok"], true);
        assert!(body["approvals"].is_array());
        assert_eq!(body["approvals"], body["approvalRequests"]);

        let (status, body) = harness
            .send(
                Method::GET,
                &format!("/api/master/approvals{SCOPE}"),
                None,
                None,
            )
            .await;
        assert_eq!(status, StatusCode::UNAUTHORIZED);
        assert_eq!(body["error"], "Unauthorized");

        let gated = Harness::with_env(disabled("MASTER_APPROVAL_CONTROL_PLANE_ENABLED"));
        let (status, body) = gated
            .send(
                Method::GET,
                &format!("/api/master/approvals{SCOPE}"),
                Some(OWNER),
                None,
            )
            .await;
        assert_eq!(status, StatusCode::NOT_FOUND);
        assert_eq!(body["error"], "Master approval control plane is disabled.");
    }

    #[tokio::test]
    async fn metrics_returns_the_collected_map() {
        let harness = Harness::new();
        let (status, body) = harness
            .send(
                Method::GET,
                &format!("/api/master/metrics{SCOPE}"),
                Some(OWNER),
                None,
            )
            .await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(body["ok"], true);
        assert!(body["metrics"].is_object());

        let (status, body) = harness
            .send(
                Method::GET,
                &format!("/api/master/metrics{SCOPE}"),
                None,
                None,
            )
            .await;
        assert_eq!(status, StatusCode::UNAUTHORIZED);
        assert_eq!(body["error"], "Unauthorized");
    }

    #[tokio::test]
    async fn unported_master_methods_fall_through_to_the_proxy() {
        // The upstream origin refuses connections, so each unmapped method is a 502.
        let harness = Harness::new();
        let cases = [
            (
                Method::DELETE,
                "/api/master/runs/r1/actions",
                r#"{"actionType":"run.start","stepId":"s"}"#,
            ),
            (
                Method::GET,
                "/api/master/approvals/a1/decision",
                r#"{"decision":"deny"}"#,
            ),
        ];
        for (method, uri, body) in cases {
            let (status, _) = harness.send(method, uri, Some(OWNER), Some(body)).await;
            assert_eq!(status, StatusCode::BAD_GATEWAY, "{uri}");
        }
    }

    #[tokio::test]
    async fn run_actions_and_approval_decision_are_served_natively() {
        let harness = Harness::new();
        let (status, body) = harness
            .send(
                Method::POST,
                "/api/master/runs/r1/actions",
                Some(OWNER),
                Some("{}"),
            )
            .await;
        assert_eq!(status, StatusCode::BAD_REQUEST);
        assert_eq!(body["error"], "actionType and stepId are required");

        let (status, body) = harness
            .send(
                Method::POST,
                "/api/master/approvals/a1/decision",
                Some(OWNER),
                Some("{}"),
            )
            .await;
        assert_eq!(status, StatusCode::BAD_REQUEST);
        assert_eq!(body["error"], "decision is required");
    }
}
