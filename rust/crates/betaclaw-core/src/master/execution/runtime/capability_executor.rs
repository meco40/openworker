//! Port of `src/server/master/execution/runtime/capabilityExecutor.ts:1-217`.
//!
//! Runs one capability: guard on the persona's allowed tools and the generic
//! runtime flag, then dispatch to `web_search`, `code_generation`, `notes`,
//! `reminders` or `system_ops` and fold the tool result into a
//! [`CapabilityTaskResult`].
//!
//! # `runTool` is a seam (OP-S9-14)
//!
//! `capabilityExecutor.ts:4` imports `runTool` from
//! `@/server/master/execution/runtime/toolRunner`. Its port is
//! [`super::tool_runner::run_tool`], which is async and runs on the S6 bridge
//! seam. This module keeps the synchronous [`MasterToolRunner`] seam, and the
//! gateway supplies the adapter once S6 lands (OP-S9-14).
//!
//! # The `catch` around `runTool`
//!
//! `web_search` wraps its `runTool` call in `try/catch`
//! (`capabilityExecutor.ts:58-94`). The seam returns `Result`, and an `Err` takes
//! the research fallback at score 0.62. Other `Err`s propagate, as a rejected
//! promise does in the source. The `new Date(Date.now() + 3600_000)` of the
//! reminder path is the `now` argument.

use chrono::{DateTime, Duration as ChronoDuration, SecondsFormat, Utc};
use serde_json::Value;

use crate::master::execution::runtime::capability_control::build_system_command;
use crate::master::execution::runtime::capability_output::to_summary_from_search_result;
use crate::master::execution::runtime::code_generation::build_code_generation_content;
use crate::master::execution::runtime::execution_plan::MasterModelDispatch;
use crate::master::feature_flags::{is_master_generic_runtime_enabled, MasterEnv};
use crate::master::repository::MasterRepository;
use crate::master::runtime_persona::{
    get_master_runtime_persona_config, MasterRuntimePersonaInput,
};
use crate::master::types::MasterRun;
use crate::master::workspace_scope::MasterWorkspaceBinding;
use crate::personas::repository::PersonaRepository;

use super::code_generation::CodeGenerationInput;
use super::types::{
    Capability, CapabilityControl, CapabilityTaskResult, MasterRuntimeTool, RuntimeMode,
    ToolRunRequest, ToolRunResult,
};

/// `input` of `runTool` — `toolRunner.ts:69-77`.
pub struct RunToolInput<'a> {
    pub scope: &'a MasterWorkspaceBinding,
    pub run: &'a MasterRun,
    pub repo: &'a dyn MasterRepository,
    pub step_id: &'a str,
    pub request: &'a ToolRunRequest,
    pub approval_bypass: bool,
}

/// The synchronous seam for `runTool` (`toolRunner.ts`). `Err` is a rejected
/// promise of the source, which the `web_search` `catch` turns into the research
/// fallback. Its async port is [`super::tool_runner::run_tool`]; the adapter is
/// OP-S9-14.
pub trait MasterToolRunner: Send + Sync {
    fn run_tool(&self, input: &RunToolInput<'_>) -> Result<ToolRunResult, String>;
}

/// `input` of `executeCapabilityTask` — `capabilityExecutor.ts:16-24`.
pub struct ExecuteCapabilityTaskInput<'a> {
    pub scope: &'a MasterWorkspaceBinding,
    pub run: &'a MasterRun,
    pub capability: Capability,
    pub step_id: &'a str,
    pub repo: &'a dyn MasterRepository,
    pub control: &'a CapabilityControl,
    pub approval_bypass: bool,
}

/// A degraded/blocked task result with the given output.
fn degraded(output: String, confidence: f64) -> CapabilityTaskResult {
    CapabilityTaskResult {
        output,
        confidence,
        mode: RuntimeMode::Fallback,
        degraded_mode: true,
    }
}

/// `result.status === 'completed' ? result.output : result.status === 'blocked'
/// ? result.reason : result.summary` of the non-search branches.
fn tool_output(result: &ToolRunResult) -> String {
    match result {
        ToolRunResult::Completed { output, .. } => output.clone(),
        ToolRunResult::Blocked { reason } => reason.clone(),
        ToolRunResult::ApprovalRequired { summary } => summary.clone(),
    }
}

fn is_completed(result: &ToolRunResult) -> bool {
    matches!(result, ToolRunResult::Completed { .. })
}

