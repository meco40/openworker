//! Port of `app/api/master/runs/route.ts` (GET, POST),
//! `app/api/master/runs/[id]/route.ts` (GET, PATCH),
//! `app/api/master/runs/[id]/delegations/route.ts` (GET, POST) and
//! `app/api/master/runs/[id]/feedback/route.ts` (POST) over `runs.store.ts`,
//! `delegation/` and the feedback store.
//!
//! `runs/[id]/actions/route.ts` is not ported: it starts and resumes runs on the
//! execution runtime (see the migration surface in the family root).

use std::sync::Arc;

use axum::body::Bytes;
use axum::extract::{Extension, Path};
use axum::http::{HeaderMap, StatusCode, Uri};
use axum::response::IntoResponse;
use axum::Json;
use betaclaw_core::master::live_events::MasterInvalidationResource::{
    Metrics, RunDetail, Runs, Subagents,
};
use betaclaw_core::master::repository::delegation_store::{
    MasterDelegationEventInput, MasterDelegationJobInput,
};
use betaclaw_core::master::repository::runs_store::{MasterFeedbackInput, RunPatch};
use betaclaw_core::master::types::MasterRunCreateInput;
use serde_json::{json, Value};

use super::support::{
    bad_request, filled_field, js_number, json_body, nullable_field, publish, query_of, scope_body,
    string_field, user_or_401, ApiError, Reply,
};
use super::Services;

/// `listRuns` default limit (`runs.store.ts:41`).
const RUN_LIST_LIMIT: i64 = 50;
/// `maxAttempts ?? 3` of `runs/[id]/delegations/route.ts:65`.
const DEFAULT_MAX_ATTEMPTS: i64 = 3;
/// `timeoutMs ?? 120_000` of `runs/[id]/delegations/route.ts:66`.
const DEFAULT_TIMEOUT_MS: i64 = 120_000;

fn run_not_found() -> ApiError {
    ApiError::new(StatusCode::NOT_FOUND, "Run not found")
}

/// `GET /api/master/runs` (`runs/route.ts:17-30`).
pub(super) async fn list(
    Extension(services): Extension<Arc<Services>>,
    headers: HeaderMap,
    uri: Uri,
) -> Reply {
    let user = user_or_401(&headers)?;
    let repos = services.repos().await;
    let scope = repos.scope(&query_of(&uri), &user, None)?;
    let runs = repos
        .master
        .list_runs(&scope, RUN_LIST_LIMIT)
        .map_err(bad_request)?;
    Ok(Json(json!({ "ok": true, "runs": runs })).into_response())
}

/// `POST /api/master/runs` (`runs/route.ts:32-63`). Answers `201`.
pub(super) async fn create(
    Extension(services): Extension<Arc<Services>>,
    headers: HeaderMap,
    uri: Uri,
    body: Bytes,
) -> Reply {
    let user = user_or_401(&headers)?;
    let body = json_body(&body)?;
    let (Some(title), Some(contract)) = (
        filled_field(&body, "title"),
        filled_field(&body, "contract"),
    ) else {
        return Err(ApiError::new(
            StatusCode::BAD_REQUEST,
            "title and contract are required",
        ));
    };
    let repos = services.repos().await;
    let scope = repos.scope(&query_of(&uri), &user, Some(&scope_body(&body)))?;
    let run = repos
        .master
        .create_run(&MasterRunCreateInput {
            user_id: scope.user_id.clone(),
            workspace_id: scope.workspace_id.clone(),
            title,
            contract,
        })
        .map_err(bad_request)?;
    publish(
        &services,
        &scope,
        vec![Runs, Metrics, RunDetail],
        Some(&run.id),
    );
    Ok((StatusCode::CREATED, Json(json!({ "ok": true, "run": run }))).into_response())
}

