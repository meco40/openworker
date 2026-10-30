//! Port of `src/server/master/execution/runtime/toolRunner.ts:1-274`.
//!
//! `runTool` routes one runtime tool request. `web_search`, `notes`,
//! `reminders` and `write` run as one idempotent action: the S6
//! [`MasterActionBridge`] wraps the [`MasterActionLedgerService`] step, and the
//! effect is a skill ([`SkillDispatcher`], S11) or a repository write.
//! `shell_execute` passes the system-operation gate first, then the bridge.
//! Any other tool is blocked.
//!
//! # Deviations
//!
//! * The seam `MasterToolRunner` (`capability_executor.rs`) is synchronous, and
//!   [`run_tool`] is async. This module does not implement the seam: a blocking
//!   adapter would park the Axum handler thread. The gateway adapter is
//!   OP-S9-14. The seam now returns `Result`, so the `web_search` fallback of
//!   `capabilityExecutor.ts:87-93` (score 0.62) is reachable once it is wired.
//! * A TypeScript rejection becomes `Err(message)`.
//! * The ledger key hashes `serde_json::to_string` of `ToolRunRequest`. The
//!   struct field order equals the key order of the TypeScript literal at all
//!   five `runTool` call sites, and escaping matches `JSON.stringify`. The test
//!   `the_ledger_key_matches_the_typescript_key` pins this with TS-generated
//!   vectors. A new call site must keep the struct order.
//! * `outputPreview` is cut at 500 `char`s, not at 500 UTF-16 code units.

use std::future::Future;

use chrono::{Duration, SecondsFormat, Utc};
use futures_util::future::BoxFuture;
use serde_json::{json, Value};

use crate::master::action_bridge::{
    boxed, MasterActionBridge, MasterActionBridgeInput, MasterActionRun,
};
use crate::master::execution::action_ledger::MasterActionLedgerService;
use crate::master::execution::idempotency::build_idempotency_key;
use crate::master::execution::runtime::capability_executor::RunToolInput;
use crate::master::execution::runtime::tool_context::{build_tool_context, ToolContext};
use crate::master::execution::runtime::types::{MasterRuntimeTool, ToolRunResult};
use crate::master::orchestrator::{
    ActionLedgerPort, BuildIdempotencyKeyInput, ExecuteExactlyOnceInput,
};
use crate::master::repository::notes_store::MasterNoteInput;
use crate::master::repository::now_iso;
use crate::master::repository::reminders_store::MasterReminderInput;
use crate::master::system_ops::{
    execute_system_operation_with_runtime_async, SystemCommandOutput, SystemOpResult,
    SystemOpStatus,
};
use crate::master::types::WorkspaceScope;
use crate::master::workspace_scope::MasterWorkspaceBinding;

/// `dispatchSkill(name, args, context)` — `skills/executeSkill.ts:126`.
///
/// The skills runtime is S11. This port declares only the call that `runTool`
/// makes (`web_search`, `write`, `shell_execute`).
pub trait SkillDispatcher: Send + Sync {
    fn dispatch_skill<'a>(
        &'a self,
        name: &'a str,
        args: Value,
        context: &'a ToolContext,
    ) -> BoxFuture<'a, Result<Value, String>>;
}

/// The collaborators of `runTool`.
pub struct ToolRunnerDeps<'a> {
    pub bridge: &'a dyn MasterActionBridge,
    pub skills: &'a dyn SkillDispatcher,
}

