//! Port of `src/server/automation/flowCompiler.ts`.
//!
//! Turns a flow graph into the schedule, timezone, enabled flag and prompt that the rule
//! stores. The topological order is Kahn's algorithm in FIFO order, as in TypeScript.
//!
//! Deviation: `action.skill` embeds the config with `serde_json`. Floats with a zero
//! fraction are printed as integers, as `JSON.stringify` does, but other number spellings
//! may still differ from JavaScript.

use std::collections::{HashMap, VecDeque};

use serde_json::{Map, Value};

use super::flow_types::{FlowEdge, FlowGraph, FlowNode, FlowNodeType};

/// Feb 31: never fires. Used for trigger types without a schedule.
pub const NEVER_CRON: &str = "0 0 31 2 *";

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CompiledFlow {
    pub cron_expression: String,
    pub timezone: String,
    pub prompt: String,
    pub enabled: bool,
}

/// `String(value)` for a JSON value, as the TypeScript templates coerce config values.
pub(crate) fn js_string(value: &Value) -> String {
    match value {
        Value::Null => "null".to_string(),
        Value::Bool(flag) => flag.to_string(),
        Value::Number(number) => match number.as_f64() {
            Some(float) if float.fract() == 0.0 && float.abs() < 1e21 => {
                format!("{}", float as i128)
            }
            Some(float) => float.to_string(),
            None => number.to_string(),
        },
        Value::String(text) => text.clone(),
        Value::Array(items) => items
            .iter()
            .map(|item| {
                if item.is_null() {
                    String::new()
                } else {
                    js_string(item)
                }
            })
            .collect::<Vec<_>>()
            .join(","),
        Value::Object(_) => "[object Object]".to_string(),
    }
}

/// `String(cfg[key])`: a missing key renders as `undefined`.
fn config_text(config: &Map<String, Value>, key: &str) -> String {
    match config.get(key) {
        None => "undefined".to_string(),
        Some(value) => js_string(value),
    }
}

/// `cfg[key] ?? fallback`: null and missing both fall back.
fn config_or(config: &Map<String, Value>, key: &str, fallback: &str) -> String {
    match config.get(key) {
        None | Some(Value::Null) => fallback.to_string(),
        Some(value) => js_string(value),
    }
}

fn topological_sort(graph: &FlowGraph) -> Vec<&FlowNode> {
    let mut adjacency: HashMap<&str, Vec<&str>> = HashMap::new();
    let mut in_degree: HashMap<&str, i64> = HashMap::new();
    let mut node_map: HashMap<&str, &FlowNode> = HashMap::new();

    for node in &graph.nodes {
        adjacency.insert(node.id.as_str(), Vec::new());
        in_degree.insert(node.id.as_str(), 0);
        node_map.insert(node.id.as_str(), node);
    }
    for FlowEdge { source, target, .. } in &graph.edges {
        if let Some(targets) = adjacency.get_mut(source.as_str()) {
            targets.push(target.as_str());
        }
        *in_degree.entry(target.as_str()).or_insert(0) += 1;
    }

    let mut queue: VecDeque<&FlowNode> = graph
        .nodes
        .iter()
        .filter(|node| in_degree.get(node.id.as_str()).copied().unwrap_or(0) == 0)
        .collect();
    let mut sorted = Vec::new();

    while let Some(node) = queue.pop_front() {
        sorted.push(node);
        let neighbors = adjacency.get(node.id.as_str()).cloned().unwrap_or_default();
        for neighbor_id in neighbors {
            // Dangling edges are skipped, as in TypeScript.
            let Some(neighbor) = node_map.get(neighbor_id).copied() else {
                continue;
            };
            let new_degree = in_degree.get(neighbor_id).copied().unwrap_or(1) - 1;
            in_degree.insert(neighbor_id, new_degree);
            if new_degree == 0 {
                queue.push_back(neighbor);
            }
        }
    }

    sorted
}

