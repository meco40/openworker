//! Port of `runTool` (`src/server/master/execution/runtime/toolRunner.ts:70-274`)
//! behind the [`MasterToolRunner`] seam that `capabilityExecutor.ts` calls.
//!
//! Each effect runs once, inside the S6 bridge with the idempotency ledger
//! ([`ActionBridge::run_ledgered`], `runCanonicalMasterAction`, `toolRunner.ts:29-68`).
//! Shell commands take the approval gate and the system-operation check first
//! (`:182-268`), and their output is recorded in the ledger afterwards, as in the
//! source.
//!
//! The seam is synchronous and the effects are async, so [`MasterToolRunner::run_tool`]
//! drives the whole chain once with [`drive_sync`]. A failure to drive it is a
//! `Blocked` result. The seam cannot throw, so the TypeScript `try/catch` around
//! `web_search` in `capabilityExecutor.ts:58-94` stays unreachable, as the core port
//! already notes.

use std::sync::Arc;

use betaclaw_core::master::execution::runtime::capability_executor::{
    MasterToolRunner, RunToolInput,
};
use betaclaw_core::master::execution::runtime::types::{MasterRuntimeTool, ToolRunResult};
use betaclaw_core::master::repository::notes_store::MasterNoteInput;
use betaclaw_core::master::repository::reminders_store::MasterReminderInput;
use betaclaw_core::master::system_ops::{
    execute_system_operation_with_runtime, SystemCommandOutput, SystemOpStatus,
};
use betaclaw_core::master::types::WorkspaceScope;
use betaclaw_core::master::workspace_scope::MasterWorkspaceBinding;
use betaclaw_core::world_model::db::drive_sync;
use betaclaw_core::world_model::services::master_action_bridge::{
    MasterActionBridgeInput, MasterActionRunOutput,
};
use chrono::{Duration as ChronoDuration, SecondsFormat, Utc};
use serde_json::{json, Map, Value};

use super::action_bridge::{ledger_key, ledger_once, ActionBridge, LedgeredAction};
use super::skills::{SkillDispatcher, SkillInvocation};

/// The runtime's tool runner: the skills and the S6 bridge.
pub struct GatewayToolRunner {
    skills: Arc<dyn SkillDispatcher>,
    bridge: Arc<ActionBridge>,
}

impl GatewayToolRunner {
    pub fn new(skills: Arc<dyn SkillDispatcher>, bridge: Arc<ActionBridge>) -> Self {
        Self { skills, bridge }
    }

    /// `runTool` — `toolRunner.ts:70-274`, as one async chain.
    async fn run_async(&self, input: &RunToolInput<'_>) -> ToolRunResult {
        match input.request.tool_name {
            MasterRuntimeTool::WebSearch => self.web_search(input).await,
            MasterRuntimeTool::Notes => self.notes(input).await,
            MasterRuntimeTool::Reminders => self.reminders(input).await,
            MasterRuntimeTool::Write => self.write(input).await,
            MasterRuntimeTool::ShellExecute => self.shell(input).await,
            other => ToolRunResult::Blocked {
                reason: format!(
                    "Tool {} is not implemented in the Master runtime.",
                    other.as_str()
                ),
            },
        }
    }

    /// `dispatchSkill(name, args, toolContext)` with the run's approval bypass and
    /// workspace.
    async fn invoke(
        &self,
        input: &RunToolInput<'_>,
        name: &str,
        args: &Map<String, Value>,
    ) -> Result<Value, String> {
        self.skills
            .dispatch(SkillInvocation {
                name,
                args,
                bypass_approval: input.approval_bypass,
                workspace_cwd: Some(input.scope.workspace_cwd.as_str()),
            })
            .await
    }

    /// The ledgered effect of one tool call, with the bridge input of
    /// `toolRunner.ts:38-45`.
    async fn canonical(
        &self,
        input: &RunToolInput<'_>,
        fallback: &str,
        effect: impl std::future::Future<Output = Result<Value, String>>,
    ) -> Result<Value, String> {
        let scope = scope_of(input.scope);
        let key = idempotency_key(input);
        let action = ledger_action(input, &scope, &key);
        self.bridge
            .run_ledgered(&action, &bridge_input(input, &key), fallback, effect)
            .await
    }

