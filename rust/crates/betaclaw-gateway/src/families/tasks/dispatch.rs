//! Port of `src/server/tasks/dispatch/` (`index.ts`, `prepareDispatch.ts`,
//! `executeDispatch.ts`, `finalizeDispatch.ts`) and of `app/api/tasks/[id]/dispatch/route.ts`.
//!
//! The pure steps are in `betaclaw_core::tasks::dispatch`. This file runs them in the
//! order of the source and makes the runtime calls through `BetaClawRuntime`.

use std::sync::Arc;

use axum::extract::{Extension, Path as AxumPath, State};
use axum::http::HeaderMap;
use axum::response::Response;
use betaclaw_core::tasks::dispatch::failure::{
    classify_dispatch_failure, decide_after_failure, AttemptDecision, SendResult,
    MAX_DISPATCH_ATTEMPTS,
};
use betaclaw_core::tasks::dispatch::finalize::{finalize_dispatch, PreparedDispatch};
use betaclaw_core::tasks::dispatch::message::{
    build_dispatch_task_message, extract_task_complete_summary,
};
use betaclaw_core::tasks::dispatch::prepare::{
    check_dispatch_target, find_or_create_session, other_orchestrators, task_project_dir,
};
use betaclaw_core::tasks::dispatch::DispatchHttpResponse;
use betaclaw_core::tasks::repository::{find_agent, find_task};
use betaclaw_core::tasks::state::completion_plan;
use betaclaw_core::tasks::types::{AgentRow, SessionRow, Task};
use serde_json::{json, Value};

use super::access::resolve;
use super::task_routes::{task_json, trigger_automated_test};
use super::wire::{error, internal, notify, now_iso, reply, Fault};
use super::Services;
use crate::auth_gate::unauthorized_response;
use crate::state::{AppState, SharedState};

/// `POST /api/tasks/{id}/dispatch`
pub async fn dispatch_route(
    State(state): State<SharedState>,
    Extension(services): Extension<Arc<Services>>,
    headers: HeaderMap,
    AxumPath(id): AxumPath<String>,
) -> Response {
    let Some(access) = resolve(&state, &headers) else {
        return unauthorized_response();
    };
    let allowed = {
        let connection = services.tasks.connection();
        access.can_access_task(&connection, &id)
    };
    match allowed {
        Ok(true) => {}
        Ok(false) => return error(404, "Task not found"),
        Err(fault) => return internal("Internal server error", fault.into()),
    }
    let outcome = dispatch_task(&services, &state, &id).await;
    reply(outcome.status, outcome.body)
}

/// One step of the dispatch: a response to send now, or the input of the next step.
enum Step<T> {
    Done(DispatchHttpResponse),
    Next(T),
}

/// The state that `prepareDispatch` hands on.
struct Prepared {
    task: Task,
    agent: AgentRow,
    session: SessionRow,
    now: String,
    project_dir: String,
    message: String,
}

/// `dispatchTask`. Any failure after the checks answers 500 with the same text.
pub async fn dispatch_task(
    services: &Services,
    state: &AppState,
    task_id: &str,
) -> DispatchHttpResponse {
    match run(services, state, task_id).await {
        Ok(response) => response,
        Err(fault) => {
            tracing::error!(error = %fault.0, "Failed to send message to agent");
            DispatchHttpResponse {
                status: 500,
                body: json!({ "error": "Internal server error" }),
            }
        }
    }
}

async fn run(
    services: &Services,
    state: &AppState,
    task_id: &str,
) -> Result<DispatchHttpResponse, Fault> {
    let prepared = match prepare(services, task_id).await? {
        Step::Done(response) => return Ok(response),
        Step::Next(prepared) => prepared,
    };
    let sent = match send_with_retries(services, &prepared).await? {
        Step::Done(response) => return Ok(response),
        Step::Next(sent) => sent,
    };
    finish(services, state, prepared, &sent)
}