/// `runTool` — `toolRunner.ts:70-274`. `Err` is a rejected promise of the source:
/// the bridge rejected, a repository write failed, or a skill failed.
pub async fn run_tool(
    deps: &ToolRunnerDeps<'_>,
    input: &RunToolInput<'_>,
) -> Result<ToolRunResult, String> {
    let request = input.request;
    let run = input.run;
    let scope = workspace_scope(input.scope);
    let context = build_tool_context(input.scope, &run.id, input.approval_bypass);

    match request.tool_name {
        MasterRuntimeTool::WebSearch => {
            let query = request
                .query
                .clone()
                .unwrap_or_else(|| run.contract.clone());
            let skills = deps.skills;
            let result = run_canonical(deps, input, &scope, move || async move {
                skills
                    .dispatch_skill(
                        "web_search",
                        json!({ "query": query, "count": 5 }),
                        &context,
                    )
                    .await
            })
            .await?;
            match result.result {
                Some(value) if result.succeeded => Ok(ToolRunResult::Completed {
                    output: value.to_string(),
                    details: Some(value),
                }),
                _ => Ok(blocked(
                    result
                        .error
                        .unwrap_or_else(|| "Web search action failed".to_string()),
                )),
            }
        }

        MasterRuntimeTool::Notes => {
            let note = MasterNoteInput {
                title: request
                    .note_title
                    .clone()
                    .unwrap_or_else(|| format!("Master note: {}", run.title)),
                content: request
                    .note_content
                    .clone()
                    .unwrap_or_else(|| run.contract.clone()),
                tags: request
                    .note_tags
                    .clone()
                    .unwrap_or_else(|| vec!["master".to_string(), "runtime".to_string()]),
            };
            let repo = input.repo;
            let owned = scope.clone();
            let result = run_canonical(deps, input, &scope, move || async move {
                let stored = repo
                    .create_note(&owned, &note)
                    .map_err(|error| error.to_string())?;
                to_value(&stored)
            })
            .await?;
            match result.result {
                Some(value) if result.succeeded => {
                    let id = value["id"].as_str().unwrap_or_default().to_string();
                    Ok(ToolRunResult::Completed {
                        output: format!("Stored note {id}"),
                        details: Some(value),
                    })
                }
                _ => Ok(blocked(
                    result
                        .error
                        .unwrap_or_else(|| "Note action failed".to_string()),
                )),
            }
        }

        MasterRuntimeTool::Reminders => {
            let reminder = MasterReminderInput {
                title: request
                    .note_title
                    .clone()
                    .unwrap_or_else(|| format!("Reminder: {}", run.title)),
                message: request
                    .note_content
                    .clone()
                    .unwrap_or_else(|| run.contract.clone()),
                remind_at: request.remind_at.clone().unwrap_or_else(|| {
                    (Utc::now() + Duration::hours(1)).to_rfc3339_opts(SecondsFormat::Millis, true)
                }),
                cron_expression: request.cron_expression.clone(),
                status: "pending".to_string(),
            };
            let repo = input.repo;
            let owned = scope.clone();
            let result = run_canonical(deps, input, &scope, move || async move {
                let stored = repo
                    .create_reminder(&owned, &reminder)
                    .map_err(|error| error.to_string())?;
                to_value(&stored)
            })
            .await?;
            match result.result {
                Some(value) if result.succeeded => {
                    let id = value["id"].as_str().unwrap_or_default().to_string();
                    Ok(ToolRunResult::Completed {
                        output: format!("Created reminder {id}"),
                        details: Some(value),
                    })
                }
                _ => Ok(blocked(
                    result
                        .error
                        .unwrap_or_else(|| "Reminder action failed".to_string()),
                )),
            }
        }

        MasterRuntimeTool::Write => {
            let path = request
                .path
                .clone()
                .unwrap_or_else(|| format!("master-output/{}-output.md", run.id));
            let content = request
                .content
                .clone()
                .unwrap_or_else(|| run.contract.clone());
            let output = format!("Wrote file {path}");
            let skills = deps.skills;
            let result = run_canonical(deps, input, &scope, move || async move {
                skills
                    .dispatch_skill(
                        "write",
                        json!({ "path": path, "content": content }),
                        &context,
                    )
                    .await
            })
            .await?;
            match result.result {
                Some(value) if result.succeeded => Ok(ToolRunResult::Completed {
                    output,
                    details: Some(value),
                }),
                _ => Ok(blocked(
                    result
                        .error
                        .unwrap_or_else(|| "Write action failed".to_string()),
                )),
            }
        }

        MasterRuntimeTool::ShellExecute => {
            if request.requires_approval && !input.approval_bypass {
                return Ok(ToolRunResult::ApprovalRequired {
                    summary: format!("Approval required for {}", request.tool_name.as_str()),
                });
            }
            let command = request.command.clone().unwrap_or_default();
            let key = ledger_key(input);
            let bridged = deps
                .bridge
                .bridge_master_action(MasterActionBridgeInput {
                    user_id: input.scope.user_id.clone(),
                    persona_id: Some(input.scope.persona_id.clone()),
                    workspace_id: Some(input.scope.workspace_id.clone()),
                    task_id: run.id.clone(),
                    action_type: request.action_type.clone(),
                    idempotency_key: key.clone(),
                    correlation_id: None,
                    run: Box::new(move || {
                        boxed(shell_run(
                            deps.skills,
                            context,
                            command,
                            input.approval_bypass,
                        ))
                    }),
                })
                .await?;

            let Some(system_value) = bridged.result else {
                return Ok(blocked(bridged.error.unwrap_or_else(|| {
                    "Action result was not available for replay".to_string()
                })));
            };
            let status = system_value["status"]
                .as_str()
                .unwrap_or_default()
                .to_string();
            let output = system_value["output"].as_str().map(str::to_string);
            if !bridged.succeeded || status != SystemOpStatus::Executed.as_str() {
                return Ok(if status == SystemOpStatus::AwaitingApproval.as_str() {
                    ToolRunResult::ApprovalRequired {
                        summary: output.unwrap_or_default(),
                    }
                } else {
                    blocked(
                        output
                            .or(bridged.error)
                            .unwrap_or_else(|| "Action failed".to_string()),
                    )
                });
            }

            let stdout = output.unwrap_or_default();
            let ledger = MasterActionLedgerService::new(input.repo);
            let executed = ledger.execute_exactly_once(ExecuteExactlyOnceInput {
                scope: &scope,
                run_id: &run.id,
                step_id: input.step_id,
                action_type: &request.action_type,
                idempotency_key: &key,
                execute: Box::new(move || json!({ "stdout": stdout, "stderr": "", "exitCode": 0 })),
            });
            Ok(ToolRunResult::Completed {
                output: executed.result["stdout"]
                    .as_str()
                    .unwrap_or_default()
                    .to_string(),
                details: Some(executed.result),
            })
        }

        MasterRuntimeTool::Read => Ok(blocked(format!(
            "Tool {} is not implemented in the Master runtime.",
            request.tool_name.as_str()
        ))),
    }
}

