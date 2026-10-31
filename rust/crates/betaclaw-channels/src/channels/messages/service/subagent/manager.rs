//! Port of `src/server/channels/messages/service/subagent/index.ts`, the
//! `SubagentManager` class.
//!
//! The class keeps its TypeScript structure. Pure helpers that the class forwards
//! to are free functions in `utils` and `actions`. The registry is injected, and
//! so are the two settings the TS constructor takes as closures.

use std::sync::Arc;

use serde_json::json;

use crate::channels::messages::service::execution::ports::PortResult;

use super::actions::kill::{
    execute_kill_all_action, execute_kill_target_action, format_kill_missing_target_error,
};
use super::actions::list::{execute_list_action, format_subagent_list};
use super::actions::spawn::{format_spawn_error, format_spawn_success, parse_spawn_input};
use super::agent_profiles::list_subagent_agent_profiles;
use super::lifecycle::{start_subagent_run, WorkspaceResolver};
use super::registry::{SubagentRegistry, SubagentRunRecord, SubagentRunStatus};
use super::types::{
    ActionResult, RunSubagentParams, StartSubagentRunParams, SubagentManagerDeps,
    SubagentTargetResult,
};
use super::utils::{non_empty, object, short_id};
use crate::channels::messages::service::types::{SubagentAction, SubagentDispatchContext};

const STEER_REASON: &str = "Run interrupted by steer request.";

/// `getSubagentMaxActivePerConversation` (the TS constructor argument).
pub type MaxActiveResolver = Arc<dyn Fn() -> usize + Send + Sync>;

/// `SubagentManager` from `subagent/index.ts:22`.
pub struct SubagentManager {
    registry: Arc<dyn SubagentRegistry>,
    max_active: MaxActiveResolver,
    workspace: Option<WorkspaceResolver>,
}

impl SubagentManager {
    pub fn new(
        registry: Arc<dyn SubagentRegistry>,
        max_active: MaxActiveResolver,
        workspace: Option<WorkspaceResolver>,
    ) -> Self {
        Self {
            registry,
            max_active,
            workspace,
        }
    }

    /// `formatSubagentList(conversationId)`.
    pub fn format_subagent_list(&self, conversation_id: &str) -> String {
        format_subagent_list(self.registry.as_ref(), conversation_id)
    }

    /// `resolveSubagentTarget(conversationId, rawTarget)`.
    pub fn resolve_subagent_target(
        &self,
        conversation_id: &str,
        raw_target: &str,
    ) -> SubagentTargetResult {
        super::utils::resolve_subagent_target(self.registry.as_ref(), conversation_id, raw_target)
    }

    /// `formatSubagentProfiles()`.
    pub fn format_subagent_profiles(&self) -> String {
        let mut lines = vec!["Subagent profiles".to_string(), String::new()];
        for profile in list_subagent_agent_profiles() {
            let tools = if profile.tool_function_names.is_empty() {
                "(all)".to_string()
            } else {
                profile.tool_function_names.join(", ")
            };
            let skills = if profile.skill_ids.is_empty() {
                "(all)".to_string()
            } else {
                profile.skill_ids.join(", ")
            };
            let aliases = if profile.aliases.is_empty() {
                String::new()
            } else {
                format!(" aliases: {}", profile.aliases.join(", "))
            };
            lines.push(format!("- {}: {}", profile.id, profile.description));
            lines.push(format!("  tools: {tools}"));
            lines.push(format!("  skills: {skills}{aliases}"));
        }
        lines.join("\n")
    }

    /// `startSubagentRun(params)`: enforces the per-conversation limit.
    pub fn start_subagent_run(
        &self,
        params: StartSubagentRunParams,
    ) -> PortResult<SubagentRunRecord> {
        let max_active = (self.max_active)();
        start_subagent_run(
            self.registry.as_ref(),
            max_active,
            self.workspace.as_ref(),
            params,
        )
    }