/// `GET /api/master/runs/{id}` (`runs/[id]/route.ts:14-32`).
pub(super) async fn get_run(
    Extension(services): Extension<Arc<Services>>,
    headers: HeaderMap,
    uri: Uri,
    Path(id): Path<String>,
) -> Reply {
    let user = user_or_401(&headers)?;
    let repos = services.repos().await;
    let scope = repos.scope(&query_of(&uri), &user, None)?;
    let run = repos
        .master
        .get_run(&scope, &id)
        .map_err(bad_request)?
        .ok_or_else(run_not_found)?;
    let steps = repos.master.list_steps(&scope, &id).map_err(bad_request)?;
    Ok(Json(json!({ "ok": true, "run": run, "steps": steps })).into_response())
}

/// `PATCH /api/master/runs/{id}` (`runs/[id]/route.ts:34-79`).
///
/// A field is patched when the body carries it, so an explicit `null` clears a
/// nullable column (`lastError`, `resultBundle`).
pub(super) async fn update_run(
    Extension(services): Extension<Arc<Services>>,
    headers: HeaderMap,
    uri: Uri,
    Path(id): Path<String>,
    body: Bytes,
) -> Reply {
    let user = user_or_401(&headers)?;
    let body = json_body(&body)?;
    let repos = services.repos().await;
    let scope = repos.scope(&query_of(&uri), &user, Some(&scope_body(&body)))?;
    let patch = RunPatch {
        title: string_field(&body, "title"),
        contract: string_field(&body, "contract"),
        status: string_field(&body, "status"),
        progress: body.get("progress").and_then(Value::as_i64),
        verification_passed: body.get("verificationPassed").and_then(Value::as_bool),
        result_bundle: nullable_field(&body, "resultBundle"),
        last_error: nullable_field(&body, "lastError"),
        paused_for_approval: body.get("pausedForApproval").and_then(Value::as_bool),
        ..RunPatch::default()
    };
    let run = repos
        .master
        .update_run(&scope, &id, &patch)
        .map_err(bad_request)?
        .ok_or_else(run_not_found)?;
    publish(
        &services,
        &scope,
        vec![Runs, Metrics, RunDetail],
        Some(&run.id),
    );
    Ok(Json(json!({ "ok": true, "run": run })).into_response())
}

/// `GET /api/master/runs/{id}/delegations` (`runs/[id]/delegations/route.ts:24-39`).
pub(super) async fn list_delegations(
    Extension(services): Extension<Arc<Services>>,
    headers: HeaderMap,
    uri: Uri,
    Path(id): Path<String>,
) -> Reply {
    let user = user_or_401(&headers)?;
    let repos = services.repos().await;
    let scope = repos.scope(&query_of(&uri), &user, None)?;
    let jobs = repos
        .master
        .list_delegation_jobs(&scope, &id)
        .map_err(bad_request)?;
    let events = repos
        .master
        .list_delegation_events(&scope, &id)
        .map_err(bad_request)?;
    Ok(Json(json!({ "ok": true, "jobs": jobs, "events": events })).into_response())
}

