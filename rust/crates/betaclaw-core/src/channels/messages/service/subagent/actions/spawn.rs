//! Port of `src/server/channels/messages/service/subagent/actions/spawn.ts`.

use serde_json::json;

use super::super::constants::SUBAGENT_DEFAULT_AGENT_ID;
use super::super::registry::SubagentRunRecord;
use super::super::types::{ActionResult, SpawnInputResult};
use super::super::utils::{non_empty, object, short_id};

const SPAWN_USAGE: &str = "Usage: /subagents spawn <agentId> <task> [--model <model>]";

/// `parseSpawnInput(args)`. `--model <value>` is taken out of the task text. A
/// blank agent id falls back to the default agent.
pub fn parse_spawn_input(args: &[String]) -> SpawnInputResult {
    if args.len() < 2 {
        return SpawnInputResult {
            agent_id: String::new(),
            task: String::new(),
            model_override: None,
            error: Some(SPAWN_USAGE.to_string()),
        };
    }

    let trimmed_agent = args[0].trim();
    let agent_id = if trimmed_agent.is_empty() {
        SUBAGENT_DEFAULT_AGENT_ID.to_string()
    } else {
        trimmed_agent.to_string()
    };

    let mut model_override = None;
    let mut task_parts: Vec<&str> = Vec::new();
    let mut index = 1;
    while index < args.len() {
        let token = args[index].as_str();
        if token == "--model" && index + 1 < args.len() {
            let value = args[index + 1].trim();
            model_override = if value.is_empty() {
                None
            } else {
                Some(value.to_string())
            };
            index += 2;
            continue;
        }
        task_parts.push(token);
        index += 1;
    }

    let task = task_parts.join(" ").trim().to_string();
    if task.is_empty() {
        return SpawnInputResult {
            agent_id,
            task: String::new(),
            model_override: None,
            error: Some(SPAWN_USAGE.to_string()),
        };
    }
    SpawnInputResult {
        agent_id,
        task,
        model_override,
        error: None,
    }
}

/// `formatSpawnSuccess(run)`.
pub fn format_spawn_success(run: &SubagentRunRecord) -> ActionResult {
    ActionResult {
        text: format!(
            "Spawned subagent {} ({}).",
            run.agent_id,
            short_id(&run.run_id)
        ),
        payload: object(json!({
            "status": "accepted",
            "action": "spawn",
            "runId": run.run_id,
            "agentId": run.agent_id,
            "profileId": non_empty(run.profile_id.as_deref()),
            "profileName": non_empty(run.profile_name.as_deref()),
            "skillIds": run.skill_ids.clone().unwrap_or_default(),
            "toolFunctionNames": run.tool_function_names.clone().unwrap_or_default(),
            "projectId": run.project_id,
            "workspacePath": run.workspace_path,
            "workspaceRelativePath": run.workspace_relative_path,
        })),
    }
}

/// `formatSpawnError(error)`.
pub fn format_spawn_error(error: &str) -> ActionResult {
    ActionResult {
        text: error.to_string(),
        payload: object(json!({
            "status": "error",
            "action": "spawn",
            "error": error,
        })),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn strings(values: &[&str]) -> Vec<String> {
        values.iter().map(|value| value.to_string()).collect()
    }

    #[test]
    fn extracts_model_and_defaults_blank_agent() {
        let parsed = parse_spawn_input(&strings(&["  ", "write", "--model", " gpt-x ", "tests"]));
        assert!(parsed.error.is_none());
        assert_eq!(parsed.agent_id, SUBAGENT_DEFAULT_AGENT_ID);
        assert_eq!(parsed.task, "write tests");
        assert_eq!(parsed.model_override.as_deref(), Some("gpt-x"));
    }

    #[test]
    fn missing_task_reports_usage() {
        let parsed = parse_spawn_input(&strings(&["qa", "--model", "m"]));
        assert_eq!(parsed.error.as_deref(), Some(SPAWN_USAGE));
        assert!(parsed.task.is_empty());
    }
}
