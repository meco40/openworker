//! Port of the task family (S10): the routes of `app/api/tasks/**`,
//! `app/api/workspaces/**`, `app/api/agents/**` and `app/api/automations/**`, and
//! the services behind them.
//!
//! The domain logic lives in `betaclaw_core::tasks`, `betaclaw_core::automation`
//! and `betaclaw_core::agents`. This family wires it to HTTP. Each file names the
//! TypeScript source it mirrors.
//!
//! Not wired here, because the owning slice is not in the workspace yet (see the
//! ports in `ports.rs`): the Mission Control runtime client and the chat dispatch
//! (S8), the automation prompt runner (S8) and the browser runner of the automated
//! tests. The test queue drains here; its runner answers with an error until the
//! browser runtime lands. Without the other ports the routes answer with the
//! TypeScript status for a stopped runtime.
//!
//! The integrator builds the services with [`build`], attaches them as
//! `Extension<Arc<Services>>`, and merges [`router`] into the route table.
//!
//! `app/api/webhooks/agent-completion` is not a member of this family. It is its own
//! route (HMAC-verified, parity-tracked by the `channels_wire` family) and stays on the
//! reverse proxy until it is ported; this slice only makes the task tables it reads
//! reachable from Rust.

use std::path::PathBuf;
use std::sync::Arc;

use axum::routing::{get, post};
use axum::Router;
use betaclaw_core::automation::error::AutomationError;
use betaclaw_core::automation::service::AutomationService;
use betaclaw_core::automation::sqlite_repository::SqliteAutomationRepository;
use betaclaw_core::tasks::repository::TaskRepository;
use betaclaw_core::tasks::testing::queue::{DeliverableRunner, TestQueue};
use betaclaw_core::tasks::TaskError;

use crate::state::SharedState;

pub mod access;
pub mod agents;
pub mod automations;
pub mod dispatch;
pub mod planning;
pub mod ports;
pub mod task_routes;
pub mod wire;
pub mod workspaces;

#[cfg(test)]
mod test_support;

pub use ports::{
    BetaClawRuntime, GatewayPromptRunner, IntegratedBetaClawRuntime, NoSkills, RuntimeError,
    SkillInventory, UnwiredDeliverableRunner, UnwiredPromptRunner, UnwiredRuntime,
};

/// Everything the task family owns at runtime.
pub struct Services {
    /// Tasks, activities, deliverables, sessions and the task workspace directories.
    /// Shared with the queue drain, which runs on a blocking thread.
    pub tasks: Arc<TaskRepository>,
    /// Automation rules, runs and the scheduler lease.
    pub automation: AutomationService<GatewayPromptRunner>,
    pub runtime: Arc<dyn BetaClawRuntime>,
    pub skills: Arc<dyn SkillInventory>,
    /// `pendingTaskTestJobIds`: the queued test jobs, drained by `task_routes::start_test_job`.
    pub test_queue: Arc<TestQueue>,
    /// The browser check of one deliverable. Replace it with the Playwright runner when it exists.
    pub deliverable_runner: Arc<dyn DeliverableRunner>,
    /// `TASK_WORKSPACES_ROOT`, resolved by the integrator.
    pub task_root: PathBuf,
    /// `getProjectsPath()`.
    pub projects_path: String,
    /// `getMissionControlUrl()`, which the dispatch message quotes.
    pub mission_control_url: String,
}

impl Services {
    /// `if (!client.isConnected()) await client.connect()`.
    pub async fn ensure_connected(&self) -> Result<(), RuntimeError> {
        if self.runtime.is_connected() {
            Ok(())
        } else {
            self.runtime.connect().await
        }
    }
}