/// `runCanonicalMasterAction` — `toolRunner.ts:29-68`: one ledger step inside the
/// bridge run. `execute` is the effect the ledger runs at most once per key.
struct Canonical {
    result: Option<Value>,
    succeeded: bool,
    error: Option<String>,
}

async fn run_canonical<Fut>(
    deps: &ToolRunnerDeps<'_>,
    input: &RunToolInput<'_>,
    scope: &WorkspaceScope,
    execute: impl FnOnce() -> Fut + Send,
) -> Result<Canonical, String>
where
    Fut: Future<Output = Result<Value, String>> + Send,
{
    let key = ledger_key(input);
    let ledger_scope = scope.clone();
    let run_id = input.run.id.clone();
    let step_id = input.step_id.to_string();
    let action_type = input.request.action_type.clone();
    let tool_name = input.request.tool_name.as_str().to_string();
    let ledger = MasterActionLedgerService::new(input.repo);
    let bridged = deps
        .bridge
        .bridge_master_action(MasterActionBridgeInput {
            user_id: input.scope.user_id.clone(),
            persona_id: Some(input.scope.persona_id.clone()),
            workspace_id: Some(input.scope.workspace_id.clone()),
            task_id: input.run.id.clone(),
            action_type: action_type.clone(),
            idempotency_key: key.clone(),
            correlation_id: Some(input.run.id.clone()),
            run: Box::new(move || {
                boxed(async move {
                    let executed = ledger
                        .execute_exactly_once_async(
                            &ledger_scope,
                            &run_id,
                            &step_id,
                            &action_type,
                            &key,
                            execute,
                        )
                        .await?;
                    Ok::<_, String>(MasterActionRun {
                        ok: true,
                        error: None,
                        result: executed.result.clone(),
                        receipt: Some(json!({
                            "providerId": "master-ledger",
                            "target": tool_name,
                            "timestamp": now_iso(),
                            "payload": { "result": executed.result, "replayed": executed.replayed },
                        })),
                    })
                })
            }),
        })
        .await?;
    Ok(Canonical {
        result: bridged.result,
        succeeded: bridged.succeeded,
        error: bridged.error,
    })
}