/// `prepareDispatch`: the checks in the source's order, then the session.
async fn prepare(services: &Services, task_id: &str) -> Result<Step<Prepared>, Fault> {
    let (task, agent, others) = {
        let connection = services.tasks.connection();
        let task = find_task(&connection, task_id)?;
        let agent = match task
            .as_ref()
            .and_then(|task| task.assigned_agent_id.as_deref())
        {
            Some(agent_id) if !agent_id.is_empty() => find_agent(&connection, agent_id)?,
            _ => None,
        };
        let others = match (&task, &agent) {
            (Some(task), Some(agent)) if agent.is_master => {
                other_orchestrators(&connection, &agent.id, &task.workspace_id)?
            }
            _ => Vec::new(),
        };
        (task, agent, others)
    };
    if let Err(response) = check_dispatch_target(task.as_ref(), agent.as_ref(), || others) {
        return Ok(Step::Done(response));
    }
    let (Some(task), Some(agent)) = (task, agent) else {
        return Ok(Step::Done(DispatchHttpResponse {
            status: 404,
            body: json!({ "error": "Task not found" }),
        }));
    };

    let installed = match services.skills.installed_count() {
        Ok(count) => count,
        Err(failure) => {
            tracing::error!(%failure, "Failed to read the installed skills");
            return Ok(Step::Done(DispatchHttpResponse {
                status: 500,
                body: json!({ "error": "Internal server error" }),
            }));
        }
    };
    if installed < 1 {
        return Ok(Step::Done(DispatchHttpResponse {
            status: 409,
            body: json!({
                "error": "Cannot dispatch task: no execution tools are installed. Enable at least one skill (e.g. Shell) and retry.",
                "code": "no_installed_tools",
            }),
        }));
    }
    if let Err(failure) = services.ensure_connected().await {
        tracing::error!(%failure, "Failed to connect to Mission Control runtime");
        return Ok(Step::Done(DispatchHttpResponse {
            status: 503,
            body: json!({ "error": "Failed to connect to Mission Control runtime" }),
        }));
    }

    let now = now_iso();
    let session = {
        let connection = services.tasks.connection();
        find_or_create_session(&connection, &agent, &now)?
    };
    let Some(session) = session else {
        return Ok(Step::Done(DispatchHttpResponse {
            status: 500,
            body: json!({ "error": "Failed to create agent session" }),
        }));
    };

    let project_dir = task_project_dir(&services.projects_path, &task.title);
    let message = build_dispatch_task_message(&task, &services.mission_control_url, &project_dir);
    Ok(Step::Next(Prepared {
        task,
        agent,
        session,
        now,
        project_dir,
        message,
    }))
}

/// `executeDispatch`: `chat.send` up to `MAX_DISPATCH_ATTEMPTS` times while the failure is retryable.
async fn send_with_retries(
    services: &Services,
    prepared: &Prepared,
) -> Result<Step<SendResult>, Fault> {
    let session_key = format!("agent:main:{}", prepared.session.betaclaw_session_id);
    let mut sent = SendResult::default();
    for attempt in 1..=MAX_DISPATCH_ATTEMPTS {
        let value = services
            .runtime
            .call(
                "chat.send",
                json!({
                    "sessionKey": session_key,
                    "message": prepared.message,
                    "idempotencyKey": format!(
                        "dispatch-{}-{}-{attempt}",
                        prepared.task.id,
                        chrono::Utc::now().timestamp_millis()
                    ),
                }),
            )
            .await?;
        sent = send_result(&value);
        let Some(failure) = classify_dispatch_failure(Some(&sent)) else {
            return Ok(Step::Next(sent));
        };
        match decide_after_failure(attempt, &failure) {
            AttemptDecision::Retry => {
                tracing::warn!(
                    task = %prepared.task.id,
                    attempt,
                    message = %failure.message,
                    "Dispatch retry"
                );
            }
            AttemptDecision::GiveUp(response) => return Ok(Step::Done(response)),
        }
    }
    Ok(Step::Next(sent))
}

fn send_result(value: &Value) -> SendResult {
    SendResult {
        agent_content: value
            .get("agentContent")
            .and_then(Value::as_str)
            .map(str::to_string),
        agent_metadata: value
            .get("agentMetadata")
            .and_then(Value::as_object)
            .cloned(),
    }
}