/// `POST /api/master/runs/{id}/delegations` (`runs/[id]/delegations/route.ts:41-84`).
/// Queues a job, records its `created` event and answers `201`.
pub(super) async fn create_delegation(
    Extension(services): Extension<Arc<Services>>,
    headers: HeaderMap,
    uri: Uri,
    Path(id): Path<String>,
    body: Bytes,
) -> Reply {
    let user = user_or_401(&headers)?;
    let body = json_body(&body)?;
    let capability = filled_field(&body, "capability")
        .ok_or_else(|| ApiError::new(StatusCode::BAD_REQUEST, "capability is required"))?;
    let repos = services.repos().await;
    let scope = repos.scope(&query_of(&uri), &user, Some(&scope_body(&body)))?;
    if repos
        .master
        .get_run(&scope, &id)
        .map_err(bad_request)?
        .is_none()
    {
        return Err(run_not_found());
    }
    let job = repos
        .master
        .create_delegation_job(
            &scope,
            &MasterDelegationJobInput {
                run_id: id.clone(),
                capability: capability.clone(),
                payload: filled_field(&body, "payload").unwrap_or_else(|| "{}".to_string()),
                status: "queued".to_string(),
                priority: filled_field(&body, "priority").unwrap_or_else(|| "medium".to_string()),
                max_attempts: body
                    .get("maxAttempts")
                    .and_then(Value::as_i64)
                    .unwrap_or(DEFAULT_MAX_ATTEMPTS),
                timeout_ms: body
                    .get("timeoutMs")
                    .and_then(Value::as_i64)
                    .unwrap_or(DEFAULT_TIMEOUT_MS),
            },
        )
        .map_err(bad_request)?;
    repos
        .master
        .append_delegation_event(
            &scope,
            &MasterDelegationEventInput {
                job_id: job.id.clone(),
                run_id: id.clone(),
                event_type: "created".to_string(),
                payload: json!({ "capability": capability }).to_string(),
            },
        )
        .map_err(bad_request)?;
    publish(&services, &scope, vec![Subagents, Metrics], Some(&id));
    Ok((StatusCode::CREATED, Json(json!({ "ok": true, "job": job }))).into_response())
}

/// `POST /api/master/runs/{id}/feedback` (`runs/[id]/feedback/route.ts:18-77`).
///
/// Only a completed run takes feedback (`422` otherwise). The scope comes from the
/// query alone, as the source reads it.
pub(super) async fn feedback(
    Extension(services): Extension<Arc<Services>>,
    headers: HeaderMap,
    uri: Uri,
    Path(id): Path<String>,
    body: Bytes,
) -> Reply {
    let user = user_or_401(&headers)?;
    let body = json_body(&body)?;
    let rating = js_number(body.get("rating"));
    if rating.fract() != 0.0 || !(1.0..=5.0).contains(&rating) {
        return Err(ApiError::new(
            StatusCode::BAD_REQUEST,
            "rating must be an integer between 1 and 5",
        ));
    }
    let policy = match body.get("policy").and_then(Value::as_str) {
        Some(policy @ ("safe" | "balanced" | "fast")) => policy.to_string(),
        _ => {
            return Err(ApiError::new(
                StatusCode::BAD_REQUEST,
                "policy must be 'safe', 'balanced', or 'fast'",
            ))
        }
    };
    let comment = body
        .get("comment")
        .filter(|value| !value.is_null())
        .map(|value| {
            value
                .as_str()
                .map_or_else(|| value.to_string(), str::to_string)
        })
        .map(|text| text.trim().to_string())
        .filter(|text| !text.is_empty());
    let repos = services.repos().await;
    let scope = repos.scope(&query_of(&uri), &user, None)?;
    let run = repos
        .master
        .get_run(&scope, &id)
        .map_err(bad_request)?
        .ok_or_else(run_not_found)?;
    if run.status != "COMPLETED" {
        return Err(ApiError::new(
            StatusCode::UNPROCESSABLE_ENTITY,
            "Feedback can only be submitted for completed runs",
        ));
    }
    let feedback = repos
        .master
        .add_feedback(
            &scope,
            &MasterFeedbackInput {
                run_id: id,
                rating: rating as i64,
                policy,
                comment,
            },
        )
        .map_err(bad_request)?;
    Ok(Json(json!({ "ok": true, "feedback": feedback })).into_response())
}

fn parse_decision(value: Option<&str>) -> Option<betaclaw_core::master::types::ApprovalDecision> {
    use betaclaw_core::master::types::ApprovalDecision;
    match value {
        Some("approve_once") => Some(ApprovalDecision::ApproveOnce),
        Some("approve_always") => Some(ApprovalDecision::ApproveAlways),
        Some("deny") => Some(ApprovalDecision::Deny),
        _ => None,
    }
}