/// The bridged `run` of the shell branch — `toolRunner.ts:198-234`. The gate of
/// `executeSystemOperationWithRuntime` decides first; the skill runs only when it
/// lets the command through.
async fn shell_run(
    skills: &dyn SkillDispatcher,
    context: ToolContext,
    command: String,
    approved: bool,
) -> Result<MasterActionRun, String> {
    let skill_command = command.clone();
    let system_result =
        execute_system_operation_with_runtime_async(&command, approved, move || async move {
            let payload = skills
                .dispatch_skill(
                    "shell_execute",
                    json!({ "command": skill_command }),
                    &context,
                )
                .await?;
            Ok::<_, String>(command_output(&payload))
        })
        .await?;

    let ok = system_result.status == SystemOpStatus::Executed;
    let output = system_result.output.clone();
    let mut payload = json!({
        "status": system_result.status.as_str(),
        "result": system_op_value(&system_result),
        "outputPreview": output.chars().take(500).collect::<String>(),
    });
    if ok {
        payload["exitCode"] = json!(0);
    }
    Ok(MasterActionRun {
        ok,
        error: if ok { None } else { Some(output) },
        result: system_op_value(&system_result),
        receipt: Some(json!({
            "providerId": "shell",
            "target": command,
            "timestamp": now_iso(),
            "payload": payload,
        })),
    })
}

/// The output of the `shell_execute` skill, read the way the source reads
/// `JSON.parse(JSON.stringify(skillResult))` (`toolRunner.ts:208-213`).
fn command_output(payload: &Value) -> SystemCommandOutput {
    SystemCommandOutput {
        stdout: payload
            .get("stdout")
            .and_then(Value::as_str)
            .map(str::to_string),
        stderr: payload
            .get("stderr")
            .and_then(Value::as_str)
            .map(str::to_string),
        exit_code: payload.get("exitCode").and_then(Value::as_i64),
    }
}

/// The `SystemOpResult` as the bridge stores it.
fn system_op_value(result: &SystemOpResult) -> Value {
    json!({
        "status": result.status.as_str(),
        "output": result.output,
        "requiresApproval": result.requires_approval,
        "risk": result.risk.map(|risk| risk.as_str()),
    })
}

/// `buildLedger` — `toolRunner.ts:12-27`: the idempotency key of one step.
fn ledger_key(input: &RunToolInput<'_>) -> String {
    let payload = serde_json::to_string(input.request).unwrap_or_default();
    build_idempotency_key(&BuildIdempotencyKeyInput {
        run_id: &input.run.id,
        step_id: input.step_id,
        action_type: &input.request.action_type,
        action_payload: &payload,
    })
}

fn workspace_scope(scope: &MasterWorkspaceBinding) -> WorkspaceScope {
    WorkspaceScope {
        user_id: scope.user_id.clone(),
        workspace_id: scope.workspace_id.clone(),
    }
}

fn blocked(reason: impl Into<String>) -> ToolRunResult {
    ToolRunResult::Blocked {
        reason: reason.into(),
    }
}

fn to_value<T: serde::Serialize>(value: &T) -> Result<Value, String> {
    serde_json::to_value(value).map_err(|error| error.to_string())
}

#[cfg(test)]
mod tests {
    use std::sync::Mutex;

    use super::*;
    use crate::master::action_bridge::MasterActionBridgeResult;
    use crate::master::execution::runtime::types::ToolRunRequest;
    use crate::master::repository::sqlite_master_repository::SqliteMasterRepository;
    use crate::master::repository::MasterRepository;
    use crate::master::types::MasterRun;

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

    /// Records the skill names it is asked for and answers with `reply`.
    struct FakeSkills {
        calls: Mutex<Vec<String>>,
        reply: Value,
    }