    /// `case 'web_search'` — `toolRunner.ts:81-103`.
    async fn web_search(&self, input: &RunToolInput<'_>) -> ToolRunResult {
        let query = input
            .request
            .query
            .clone()
            .unwrap_or_else(|| input.run.contract.clone());
        let args = args(vec![("query", json!(query)), ("count", json!(5))]);
        match self
            .canonical(
                input,
                "Web search action failed",
                self.invoke(input, "web_search", &args),
            )
            .await
        {
            Ok(value) => ToolRunResult::Completed {
                output: value.to_string(),
                details: Some(value),
            },
            Err(reason) => ToolRunResult::Blocked { reason },
        }
    }

    /// `case 'notes'` — `toolRunner.ts:105-127`.
    async fn notes(&self, input: &RunToolInput<'_>) -> ToolRunResult {
        let request = input.request;
        let note = MasterNoteInput {
            title: request
                .note_title
                .clone()
                .unwrap_or_else(|| format!("Master note: {}", input.run.title)),
            content: request
                .note_content
                .clone()
                .unwrap_or_else(|| input.run.contract.clone()),
            tags: request
                .note_tags
                .clone()
                .unwrap_or_else(|| vec!["master".to_string(), "runtime".to_string()]),
        };
        let scope = scope_of(input.scope);
        match self
            .canonical(input, "Note action failed", async {
                let stored = input
                    .repo
                    .create_note(&scope, &note)
                    .map_err(|error| error.to_string())?;
                serde_json::to_value(stored).map_err(|error| error.to_string())
            })
            .await
        {
            Ok(value) => ToolRunResult::Completed {
                output: format!("Stored note {}", id_of(&value)),
                details: Some(value),
            },
            Err(reason) => ToolRunResult::Blocked { reason },
        }
    }

    /// `case 'reminders'` — `toolRunner.ts:129-153`. The repository is written
    /// directly, as in the source, so no scheduler sync runs here.
    async fn reminders(&self, input: &RunToolInput<'_>) -> ToolRunResult {
        let request = input.request;
        let remind_at = request.remind_at.clone().unwrap_or_else(|| {
            (Utc::now() + ChronoDuration::hours(1)).to_rfc3339_opts(SecondsFormat::Millis, true)
        });
        let reminder = MasterReminderInput {
            title: request
                .note_title
                .clone()
                .unwrap_or_else(|| format!("Reminder: {}", input.run.title)),
            message: request
                .note_content
                .clone()
                .unwrap_or_else(|| input.run.contract.clone()),
            remind_at,
            cron_expression: request.cron_expression.clone(),
            status: "pending".to_string(),
        };
        let scope = scope_of(input.scope);
        match self
            .canonical(input, "Reminder action failed", async {
                let stored = input
                    .repo
                    .create_reminder(&scope, &reminder)
                    .map_err(|error| error.to_string())?;
                serde_json::to_value(stored).map_err(|error| error.to_string())
            })
            .await
        {
            Ok(value) => ToolRunResult::Completed {
                output: format!("Created reminder {}", id_of(&value)),
                details: Some(value),
            },
            Err(reason) => ToolRunResult::Blocked { reason },
        }
    }

    /// `case 'write'` — `toolRunner.ts:155-180`.
    async fn write(&self, input: &RunToolInput<'_>) -> ToolRunResult {
        let request = input.request;
        let path = request
            .path
            .clone()
            .unwrap_or_else(|| format!("master-output/{}-output.md", input.run.id));
        let content = request
            .content
            .clone()
            .unwrap_or_else(|| input.run.contract.clone());
        let args = args(vec![("path", json!(path)), ("content", json!(content))]);
        match self
            .canonical(
                input,
                "Write action failed",
                self.invoke(input, "write", &args),
            )
            .await
        {
            Ok(value) => ToolRunResult::Completed {
                output: format!("Wrote file {path}"),
                details: Some(value),
            },
            Err(reason) => ToolRunResult::Blocked { reason },
        }
    }