/// Failures while opening the family's stores.
#[derive(Debug, thiserror::Error)]
pub enum ServicesError {
    #[error(transparent)]
    Tasks(#[from] TaskError),
    #[error(transparent)]
    Automation(#[from] AutomationError),
}

/// Opens the family's stores on `db_path`, the Mission Control database. Both
/// migration ladders run there.
pub fn build(
    db_path: &str,
    task_root: PathBuf,
    projects_path: String,
    mission_control_url: String,
    runtime: Arc<dyn BetaClawRuntime>,
    skills: Arc<dyn SkillInventory>,
) -> Result<Services, ServicesError> {
    build_with_prompt_runner(
        (db_path, db_path),
        task_root,
        projects_path,
        mission_control_url,
        runtime,
        skills,
        GatewayPromptRunner::unwired(),
    )
}

/// Opens the family's stores on `db_path` with a custom [`GatewayPromptRunner`] and
/// optional [`IntegratedBetaClawRuntime`] factory.
pub fn build_with_prompt_runner(
    (db_path, automation_db_path): (&str, &str),
    task_root: PathBuf,
    projects_path: String,
    mission_control_url: String,
    runtime: Arc<dyn BetaClawRuntime>,
    skills: Arc<dyn SkillInventory>,
    prompt_runner: GatewayPromptRunner,
) -> Result<Services, ServicesError> {
    let tasks = Arc::new(TaskRepository::open(db_path)?);
    let automation_store = SqliteAutomationRepository::open(automation_db_path)?;
    Ok(Services {
        tasks,
        automation: AutomationService::new(automation_store, prompt_runner),
        runtime,
        skills,
        test_queue: Arc::new(TestQueue::default()),
        deliverable_runner: Arc::new(UnwiredDeliverableRunner),
        task_root,
        projects_path,
        mission_control_url,
    })
}

/// The routes of the family. Every handler takes `Extension<Arc<Services>>`.
pub fn router() -> Router<SharedState> {
    Router::new()
        .route(
            "/api/tasks",
            get(task_routes::list_tasks).post(task_routes::create_task),
        )
        .route(
            "/api/tasks/{id}",
            get(task_routes::get_task)
                .patch(task_routes::update_task)
                .delete(task_routes::delete_task),
        )
        .route(
            "/api/tasks/{id}/activities",
            get(task_routes::list_activities).post(task_routes::create_activity),
        )
        .route(
            "/api/tasks/{id}/deliverables",
            get(task_routes::list_deliverables).post(task_routes::create_deliverable),
        )
        .route("/api/tasks/{id}/dispatch", post(dispatch::dispatch_route))
        .route(
            "/api/tasks/{id}/planning",
            get(planning::get_state)
                .post(planning::start)
                .delete(planning::cancel),
        )
        .route("/api/tasks/{id}/planning/answer", post(planning::answer))
        .route("/api/tasks/{id}/planning/poll", get(planning::poll))
        .route(
            "/api/tasks/{id}/planning/retry-dispatch",
            post(planning::retry_dispatch),
        )
        .route(
            "/api/tasks/{id}/subagent",
            get(task_routes::list_subagents).post(task_routes::register_subagent),
        )
        .route(
            "/api/tasks/{id}/test",
            get(task_routes::test_info).post(task_routes::run_test),
        )
        .route(
            "/api/workspaces",
            get(workspaces::list_workspaces).post(workspaces::create_workspace),
        )
        .route(
            "/api/workspaces/{id}",
            get(workspaces::get_workspace)
                .patch(workspaces::update_workspace)
                .delete(workspaces::delete_workspace),
        )
        .route(
            "/api/agents",
            get(agents::list_agents).post(agents::create_agent),
        )
        .route("/api/agents/discover", get(agents::discover_agents))
        .route("/api/agents/import", post(agents::import_agents))
        .route(
            "/api/agents/{id}",
            get(agents::get_agent)
                .patch(agents::update_agent)
                .delete(agents::delete_agent),
        )
        .route(
            "/api/agents/{id}/betaclaw",
            get(agents::get_betaclaw)
                .post(agents::link_betaclaw)
                .delete(agents::unlink_betaclaw),
        )
        .route(
            "/api/automations",
            get(automations::list_rules).post(automations::create_rule),
        )
        .route("/api/automations/metrics", get(automations::metrics))
        .route(
            "/api/automations/{id}",
            get(automations::get_rule)
                .patch(automations::update_rule)
                .delete(automations::delete_rule),
        )
        .route(
            "/api/automations/{id}/flow",
            get(automations::get_flow).put(automations::put_flow),
        )
        .route("/api/automations/{id}/run", post(automations::run_rule))
        .route("/api/automations/{id}/runs", get(automations::list_runs))
}

#[cfg(test)]
mod tests {
    use axum::http::Method;

    use super::test_support::{fixture, send};

    /// Every route of the family, with a sample path, answers 401 without an identity.
    #[tokio::test]
    async fn every_route_answers_401_without_an_identity() {
        let routes: [(Method, &str); 45] = [
            (Method::GET, "/api/tasks"),
            (Method::POST, "/api/tasks"),
            (Method::GET, "/api/tasks/t1"),
            (Method::PATCH, "/api/tasks/t1"),
            (Method::DELETE, "/api/tasks/t1"),
            (Method::GET, "/api/tasks/t1/activities"),
            (Method::POST, "/api/tasks/t1/activities"),
            (Method::GET, "/api/tasks/t1/deliverables"),
            (Method::POST, "/api/tasks/t1/deliverables"),
            (Method::POST, "/api/tasks/t1/dispatch"),
            (Method::GET, "/api/tasks/t1/planning"),
            (Method::POST, "/api/tasks/t1/planning"),
            (Method::DELETE, "/api/tasks/t1/planning"),
            (Method::POST, "/api/tasks/t1/planning/answer"),
            (Method::GET, "/api/tasks/t1/planning/poll"),
            (Method::POST, "/api/tasks/t1/planning/retry-dispatch"),
            (Method::GET, "/api/tasks/t1/subagent"),
            (Method::POST, "/api/tasks/t1/subagent"),
            (Method::GET, "/api/tasks/t1/test"),
            (Method::POST, "/api/tasks/t1/test"),
            (Method::GET, "/api/workspaces"),
            (Method::POST, "/api/workspaces"),
            (Method::GET, "/api/workspaces/w1"),
            (Method::PATCH, "/api/workspaces/w1"),
            (Method::DELETE, "/api/workspaces/w1"),
            (Method::GET, "/api/agents"),
            (Method::POST, "/api/agents"),
            (Method::GET, "/api/agents/discover"),
            (Method::POST, "/api/agents/import"),
            (Method::GET, "/api/agents/a1"),
            (Method::PATCH, "/api/agents/a1"),
            (Method::DELETE, "/api/agents/a1"),
            (Method::GET, "/api/agents/a1/betaclaw"),
            (Method::POST, "/api/agents/a1/betaclaw"),
            (Method::DELETE, "/api/agents/a1/betaclaw"),
            (Method::GET, "/api/automations"),
            (Method::POST, "/api/automations"),
            (Method::GET, "/api/automations/metrics"),
            (Method::GET, "/api/automations/r1"),
            (Method::PATCH, "/api/automations/r1"),
            (Method::DELETE, "/api/automations/r1"),
            (Method::GET, "/api/automations/r1/flow"),
            (Method::PUT, "/api/automations/r1/flow"),
            (Method::POST, "/api/automations/r1/run"),
            (Method::GET, "/api/automations/r1/runs"),
        ];
        let fixture = fixture();
        for (method, uri) in routes {
            let (status, body) = send(&fixture, method.clone(), uri, None, Some("{}")).await;
            assert_eq!(status, 401, "{method} {uri}");
            assert_eq!(body["error"], "Unauthorized", "{method} {uri}");
        }
    }
}