/// `executeCapabilityTask` — `capabilityExecutor.ts:16-217`. `Err` is a rejected
/// `runTool` outside the `web_search` `try/catch`, which propagates as in the source.
pub fn execute_capability_task(
    input: &ExecuteCapabilityTaskInput<'_>,
    persona_repo: &PersonaRepository,
    env: &MasterEnv,
    model: &dyn MasterModelDispatch,
    tool_runner: &dyn MasterToolRunner,
    now: DateTime<Utc>,
) -> Result<CapabilityTaskResult, String> {
    let capability = input.capability;
    let runtime_persona = get_master_runtime_persona_config(
        &MasterRuntimePersonaInput {
            user_id: input.scope.user_id.clone(),
            persona_id: Some(input.scope.persona_id.clone()),
        },
        persona_repo,
        env,
    );

    let required_tool = match capability {
        Capability::WebSearch => Some(MasterRuntimeTool::WebSearch),
        Capability::CodeGeneration => Some(MasterRuntimeTool::Write),
        Capability::SystemOps => Some(MasterRuntimeTool::ShellExecute),
        Capability::Notes | Capability::Reminders => None,
    };
    if let Some(required) = required_tool {
        let allowed = runtime_persona
            .as_ref()
            .map(|persona| {
                persona
                    .allowed_tool_function_names
                    .iter()
                    .any(|name| name == required.as_str())
            })
            .unwrap_or(false);
        if !allowed {
            return Ok(degraded(
                format!(
                    "Capability {} is not allowed because tool {} is not allowed.",
                    capability.as_str(),
                    required.as_str()
                ),
                0.2,
            ));
        }
    }

    if !is_master_generic_runtime_enabled(env) {
        return Ok(degraded(
            format!(
                "Generic runtime is disabled for capability {}.",
                capability.as_str()
            ),
            0.2,
        ));
    }

    let run_tool = |request: ToolRunRequest| {
        tool_runner.run_tool(&RunToolInput {
            scope: input.scope,
            run: input.run,
            repo: input.repo,
            step_id: input.step_id,
            request: &request,
            approval_bypass: input.approval_bypass,
        })
    };

    match capability {
        Capability::WebSearch => {
            // `try { runTool } catch { ... }` of `capabilityExecutor.ts:57-94`: a
            // rejected `runTool` becomes the research fallback at score 0.62.
            let result = run_tool(ToolRunRequest {
                tool_name: MasterRuntimeTool::WebSearch,
                action_type: "web_search".to_string(),
                fingerprint: "web_search".to_string(),
                requires_approval: false,
                command: None,
                path: None,
                content: None,
                query: Some(input.run.contract.clone()),
                note_title: None,
                note_content: None,
                note_tags: None,
                remind_at: None,
                cron_expression: None,
            });
            Ok(match result {
                Ok(ToolRunResult::Completed { details, .. }) => CapabilityTaskResult {
                    output: to_summary_from_search_result(details.as_ref().unwrap_or(&Value::Null)),
                    confidence: 0.78,
                    mode: RuntimeMode::Fallback,
                    degraded_mode: false,
                },
                Ok(other) => degraded(tool_output(&other), 0.25),
                Err(_) => degraded(
                    format!(
                        "Fallback research summary for contract: {}",
                        input.run.contract
                    ),
                    0.62,
                ),
            })
        }

        Capability::CodeGeneration => {
            let file_path = input
                .control
                .file_path
                .clone()
                .unwrap_or_else(|| format!("master-output/{}-solution.md", input.run.id));
            let generated = build_code_generation_content(
                &CodeGenerationInput {
                    run: input.run,
                    file_path: Some(&file_path),
                    scope: &MasterRuntimePersonaInput {
                        user_id: input.scope.user_id.clone(),
                        persona_id: Some(input.scope.persona_id.clone()),
                    },
                },
                persona_repo,
                env,
                model,
            );
            let result = run_tool(ToolRunRequest {
                tool_name: MasterRuntimeTool::Write,
                action_type: input.control.action_type.clone(),
                fingerprint: input.control.fingerprint.clone(),
                requires_approval: input.control.requires_approval,
                command: None,
                path: Some(file_path.clone()),
                content: Some(generated.content.clone()),
                query: None,
                note_title: None,
                note_content: None,
                note_tags: None,
                remind_at: None,
                cron_expression: None,
            })?;
            let completed = is_completed(&result);
            Ok(CapabilityTaskResult {
                output: if completed {
                    format!("Wrote implementation draft to {file_path}")
                } else {
                    tool_output(&result)
                },
                confidence: if completed {
                    if generated.mode == RuntimeMode::Model {
                        0.86
                    } else {
                        0.74
                    }
                } else {
                    0.25
                },
                mode: generated.mode,
                degraded_mode: generated.degraded_mode || !completed,
            })
        }
        Capability::Notes => {
            let result = run_tool(ToolRunRequest {
                tool_name: MasterRuntimeTool::Notes,
                action_type: "notes".to_string(),
                fingerprint: "notes".to_string(),
                requires_approval: false,
                command: None,
                path: None,
                content: None,
                query: None,
                note_title: Some(format!("Master note: {}", input.run.title)),
                note_content: Some(input.run.contract.clone()),
                note_tags: Some(vec!["master".to_string(), "autonomous".to_string()]),
                remind_at: None,
                cron_expression: None,
            })?;
            let completed = is_completed(&result);
            Ok(CapabilityTaskResult {
                output: tool_output(&result),
                confidence: if completed { 0.8 } else { 0.25 },
                mode: RuntimeMode::Fallback,
                degraded_mode: !completed,
            })
        }
        Capability::Reminders => {
            let remind_at = (now + ChronoDuration::milliseconds(60 * 60 * 1000))
                .to_rfc3339_opts(SecondsFormat::Millis, true);
            let result = run_tool(ToolRunRequest {
                tool_name: MasterRuntimeTool::Reminders,
                action_type: "reminders".to_string(),
                fingerprint: "reminders".to_string(),
                requires_approval: false,
                command: None,
                path: None,
                content: None,
                query: None,
                note_title: Some(format!("Follow-up: {}", input.run.title)),
                note_content: Some(input.run.contract.clone()),
                note_tags: None,
                remind_at: Some(remind_at),
                cron_expression: None,
            })?;
            let completed = is_completed(&result);
            Ok(CapabilityTaskResult {
                output: tool_output(&result),
                confidence: if completed { 0.75 } else { 0.25 },
                mode: RuntimeMode::Fallback,
                degraded_mode: !completed,
            })
        }
        Capability::SystemOps => {
            let command = input
                .control
                .command
                .clone()
                .unwrap_or_else(|| build_system_command(&input.run.contract));
            let result = run_tool(ToolRunRequest {
                tool_name: MasterRuntimeTool::ShellExecute,
                action_type: input.control.action_type.clone(),
                fingerprint: input.control.fingerprint.clone(),
                requires_approval: input.control.requires_approval,
                command: Some(command),
                path: None,
                content: None,
                query: None,
                note_title: None,
                note_content: None,
                note_tags: None,
                remind_at: None,
                cron_expression: None,
            })?;
            let completed = is_completed(&result);
            Ok(CapabilityTaskResult {
                output: tool_output(&result),
                confidence: if completed { 0.65 } else { 0.25 },
                mode: RuntimeMode::Fallback,
                degraded_mode: !completed,
            })
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::master::execution::runtime::execution_plan::{
        MasterModelDispatch, MasterModelRequest, MasterModelResponse,
    };
    use crate::master::repository::sqlite_master_repository::SqliteMasterRepository;
    use crate::personas::repository::PersonaRepository;
    use crate::personas::workspace::PersonaWorkspace;

    struct TempDir(std::path::PathBuf);

    impl TempDir {
        fn new() -> Self {
            let unique = uuid::Uuid::new_v4().simple().to_string();
            let path = std::env::temp_dir().join(format!("betaclaw-master-cap-{unique}"));
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

    struct FixedToolRunner(ToolRunResult);

    impl MasterToolRunner for FixedToolRunner {
        fn run_tool(&self, _input: &RunToolInput<'_>) -> Result<ToolRunResult, String> {
            Ok(self.0.clone())
        }
    }

    /// A rejected `runTool`: the bridge fails before it runs anything.
    struct RejectingToolRunner;

    impl MasterToolRunner for RejectingToolRunner {
        fn run_tool(&self, _input: &RunToolInput<'_>) -> Result<ToolRunResult, String> {
            Err("bridge down".to_string())
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

    fn now() -> DateTime<Utc> {
        use chrono::TimeZone;
        Utc.with_ymd_and_hms(2026, 1, 1, 0, 0, 0).unwrap()
    }

    fn control(action_type: &str) -> CapabilityControl {
        CapabilityControl {
            requires_approval: false,
            action_type: action_type.to_string(),
            fingerprint: action_type.to_string(),
            file_path: None,
            command: None,
        }
    }

    #[test]
    fn a_disabled_generic_runtime_degrades() {
        let dir = TempDir::new();
        let repo = dir.repo();
        let master = SqliteMasterRepository::open(":memory:").unwrap();
        let binding = binding();
        let run = run();
        let control = control("notes");
        let mut env = MasterEnv::new();
        env.insert(
            "MASTER_GENERIC_RUNTIME_ENABLED".to_string(),
            "false".to_string(),
        );
        let result = execute_capability_task(
            &ExecuteCapabilityTaskInput {
                scope: &binding,
                run: &run,
                capability: Capability::Notes,
                step_id: "step-1",
                repo: &master,
                control: &control,
                approval_bypass: false,
            },
            &repo,
            &env,
            &FailingModel,
            &FixedToolRunner(ToolRunResult::Completed {
                output: "x".to_string(),
                details: None,
            }),
            now(),
        )
        .unwrap();
        assert_eq!(
            result.output,
            "Generic runtime is disabled for capability notes."
        );
        assert_eq!(result.confidence, 0.2);
        assert!(result.degraded_mode);
    }

    #[test]
    fn a_completed_notes_tool_is_reported_verbatim() {
        let dir = TempDir::new();
        let repo = dir.repo();
        let master = SqliteMasterRepository::open(":memory:").unwrap();
        let binding = binding();
        let run = run();
        let control = control("notes");
        let result = execute_capability_task(
            &ExecuteCapabilityTaskInput {
                scope: &binding,
                run: &run,
                capability: Capability::Notes,
                step_id: "step-1",
                repo: &master,
                control: &control,
                approval_bypass: false,
            },
            &repo,
            &MasterEnv::new(),
            &FailingModel,
            &FixedToolRunner(ToolRunResult::Completed {
                output: "note-1".to_string(),
                details: None,
            }),
            now(),
        )
        .unwrap();
        assert_eq!(result.output, "note-1");
        assert_eq!(result.confidence, 0.8);
        assert!(!result.degraded_mode);
    }

    #[test]
    fn a_completed_web_search_uses_the_row_summary() {
        let dir = TempDir::new();
        let repo = dir.repo();
        let master = SqliteMasterRepository::open(":memory:").unwrap();
        let binding = binding();
        let run = run();
        let control = control("web_search");
        let result = execute_capability_task(
            &ExecuteCapabilityTaskInput {
                scope: &binding,
                run: &run,
                capability: Capability::WebSearch,
                step_id: "step-1",
                repo: &master,
                control: &control,
                approval_bypass: false,
            },
            &repo,
            &MasterEnv::new(),
            &FailingModel,
            &FixedToolRunner(ToolRunResult::Completed {
                output: "unused".to_string(),
                details: Some(serde_json::json!({
                    "results": [{ "title": "A", "url": "https://a" }]
                })),
            }),
            now(),
        )
        .unwrap();
        assert_eq!(result.output, "1. A (https://a)");
        assert_eq!(result.confidence, 0.78);
        assert!(!result.degraded_mode);
    }

    #[test]
    fn a_blocked_tool_reports_its_reason() {
        let dir = TempDir::new();
        let repo = dir.repo();
        let master = SqliteMasterRepository::open(":memory:").unwrap();
        let binding = binding();
        let run = run();
        let control = control("reminders");
        let result = execute_capability_task(
            &ExecuteCapabilityTaskInput {
                scope: &binding,
                run: &run,
                capability: Capability::Reminders,
                step_id: "step-1",
                repo: &master,
                control: &control,
                approval_bypass: false,
            },
            &repo,
            &MasterEnv::new(),
            &FailingModel,
            &FixedToolRunner(ToolRunResult::Blocked {
                reason: "denied".to_string(),
            }),
            now(),
        )
        .unwrap();
        assert_eq!(result.output, "denied");
        assert_eq!(result.confidence, 0.25);
        assert!(result.degraded_mode);
    }

    #[test]
    fn a_rejected_web_search_falls_back_to_the_research_summary() {
        let dir = TempDir::new();
        let repo = dir.repo();
        let master = SqliteMasterRepository::open(":memory:").unwrap();
        let binding = binding();
        let run = run();
        let control = control("web_search");
        let result = execute_capability_task(
            &ExecuteCapabilityTaskInput {
                scope: &binding,
                run: &run,
                capability: Capability::WebSearch,
                step_id: "step-1",
                repo: &master,
                control: &control,
                approval_bypass: false,
            },
            &repo,
            &MasterEnv::new(),
            &FailingModel,
            &RejectingToolRunner,
            now(),
        )
        .unwrap();
        assert_eq!(
            result.output,
            "Fallback research summary for contract: Contract"
        );
        assert_eq!(result.confidence, 0.62);
        assert_eq!(result.mode, RuntimeMode::Fallback);
        assert!(result.degraded_mode);
    }

    #[test]
    fn a_rejected_notes_tool_propagates_like_the_source() {
        let dir = TempDir::new();
        let repo = dir.repo();
        let master = SqliteMasterRepository::open(":memory:").unwrap();
        let binding = binding();
        let run = run();
        let control = control("notes");
        let error = execute_capability_task(
            &ExecuteCapabilityTaskInput {
                scope: &binding,
                run: &run,
                capability: Capability::Notes,
                step_id: "step-1",
                repo: &master,
                control: &control,
                approval_bypass: false,
            },
            &repo,
            &MasterEnv::new(),
            &FailingModel,
            &RejectingToolRunner,
            now(),
        )
        .unwrap_err();
        assert_eq!(error, "bridge down");
    }
}
