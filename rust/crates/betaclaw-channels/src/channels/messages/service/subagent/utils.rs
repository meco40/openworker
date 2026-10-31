//! Port of `src/server/channels/messages/service/subagent/utils.ts`.
//!
//! Also holds the small JavaScript-semantics helpers that the subagent modules
//! share: truthiness of optional strings, `String(x || '')` coercion, and
//! `slice(0, n)`, which counts UTF-16 units.

use std::collections::{HashMap, HashSet};

use serde_json::{Map, Value};

use crate::channels::messages::service::types::ResolvedToolContext;

use super::constants::SUBAGENT_RECENT_MINUTES;
use super::registry::{SubagentRegistry, SubagentRunRecord};
use super::types::{ParsedSubagentAction, SubagentTargetResult};
use crate::channels::messages::service::types::SubagentAction;

/// `value.slice(0, max)` in JavaScript: keeps at most `max` UTF-16 units. A cut
/// never splits a surrogate pair. JavaScript could leave a lone surrogate there,
/// which a Rust string cannot hold.
pub fn truncate_utf16(text: &str, max_units: usize) -> &str {
    let mut units = 0;
    for (index, ch) in text.char_indices() {
        let next = units + ch.len_utf16();
        if next > max_units {
            return &text[..index];
        }
        units = next;
    }
    text
}

/// `runId.slice(0, 8)`, the short id shown to users.
pub fn short_id(run_id: &str) -> &str {
    truncate_utf16(run_id, 8)
}

/// Keeps a string only when JavaScript would treat it as truthy (`s ? s : ...`).
pub fn non_empty(value: Option<&str>) -> Option<&str> {
    value.filter(|text| !text.is_empty())
}

/// Coerces a JSON argument the way `String(args.x || '')` does. `null`, `false`,
/// `0` and `""` are falsy and become empty. Other scalars are stringified.
/// Objects and arrays become empty, which is a deliberate simplification.
pub fn str_arg(args: &Map<String, Value>, key: &str) -> String {
    match args.get(key) {
        Some(Value::String(text)) => text.clone(),
        Some(Value::Number(number)) if number.as_f64() != Some(0.0) => number.to_string(),
        Some(Value::Bool(true)) => "true".to_string(),
        _ => String::new(),
    }
}

/// Turns a JSON object literal into the map used for payloads.
pub fn object(value: Value) -> Map<String, Value> {
    match value {
        Value::Object(map) => map,
        _ => Map::new(),
    }
}

/// `resolveToolFunctionName` (`utils.ts:5-11`).
pub fn resolve_tool_function_name(tool: &Value) -> &str {
    if let Some(name) = tool
        .get("function")
        .and_then(|function| function.get("name"))
        .and_then(Value::as_str)
    {
        return name;
    }
    tool.get("name").and_then(Value::as_str).unwrap_or("")
}

/// `filterToolContextForSubagent` (`utils.ts:13-60`). `subagents` is always removed.
/// A non-empty allow-list narrows the context to those functions. An allow-list
/// that is empty after trimming means "no filter".
pub fn filter_tool_context_for_subagent(
    tool_context: &ResolvedToolContext,
    allowed_function_names: Option<&[String]>,
) -> ResolvedToolContext {
    let allowed: Option<HashSet<String>> = allowed_function_names
        .map(|names| {
            names
                .iter()
                .map(|name| name.trim().to_string())
                .filter(|name| !name.is_empty())
                .collect::<HashSet<String>>()
        })
        .filter(|set| !set.is_empty());

    let tools: Vec<Value> = tool_context
        .tools
        .iter()
        .filter(|tool| resolve_tool_function_name(tool) != "subagents")
        .cloned()
        .collect();
    let installed: HashSet<String> = tool_context
        .installed_function_names
        .iter()
        .filter(|name| name.as_str() != "subagents")
        .cloned()
        .collect();
    let mapping: HashMap<String, String> = tool_context
        .function_to_skill_id
        .iter()
        .filter(|(name, _)| name.as_str() != "subagents")
        .map(|(name, skill)| (name.clone(), skill.clone()))
        .collect();

    match allowed {
        None => ResolvedToolContext {
            tools,
            installed_function_names: installed,
            function_to_skill_id: mapping,
        },
        Some(set) => ResolvedToolContext {
            tools: tools
                .into_iter()
                .filter(|tool| set.contains(resolve_tool_function_name(tool)))
                .collect(),
            installed_function_names: installed
                .into_iter()
                .filter(|name| set.contains(name))
                .collect(),
            function_to_skill_id: mapping
                .into_iter()
                .filter(|(name, _)| set.contains(name))
                .collect(),
        },
    }
}