fn node_to_prompt_step(node: &FlowNode, index: usize) -> String {
    let config = &node.data.config;
    match node.node_type {
        FlowNodeType::TriggerCron | FlowNodeType::TriggerWebhook | FlowNodeType::TriggerManual => {
            String::new()
        }
        FlowNodeType::ConditionFilter => format!(
            "Step {index}: Filter: if {} {} \"{}\", continue; otherwise stop.",
            config_text(config, "field"),
            config_text(config, "operator"),
            config_text(config, "value"),
        ),
        FlowNodeType::ConditionAiClassifier => format!(
            "Step {index}: Classify the input using: \"{}\". Continue only if category matches.",
            config_text(config, "prompt"),
        ),
        FlowNodeType::ConditionRegex => format!(
            "Step {index}: Check if input matches regex /{}/{}. Continue if matches.",
            config_text(config, "pattern"),
            config_or(config, "flags", ""),
        ),
        FlowNodeType::ActionRunPrompt => {
            format!("Step {index}: {}", config_text(config, "prompt"))
        }
        FlowNodeType::ActionSkill => format!(
            "Step {index}: Use skill \"{}\" with parameters: {}.",
            config_text(config, "skillId"),
            serde_json::to_string(&Value::Object(config.clone())).unwrap_or_default(),
        ),
        FlowNodeType::ActionSendMessage => format!(
            "Step {index}: Send message to channel \"{}\": \"{}\".",
            config_text(config, "channelId"),
            config_text(config, "template"),
        ),
        FlowNodeType::ActionNotify => format!(
            "Step {index}: Send notification — Title: \"{}\", Body: \"{}\".",
            config_text(config, "title"),
            config_text(config, "body"),
        ),
    }
}

pub fn compile_flow(graph: &FlowGraph) -> CompiledFlow {
    let sorted = topological_sort(graph);
    let trigger = sorted
        .iter()
        .copied()
        .find(|node| node.node_type.is_trigger());

    let mut cron_expression = NEVER_CRON.to_string();
    let mut timezone = "UTC".to_string();
    let mut enabled = true;

    if let Some(node) = trigger {
        match node.node_type {
            FlowNodeType::TriggerCron => {
                cron_expression = config_or(&node.data.config, "cronExpression", NEVER_CRON);
                timezone = config_or(&node.data.config, "timezone", "UTC");
                enabled = true;
            }
            FlowNodeType::TriggerManual => {
                enabled = false;
            }
            _ => {}
        }
    }

    let steps: Vec<String> = sorted
        .iter()
        .copied()
        .filter(|node| !node.node_type.is_trigger())
        .enumerate()
        .map(|(position, node)| node_to_prompt_step(node, position + 1))
        .filter(|step| !step.is_empty())
        .collect();

    let prompt = if steps.is_empty() {
        "Automated flow with no action steps.".to_string()
    } else {
        format!(
            "Execute the following automated workflow:\n\n{}",
            steps.join("\n\n")
        )
    };

    CompiledFlow {
        cron_expression,
        timezone,
        prompt,
        enabled,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::automation::flow_types::{test_edge, test_node};
    use serde_json::json;

    fn flow(nodes: Vec<FlowNode>, edges: Vec<FlowEdge>) -> FlowGraph {
        FlowGraph {
            version: 1,
            nodes,
            edges,
        }
    }

    #[test]
    fn a_cron_flow_compiles_to_its_schedule_and_numbered_steps() {
        let graph = flow(
            vec![
                test_node(
                    "t",
                    FlowNodeType::TriggerCron,
                    json!({"cronExpression": "0 9 * * *", "timezone": "Europe/Berlin"}),
                ),
                test_node(
                    "a",
                    FlowNodeType::ActionRunPrompt,
                    json!({"prompt": "Summarize"}),
                ),
            ],
            vec![test_edge("e1", "t", "a")],
        );
        let compiled = compile_flow(&graph);
        assert_eq!(compiled.cron_expression, "0 9 * * *");
        assert_eq!(compiled.timezone, "Europe/Berlin");
        assert!(compiled.enabled);
        assert_eq!(
            compiled.prompt,
            "Execute the following automated workflow:\n\nStep 1: Summarize"
        );
    }

    #[test]
    fn a_manual_trigger_disables_the_rule_and_uses_the_never_schedule() {
        let graph = flow(
            vec![test_node("t", FlowNodeType::TriggerManual, json!({}))],
            vec![],
        );
        let compiled = compile_flow(&graph);
        assert!(!compiled.enabled);
        assert_eq!(compiled.cron_expression, NEVER_CRON);
        assert_eq!(compiled.prompt, "Automated flow with no action steps.");
    }

    #[test]
    fn missing_config_values_render_like_javascript_string_coercion() {
        let graph = flow(
            vec![
                test_node("t", FlowNodeType::TriggerManual, json!({})),
                test_node("f", FlowNodeType::ConditionFilter, json!({})),
            ],
            vec![test_edge("e1", "t", "f")],
        );
        assert_eq!(
            compile_flow(&graph).prompt,
            "Execute the following automated workflow:\n\nStep 1: Filter: if undefined undefined \"undefined\", continue; otherwise stop."
        );
    }
}