fn run_background(
    services: &Services,
    repos: &super::support::Repos<'_>,
    binding: &betaclaw_core::master::workspace_scope::MasterWorkspaceBinding,
    run_id: &str,
) -> Result<bool, betaclaw_core::master::execution::runtime::master_execution_runtime::MasterExecutionRuntimeError>{
    use betaclaw_core::master::delegation::dispatcher::{
        DelegationDispatcher, DelegationDispatcherOptions,
    };
    use betaclaw_core::master::delegation::subagent_pool::NoopSubagentHeartbeatScheduler;
    use betaclaw_core::master::execution::action_ledger::MasterActionLedgerService;
    use betaclaw_core::master::execution::runtime::master_execution_runtime::{
        ExecutionFlowDeps, MasterExecutionRuntime, NoopRuntimeLeaseHeartbeat,
    };
    use betaclaw_core::master::orchestrator::MasterOrchestrator;
    use betaclaw_core::master::tool_policy::service::ToolPolicyServiceResolver;

    let subagent_hb = NoopSubagentHeartbeatScheduler;
    let dispatcher = DelegationDispatcher::new(
        &*repos.master,
        &services.env,
        &services.events,
        &subagent_hb,
        DelegationDispatcherOptions::default(),
    );
    let ledger = MasterActionLedgerService::new(&*repos.master);
    let orchestrator = MasterOrchestrator::new(&*repos.master, &dispatcher, &ledger)
        .with_publisher(&services.events);
    let policy_resolver = ToolPolicyServiceResolver;
    let runtime_hb = NoopRuntimeLeaseHeartbeat;
    let runtime = MasterExecutionRuntime::new(
        &*repos.master,
        &orchestrator,
        ExecutionFlowDeps {
            persona_repo: &repos.personas,
            env: &services.env,
            model: services.model.as_ref(),
            tool_runner: services.tool_runner.as_ref(),
            tool_policy: &policy_resolver,
            publisher: &services.events,
        },
        &runtime_hb,
    );
    runtime.start_background(binding, run_id)
}

/// `POST /api/master/approvals/{id}/decision` (`approvals/[id]/decision/route.ts:26-65`).
pub(super) async fn approval_decision(
    Extension(services): Extension<Arc<Services>>,
    headers: HeaderMap,
    uri: Uri,
    Path(id): Path<String>,
    body: Bytes,
) -> Reply {
    use betaclaw_core::master::approvals::service::{
        apply_approval_decision, ApplyApprovalDecisionInput,
    };
    use betaclaw_core::master::feature_flags::is_master_approval_control_plane_enabled;
    use betaclaw_core::master::types::ApprovalDecision;
    use chrono::Utc;

    if !is_master_approval_control_plane_enabled(&services.env) {
        return Err(ApiError::new(
            StatusCode::NOT_FOUND,
            "Master approval control plane is disabled.",
        ));
    }
    let user = user_or_401(&headers)?;
    let body = json_body(&body)?;
    let Some(decision) = parse_decision(string_field(&body, "decision").as_deref()) else {
        return Err(ApiError::new(
            StatusCode::BAD_REQUEST,
            "decision is required",
        ));
    };

    let repos = services.repos().await;
    let (scope, binding) = repos.binding(&query_of(&uri), &user, Some(&scope_body(&body)))?;
    let approval_request = apply_approval_decision(
        &ApplyApprovalDecisionInput {
            repo: &*repos.master,
            scope: &scope,
            request_id: &id,
            decision,
        },
        &services.events,
        Utc::now(),
    )
    .map_err(bad_request)?;

    if decision != ApprovalDecision::Deny {
        let _ = run_background(&services, &repos, &binding, &approval_request.run_id);
    }

    let run = repos
        .master
        .get_run(&scope, &approval_request.run_id)
        .map_err(bad_request)?;
    Ok(Json(json!({
        "ok": true,
        "approval": approval_request,
        "approvalRequest": approval_request,
        "run": run,
    }))
    .into_response())
}