    /// `case 'shell_execute'` — `toolRunner.ts:182-268`: the approval gate, the bridge
    /// around the system operation, then the ledger record of its output.
    async fn shell(&self, input: &RunToolInput<'_>) -> ToolRunResult {
        let request = input.request;
        if request.requires_approval && !input.approval_bypass {
            return ToolRunResult::ApprovalRequired {
                summary: "Approval required for shell_execute".to_string(),
            };
        }
        let command = request.command.clone().unwrap_or_default();
        let approved = input.approval_bypass;
        let scope = scope_of(input.scope);
        let key = idempotency_key(input);

        let bridged = self
            .bridge
            .run(&bridge_input(input, &key), || async {
                // The gate runs with an empty execute first. The skill is awaited only
                // when the command is allowed to run, and the operation is then
                // evaluated once more with the real output.
                let gate = execute_system_operation_with_runtime(
                    &command,
                    approved,
                    SystemCommandOutput::default,
                );
                let (system, failure) = if gate.status == SystemOpStatus::Executed {
                    let call = args(vec![("command", json!(command))]);
                    match self.invoke(input, "shell_execute", &call).await {
                        Ok(value) => (
                            execute_system_operation_with_runtime(&command, approved, || {
                                system_output(&value)
                            }),
                            None,
                        ),
                        Err(error) => (gate, Some(error)),
                    }
                } else {
                    (gate, None)
                };
                let ok = system.status == SystemOpStatus::Executed && failure.is_none();
                MasterActionRunOutput {
                    ok,
                    error: if ok {
                        None
                    } else {
                        Some(failure.unwrap_or_else(|| system.output.clone()))
                    },
                    result: json!({ "status": system.status.as_str(), "output": system.output }),
                    receipt: None,
                }
            })
            .await;
        let bridged = match bridged {
            Ok(bridged) => bridged,
            Err(reason) => return ToolRunResult::Blocked { reason },
        };
        let Some(result) = bridged.result else {
            return ToolRunResult::Blocked {
                reason: bridged
                    .error
                    .unwrap_or_else(|| "Action result was not available for replay".to_string()),
            };
        };
        let status = result["status"].as_str().unwrap_or_default();
        let output = result["output"].as_str().unwrap_or_default().to_string();
        if !bridged.succeeded || status != SystemOpStatus::Executed.as_str() {
            return if status == SystemOpStatus::AwaitingApproval.as_str() {
                ToolRunResult::ApprovalRequired { summary: output }
            } else {
                ToolRunResult::Blocked {
                    reason: bridged.error.unwrap_or(output),
                }
            };
        }

        // `ledger.executeExactlyOnce` of the command output, `toolRunner.ts:254-265`.
        let action = ledger_action(input, &scope, &key);
        let recorded = ledger_once(
            &action,
            std::future::ready(Ok(json!({ "stdout": output, "stderr": "", "exitCode": 0 }))),
        )
        .await
        .unwrap_or(Value::Null);
        ToolRunResult::Completed {
            output: recorded["stdout"].as_str().unwrap_or_default().to_string(),
            details: Some(recorded),
        }
    }
}

impl MasterToolRunner for GatewayToolRunner {
    fn run_tool(&self, input: &RunToolInput<'_>) -> Result<ToolRunResult, String> {
        // The seam's `Err` is a rejected `runTool` of the source. This runner
        // drives its own chain and reports a drive failure as `Blocked`, so it
        // never rejects: the `web_search` fallback of `capabilityExecutor.ts`
        // stays unreachable here (OP-S9-14).
        Ok(match drive_sync(self.run_async(input)) {
            Ok(result) => result,
            Err(error) => ToolRunResult::Blocked {
                reason: error.into_message(),
            },
        })
    }
}

/// `buildIdempotencyKey` over the run, the step and the JSON of the request —
/// `toolRunner.ts:19-27`.
fn idempotency_key(input: &RunToolInput<'_>) -> String {
    let payload = serde_json::to_string(input.request).unwrap_or_default();
    ledger_key(
        &input.run.id,
        input.step_id,
        &input.request.action_type,
        &payload,
    )
}

/// The ledger identity of this tool call.
fn ledger_action<'a>(
    input: &RunToolInput<'a>,
    scope: &'a WorkspaceScope,
    key: &'a str,
) -> LedgeredAction<'a> {
    LedgeredAction {
        repo: input.repo,
        scope,
        run_id: &input.run.id,
        step_id: input.step_id,
        action_type: &input.request.action_type,
        idempotency_key: key,
    }
}

