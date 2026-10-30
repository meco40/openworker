//! Port of `src/server/master/execution/runtime/executionFlow.ts:1-360`.
//!
//! The end-to-end flow of one Master run: recover the delegation queue, plan,
//! then per capability resolve the approval gate, delegate to a subagent task,
//! aggregate the result, and finally verify the run and settle its status.
//!
//! # Cross-package seams
//!
//! The flow consumes the delegation and approvals ports (P3, already landed) and
//! the P4 runtime modules of this package. Beyond them it needs:
//!
//! * the model hub ([`MasterModelDispatch`], OP-S9-8),
//! * the tool runner ([`MasterToolRunner`], OP-S9-4/OP-S9-14),
//! * the tool policy ([`ToolPolicyResolver`], OP-S9-13),
//! * the event bus ([`MasterEventPublisher`]) and the runtime persona repository.
//!
//! All are injected; nothing is imported from or stubbed against S6/S8.
//!
//! # The flow is synchronous
//!
//! Every awaited call (`orchestrator.delegate`, `executeCapabilityTask`,
//! `buildExecutionPlanWithModel`) is synchronous in Rust because the delegation
//! port and the tool/model seams are synchronous. The `now` function pointer is
//! the single clock read (`new Date().toISOString()`).

use chrono::{DateTime, SecondsFormat, Utc};
use serde_json::Value;

use crate::master::approvals::service::{
    create_pending_approval_request, ApprovalServiceError, CreatePendingApprovalRequestInput,
};
use crate::master::delegation::aggregator::{aggregate_delegation_result, DelegationResult};
use crate::master::delegation::recovery::recover_delegation_queue;
use crate::master::execution::approval_policy::{
    resolve_runtime_approval, ApprovalGateDecision, ResolveRuntimeApprovalInput, ToolPolicyResolver,
};
use crate::master::execution::runtime::capability_control::build_capability_control;
use crate::master::execution::runtime::capability_executor::{
    execute_capability_task, ExecuteCapabilityTaskInput, MasterToolRunner,
};
use crate::master::execution::runtime::capability_output::normalize_capability_output;
use crate::master::execution::runtime::execution_plan::{
    build_execution_plan_with_model, MasterModelDispatch,
};
use crate::master::execution::runtime::json_parsing::parse_json_object;
use crate::master::execution::runtime::types::{Capability, RuntimeMode};
use crate::master::feature_flags::{is_master_approval_control_plane_enabled, MasterEnv};
use crate::master::live_events::{
    publish_master_updated, MasterEventPublisher, MasterInvalidationResource,
    PublishMasterUpdatedInput,
};
use crate::master::orchestrator::{
    AdvanceRunOptions, DelegationTaskResult, MasterOrchestrator, MasterOrchestratorError,
};
use crate::master::repository::audit_store::MasterAuditEventInput;
use crate::master::repository::runs_store::{MasterStepInput, RunPatch};
use crate::master::repository::MasterRepository;
use crate::master::runtime_persona::MasterRuntimePersonaInput;
use crate::master::types::MasterStep;
use crate::master::verification::{verify_execution_result, VerificationInput, VerificationReport};
use crate::master::workspace_scope::MasterWorkspaceBinding;
use crate::personas::repository::PersonaRepository;