/// `POST /api/master/runs/{id}/actions` (`runs/[id]/actions/route.ts:43-218`).
pub(super) async fn run_actions(
    Extension(services): Extension<Arc<Services>>,
    headers: HeaderMap,
    uri: Uri,
    Path(id): Path<String>,
    body: Bytes,
) -> Reply {
    use betaclaw_core::master::approvals::service::{
        apply_approval_decision, create_pending_approval_request, ApplyApprovalDecisionInput,
        CreatePendingApprovalRequestInput,
    };
    use betaclaw_core::master::delegation::dispatcher::{
        DelegationDispatcher, DelegationDispatcherOptions,
    };
    use betaclaw_core::master::delegation::subagent_pool::NoopSubagentHeartbeatScheduler;
    use betaclaw_core::master::execution::action_ledger::MasterActionLedgerService;
    use betaclaw_core::master::execution::runtime::master_execution_runtime::{
        ExecutionFlowDeps, MasterExecutionRuntime, NoopRuntimeLeaseHeartbeat,
    };
    use betaclaw_core::master::feature_flags::is_master_approval_control_plane_enabled;
    use betaclaw_core::master::orchestrator::MasterOrchestrator;
    use betaclaw_core::master::repository::now_iso;
    use betaclaw_core::master::tool_policy::service::ToolPolicyServiceResolver;
    use betaclaw_core::master::types::ApprovalDecision;
    use chrono::Utc;

    let user = user_or_401(&headers)?;
    let body = json_body(&body)?;
    let action_type = string_field(&body, "actionType")
        .unwrap_or_default()
        .trim()
        .to_string();
    let step_id = string_field(&body, "stepId")
        .unwrap_or_default()
        .trim()
        .to_string();
    if action_type.is_empty() || step_id.is_empty() {
        return Err(ApiError::new(
            StatusCode::BAD_REQUEST,
            "actionType and stepId are required",
        ));
    }

    let repos = services.repos().await;
    let (scope, binding) = repos.binding(&query_of(&uri), &user, Some(&scope_body(&body)))?;
    if repos
        .master
        .get_run(&scope, &id)
        .map_err(bad_request)?
        .is_none()
    {
        return Err(run_not_found());
    }

    if matches!(
        action_type.as_str(),
        "run.start" | "run.tick" | "run.cancel" | "run.export"
    ) {
        if action_type == "run.start" {
            let started = run_background(&services, &repos, &binding, &id).unwrap_or(false);
            let updated = repos.master.get_run(&scope, &id).map_err(bad_request)?;
            if let Some(ref r) = updated {
                publish(
                    &services,
                    &scope,
                    vec![Runs, Metrics, RunDetail],
                    Some(&r.id),
                );
            }
            let run_json = match updated {
                Some(mut r) => {
                    r.status = "EXECUTING".to_string();
                    serde_json::to_value(r).unwrap_or(Value::Null)
                }
                None => Value::Null,
            };
            return Ok(Json(json!({
                "ok": true,
                "started": started,
                "run": run_json,
            }))
            .into_response());
        }
        if action_type == "run.tick" {
            let subagent_hb = NoopSubagentHeartbeatScheduler;
            let dispatcher = DelegationDispatcher::new(
                &*repos.master,
                &services.env,
                &services.events,
                &subagent_hb,
                DelegationDispatcherOptions::default(),
            );
            let ledger = MasterActionLedgerService::new(&*repos.master);
            let orchestrator = MasterOrchestrator::new(&*repos.master, &dispatcher, &ledger)
                .with_publisher(&services.events);
            let policy_resolver = ToolPolicyServiceResolver;
            let runtime_hb = NoopRuntimeLeaseHeartbeat;
            let runtime = MasterExecutionRuntime::new(
                &*repos.master,
                &orchestrator,
                ExecutionFlowDeps {
                    persona_repo: &repos.personas,
                    env: &services.env,
                    model: services.model.as_ref(),
                    tool_runner: services.tool_runner.as_ref(),
                    tool_policy: &policy_resolver,
                    publisher: &services.events,
                },
                &runtime_hb,
            );
            let updated = runtime.execute_now(&binding, &id).map_err(bad_request)?;
            publish(
                &services,
                &scope,
                vec![Runs, Metrics, RunDetail],
                Some(&updated.id),
            );
            return Ok(Json(json!({ "ok": true, "run": updated })).into_response());
        }
        if action_type == "run.cancel" {
            let patched = repos
                .master
                .update_run(
                    &scope,
                    &id,
                    &RunPatch {
                        status: Some("CANCELLED".to_string()),
                        paused_for_approval: Some(false),
                        last_error: Some(Some("Run cancelled by operator.".to_string())),
                        cancelled_at: Some(Some(now_iso())),
                        cancel_reason: Some(Some("operator_cancel".to_string())),
                        ..RunPatch::default()
                    },
                )
                .map_err(bad_request)?;
            if let Some(ref r) = patched {
                publish(
                    &services,
                    &scope,
                    vec![Runs, Metrics, RunDetail],
                    Some(&r.id),
                );
            }
            return Ok(Json(json!({ "ok": true, "run": patched })).into_response());
        }
        let subagent_hb = NoopSubagentHeartbeatScheduler;
        let dispatcher = DelegationDispatcher::new(
            &*repos.master,
            &services.env,
            &services.events,
            &subagent_hb,
            DelegationDispatcherOptions::default(),
        );
        let ledger = MasterActionLedgerService::new(&*repos.master);
        let orchestrator = MasterOrchestrator::new(&*repos.master, &dispatcher, &ledger)
            .with_publisher(&services.events);
        let policy_resolver = ToolPolicyServiceResolver;
        let runtime_hb = NoopRuntimeLeaseHeartbeat;
        let runtime = MasterExecutionRuntime::new(
            &*repos.master,
            &orchestrator,
            ExecutionFlowDeps {
                persona_repo: &repos.personas,
                env: &services.env,
                model: services.model.as_ref(),
                tool_runner: services.tool_runner.as_ref(),
                tool_policy: &policy_resolver,
                publisher: &services.events,
            },
            &runtime_hb,
        );
        let export_bundle = runtime
            .build_export_bundle(&scope, &id)
            .map_err(bad_request)?;
        return Ok(Json(json!({ "ok": true, "exportBundle": export_bundle })).into_response());
    }

    if !is_master_approval_control_plane_enabled(&services.env) {
        return Err(ApiError::new(
            StatusCode::NOT_FOUND,
            "Master approval control plane is disabled.",
        ));
    }

    let fingerprint = string_field(&body, "fingerprint")
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| action_type.clone());
    let stored_rule = repos
        .master
        .get_approval_rule(&scope, &action_type, &fingerprint)
        .map_err(bad_request)?
        .and_then(|r| parse_decision(Some(r.as_str())));
    let effective_decision =
        parse_decision(string_field(&body, "decision").as_deref()).or(stored_rule);

    if let (Some(approval_request_id), Some(decision)) =
        (filled_field(&body, "approvalRequestId"), effective_decision)
    {
        let approval = apply_approval_decision(
            &ApplyApprovalDecisionInput {
                repo: &*repos.master,
                scope: &scope,
                request_id: &approval_request_id,
                decision,
            },
            &services.events,
            Utc::now(),
        )
        .map_err(bad_request)?;
        if decision != ApprovalDecision::Deny {
            let _ = run_background(&services, &repos, &binding, &approval.run_id);
        }
        let run = repos
            .master
            .get_run(&scope, &approval.run_id)
            .map_err(bad_request)?;
        return Ok(Json(json!({ "ok": true, "approval": approval, "run": run })).into_response());
    }

    let workspace_cwd = string_field(&body, "workspaceCwd");
    let summary = format!("Approval required for {action_type}");
    let approval_request = create_pending_approval_request(
        &CreatePendingApprovalRequestInput {
            repo: &*repos.master,
            scope: &scope,
            run_id: &id,
            step_id: &step_id,
            action_type: &action_type,
            summary: &summary,
            host: Some("gateway"),
            cwd: workspace_cwd.as_deref(),
            resolved_path: workspace_cwd.as_deref(),
            fingerprint: &fingerprint,
            risk_level: "high",
            tool_name: None,
            prompt: None,
            expires_at: None,
        },
        &services.events,
        Utc::now(),
    )
    .map_err(bad_request)?;

    let Some(decision) = effective_decision else {
        let _ = repos
            .master
            .update_run(
                &scope,
                &id,
                &RunPatch {
                    status: Some("AWAITING_APPROVAL".to_string()),
                    paused_for_approval: Some(true),
                    pending_approval_action_type: Some(Some(action_type.clone())),
                    ..RunPatch::default()
                },
            )
            .map_err(bad_request)?;
        return Ok((
            StatusCode::ACCEPTED,
            Json(json!({
                "ok": false,
                "approvalRequired": true,
                "status": "AWAITING_APPROVAL",
                "actionType": action_type,
                "fingerprint": fingerprint,
                "approvalRequestId": approval_request.id,
            })),
        )
            .into_response());
    };

    apply_approval_decision(
        &ApplyApprovalDecisionInput {
            repo: &*repos.master,
            scope: &scope,
            request_id: &approval_request.id,
            decision,
        },
        &services.events,
        Utc::now(),
    )
    .map_err(bad_request)?;

    if decision == ApprovalDecision::Deny {
        let patched = repos
            .master
            .update_run(
                &scope,
                &id,
                &RunPatch {
                    status: Some("REFINING".to_string()),
                    paused_for_approval: Some(false),
                    pending_approval_action_type: Some(None),
                    last_error: Some(Some(format!("Action denied: {action_type}"))),
                    ..RunPatch::default()
                },
            )
            .map_err(bad_request)?;
        return Ok(Json(json!({
            "ok": true,
            "decision": decision.as_str(),
            "run": patched,
        }))
        .into_response());
    }

    let patched = repos
        .master
        .update_run(
            &scope,
            &id,
            &RunPatch {
                status: Some("EXECUTING".to_string()),
                paused_for_approval: Some(false),
                pending_approval_action_type: Some(None),
                last_error: Some(None),
                ..RunPatch::default()
            },
        )
        .map_err(bad_request)?;
    let resumed = run_background(&services, &repos, &binding, &id).unwrap_or(false);
    Ok(Json(json!({
        "ok": true,
        "decision": decision.as_str(),
        "resumed": resumed,
        "run": patched,
    }))
    .into_response())
}

