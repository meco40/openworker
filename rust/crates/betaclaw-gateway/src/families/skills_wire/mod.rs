//! Family skills_wire: the skill, ClawHub and file preview routes.
//!
//! Ports `app/api/skills/**`, `app/api/clawhub/**` and `app/api/files/**`. Each
//! route module names its TypeScript source. `POST /api/skills/execute` runs the
//! skill through the core dispatcher ([`crate::families::master::skills::CoreSkillDispatcher`]),
//! behind the same activation check and exec-approval gate as TypeScript. Two paths stay
//! on the proxy, because core has no port of their logic yet:
//! - `POST /api/skills` (`skillInstaller.ts`: GitHub and npm downloads),
//! - `/api/skills/external-host` (`externalSkillHost.ts`: process supervisor).
//!
//! Handlers take the services through `Extension<Arc<Services>>`.

mod clawhub;
mod files;
mod skills;
#[cfg(test)]
mod test_support;

use std::path::PathBuf;
use std::sync::Arc;

use axum::http::{StatusCode, Uri};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, patch, post};
use axum::{Json, Router};
use betaclaw_core::clawhub::cli::{ClawHubCli, ClawHubCliOptions, ProcessRunner};
use betaclaw_core::clawhub::errors::ClawHubError;
use betaclaw_core::clawhub::repository::ClawHubRepository;
use betaclaw_core::clawhub::service::ClawHubService;
use betaclaw_core::skills::builtin_skills::built_in_skills;
use betaclaw_core::skills::exec_approval::ExecApprovalStore;
use betaclaw_core::skills::runtime_config::SkillRuntimeConfigStore;
use betaclaw_core::skills::store::SkillRepository;
use betaclaw_core::skills::types::{js_to_string, SkillError};
use serde_json::{json, Value};

use crate::families::master::skills::SkillDispatcher;
use crate::proxy::proxy_to_upstream;
use crate::state::SharedState;

/// The stores and the ClawHub service of this family.
pub struct Services {
    /// Skill rows (`skillRepository.ts`).
    pub skills: SkillRepository,
    /// Runtime config of skills, in the same file as the skill rows (`runtimeConfig.ts`).
    pub runtime_config: SkillRuntimeConfigStore,
    /// ClawHub service (`clawhubService.ts`), running the `clawhub` CLI.
    pub clawhub: ClawHubService<ProcessRunner>,
    /// Exec approvals (`exec-approval-manager.ts`). Read by the `execute` route's dispatcher.
    pub exec_approvals: ExecApprovalStore,
    /// The skill dispatcher behind `POST /api/skills/execute` (`dispatchSkill` in
    /// `executeSkill.ts`). It carries the exec-approval store and the path guard.
    pub dispatcher: Arc<dyn SkillDispatcher>,
}