/// The `{ userId, workspaceId }` pair the repository takes.
fn scope_of(binding: &MasterWorkspaceBinding) -> WorkspaceScope {
    WorkspaceScope {
        user_id: binding.user_id.clone(),
        workspace_id: binding.workspace_id.clone(),
    }
}

/// The `runCanonicalMasterAction` bridge input — `toolRunner.ts:38-45`.
fn bridge_input(input: &RunToolInput<'_>, key: &str) -> MasterActionBridgeInput {
    MasterActionBridgeInput {
        user_id: input.scope.user_id.clone(),
        persona_id: Some(input.scope.persona_id.clone()),
        workspace_id: Some(input.scope.workspace_id.clone()),
        task_id: input.run.id.clone(),
        action_type: input.request.action_type.clone(),
        idempotency_key: key.to_string(),
        correlation_id: Some(input.run.id.clone()),
    }
}

/// The system-operation output of a skill result — `toolRunner.ts:208-213`.
fn system_output(value: &Value) -> SystemCommandOutput {
    SystemCommandOutput {
        stdout: value["stdout"].as_str().map(str::to_string),
        stderr: value["stderr"].as_str().map(str::to_string),
        exit_code: value["exitCode"].as_i64(),
    }
}

fn args(pairs: Vec<(&str, Value)>) -> Map<String, Value> {
    pairs
        .into_iter()
        .map(|(key, value)| (key.to_string(), value))
        .collect()
}