#[cfg(test)]
mod tests {
    use axum::http::{Method, StatusCode};

    use crate::families::master::test_support::{Harness, OWNER, SCOPE};

    /// Creates a run and returns its id.
    async fn create_run(harness: &Harness) -> String {
        let (status, body) = harness
            .send(
                Method::POST,
                "/api/master/runs",
                Some(OWNER),
                Some(r#"{"workspaceId":"main","title":"Plan","contract":"Ship it"}"#),
            )
            .await;
        assert_eq!(status, StatusCode::CREATED);
        body["run"]["id"].as_str().expect("run id").to_string()
    }

    #[tokio::test]
    async fn runs_create_list_get_and_patch() {
        let harness = Harness::new();
        let run_id = create_run(&harness).await;

        let (status, body) = harness
            .send(
                Method::GET,
                &format!("/api/master/runs{SCOPE}"),
                Some(OWNER),
                None,
            )
            .await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(body["runs"].as_array().expect("runs").len(), 1);

        let (status, body) = harness
            .send(
                Method::GET,
                &format!("/api/master/runs/{run_id}{SCOPE}"),
                Some(OWNER),
                None,
            )
            .await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(body["run"]["title"], "Plan");
        assert!(body["steps"].is_array());

        let (status, body) = harness
            .send(
                Method::PATCH,
                &format!("/api/master/runs/{run_id}"),
                Some(OWNER),
                Some(r#"{"workspaceId":"main","status":"COMPLETED","progress":100}"#),
            )
            .await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(body["run"]["status"], "COMPLETED");

        let (status, body) = harness
            .send(Method::GET, &format!("/api/master/runs{SCOPE}"), None, None)
            .await;
        assert_eq!(status, StatusCode::UNAUTHORIZED);
        assert_eq!(body["error"], "Unauthorized");
    }

    #[tokio::test]
    async fn runs_reject_missing_fields_and_unknown_ids() {
        let harness = Harness::new();
        let (status, body) = harness
            .send(
                Method::POST,
                "/api/master/runs",
                Some(OWNER),
                Some(r#"{"workspaceId":"main","title":"No contract"}"#),
            )
            .await;
        assert_eq!(status, StatusCode::BAD_REQUEST);
        assert_eq!(body["error"], "title and contract are required");

        let (status, body) = harness
            .send(
                Method::GET,
                &format!("/api/master/runs/nope{SCOPE}"),
                Some(OWNER),
                None,
            )
            .await;
        assert_eq!(status, StatusCode::NOT_FOUND);
        assert_eq!(body["error"], "Run not found");

        let (status, _) = harness
            .send(
                Method::PATCH,
                "/api/master/runs/nope",
                Some(OWNER),
                Some(r#"{"workspaceId":"main","status":"CANCELLED"}"#),
            )
            .await;
        assert_eq!(status, StatusCode::NOT_FOUND);
    }

    #[tokio::test]
    async fn delegations_and_feedback_follow_the_run_state() {
        let harness = Harness::new();
        let run_id = create_run(&harness).await;

        let (status, body) = harness
            .send(
                Method::POST,
                &format!("/api/master/runs/{run_id}/delegations"),
                Some(OWNER),
                Some(r#"{"workspaceId":"main","capability":"scan"}"#),
            )
            .await;
        assert_eq!(status, StatusCode::CREATED);
        assert_eq!(body["job"]["capability"], "scan");

        let (status, body) = harness
            .send(
                Method::GET,
                &format!("/api/master/runs/{run_id}/delegations{SCOPE}"),
                Some(OWNER),
                None,
            )
            .await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(body["jobs"].as_array().expect("jobs").len(), 1);
        assert_eq!(body["events"].as_array().expect("events").len(), 1);

        let (status, body) = harness
            .send(
                Method::POST,
                &format!("/api/master/runs/{run_id}/delegations"),
                Some(OWNER),
                Some(r#"{"workspaceId":"main"}"#),
            )
            .await;
        assert_eq!(status, StatusCode::BAD_REQUEST);
        assert_eq!(body["error"], "capability is required");

        let feedback_uri = format!("/api/master/runs/{run_id}/feedback{SCOPE}");
        let rating = r#"{"rating":4,"policy":"safe"}"#;
        let (status, body) = harness
            .send(Method::POST, &feedback_uri, Some(OWNER), Some(rating))
            .await;
        assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY);
        assert_eq!(
            body["error"],
            "Feedback can only be submitted for completed runs"
        );

        harness
            .send(
                Method::PATCH,
                &format!("/api/master/runs/{run_id}"),
                Some(OWNER),
                Some(r#"{"workspaceId":"main","status":"COMPLETED"}"#),
            )
            .await;
        let (status, body) = harness
            .send(Method::POST, &feedback_uri, Some(OWNER), Some(rating))
            .await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(body["feedback"]["rating"], 4);

        let (status, body) = harness
            .send(
                Method::POST,
                &feedback_uri,
                Some(OWNER),
                Some(r#"{"rating":9,"policy":"safe"}"#),
            )
            .await;
        assert_eq!(status, StatusCode::BAD_REQUEST);
        assert_eq!(body["error"], "rating must be an integer between 1 and 5");
    }
}