/// `Master run not found.` — `executionFlow.ts:34`.
#[derive(Debug, thiserror::Error)]
pub enum MasterExecutionFlowError {
    #[error("Master run not found.")]
    RunNotFound,
    #[error(transparent)]
    Orchestrator(#[from] MasterOrchestratorError),
    #[error(transparent)]
    Approval(#[from] ApprovalServiceError),
    #[error(transparent)]
    ApprovalPolicy(#[from] crate::master::execution::approval_policy::ApprovalPolicyError),
    #[error(transparent)]
    Repository(#[from] rusqlite::Error),
    #[error(transparent)]
    Json(#[from] serde_json::Error),
    /// A `runTool` rejection that `executeCapabilityTask` does not catch.
    #[error("Capability task failed: {0}")]
    CapabilityTask(String),
}

/// `input` of `executeMasterRunFlow` — `executionFlow.ts:18-24`.
pub struct ExecuteMasterRunFlowInput<'a> {
    pub scope: &'a MasterWorkspaceBinding,
    pub run_id: &'a str,
    pub repo: &'a dyn MasterRepository,
    pub orchestrator: &'a MasterOrchestrator<'a>,
    /// `nextStepSequence` — `executionFlow.ts:23`.
    pub next_step_sequence: &'a dyn Fn(&MasterWorkspaceBinding, &str) -> i64,
    pub persona_repo: &'a PersonaRepository,
    pub env: &'a MasterEnv,
    pub model: &'a dyn MasterModelDispatch,
    pub tool_runner: &'a dyn MasterToolRunner,
    pub tool_policy: &'a dyn ToolPolicyResolver,
    pub publisher: &'a dyn MasterEventPublisher,
    pub now: fn() -> DateTime<Utc>,
}

fn persona_input(scope: &MasterWorkspaceBinding) -> MasterRuntimePersonaInput {
    MasterRuntimePersonaInput {
        user_id: scope.user_id.clone(),
        persona_id: Some(scope.persona_id.clone()),
    }
}

/// The repo calls take the `(userId, workspaceId)` pair, which the binding
/// carries structurally, exactly like the TypeScript code passes `scope`.
fn workspace_scope(scope: &MasterWorkspaceBinding) -> crate::master::types::WorkspaceScope {
    crate::master::types::WorkspaceScope {
        user_id: scope.user_id.clone(),
        workspace_id: scope.workspace_id.clone(),
    }
}

fn publish_run_state(
    publisher: &dyn MasterEventPublisher,
    scope: &MasterWorkspaceBinding,
    run_id: &str,
) {
    publish_master_updated(
        publisher,
        &PublishMasterUpdatedInput {
            scope: workspace_scope(scope),
            resources: vec![
                MasterInvalidationResource::Runs,
                MasterInvalidationResource::Metrics,
                MasterInvalidationResource::RunDetail,
            ],
            run_id: Some(run_id.to_string()),
            approval_request_id: None,
            session_id: None,
            reminder_id: None,
        },
    );
}

fn append_step(
    repo: &dyn MasterRepository,
    scope: &MasterWorkspaceBinding,
    run_id: &str,
    step: &MasterStepInput,
) -> Result<MasterStep, MasterExecutionFlowError> {
    Ok(repo.append_step(&workspace_scope(scope), run_id, step)?)
}

fn append_audit(
    repo: &dyn MasterRepository,
    scope: &MasterWorkspaceBinding,
    category: &str,
    action: &str,
    metadata: serde_json::Value,
) -> Result<(), MasterExecutionFlowError> {
    repo.append_audit_event(
        &workspace_scope(scope),
        &MasterAuditEventInput {
            category: category.to_string(),
            action: action.to_string(),
            metadata: metadata.to_string(),
        },
    )?;
    Ok(())
}

/// `String(value || '')` — the empty string for absent/null, let the callers
/// `trim()`.
fn js_string(value: Option<&Value>) -> String {
    match value {
        None | Some(Value::Null) => String::new(),
        Some(Value::String(text)) => text.clone(),
        Some(other) => other.to_string(),
    }
}

/// JavaScript truthiness for a parsed JSON value.
fn js_truthy(value: &Value) -> bool {
    match value {
        Value::Null => false,
        Value::Bool(flag) => *flag,
        Value::Number(number) => number.as_f64().map(|f| f != 0.0).unwrap_or(false),
        Value::String(text) => !text.is_empty(),
        Value::Array(_) | Value::Object(_) => true,
    }
}

/// `Number(value ?? fallback)` with JavaScript's string/number coercion.
fn number_or(value: Option<&Value>, fallback: f64) -> f64 {
    match value {
        None | Some(Value::Null) => fallback,
        Some(Value::Number(number)) => number.as_f64().unwrap_or(fallback),
        Some(Value::String(text)) => text.trim().parse::<f64>().unwrap_or(f64::NAN),
        Some(Value::Bool(flag)) => {
            if *flag {
                1.0
            } else {
                0.0
            }
        }
        _ => f64::NAN,
    }
}

/// `JSON.stringify(verificationReport)` — the report is not a serde type, so the
/// four fields are written by hand (verification.ts:11-16).
fn verification_report_json(report: &VerificationReport) -> serde_json::Value {
    serde_json::json!({
        "status": report.status.as_str(),
        "score": report.score,
        "summary": report.summary,
        "checks": report
            .checks
            .iter()
            .map(|check| serde_json::json!({
                "name": check.name,
                "passed": check.passed,
                "detail": check.detail,
            }))
            .collect::<Vec<_>>(),
    })
}

/// `executeMasterRunFlow` — `executionFlow.ts:18-360`.
pub fn execute_master_run_flow(
    input: &ExecuteMasterRunFlowInput<'_>,
) -> Result<(), MasterExecutionFlowError> {
    let scope = input.scope;
    let run_id = input.run_id;
    let repo = input.repo;
    let ws = workspace_scope(scope);

    let run = repo
        .get_run(&ws, run_id)?
        .ok_or(MasterExecutionFlowError::RunNotFound)?;
    if matches!(
        run.status.as_str(),
        "COMPLETED" | "FAILED" | "CANCELLED" | "AWAITING_APPROVAL"
    ) {
        return Ok(());
    }

    recover_delegation_queue(repo, &ws, run_id)?;

    let mut current = run;
    if matches!(current.status.as_str(), "ANALYZING" | "IDLE" | "REFINING") {
        current = input.orchestrator.advance_run(
            &ws,
            run_id,
            &AdvanceRunOptions {
                progress: Some(12),
                ..AdvanceRunOptions::default()
            },
        )?;
    }

    let plan = build_execution_plan_with_model(
        &current.contract,
        &persona_input(scope),
        input.persona_repo,
        input.env,
        input.model,
    );
    append_step(
        repo,
        scope,
        run_id,
        &MasterStepInput {
            seq: (input.next_step_sequence)(scope, run_id),
            phase: "planning".to_string(),
            status: "done".to_string(),
            input: Some(current.contract.clone()),
            output: Some(serde_json::to_string(&plan)?),
        },
    )?;

    if current.status == "PLANNING" {
        current = input.orchestrator.advance_run(
            &ws,
            run_id,
            &AdvanceRunOptions {
                progress: Some(35),
                ..AdvanceRunOptions::default()
            },
        )?;
    }

    let mut merged_outputs: Vec<String> = Vec::new();
    let mut mode_set: std::collections::HashSet<RuntimeMode> = std::collections::HashSet::new();
    mode_set.insert(plan.source);
    let mut degraded_mode = false;

    for capability in &plan.capabilities {
        let capability = *capability;
        let latest = match repo.get_run(&ws, run_id)? {
            Some(latest) if latest.status != "CANCELLED" && latest.status != "FAILED" => latest,
            _ => return Ok(()),
        };

        let control = build_capability_control(capability, &latest);
        let tool_name = match capability {
            Capability::SystemOps => "shell_execute",
            Capability::CodeGeneration => "write",
            other => other.as_str(),
        };
        let target_context = control.file_path.clone().unwrap_or_else(|| {
            if capability == Capability::SystemOps {
                scope.workspace_cwd.clone()
            } else {
                "create".to_string()
            }
        });
        let approval = resolve_runtime_approval(
            &ResolveRuntimeApprovalInput {
                repo,
                scope: &ws,
                action_type: &control.action_type,
                fingerprint: Some(&control.fingerprint),
                requires_approval: control.requires_approval,
                tool_name: Some(tool_name),
                host: Some("gateway"),
                target_context: Some(&target_context),
            },
            input.env,
            input.tool_policy,
            input.publisher,
        )?;

        if approval.decision == ApprovalGateDecision::AwaitingApproval {
            if is_master_approval_control_plane_enabled(input.env) {
                create_pending_approval_request(
                    &CreatePendingApprovalRequestInput {
                        repo,
                        scope: &ws,
                        run_id,
                        step_id: &format!(
                            "approval-{}-{}",
                            capability.as_str(),
                            (input.next_step_sequence)(scope, run_id)
                        ),
                        action_type: &approval.action_type,
                        summary: &format!("Approval required for {}", capability.as_str()),
                        host: Some("gateway"),
                        cwd: Some(&scope.workspace_cwd),
                        resolved_path: control.file_path.as_deref(),
                        fingerprint: &approval.fingerprint,
                        risk_level: if control.requires_approval {
                            "high"
                        } else {
                            "medium"
                        },
                        tool_name: Some(tool_name),
                        prompt: None,
                        expires_at: None,
                    },
                    input.publisher,
                    (input.now)(),
                )?;
            }
            repo.update_run(
                &ws,
                run_id,
                &RunPatch {
                    status: Some("AWAITING_APPROVAL".to_string()),
                    paused_for_approval: Some(true),
                    last_error: Some(Some(approval.reason.clone().unwrap_or_else(|| {
                        format!("Approval required for {}.", approval.action_type)
                    }))),
                    ..RunPatch::default()
                },
            )?;
            append_step(
                repo,
                scope,
                run_id,
                &MasterStepInput {
                    seq: (input.next_step_sequence)(scope, run_id),
                    phase: format!("approval:{}", capability.as_str()),
                    status: "blocked".to_string(),
                    input: Some(latest.contract.clone()),
                    output: Some(approval.reason.clone().unwrap_or_else(|| {
                        format!("Approval required for {}.", approval.action_type)
                    })),
                },
            )?;
            append_audit(
                repo,
                scope,
                "approval",
                "approval_required",
                serde_json::json!({
                    "runId": run_id,
                    "capability": capability.as_str(),
                    "actionType": approval.action_type,
                    "fingerprint": approval.fingerprint,
                }),
            )?;
            return Ok(());
        }

        if approval.decision == ApprovalGateDecision::Denied {
            let reason = approval
                .reason
                .clone()
                .unwrap_or_else(|| format!("Action denied: {}.", approval.action_type));
            repo.update_run(
                &ws,
                run_id,
                &RunPatch {
                    status: Some("REFINING".to_string()),
                    paused_for_approval: Some(false),
                    last_error: Some(Some(reason.clone())),
                    ..RunPatch::default()
                },
            )?;
            publish_run_state(input.publisher, scope, run_id);
            append_step(
                repo,
                scope,
                run_id,
                &MasterStepInput {
                    seq: (input.next_step_sequence)(scope, run_id),
                    phase: format!("approval:{}", capability.as_str()),
                    status: "blocked".to_string(),
                    input: Some(latest.contract.clone()),
                    output: Some(reason),
                },
            )?;
            append_audit(
                repo,
                scope,
                "approval",
                "approval_denied",
                serde_json::json!({
                    "runId": run_id,
                    "capability": capability.as_str(),
                    "actionType": approval.action_type,
                    "fingerprint": approval.fingerprint,
                }),
            )?;
            return Ok(());
        }

        let step = append_step(
            repo,
            scope,
            run_id,
            &MasterStepInput {
                seq: (input.next_step_sequence)(scope, run_id),
                phase: format!("delegation:{}", capability.as_str()),
                status: "running".to_string(),
                input: Some(latest.contract.clone()),
                output: None,
            },
        )?;

        let payload = serde_json::json!({
            "contract": latest.contract,
            "stepId": step.id,
        })
        .to_string();
        let task_error = std::cell::RefCell::new(None::<String>);
        let delegated = input.orchestrator.delegate(
            &ws,
            run_id,
            crate::master::orchestrator::DelegateInput {
                capability: capability.as_str(),
                payload: &payload,
                task: Box::new(|| {
                    match execute_capability_task(
                        &ExecuteCapabilityTaskInput {
                            scope,
                            run: &latest,
                            capability,
                            step_id: &step.id,
                            repo,
                            control: &control,
                            approval_bypass: control.requires_approval
                                && approval.decision == ApprovalGateDecision::Allowed,
                        },
                        input.persona_repo,
                        input.env,
                        input.model,
                        input.tool_runner,
                        (input.now)(),
                    ) {
                        Ok(result) => DelegationTaskResult {
                            output: result.output,
                            confidence: Some(result.confidence),
                        },
                        // The source's `await` rethrows a rejected task; the error is
                        // kept here and raised once the delegation has returned.
                        Err(error) => {
                            *task_error.borrow_mut() = Some(error);
                            DelegationTaskResult {
                                output: String::new(),
                                confidence: None,
                            }
                        }
                    }
                }),
            },
        );
        if let Some(error) = task_error.into_inner() {
            return Err(MasterExecutionFlowError::CapabilityTask(error));
        }

        if !delegated.accepted {
            repo.update_run(
                &ws,
                run_id,
                &RunPatch {
                    last_error: Some(Some(delegated.reason.clone().unwrap_or_else(|| {
                        format!("Delegation rejected for {}.", capability.as_str())
                    }))),
                    ..RunPatch::default()
                },
            )?;
            publish_run_state(input.publisher, scope, run_id);
            append_step(
                repo,
                scope,
                run_id,
                &MasterStepInput {
                    seq: (input.next_step_sequence)(scope, run_id),
                    phase: format!("policy:{}", capability.as_str()),
                    status: "blocked".to_string(),
                    input: Some(latest.contract.clone()),
                    output: Some(
                        delegated
                            .reason
                            .clone()
                            .unwrap_or_else(|| "policy_denied".to_string()),
                    ),
                },
            )?;
            continue;
        }

        let events = repo.list_delegation_events(&ws, run_id)?;
        let result_event = events
            .iter()
            .rev()
            .find(|event| event.job_id == delegated.job_id && event.event_type == "result");
        let payload_value = result_event.and_then(|event| parse_json_object(&event.payload));
        let output = js_string(payload_value.as_ref().and_then(|value| value.get("output")))
            .trim()
            .to_string();
        let confidence_value = number_or(
            payload_value
                .as_ref()
                .and_then(|value| value.get("confidence")),
            0.5,
        );
        let confidence = if confidence_value.is_finite() {
            confidence_value
        } else {
            0.5
        };
        let aggregation = aggregate_delegation_result(&DelegationResult {
            summary: None,
            output: Some(output),
            confidence: Some(confidence),
        });
        let normalized_output = normalize_capability_output(capability, &aggregation.merged_output);
        merged_outputs.push(normalized_output.clone());

        if let Some(mode) = payload_value
            .as_ref()
            .and_then(|value| value.get("mode"))
            .and_then(Value::as_str)
            .and_then(RuntimeMode::parse)
        {
            mode_set.insert(mode);
        }
        if payload_value
            .as_ref()
            .and_then(|value| value.get("degradedMode"))
            .map(js_truthy)
            .unwrap_or(false)
        {
            degraded_mode = true;
        }

        let current_progress = repo
            .get_run(&ws, run_id)?
            .map(|run| run.progress)
            .unwrap_or(0);
        repo.update_run(
            &ws,
            run_id,
            &RunPatch {
                progress: Some(80.min(current_progress + 18)),
                ..RunPatch::default()
            },
        )?;
        publish_run_state(input.publisher, scope, run_id);
        append_step(
            repo,
            scope,
            run_id,
            &MasterStepInput {
                seq: (input.next_step_sequence)(scope, run_id),
                phase: format!("aggregation:{}", capability.as_str()),
                status: match aggregation.status {
                    crate::master::delegation::aggregator::AggregationStatus::Accepted => "done",
                    crate::master::delegation::aggregator::AggregationStatus::NeedsRework => {
                        "running"
                    }
                    crate::master::delegation::aggregator::AggregationStatus::Rejected => "error",
                }
                .to_string(),
                input: Some(latest.contract.clone()),
                output: Some(normalized_output),
            },
        )?;
    }

    if current.status == "DELEGATING" {
        current = input.orchestrator.advance_run(
            &ws,
            run_id,
            &AdvanceRunOptions {
                progress: Some(72),
                ..AdvanceRunOptions::default()
            },
        )?;
    }
    if current.status == "EXECUTING" {
        current = input.orchestrator.advance_run(
            &ws,
            run_id,
            &AdvanceRunOptions {
                progress: Some(85),
                ..AdvanceRunOptions::default()
            },
        )?;
    }

    let steps = repo.list_steps(&ws, run_id)?;
    let expected_capabilities: Vec<String> = plan
        .capabilities
        .iter()
        .map(|capability| capability.as_str().to_string())
        .collect();
    let verification_report = verify_execution_result(&VerificationInput {
        outputs: &merged_outputs,
        steps: &steps,
        expected_capabilities: &expected_capabilities,
    });
    let verification_passed =
        verification_report.status == crate::master::verification::VerificationStatus::Passed;
    let execution_mode = if mode_set.contains(&RuntimeMode::Model) && !degraded_mode {
        RuntimeMode::Model
    } else {
        RuntimeMode::Fallback
    };
    let report_json = verification_report_json(&verification_report);
    let result_bundle = serde_json::to_string_pretty(&serde_json::json!({
        "runId": run_id,
        "title": current.title,
        "contract": current.contract,
        "outputs": merged_outputs,
        "summary": merged_outputs.join("\n\n"),
        "executionMode": execution_mode.as_str(),
        "degradedMode": degraded_mode,
        "plan": {
            "source": plan.source.as_str(),
            "rationale": plan.rationale,
            "capabilities": expected_capabilities,
            "verificationChecks": plan.verification_checks,
            "riskProfile": plan.risk_profile.as_str(),
            "requiresApproval": plan.requires_approval,
        },
        "verificationReport": report_json,
        "completedAt": (input.now)().to_rfc3339_opts(SecondsFormat::Millis, true),
    }))?;

    repo.update_run(
        &ws,
        run_id,
        &RunPatch {
            verification_passed: Some(verification_passed),
            result_bundle: Some(Some(result_bundle)),
            ..RunPatch::default()
        },
    )?;
    publish_run_state(input.publisher, scope, run_id);

    if verification_report.status == crate::master::verification::VerificationStatus::Failed {
        input.orchestrator.advance_run(
            &ws,
            run_id,
            &AdvanceRunOptions {
                failed: Some(true),
                progress: Some(92),
                ..AdvanceRunOptions::default()
            },
        )?;
        repo.update_run(
            &ws,
            run_id,
            &RunPatch {
                status: Some("FAILED".to_string()),
                last_error: Some(Some(verification_report.summary.to_string())),
                ..RunPatch::default()
            },
        )?;
        publish_run_state(input.publisher, scope, run_id);
        append_audit(
            repo,
            scope,
            "verification",
            "verification_failed",
            serde_json::json!({ "runId": run_id, "report": report_json }),
        )?;
        return Ok(());
    }

    if verification_report.status
        == crate::master::verification::VerificationStatus::NeedsRefinement
    {
        input.orchestrator.advance_run(
            &ws,
            run_id,
            &AdvanceRunOptions {
                verification_passed: Some(false),
                progress: Some(92),
                ..AdvanceRunOptions::default()
            },
        )?;
        repo.update_run(
            &ws,
            run_id,
            &RunPatch {
                status: Some("REFINING".to_string()),
                last_error: Some(Some(verification_report.summary.to_string())),
                ..RunPatch::default()
            },
        )?;
        publish_run_state(input.publisher, scope, run_id);
        append_audit(
            repo,
            scope,
            "verification",
            "verification_needs_refinement",
            serde_json::json!({ "runId": run_id, "report": report_json }),
        )?;
        return Ok(());
    }

    current = input.orchestrator.advance_run(
        &ws,
        run_id,
        &AdvanceRunOptions {
            verification_passed: Some(true),
            progress: Some(100),
            ..AdvanceRunOptions::default()
        },
    )?;
    if current.status != "COMPLETED" {
        repo.update_run(
            &ws,
            run_id,
            &RunPatch {
                status: Some("COMPLETED".to_string()),
                ..RunPatch::default()
            },
        )?;
    }
    repo.update_run(
        &ws,
        run_id,
        &RunPatch {
            progress: Some(100),
            paused_for_approval: Some(false),
            last_error: Some(None),
            ..RunPatch::default()
        },
    )?;
    publish_run_state(input.publisher, scope, run_id);
    append_audit(
        repo,
        scope,
        "verification",
        "verification_passed",
        serde_json::json!({ "runId": run_id, "report": report_json }),
    )?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::master::delegation::dispatcher::{
        DelegationDispatcher, DelegationDispatcherOptions,
    };
    use crate::master::delegation::subagent_pool::NoopSubagentHeartbeatScheduler;
    use crate::master::execution::action_ledger::MasterActionLedgerService;
    use crate::master::execution::runtime::capability_executor::{MasterToolRunner, RunToolInput};
    use crate::master::execution::runtime::execution_plan::{
        MasterModelDispatch, MasterModelRequest, MasterModelResponse,
    };
    use crate::master::execution::runtime::types::ToolRunResult;
    use crate::master::live_events::NoopMasterEventPublisher;
    use crate::master::repository::sqlite_master_repository::SqliteMasterRepository;
    use crate::master::types::{MasterRunCreateInput, WorkspaceScope};
    use crate::personas::repository::PersonaRepository;
    use crate::personas::workspace::PersonaWorkspace;

    struct TempDir(std::path::PathBuf);

    impl TempDir {
        fn new() -> Self {
            let unique = uuid::Uuid::new_v4().simple().to_string();
            let path = std::env::temp_dir().join(format!("betaclaw-master-flow-{unique}"));
            std::fs::create_dir_all(&path).expect("create temp dir");
            Self(path)
        }

        fn repo(&self) -> PersonaRepository {
            PersonaRepository::open_with_workspace(
                self.0.join("personas.db").to_string_lossy().as_ref(),
                PersonaWorkspace::new(self.0.join("personas")),
            )
            .expect("open persona repository")
        }
    }

    impl Drop for TempDir {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    struct FailingModel;

    impl MasterModelDispatch for FailingModel {
        fn dispatch_with_fallback(
            &self,
            _profile_id: &str,
            _request: &MasterModelRequest,
        ) -> Result<MasterModelResponse, String> {
            Err("no model".to_string())
        }
    }

    struct SearchRunner;

    impl MasterToolRunner for SearchRunner {
        fn run_tool(&self, _input: &RunToolInput<'_>) -> Result<ToolRunResult, String> {
            Ok(ToolRunResult::Completed {
                output: "unused".to_string(),
                details: Some(serde_json::json!({
                    "results": [
                        { "title": "Rust Book", "url": "https://doc.rust-lang.org" }
                    ]
                })),
            })
        }
    }

    fn now() -> DateTime<Utc> {
        use chrono::TimeZone;
        Utc.with_ymd_and_hms(2026, 1, 1, 0, 0, 0).unwrap()
    }

    fn binding(workspace_id: &str) -> MasterWorkspaceBinding {
        MasterWorkspaceBinding {
            user_id: "u1".to_string(),
            workspace_id: workspace_id.to_string(),
            persona_id: "p1".to_string(),
            persona_workspace_root: "/root".to_string(),
            workspace_cwd: "/root/cwd".to_string(),
        }
    }

    fn create_run(repo: &SqliteMasterRepository, workspace_id: &str, status: &str) -> String {
        let run = repo
            .create_run(&MasterRunCreateInput {
                user_id: "u1".to_string(),
                workspace_id: workspace_id.to_string(),
                title: "Run".to_string(),
                contract: "summarize the rust book".to_string(),
            })
            .unwrap();
        repo.update_run(
            &WorkspaceScope {
                user_id: "u1".to_string(),
                workspace_id: workspace_id.to_string(),
            },
            &run.id,
            &RunPatch {
                status: Some(status.to_string()),
                ..RunPatch::default()
            },
        )
        .unwrap();
        run.id
    }

    #[test]
    fn a_terminal_run_is_a_no_op() {
        let repo = SqliteMasterRepository::open(":memory:").unwrap();
        let dir = TempDir::new();
        let personas = dir.repo();
        let env = MasterEnv::new();
        let publisher = NoopMasterEventPublisher;
        let heartbeat = NoopSubagentHeartbeatScheduler;
        let dispatcher = DelegationDispatcher::new(
            &repo,
            &env,
            &publisher,
            &heartbeat,
            DelegationDispatcherOptions::default(),
        );
        let ledger = MasterActionLedgerService::new(&repo);
        let orchestrator = MasterOrchestrator::new(&repo, &dispatcher, &ledger);
        let scope = binding("w1");
        let run_id = create_run(&repo, "w1", "COMPLETED");
        let next = |_scope: &MasterWorkspaceBinding, _run: &str| 1i64;

        execute_master_run_flow(&ExecuteMasterRunFlowInput {
            scope: &scope,
            run_id: &run_id,
            repo: &repo,
            orchestrator: &orchestrator,
            next_step_sequence: &next,
            persona_repo: &personas,
            env: &env,
            model: &FailingModel,
            tool_runner: &SearchRunner,
            tool_policy: &crate::master::execution::approval_policy::AllowAllToolPolicyResolver,
            publisher: &publisher,
            now,
        })
        .unwrap();

        let ws = WorkspaceScope {
            user_id: "u1".to_string(),
            workspace_id: "w1".to_string(),
        };
        assert!(repo.list_steps(&ws, &run_id).unwrap().is_empty());
    }

    #[test]
    fn a_full_run_reaches_a_terminal_status_and_writes_steps() {
        let repo = SqliteMasterRepository::open(":memory:").unwrap();
        let dir = TempDir::new();
        let personas = dir.repo();
        let env = MasterEnv::new();
        let publisher = NoopMasterEventPublisher;
        let heartbeat = NoopSubagentHeartbeatScheduler;
        let dispatcher = DelegationDispatcher::new(
            &repo,
            &env,
            &publisher,
            &heartbeat,
            DelegationDispatcherOptions::default(),
        );
        let ledger = MasterActionLedgerService::new(&repo);
        let orchestrator = MasterOrchestrator::new(&repo, &dispatcher, &ledger);
        let scope = binding("w1");
        let run_id = create_run(&repo, "w1", "EXECUTING");
        let ws = WorkspaceScope {
            user_id: "u1".to_string(),
            workspace_id: "w1".to_string(),
        };
        let next = |scope: &MasterWorkspaceBinding, run: &str| -> i64 {
            let ws = WorkspaceScope {
                user_id: scope.user_id.clone(),
                workspace_id: scope.workspace_id.clone(),
            };
            let steps = repo.list_steps(&ws, run).unwrap_or_default();
            steps.iter().map(|step| step.seq).max().unwrap_or(0) + 1
        };

        execute_master_run_flow(&ExecuteMasterRunFlowInput {
            scope: &scope,
            run_id: &run_id,
            repo: &repo,
            orchestrator: &orchestrator,
            next_step_sequence: &next,
            persona_repo: &personas,
            env: &env,
            model: &FailingModel,
            tool_runner: &SearchRunner,
            tool_policy: &crate::master::execution::approval_policy::AllowAllToolPolicyResolver,
            publisher: &publisher,
            now,
        })
        .unwrap();

        let run = repo.get_run(&ws, &run_id).unwrap().unwrap();
        assert!(
            matches!(run.status.as_str(), "COMPLETED" | "FAILED" | "REFINING"),
            "unexpected status {}",
            run.status
        );
        assert!(run.result_bundle.is_some());
        let steps = repo.list_steps(&ws, &run_id).unwrap();
        assert!(steps.iter().any(|step| step.phase == "planning"));
        assert!(steps
            .iter()
            .any(|step| step.phase.starts_with("delegation:")));
        assert!(steps
            .iter()
            .any(|step| step.phase.starts_with("aggregation:")));
    }
}