    /// `executeSubagentAction(context, action, args, deps)`.
    pub fn execute_subagent_action(
        &self,
        context: &SubagentDispatchContext,
        action: SubagentAction,
        args: &[String],
        deps: &dyn SubagentManagerDeps,
    ) -> PortResult<ActionResult> {
        let conversation = &context.conversation;
        let registry = self.registry.as_ref();

        match action {
            SubagentAction::Help => Ok(ActionResult {
                text: self.help_text(),
                payload: Default::default(),
            }),

            SubagentAction::Profiles => Ok(ActionResult {
                text: self.format_subagent_profiles(),
                payload: object(json!({
                    "status": "ok",
                    "action": "profiles",
                    "profiles": list_subagent_agent_profiles(),
                })),
            }),

            SubagentAction::List => Ok(execute_list_action(registry, &conversation.id)),

            SubagentAction::Spawn => {
                let parsed = parse_spawn_input(args);
                if let Some(error) = parsed.error {
                    return Ok(format_spawn_error(&error));
                }
                let run = deps.start_subagent_run(StartSubagentRunParams {
                    conversation: conversation.clone(),
                    platform: context.platform,
                    external_chat_id: context.external_chat_id.clone(),
                    agent_id: parsed.agent_id,
                    task: parsed.task,
                    guidance: None,
                    model_override: parsed.model_override,
                })?;

                deps.run_subagent(RunSubagentParams {
                    conversation: conversation.clone(),
                    platform: context.platform,
                    external_chat_id: context.external_chat_id.clone(),
                    run: run.clone(),
                });

                Ok(format_spawn_success(&run))
            }

            SubagentAction::Kill => {
                let target = first_arg(args);
                if target.is_empty() {
                    return Ok(format_kill_missing_target_error());
                }
                if target == "all" || target == "*" {
                    return Ok(execute_kill_all_action(registry, &conversation.id));
                }
                let resolved = self.resolve_subagent_target(&conversation.id, target);
                Ok(execute_kill_target_action(registry, target, &resolved))
            }

            SubagentAction::Steer => {
                let target = first_arg(args);
                let guidance = args
                    .iter()
                    .skip(1)
                    .map(String::as_str)
                    .collect::<Vec<&str>>()
                    .join(" ")
                    .trim()
                    .to_string();
                if target.is_empty() || guidance.is_empty() {
                    return Ok(ActionResult {
                        text: "Usage: /subagents steer <id|#> <message>".to_string(),
                        payload: object(json!({
                            "status": "error",
                            "action": "steer",
                            "error": "Missing target or message.",
                        })),
                    });
                }

                let resolved = self.resolve_subagent_target(&conversation.id, target);
                let Some(previous) = resolved.run else {
                    let error = resolved
                        .error
                        .unwrap_or_else(|| "Unknown subagent target.".to_string());
                    return Ok(ActionResult {
                        text: error.clone(),
                        payload: object(json!({
                            "status": "error",
                            "action": "steer",
                            "target": target,
                            "error": error,
                        })),
                    });
                };

                if previous.status == SubagentRunStatus::Running {
                    registry.abort_run(&previous.run_id, STEER_REASON);
                }

                let replacement = deps.start_subagent_run(StartSubagentRunParams {
                    conversation: conversation.clone(),
                    platform: context.platform,
                    external_chat_id: context.external_chat_id.clone(),
                    agent_id: previous.agent_id.clone(),
                    task: previous.task.clone(),
                    guidance: Some(guidance),
                    model_override: previous.model_override.clone(),
                })?;

                deps.run_subagent(RunSubagentParams {
                    conversation: conversation.clone(),
                    platform: context.platform,
                    external_chat_id: context.external_chat_id.clone(),
                    run: replacement.clone(),
                });
                registry.replace_run(&previous.run_id, &replacement.run_id);

                Ok(ActionResult {
                    text: format!(
                        "Steered {}: {} started.",
                        previous.agent_id,
                        short_id(&replacement.run_id)
                    ),
                    payload: object(json!({
                        "status": "accepted",
                        "action": "steer",
                        "target": target,
                        "previousRunId": previous.run_id,
                        "runId": replacement.run_id,
                    })),
                })
            }

            SubagentAction::Info | SubagentAction::Log => {
                let target = first_arg(args);
                if target.is_empty() {
                    return Ok(ActionResult {
                        text: format!("Usage: /subagents {} <id|#>", action.as_str()),
                        payload: object(json!({
                            "status": "error",
                            "action": action.as_str(),
                            "error": "Missing target.",
                        })),
                    });
                }

                let resolved = self.resolve_subagent_target(&conversation.id, target);
                let Some(run) = resolved.run else {
                    let error = resolved
                        .error
                        .unwrap_or_else(|| "Unknown subagent target.".to_string());
                    return Ok(ActionResult {
                        text: error.clone(),
                        payload: object(json!({
                            "status": "error",
                            "action": action.as_str(),
                            "target": target,
                            "error": error,
                        })),
                    });
                };

                let text = if action == SubagentAction::Log {
                    non_empty(run.result_preview.as_deref())
                        .or(non_empty(run.error.as_deref()))
                        .unwrap_or("(no output)")
                        .to_string()
                } else {
                    info_text(&run)
                };
                Ok(ActionResult {
                    text,
                    payload: object(json!({
                        "status": "ok",
                        "action": action.as_str(),
                        "run": run,
                    })),
                })
            }
        }
    }