fn id_of(value: &Value) -> &str {
    value["id"].as_str().unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use std::sync::{Arc, Mutex};

    use betaclaw_core::master::execution::runtime::capability_executor::{
        MasterToolRunner, RunToolInput,
    };
    use betaclaw_core::master::execution::runtime::types::{
        MasterRuntimeTool, ToolRunRequest, ToolRunResult,
    };
    use betaclaw_core::master::repository::sqlite_master_repository::SqliteMasterRepository;
    use betaclaw_core::master::types::MasterRun;
    use betaclaw_core::master::workspace_scope::MasterWorkspaceBinding;
    use serde_json::{json, Value};

    use super::GatewayToolRunner;
    use crate::families::master::action_bridge::ActionBridge;
    use crate::families::master::skills::{SkillDispatcher, SkillFuture, SkillInvocation};

    /// Replies with a fixed answer and records the skill names it was asked for.
    struct FakeSkills {
        reply: Result<Value, String>,
        calls: Mutex<Vec<String>>,
    }

    impl FakeSkills {
        fn replying(reply: Result<Value, String>) -> Arc<Self> {
            Arc::new(Self {
                reply,
                calls: Mutex::new(Vec::new()),
            })
        }

        fn calls(&self) -> Vec<String> {
            self.calls.lock().expect("calls lock").clone()
        }
    }

    impl SkillDispatcher for FakeSkills {
        fn dispatch<'a>(&'a self, invocation: SkillInvocation<'a>) -> SkillFuture<'a> {
            self.calls
                .lock()
                .expect("calls lock")
                .push(invocation.name.to_string());
            let reply = self.reply.clone();
            Box::pin(async move { reply })
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

    fn binding() -> MasterWorkspaceBinding {
        MasterWorkspaceBinding {
            user_id: "u1".to_string(),
            workspace_id: "w1".to_string(),
            persona_id: "p1".to_string(),
            persona_workspace_root: "/root".to_string(),
            workspace_cwd: "/root/cwd".to_string(),
        }
    }

    fn request(tool: MasterRuntimeTool, action_type: &str) -> ToolRunRequest {
        ToolRunRequest {
            tool_name: tool,
            action_type: action_type.to_string(),
            fingerprint: action_type.to_string(),
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

    fn run_with(
        skills: &Arc<FakeSkills>,
        repo: &SqliteMasterRepository,
        request: &ToolRunRequest,
        approval_bypass: bool,
    ) -> ToolRunResult {
        let runner = GatewayToolRunner::new(skills.clone(), Arc::new(ActionBridge::direct()));
        let run = run();
        let binding = binding();
        runner
            .run_tool(&RunToolInput {
                scope: &binding,
                run: &run,
                repo,
                step_id: "step-1",
                request,
                approval_bypass,
            })
            .expect("the gateway runner drives its own chain")
    }

    #[test]
    fn a_web_search_result_is_completed_with_its_details() {
        let repo = SqliteMasterRepository::open(":memory:").expect("repository");
        let skills = FakeSkills::replying(Ok(json!({ "results": [] })));
        let result = run_with(
            &skills,
            &repo,
            &request(MasterRuntimeTool::WebSearch, "web_search"),
            false,
        );
        assert_eq!(skills.calls(), vec!["web_search".to_string()]);
        match result {
            ToolRunResult::Completed { output, details } => {
                assert_eq!(output, r#"{"results":[]}"#);
                assert_eq!(details, Some(json!({ "results": [] })));
            }
            other => panic!("expected completed, got {other:?}"),
        }
    }

    #[test]
    fn a_failed_web_search_is_blocked_with_the_skill_error() {
        let repo = SqliteMasterRepository::open(":memory:").expect("repository");
        let skills = FakeSkills::replying(Err("search backend down".to_string()));
        let result = run_with(
            &skills,
            &repo,
            &request(MasterRuntimeTool::WebSearch, "web_search"),
            false,
        );
        assert_eq!(
            result,
            ToolRunResult::Blocked {
                reason: "search backend down".to_string()
            }
        );
    }

    #[test]
    fn a_committed_web_search_is_replayed_without_a_second_call() {
        let repo = SqliteMasterRepository::open(":memory:").expect("repository");
        let skills = FakeSkills::replying(Ok(json!({ "results": ["a"] })));
        let search = request(MasterRuntimeTool::WebSearch, "web_search");
        let first = run_with(&skills, &repo, &search, false);
        let second = run_with(&skills, &repo, &search, false);
        assert_eq!(skills.calls().len(), 1, "the effect runs once");
        assert_eq!(first, second, "the replay reports the same result");
    }

    #[test]
    fn a_note_is_stored_through_the_repository_without_the_skills() {
        let repo = SqliteMasterRepository::open(":memory:").expect("repository");
        let skills = FakeSkills::replying(Err("must not be called".to_string()));
        let result = run_with(
            &skills,
            &repo,
            &request(MasterRuntimeTool::Notes, "notes"),
            false,
        );
        assert!(skills.calls().is_empty());
        match result {
            ToolRunResult::Completed { output, .. } => {
                assert!(output.starts_with("Stored note "), "{output}");
            }
            other => panic!("expected completed, got {other:?}"),
        }
    }

    #[test]
    fn a_shell_command_needing_approval_is_held_without_running() {
        let repo = SqliteMasterRepository::open(":memory:").expect("repository");
        let skills = FakeSkills::replying(Err("must not be called".to_string()));
        let mut shell = request(MasterRuntimeTool::ShellExecute, "system_ops");
        shell.requires_approval = true;
        shell.command = Some("echo hi".to_string());
        let result = run_with(&skills, &repo, &shell, false);
        assert!(skills.calls().is_empty());
        assert_eq!(
            result,
            ToolRunResult::ApprovalRequired {
                summary: "Approval required for shell_execute".to_string()
            }
        );
    }

    #[test]
    fn an_approved_shell_command_reports_the_skill_stdout() {
        let repo = SqliteMasterRepository::open(":memory:").expect("repository");
        let skills =
            FakeSkills::replying(Ok(json!({ "stdout": "hi", "stderr": "", "exitCode": 0 })));
        let mut shell = request(MasterRuntimeTool::ShellExecute, "system_ops");
        shell.requires_approval = true;
        shell.command = Some("echo hi".to_string());
        let result = run_with(&skills, &repo, &shell, true);
        assert_eq!(skills.calls(), vec!["shell_execute".to_string()]);
        match result {
            ToolRunResult::Completed { output, .. } => assert_eq!(output, "hi"),
            other => panic!("expected completed, got {other:?}"),
        }
    }

    #[test]
    fn an_unimplemented_tool_is_blocked_by_name() {
        let repo = SqliteMasterRepository::open(":memory:").expect("repository");
        let skills = FakeSkills::replying(Err("must not be called".to_string()));
        let result = run_with(
            &skills,
            &repo,
            &request(MasterRuntimeTool::Read, "read"),
            false,
        );
        assert_eq!(
            result,
            ToolRunResult::Blocked {
                reason: "Tool read is not implemented in the Master runtime.".to_string()
            }
        );
    }
}