/// `resolveSubagentTarget` (`utils.ts:62-94`). A target is a 1-based index into
/// the active-then-recent list (`#` optional), a run id or a run-id prefix, or an
/// agent id. Matching is case-insensitive.
pub fn resolve_subagent_target(
    registry: &dyn SubagentRegistry,
    conversation_id: &str,
    raw_target: &str,
) -> SubagentTargetResult {
    let target = raw_target.trim();
    if target.is_empty() {
        return missing("Missing subagent target.");
    }

    let runs = registry.list_runs_for_conversation(conversation_id, SUBAGENT_RECENT_MINUTES);
    let ordered: Vec<SubagentRunRecord> = runs.active.into_iter().chain(runs.recent).collect();
    let unknown = || missing(&format!("Unknown target {target}."));

    let digits = target.strip_prefix('#').unwrap_or(target);
    if !digits.is_empty() && digits.bytes().all(|byte| byte.is_ascii_digit()) {
        return match digits
            .parse::<usize>()
            .ok()
            .filter(|index| *index >= 1 && *index <= ordered.len())
        {
            Some(index) => found(ordered[index - 1].clone()),
            None => unknown(),
        };
    }

    let normalized = target.to_lowercase();
    let by_run_id = ordered
        .iter()
        .find(|run| run.run_id.to_lowercase() == normalized)
        .or_else(|| {
            ordered
                .iter()
                .find(|run| run.run_id.to_lowercase().starts_with(&normalized))
        })
        .or_else(|| {
            ordered
                .iter()
                .find(|run| run.agent_id.to_lowercase() == normalized)
        });

    match by_run_id {
        Some(run) => found(run.clone()),
        None => unknown(),
    }
}

fn found(run: SubagentRunRecord) -> SubagentTargetResult {
    SubagentTargetResult {
        run: Some(run),
        error: None,
    }
}

fn missing(message: &str) -> SubagentTargetResult {
    SubagentTargetResult {
        run: None,
        error: Some(message.to_string()),
    }
}

/// `parseSubagentAction` (`utils.ts:96-135`). `/kill` and `/steer` keep every
/// token as an argument. A plain `/subagents` call with no tokens lists the runs.
/// An unknown first token means `info`, and all tokens are kept as arguments.
pub fn parse_subagent_action(payload: &str, command: Option<&str>) -> ParsedSubagentAction {
    let normalized_command = command.unwrap_or("").trim().to_lowercase();
    let tokens: Vec<String> = payload.split_whitespace().map(str::to_string).collect();

    if normalized_command == "/kill" {
        return ParsedSubagentAction {
            action: SubagentAction::Kill,
            args: tokens,
        };
    }
    if normalized_command == "/steer" {
        return ParsedSubagentAction {
            action: SubagentAction::Steer,
            args: tokens,
        };
    }

    let Some(first) = tokens.first() else {
        return ParsedSubagentAction {
            action: SubagentAction::List,
            args: Vec::new(),
        };
    };

    match SubagentAction::parse(&first.to_lowercase()) {
        Some(action) => ParsedSubagentAction {
            action,
            args: tokens[1..].to_vec(),
        },
        None => ParsedSubagentAction {
            action: SubagentAction::Info,
            args: tokens,
        },
    }
}

#[cfg(test)]
mod tests {
    use std::collections::{HashMap, HashSet};

    use serde_json::{json, Value};

    use super::*;
    use crate::channels::messages::service::execution::test_doubles::{run_record, FakeRegistry};
    use crate::channels::messages::service::subagent::registry::SubagentRunStatus;

    #[test]
    fn kill_keeps_every_token_as_argument() {
        let parsed = parse_subagent_action("abc def", Some("/kill"));
        assert_eq!(parsed.action, SubagentAction::Kill);
        assert_eq!(parsed.args, vec!["abc", "def"]);
    }