    fn help_text(&self) -> String {
        let mut lines: Vec<String> = [
            "Subagent commands:",
            "- /subagents list",
            "- /subagents spawn <agentId> <task> [--model <model>]",
            "- /subagents profiles",
            "- /subagents kill <id|#|all>",
            "- /subagents steer <id|#> <message>",
            "- /subagents info <id|#>",
            "- /subagents log <id|#>",
            "- /kill <id|#|all>",
            "- /steer <id|#> <message>",
            "",
        ]
        .iter()
        .map(|line| line.to_string())
        .collect();
        lines.push(self.format_subagent_profiles());
        lines.join("\n")
    }
}

/// `String(args[0] || '').trim()`.
fn first_arg(args: &[String]) -> &str {
    args.first().map(|value| value.trim()).unwrap_or("")
}

/// `list.length > 0 ? list.join(', ') : null`, the JavaScript `?.length` check.
fn joined(values: &Option<Vec<String>>) -> Option<String> {
    values
        .as_ref()
        .filter(|list| !list.is_empty())
        .map(|list| list.join(", "))
}

/// The multi-line `info` text (`index.ts:266-285`).
fn info_text(run: &SubagentRunRecord) -> String {
    let lines: [Option<String>; 13] = [
        Some(format!("runId: {}", run.run_id)),
        Some(format!("agentId: {}", run.agent_id)),
        non_empty(run.profile_id.as_deref()).map(|value| format!("profileId: {value}")),
        non_empty(run.profile_name.as_deref()).map(|value| format!("profile: {value}")),
        joined(&run.tool_function_names).map(|value| format!("tools: {value}")),
        joined(&run.skill_ids).map(|value| format!("skills: {value}")),
        Some(format!("status: {}", run.status.as_str())),
        Some(format!("startedAt: {}", run.started_at)),
        Some(format!(
            "endedAt: {}",
            non_empty(run.ended_at.as_deref()).unwrap_or("-")
        )),
        Some(format!("task: {}", run.task)),
        non_empty(run.guidance.as_deref()).map(|value| format!("guidance: {value}")),
        non_empty(run.workspace_path.as_deref()).map(|value| format!("workspace: {value}")),
        non_empty(run.error.as_deref()).map(|value| format!("error: {value}")),
    ];
    lines
        .into_iter()
        .flatten()
        .collect::<Vec<String>>()
        .join("\n")
}

#[cfg(test)]
mod tests {
    use std::sync::Mutex;

    use super::*;
    use crate::channels::messages::service::execution::ports::PortResult;
    use crate::channels::messages::service::execution::test_doubles::{
        conversation, run_record, FakeRegistry,
    };
    use crate::messages_store::types::ChannelType;