/// `finalizeDispatch`, then the test trigger and the `task_updated` event.
fn finish(
    services: &Services,
    state: &AppState,
    prepared: Prepared,
    sent: &SendResult,
) -> Result<DispatchHttpResponse, Fault> {
    let context = PreparedDispatch {
        task: prepared.task,
        agent: prepared.agent,
        session: prepared.session,
        now: prepared.now,
        task_project_dir: prepared.project_dir,
    };
    let connection = services.tasks.connection();
    let response = finalize_dispatch(&connection, &context, sent.agent_content.as_deref())?;
    let completed = extract_task_complete_summary(sent.agent_content.as_deref()).is_some();
    if completed && completion_plan(&context.task.status).auto_test {
        trigger_automated_test(services, &connection, &context.task.id, &context.now)?;
    }
    let updated = task_json(&connection, &context.task.id)?;
    drop(connection);
    if let Some(task) = updated {
        notify(state, "task_updated", task);
    }
    Ok(response)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::families::tasks::ports::{BetaClawRuntime, BoxFuture, NoSkills, RuntimeError};
    use crate::families::tasks::test_support::{
        fixture_with, send, FakeRuntime, FixedSkills, Fixture,
    };
    use axum::http::{Method, StatusCode};

    /// A connected runtime whose `chat.send` answers with `reply`.
    fn answering(reply: &str) -> Arc<dyn BetaClawRuntime> {
        Arc::new(FakeRuntime::answering(
            "chat.send",
            json!({ "agentContent": reply }),
        ))
    }

    async fn create_assigned(fixture: &Fixture, assigned: bool) -> String {
        let (_, agent) = send(
            fixture,
            Method::POST,
            "/api/agents",
            Some("user-1"),
            Some(r#"{"name":"Builder","role":"worker"}"#),
        )
        .await;
        let agent_id = agent["id"].as_str().unwrap().to_string();
        let body = if assigned {
            json!({ "title": "Ship page", "status": "assigned", "assigned_agent_id": agent_id })
        } else {
            json!({ "title": "Ship page" })
        };
        let (status, task) = send(
            fixture,
            Method::POST,
            "/api/tasks",
            Some("user-1"),
            Some(&body.to_string()),
        )
        .await;
        assert_eq!(status, StatusCode::CREATED);
        task["id"].as_str().unwrap().to_string()
    }

    #[tokio::test]
    async fn dispatch_without_an_assignee_is_a_bad_request() {
        let fixture = fixture_with(answering(""), Arc::new(FixedSkills(1)), |_| {});
        let id = create_assigned(&fixture, false).await;
        let (status, body) = send(
            &fixture,
            Method::POST,
            &format!("/api/tasks/{id}/dispatch"),
            Some("user-1"),
            None,
        )
        .await;
        assert_eq!(status, StatusCode::BAD_REQUEST);
        assert_eq!(body["error"], "Task has no assigned agent");
    }

    #[tokio::test]
    async fn dispatch_without_installed_tools_is_a_conflict() {
        let fixture = fixture_with(answering(""), Arc::new(NoSkills), |_| {});
        let id = create_assigned(&fixture, true).await;
        let (status, body) = send(
            &fixture,
            Method::POST,
            &format!("/api/tasks/{id}/dispatch"),
            Some("user-1"),
            None,
        )
        .await;
        assert_eq!(status, StatusCode::CONFLICT);
        assert_eq!(body["code"], "no_installed_tools");
    }

    #[tokio::test]
    async fn completion_marker_moves_the_task_to_testing() {
        let fixture = fixture_with(
            answering("TASK_COMPLETE: built the page"),
            Arc::new(FixedSkills(1)),
            |_| {},
        );
        let id = create_assigned(&fixture, true).await;
        let (status, body) = send(
            &fixture,
            Method::POST,
            &format!("/api/tasks/{id}/dispatch"),
            Some("user-1"),
            None,
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(body["completed"], true);
        assert_eq!(body["new_status"], "testing");
        assert_eq!(body["summary"], "built the page");

        let (_, task) = send(
            &fixture,
            Method::GET,
            &format!("/api/tasks/{id}"),
            Some("user-1"),
            None,
        )
        .await;
        assert_eq!(task["status"], "testing");
    }

    #[tokio::test]
    async fn a_reply_without_the_marker_leaves_the_task_in_progress() {
        let fixture = fixture_with(answering("still working"), Arc::new(FixedSkills(1)), |_| {});
        let id = create_assigned(&fixture, true).await;
        let (status, body) = send(
            &fixture,
            Method::POST,
            &format!("/api/tasks/{id}/dispatch"),
            Some("user-1"),
            None,
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(body["message"], "Task dispatched to agent");
        let (_, task) = send(
            &fixture,
            Method::GET,
            &format!("/api/tasks/{id}"),
            Some("user-1"),
            None,
        )
        .await;
        assert_eq!(task["status"], "in_progress");
    }

    #[tokio::test]
    async fn a_failing_runtime_call_is_an_internal_error() {
        struct Broken;
        impl BetaClawRuntime for Broken {
            fn is_connected(&self) -> bool {
                true
            }
            fn connect(&self) -> BoxFuture<'_, Result<(), RuntimeError>> {
                Box::pin(async { Ok(()) })
            }
            fn call<'a>(
                &'a self,
                _method: &'a str,
                _params: Value,
            ) -> BoxFuture<'a, Result<Value, RuntimeError>> {
                Box::pin(async { Err(RuntimeError("socket closed".to_string())) })
            }
        }
        let fixture = fixture_with(Arc::new(Broken), Arc::new(FixedSkills(1)), |_| {});
        let id = create_assigned(&fixture, true).await;
        let (status, body) = send(
            &fixture,
            Method::POST,
            &format!("/api/tasks/{id}/dispatch"),
            Some("user-1"),
            None,
        )
        .await;
        assert_eq!(status, StatusCode::INTERNAL_SERVER_ERROR);
        assert_eq!(body["error"], "Internal server error");
    }
}