/// Failures while opening the stores in [`build`].
#[derive(Debug, thiserror::Error)]
pub enum BuildError {
    #[error("skills store: {0}")]
    Skills(#[from] SkillError),
    #[error("clawhub store: {0}")]
    ClawHub(#[from] ClawHubError),
}

/// Opens the stores and builds the services.
///
/// - `skills_db_path`: `SKILLS_DB_PATH`. The skill rows and the runtime config share it.
/// - `clawhub_db_path`: `CLAWHUB_DB_PATH`.
/// - `workspace_dir`: `CLAWHUB_WORKDIR`, where `skills/` and `.clawhub/lock.json` live.
/// - `exec_approvals_path`: the approval file, `<cwd>/.local/exec-approvals.json` by default.
/// - `dispatcher`: the skill dispatcher behind `POST /api/skills/execute`. The caller builds it,
///   because it also carries the exec-approval store and the persona workspace.
///
/// The built-in skills are seeded here, once, as `getSkillRepository` seeds them on
/// first use. `CLAWHUB_BIN` is read through the core CLI options.
pub fn build(
    skills_db_path: &str,
    clawhub_db_path: &str,
    workspace_dir: PathBuf,
    exec_approvals_path: PathBuf,
    dispatcher: Arc<dyn SkillDispatcher>,
) -> Result<Services, BuildError> {
    let skills = SkillRepository::open(skills_db_path)?;
    skills.seed_built_ins(&built_in_skills())?;
    let runtime_config = SkillRuntimeConfigStore::open(skills_db_path)?;
    let cli = ClawHubCli::new(
        ProcessRunner,
        ClawHubCliOptions::from_env(workspace_dir.clone()),
    );
    let repository = ClawHubRepository::open(clawhub_db_path)?;
    Ok(Services {
        skills,
        runtime_config,
        clawhub: ClawHubService::new(cli, repository, workspace_dir),
        exec_approvals: ExecApprovalStore::new(exec_approvals_path),
        dispatcher,
    })
}

pub fn router() -> Router<SharedState> {
    Router::new()
        .route(
            "/api/skills",
            get(skills::list)
                .post(skills::install)
                .fallback(proxy_to_upstream),
        )
        // Static segments win over `{id}`, so `external-host` keeps its own path.
        .route(
            "/api/skills/execute",
            post(skills::execute).fallback(proxy_to_upstream),
        )
        .route(
            "/api/skills/external-host",
            get(skills::external_host_get)
                .post(skills::external_host_post)
                .fallback(proxy_to_upstream),
        )
        .route(
            "/api/skills/runtime-config",
            get(skills::get_runtime_config)
                .put(skills::put_runtime_config)
                .delete(skills::delete_runtime_config)
                .fallback(proxy_to_upstream),
        )
        .route(
            "/api/skills/{id}",
            patch(skills::patch_skill)
                .delete(skills::delete_skill)
                .fallback(proxy_to_upstream),
        )
        .route(
            "/api/clawhub/install",
            post(clawhub::install).fallback(proxy_to_upstream),
        )
        .route(
            "/api/clawhub/installed",
            get(clawhub::installed).fallback(proxy_to_upstream),
        )
        .route(
            "/api/clawhub/prompt",
            get(clawhub::prompt).fallback(proxy_to_upstream),
        )
        .route(
            "/api/clawhub/search",
            get(clawhub::search).fallback(proxy_to_upstream),
        )
        .route(
            "/api/clawhub/update",
            post(clawhub::update).fallback(proxy_to_upstream),
        )
        .route(
            "/api/clawhub/{slug}",
            patch(clawhub::set_enabled)
                .delete(clawhub::uninstall)
                .fallback(proxy_to_upstream),
        )
        .route(
            "/api/files/preview",
            get(files::preview).fallback(proxy_to_upstream),
        )
        .route(
            "/api/files/reveal",
            post(files::reveal).fallback(proxy_to_upstream),
        )
}

/// `{ ok: false, error }`, the shape of the skill and ClawHub routes.
fn error_response(status: StatusCode, message: &str) -> Response {
    (status, Json(json!({ "ok": false, "error": message }))).into_response()
}

/// `{ error }`, the shape of the file routes, which have no `ok` key.
fn plain_error(status: StatusCode, message: &str) -> Response {
    (status, Json(json!({ "error": message }))).into_response()
}

/// `new URL(request.url).searchParams.get(name)`: the first value, decoded.
fn query_param(uri: &Uri, name: &str) -> Option<String> {
    let url = reqwest::Url::parse(&format!("http://localhost{uri}")).ok()?;
    url.query_pairs()
        .find(|(key, _)| key == name)
        .map(|(_, value)| value.into_owned())
}

/// `String(value || '')`: a missing, null, false or empty value gives "".
fn js_text(value: Option<&Value>) -> String {
    match value {
        None | Some(Value::Null | Value::Bool(false)) => String::new(),
        Some(Value::String(text)) => text.clone(),
        Some(other) => js_to_string(other),
    }
}

#[cfg(test)]
mod tests {
    use axum::http::{Method, StatusCode};

    use super::test_support::{harness, send, OWNER};

    #[tokio::test]
    async fn unported_routes_fall_through_to_the_proxy() {
        let h = harness();
        let cases: [(Method, &str, Option<&str>); 4] = [
            (Method::PUT, "/api/skills", Some("{}")),
            (Method::DELETE, "/api/skills/external-host", None),
            (Method::PATCH, "/api/clawhub/installed", Some("{}")),
            (Method::GET, "/api/clawhub/install", None),
        ];

        for (method, uri, body) in cases {
            let reply = send(&h, method, uri, Some(OWNER), body).await;
            assert_eq!(reply.status, StatusCode::BAD_GATEWAY, "{uri}");
        }
    }

    #[tokio::test]
    async fn install_and_external_host_routes_are_served_natively() {
        let h = harness();

        let install = send(&h, Method::POST, "/api/skills", Some(OWNER), Some("{}")).await;
        assert_eq!(install.status, StatusCode::FORBIDDEN);
        assert_eq!(
            install.json()["error"],
            "External skill installation is disabled. Set EXTERNAL_SKILLS_ENABLED=true after review."
        );

        let host_get = send(
            &h,
            Method::GET,
            "/api/skills/external-host",
            Some(OWNER),
            None,
        )
        .await;
        assert_eq!(host_get.status, StatusCode::OK);
        assert_eq!(host_get.json()["status"]["running"], false);

        let host_post = send(
            &h,
            Method::POST,
            "/api/skills/external-host",
            Some(OWNER),
            Some("{}"),
        )
        .await;
        assert_eq!(host_post.status, StatusCode::BAD_REQUEST);
        assert_eq!(
            host_post.json()["error"],
            "Unsupported action. Use action=\"stop\"."
        );
    }
}