    /// Starts runs through the real manager and records the runner calls.
    struct RecordingDeps<'a> {
        manager: &'a SubagentManager,
        started: Mutex<Vec<String>>,
        spawned: Mutex<Vec<String>>,
    }

    impl SubagentManagerDeps for RecordingDeps<'_> {
        fn start_subagent_run(
            &self,
            params: StartSubagentRunParams,
        ) -> PortResult<SubagentRunRecord> {
            self.started.lock().unwrap().push(params.agent_id.clone());
            self.manager.start_subagent_run(params)
        }

        fn run_subagent(&self, params: RunSubagentParams) {
            self.spawned.lock().unwrap().push(params.run.run_id);
        }
    }

    fn context() -> SubagentDispatchContext {
        SubagentDispatchContext {
            conversation: conversation("conv", "user-1", None),
            platform: ChannelType::WebChat,
            external_chat_id: "web-1".to_string(),
        }
    }

    fn args(values: &[&str]) -> Vec<String> {
        values.iter().map(|value| value.to_string()).collect()
    }

    fn manager(registry: Arc<FakeRegistry>) -> SubagentManager {
        SubagentManager::new(registry, Arc::new(|| 5usize), None)
    }

    #[test]
    fn help_lists_commands_and_profiles() {
        let registry = Arc::new(FakeRegistry::default());
        let manager = manager(registry);
        let deps = RecordingDeps {
            manager: &manager,
            started: Mutex::new(Vec::new()),
            spawned: Mutex::new(Vec::new()),
        };

        let result = manager
            .execute_subagent_action(&context(), SubagentAction::Help, &[], &deps)
            .unwrap();
        assert!(result.text.starts_with("Subagent commands:"));
        assert!(result.text.contains("\nSubagent profiles\n"));
        assert!(result.text.contains("  tools: (all)"));
        assert!(result.payload.is_empty());
    }

    #[test]
    fn spawn_starts_a_run_and_hands_it_to_the_runner() {
        let registry = Arc::new(FakeRegistry::default());
        let manager = manager(registry);
        let deps = RecordingDeps {
            manager: &manager,
            started: Mutex::new(Vec::new()),
            spawned: Mutex::new(Vec::new()),
        };

        let result = manager
            .execute_subagent_action(
                &context(),
                SubagentAction::Spawn,
                &args(&["qa", "check", "login"]),
                &deps,
            )
            .unwrap();
        assert_eq!(result.payload["status"], json!("accepted"));
        assert_eq!(result.payload["profileId"], json!("qa"));
        assert_eq!(deps.started.lock().unwrap().as_slice(), ["qa"]);
        assert_eq!(deps.spawned.lock().unwrap().len(), 1);
    }

    #[test]
    fn steer_interrupts_the_running_run_and_replaces_it() {
        let registry = Arc::new(FakeRegistry::default());
        registry.seed(run_record(
            "subagent-old1",
            "conv",
            SubagentRunStatus::Running,
        ));
        let manager = manager(registry.clone());
        let deps = RecordingDeps {
            manager: &manager,
            started: Mutex::new(Vec::new()),
            spawned: Mutex::new(Vec::new()),
        };

        let result = manager
            .execute_subagent_action(
                &context(),
                SubagentAction::Steer,
                &args(&["subagent-old", "be", "brief"]),
                &deps,
            )
            .unwrap();
        assert_eq!(result.payload["status"], json!("accepted"));
        assert_eq!(result.payload["previousRunId"], json!("subagent-old1"));

        let previous = registry.get("subagent-old1");
        assert_eq!(previous.status, SubagentRunStatus::Killed);
        let new_run_id = result.payload["runId"].as_str().unwrap().to_string();
        assert_eq!(
            previous.replaced_by_run_id.as_deref(),
            Some(new_run_id.as_str())
        );
        assert_eq!(deps.spawned.lock().unwrap().as_slice(), [new_run_id]);
    }

    #[test]
    fn info_for_unknown_target_is_an_error_payload() {
        let registry = Arc::new(FakeRegistry::default());
        let manager = manager(registry);
        let deps = RecordingDeps {
            manager: &manager,
            started: Mutex::new(Vec::new()),
            spawned: Mutex::new(Vec::new()),
        };

        let result = manager
            .execute_subagent_action(&context(), SubagentAction::Info, &args(&["zzz"]), &deps)
            .unwrap();
        assert_eq!(result.text, "Unknown target zzz.");
        assert_eq!(result.payload["status"], json!("error"));
        assert_eq!(result.payload["target"], json!("zzz"));
    }
}