    #[test]
    fn plain_payload_maps_to_list_spawn_or_info() {
        assert_eq!(
            parse_subagent_action("  ", None).action,
            SubagentAction::List
        );
        let spawn = parse_subagent_action("SPAWN qa run", None);
        assert_eq!(spawn.action, SubagentAction::Spawn);
        assert_eq!(spawn.args, vec!["qa", "run"]);
        let unknown = parse_subagent_action("abc", None);
        assert_eq!(unknown.action, SubagentAction::Info);
        assert_eq!(unknown.args, vec!["abc"]);
    }

    #[test]
    fn filter_drops_subagents_and_applies_allow_list() {
        let context = ResolvedToolContext {
            tools: vec![
                json!({"function": {"name": "subagents"}}),
                json!({"function": {"name": "file_read"}}),
                json!({"name": "web_search"}),
            ],
            installed_function_names: HashSet::from(
                ["subagents", "file_read", "web_search"].map(str::to_string),
            ),
            function_to_skill_id: HashMap::from([
                ("subagents".to_string(), "s".to_string()),
                ("file_read".to_string(), "fs".to_string()),
            ]),
        };

        let open = filter_tool_context_for_subagent(&context, None);
        assert_eq!(open.tools.len(), 2);
        assert!(!open.installed_function_names.contains("subagents"));
        assert!(!open.function_to_skill_id.contains_key("subagents"));

        let blank = vec!["  ".to_string()];
        assert_eq!(
            filter_tool_context_for_subagent(&context, Some(&blank))
                .tools
                .len(),
            2
        );

        let allowed = vec!["web_search".to_string()];
        let narrow = filter_tool_context_for_subagent(&context, Some(&allowed));
        assert_eq!(narrow.tools, vec![json!({"name": "web_search"})]);
        assert_eq!(
            narrow.installed_function_names,
            HashSet::from(["web_search".to_string()])
        );
        assert!(narrow.function_to_skill_id.is_empty());
    }

    #[test]
    fn target_resolves_by_index_prefix_and_agent() {
        let registry = FakeRegistry::default();
        // Newest first: the running run is listed before the completed one.
        registry.seed(run_record(
            "subagent-old1",
            "conv",
            SubagentRunStatus::Completed,
        ));
        registry.seed(run_record(
            "subagent-new2",
            "conv",
            SubagentRunStatus::Running,
        ));

        let by_index = resolve_subagent_target(&registry, "conv", "#1");
        assert_eq!(by_index.run.unwrap().run_id, "subagent-new2");
        let by_prefix = resolve_subagent_target(&registry, "conv", "SUBAGENT-OLD");
        assert_eq!(by_prefix.run.unwrap().run_id, "subagent-old1");
        let by_agent = resolve_subagent_target(&registry, "conv", "worker");
        assert_eq!(by_agent.run.unwrap().run_id, "subagent-new2");
    }

    #[test]
    fn target_reports_missing_and_unknown() {
        let registry = FakeRegistry::default();
        registry.seed(run_record(
            "subagent-only",
            "conv",
            SubagentRunStatus::Running,
        ));
        let blank = resolve_subagent_target(&registry, "conv", "   ");
        assert_eq!(blank.error.as_deref(), Some("Missing subagent target."));
        let out_of_range = resolve_subagent_target(&registry, "conv", "#2");
        assert_eq!(out_of_range.error.as_deref(), Some("Unknown target #2."));
        assert!(out_of_range.run.is_none());
    }

    #[test]
    fn js_helpers_match_javascript_semantics() {
        assert_eq!(truncate_utf16("abc\u{1F600}def", 4), "abc");
        assert_eq!(truncate_utf16("abcdef", 4), "abcd");
        assert_eq!(short_id("subagent-1234"), "subagent");

        let args: Map<String, Value> = serde_json::from_value(json!({
            "zero": 0,
            "flag": false,
            "text": "hi",
            "num": 7,
        }))
        .unwrap();
        assert_eq!(str_arg(&args, "zero"), "");
        assert_eq!(str_arg(&args, "flag"), "");
        assert_eq!(str_arg(&args, "text"), "hi");
        assert_eq!(str_arg(&args, "num"), "7");
        assert_eq!(str_arg(&args, "missing"), "");
    }
}