    impl SkillDispatcher for FakeSkills {
        fn dispatch_skill<'a>(
            &'a self,
            name: &'a str,
            _args: Value,
            _context: &'a ToolContext,
        ) -> BoxFuture<'a, Result<Value, String>> {
            boxed(async move {
                self.calls.lock().unwrap().push(name.to_string());
                Ok(self.reply.clone())
            })
        }
    }

    fn binding() -> MasterWorkspaceBinding {
        MasterWorkspaceBinding {
            user_id: "u1".to_string(),
            workspace_id: "w1".to_string(),
            persona_id: "p1".to_string(),
            persona_workspace_root: "/root".to_string(),
            workspace_cwd: "/root/cwd".to_string(),
        }
    }

    fn run() -> MasterRun {
        MasterRun {
            id: "run-1".to_string(),
            user_id: "u1".to_string(),
            workspace_id: "w1".to_string(),
            title: "Title".to_string(),
            contract: "Contract".to_string(),
            status: "EXECUTING".to_string(),
            progress: 0,
            verification_passed: false,
            result_bundle: None,
            created_at: "t".to_string(),
            updated_at: "t".to_string(),
            last_error: None,
            paused_for_approval: false,
            pending_approval_action_type: None,
            cancelled_at: None,
            cancel_reason: None,
            owner_id: None,
            lease_expires_at: None,
            heartbeat_at: None,
        }
    }

    fn request(tool: MasterRuntimeTool) -> ToolRunRequest {
        ToolRunRequest {
            tool_name: tool,
            action_type: tool.as_str().to_string(),
            fingerprint: tool.as_str().to_string(),
            requires_approval: false,
            command: None,
            path: None,
            content: None,
            query: None,
            note_title: None,
            note_content: None,
            note_tags: None,
            remind_at: None,
            cron_expression: None,
        }
    }

    fn skills(reply: Value) -> FakeSkills {
        FakeSkills {
            calls: Mutex::new(Vec::new()),
            reply,
        }
    }

    fn call<'a>(
        binding: &'a MasterWorkspaceBinding,
        run: &'a MasterRun,
        repo: &'a dyn MasterRepository,
        request: &'a ToolRunRequest,
        approval_bypass: bool,
    ) -> RunToolInput<'a> {
        RunToolInput {
            scope: binding,
            run,
            repo,
            step_id: "step-1",
            request,
            approval_bypass,
        }
    }

    #[tokio::test]
    async fn a_web_search_runs_the_skill_inside_the_bridge() {
        let repo = SqliteMasterRepository::open(":memory:").unwrap();
        let (binding, run) = (binding(), run());
        let request = request(MasterRuntimeTool::WebSearch);
        let bridge = FakeBridge { fail: None };
        let skills = skills(json!({ "results": [1] }));

        let result = run_tool(
            &ToolRunnerDeps {
                bridge: &bridge,
                skills: &skills,
            },
            &call(&binding, &run, &repo, &request, false),
        )
        .await
        .unwrap();

        assert_eq!(
            result,
            ToolRunResult::Completed {
                output: r#"{"results":[1]}"#.to_string(),
                details: Some(json!({ "results": [1] })),
            }
        );
        assert_eq!(
            *skills.calls.lock().unwrap(),
            vec!["web_search".to_string()]
        );
    }

    #[tokio::test]
    async fn a_note_is_stored_through_the_ledger() {
        let repo = SqliteMasterRepository::open(":memory:").unwrap();
        let (binding, run) = (binding(), run());
        let mut request = request(MasterRuntimeTool::Notes);
        request.note_title = Some("Idea".to_string());
        request.note_content = Some("Body".to_string());
        let bridge = FakeBridge { fail: None };
        let skills = skills(Value::Null);

        let result = run_tool(
            &ToolRunnerDeps {
                bridge: &bridge,
                skills: &skills,
            },
            &call(&binding, &run, &repo, &request, false),
        )
        .await
        .unwrap();

        let ToolRunResult::Completed { output, .. } = result else {
            panic!("expected a completed note, got {result:?}");
        };
        assert!(output.starts_with("Stored note "), "{output}");
        let scope = WorkspaceScope {
            user_id: "u1".to_string(),
            workspace_id: "w1".to_string(),
        };
        assert_eq!(repo.list_notes(&scope, 100).unwrap().len(), 1);
    }

    #[tokio::test]
    async fn a_shell_command_that_needs_approval_stops_before_the_bridge() {
        let repo = SqliteMasterRepository::open(":memory:").unwrap();
        let (binding, run) = (binding(), run());
        let mut request = request(MasterRuntimeTool::ShellExecute);
        request.command = Some("mkdir x".to_string());
        request.requires_approval = true;
        // The bridge would reject with a different message if it were reached.
        let bridge = FakeBridge {
            fail: Some("bridge must not run".to_string()),
        };
        let skills = skills(Value::Null);

        let result = run_tool(
            &ToolRunnerDeps {
                bridge: &bridge,
                skills: &skills,
            },
            &call(&binding, &run, &repo, &request, false),
        )
        .await
        .unwrap();

        assert_eq!(
            result,
            ToolRunResult::ApprovalRequired {
                summary: "Approval required for shell_execute".to_string(),
            }
        );
        assert!(skills.calls.lock().unwrap().is_empty());
    }

    #[tokio::test]
    async fn an_approved_shell_command_returns_its_stdout() {
        let repo = SqliteMasterRepository::open(":memory:").unwrap();
        let (binding, run) = (binding(), run());
        let mut request = request(MasterRuntimeTool::ShellExecute);
        request.command = Some("echo hi".to_string());
        let bridge = FakeBridge { fail: None };
        let skills = skills(json!({ "stdout": "hi\n", "stderr": "", "exitCode": 0 }));

        let result = run_tool(
            &ToolRunnerDeps {
                bridge: &bridge,
                skills: &skills,
            },
            &call(&binding, &run, &repo, &request, true),
        )
        .await
        .unwrap();

        let ToolRunResult::Completed { output, .. } = result else {
            panic!("expected a completed command, got {result:?}");
        };
        assert_eq!(output, "hi");
        assert_eq!(
            *skills.calls.lock().unwrap(),
            vec!["shell_execute".to_string()]
        );
    }

    #[tokio::test]
    async fn an_unsupported_tool_is_blocked() {
        let repo = SqliteMasterRepository::open(":memory:").unwrap();
        let (binding, run) = (binding(), run());
        let request = request(MasterRuntimeTool::Read);
        let bridge = FakeBridge { fail: None };
        let skills = skills(Value::Null);

        let result = run_tool(
            &ToolRunnerDeps {
                bridge: &bridge,
                skills: &skills,
            },
            &call(&binding, &run, &repo, &request, false),
        )
        .await
        .unwrap();

        assert_eq!(
            result,
            ToolRunResult::Blocked {
                reason: "Tool read is not implemented in the Master runtime.".to_string(),
            }
        );
    }

    #[tokio::test]
    async fn a_bridge_rejection_is_an_error_not_a_block() {
        let repo = SqliteMasterRepository::open(":memory:").unwrap();
        let (binding, run) = (binding(), run());
        let request = request(MasterRuntimeTool::WebSearch);
        let bridge = FakeBridge {
            fail: Some("bridge down".to_string()),
        };
        let skills = skills(Value::Null);

        let error = run_tool(
            &ToolRunnerDeps {
                bridge: &bridge,
                skills: &skills,
            },
            &call(&binding, &run, &repo, &request, false),
        )
        .await
        .unwrap_err();

        assert_eq!(error, "bridge down");
    }

    /// `(request, JSON.stringify(request), buildIdempotencyKey(...))` from node 24
    /// with run `run-1` and step `step-1`. The TypeScript side is the object
    /// literal at each `runTool` call site of `capabilityExecutor.ts`. The last
    /// vector carries quotes, a backslash, control characters, DEL, non-ASCII,
    /// U+2028 and a slash.
    fn ledger_vectors() -> Vec<(ToolRunRequest, &'static str, &'static str)> {
        let base = |tool: MasterRuntimeTool, action: &str, fingerprint: &str| ToolRunRequest {
            tool_name: tool,
            action_type: action.to_string(),
            fingerprint: fingerprint.to_string(),
            requires_approval: false,
            command: None,
            path: None,
            content: None,
            query: None,
            note_title: None,
            note_content: None,
            note_tags: None,
            remind_at: None,
            cron_expression: None,
        };
        vec![
            (
                ToolRunRequest {
                    query: Some("Contract".to_string()),
                    ..base(MasterRuntimeTool::WebSearch, "web_search", "web_search")
                },
                r#"{"toolName":"web_search","actionType":"web_search","fingerprint":"web_search","requiresApproval":false,"query":"Contract"}"#,
                "run-1:step-1:web_search:1656b829682e994c",
            ),
            (
                ToolRunRequest {
                    path: Some("master-output/run-1-solution.md".to_string()),
                    content: Some("body".to_string()),
                    ..base(MasterRuntimeTool::Write, "file.write", "fp-1")
                },
                r#"{"toolName":"write","actionType":"file.write","fingerprint":"fp-1","requiresApproval":false,"path":"master-output/run-1-solution.md","content":"body"}"#,
                "run-1:step-1:file.write:2dcede4d370fd948",
            ),
            (
                ToolRunRequest {
                    note_title: Some("Master note: Title".to_string()),
                    note_content: Some("Contract".to_string()),
                    note_tags: Some(vec!["master".to_string(), "autonomous".to_string()]),
                    ..base(MasterRuntimeTool::Notes, "notes", "notes")
                },
                r#"{"toolName":"notes","actionType":"notes","fingerprint":"notes","requiresApproval":false,"noteTitle":"Master note: Title","noteContent":"Contract","noteTags":["master","autonomous"]}"#,
                "run-1:step-1:notes:815dfb06dbba4040",
            ),
            (
                ToolRunRequest {
                    note_title: Some("Follow-up: Title".to_string()),
                    note_content: Some("Contract".to_string()),
                    remind_at: Some("2026-01-01T01:00:00.000Z".to_string()),
                    ..base(MasterRuntimeTool::Reminders, "reminders", "reminders")
                },
                r#"{"toolName":"reminders","actionType":"reminders","fingerprint":"reminders","requiresApproval":false,"noteTitle":"Follow-up: Title","noteContent":"Contract","remindAt":"2026-01-01T01:00:00.000Z"}"#,
                "run-1:step-1:reminders:dd74b5f87dde52af",
            ),
            (
                ToolRunRequest {
                    command: Some("echo hi".to_string()),
                    ..base(MasterRuntimeTool::ShellExecute, "file.write", "fp-1")
                },
                r#"{"toolName":"shell_execute","actionType":"file.write","fingerprint":"fp-1","requiresApproval":false,"command":"echo hi"}"#,
                "run-1:step-1:file.write:2dfde5321d008ab6",
            ),
            (
                ToolRunRequest {
                    query: Some(
                        "q \"x\" \\ slash/ tab\t nl\n cr\r bs\u{8} ff\u{c} ctl\u{1} del\u{7f} \u{fc} \u{1F600} \u{2028}"
                            .to_string(),
                    ),
                    ..base(MasterRuntimeTool::WebSearch, "web_search", "web_search")
                },
                "{\"toolName\":\"web_search\",\"actionType\":\"web_search\",\"fingerprint\":\"web_search\",\"requiresApproval\":false,\"query\":\"q \\\"x\\\" \\\\ slash/ tab\\t nl\\n cr\\r bs\\b ff\\f ctl\\u0001 del\u{7f} \u{fc} \u{1F600} \u{2028}\"}",
                "run-1:step-1:web_search:4186be41142327e1",
            ),
        ]
    }

    #[test]
    fn the_ledger_key_matches_the_typescript_key() {
        let repo = SqliteMasterRepository::open(":memory:").unwrap();
        let (binding, run) = (binding(), run());
        for (request, payload, key) in ledger_vectors() {
            assert_eq!(serde_json::to_string(&request).unwrap(), payload);
            assert_eq!(
                ledger_key(&call(&binding, &run, &repo, &request, false)),
                key,
                "key for {payload}"
            );
        }
    }

    #[tokio::test]
    async fn the_run_tool_future_is_send() {
        fn assert_send<T: Send>(_: T) {}

        let repo = SqliteMasterRepository::open(":memory:").unwrap();
        let (binding, run) = (binding(), run());
        let request = request(MasterRuntimeTool::WebSearch);
        let bridge = FakeBridge { fail: None };
        let skills = skills(json!({ "results": [] }));
        let deps = ToolRunnerDeps {
            bridge: &bridge,
            skills: &skills,
        };
        let input = call(&binding, &run, &repo, &request, false);

        assert_send(run_tool(&deps, &input));
        assert!(run_tool(&deps, &input).await.is_ok());
    }
}
