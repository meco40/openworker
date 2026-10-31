//! Port of `src/server/automation/flowValidator.ts`.
//!
//! Checks the rules the flow builder enforces: exactly one trigger, no cycles, and a valid
//! cron expression on every `trigger.cron` node. The two codes `DISCONNECTED_NODE` and
//! `INVALID_NODE_CONFIG` exist in the TypeScript type but are never produced; they are kept
//! so the serialised contract stays the same.

use std::collections::{HashMap, HashSet};

use serde::Serialize;
use serde_json::Value;

use super::cron_engine::validate_cron_expression;
use super::flow_types::{FlowGraph, FlowNodeType};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum FlowValidationCode {
    NoTrigger,
    MultipleTriggers,
    CycleDetected,
    InvalidCronExpression,
    DisconnectedNode,
    InvalidNodeConfig,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FlowValidationError {
    pub code: FlowValidationCode,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub node_id: Option<String>,
    pub message: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct FlowValidationResult {
    pub valid: bool,
    pub errors: Vec<FlowValidationError>,
}

fn detect_cycle(graph: &FlowGraph) -> bool {
    let mut adjacency: HashMap<&str, Vec<&str>> = graph
        .nodes
        .iter()
        .map(|node| (node.id.as_str(), Vec::new()))
        .collect();
    for edge in &graph.edges {
        if let Some(targets) = adjacency.get_mut(edge.source.as_str()) {
            targets.push(edge.target.as_str());
        }
    }

    fn visit<'a>(
        node: &'a str,
        adjacency: &HashMap<&'a str, Vec<&'a str>>,
        visited: &mut HashSet<&'a str>,
        in_stack: &mut HashSet<&'a str>,
    ) -> bool {
        visited.insert(node);
        in_stack.insert(node);
        let neighbors: &[&str] = adjacency.get(node).map(Vec::as_slice).unwrap_or(&[]);
        for &neighbor in neighbors {
            // A neighbour still on the stack is a back edge, which means a cycle.
            if in_stack.contains(neighbor) {
                return true;
            }
            if !visited.contains(neighbor) && visit(neighbor, adjacency, visited, in_stack) {
                return true;
            }
        }
        in_stack.remove(node);
        false
    }

    let mut visited = HashSet::new();
    let mut in_stack = HashSet::new();
    graph.nodes.iter().any(|node| {
        !visited.contains(node.id.as_str())
            && visit(node.id.as_str(), &adjacency, &mut visited, &mut in_stack)
    })
}

pub fn validate_flow_graph(graph: &FlowGraph) -> FlowValidationResult {
    let mut errors = Vec::new();

    let triggers = graph
        .nodes
        .iter()
        .filter(|node| node.node_type.is_trigger())
        .count();
    if triggers == 0 {
        errors.push(FlowValidationError {
            code: FlowValidationCode::NoTrigger,
            node_id: None,
            message: "Flow must have exactly one trigger node.".to_string(),
        });
    } else if triggers > 1 {
        errors.push(FlowValidationError {
            code: FlowValidationCode::MultipleTriggers,
            node_id: None,
            message: "Flow must have exactly one trigger node.".to_string(),
        });
    }

    if detect_cycle(graph) {
        errors.push(FlowValidationError {
            code: FlowValidationCode::CycleDetected,
            node_id: None,
            message: "Flow graph contains a cycle.".to_string(),
        });
    }

    for node in &graph.nodes {
        if node.node_type != FlowNodeType::TriggerCron {
            continue;
        }
        let config = &node.data.config;
        // `timezone ?? 'UTC'`: a non-string value fails the timezone check, as in TypeScript.
        let timezone = match config.get("timezone") {
            None | Some(Value::Null) => "UTC".to_string(),
            Some(Value::String(text)) => text.clone(),
            Some(other) => other.to_string(),
        };
        let valid = match config.get("cronExpression") {
            Some(Value::String(expression)) if !expression.is_empty() => {
                validate_cron_expression(expression, &timezone)
            }
            _ => false,
        };
        if !valid {
            errors.push(FlowValidationError {
                code: FlowValidationCode::InvalidCronExpression,
                node_id: Some(node.id.clone()),
                message: format!(
                    "Node \"{}\" has an invalid cron expression.",
                    node.data.label
                ),
            });
        }
    }

    FlowValidationResult {
        valid: errors.is_empty(),
        errors,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::automation::flow_types::{test_edge, test_node, FlowNodeType};
    use serde_json::json;

    fn graph(
        nodes: Vec<crate::automation::flow_types::FlowNode>,
        edges: Vec<crate::automation::flow_types::FlowEdge>,
    ) -> FlowGraph {
        FlowGraph {
            version: 1,
            nodes,
            edges,
        }
    }

    #[test]
    fn a_trigger_with_a_valid_schedule_passes() {
        let flow = graph(
            vec![
                test_node(
                    "t",
                    FlowNodeType::TriggerCron,
                    json!({"cronExpression": "0 9 * * *", "timezone": "UTC"}),
                ),
                test_node("a", FlowNodeType::ActionRunPrompt, json!({"prompt": "Go"})),
            ],
            vec![test_edge("e1", "t", "a")],
        );
        assert!(validate_flow_graph(&flow).valid);
    }

    #[test]
    fn a_missing_trigger_and_a_cycle_are_both_reported() {
        let flow = graph(
            vec![
                test_node("a", FlowNodeType::ActionRunPrompt, json!({})),
                test_node("b", FlowNodeType::ActionRunPrompt, json!({})),
            ],
            vec![test_edge("e1", "a", "b"), test_edge("e2", "b", "a")],
        );
        let result = validate_flow_graph(&flow);
        assert!(!result.valid);
        let codes: Vec<FlowValidationCode> = result.errors.iter().map(|error| error.code).collect();
        assert!(codes.contains(&FlowValidationCode::NoTrigger));
        assert!(codes.contains(&FlowValidationCode::CycleDetected));
    }

    #[test]
    fn an_invalid_schedule_names_its_node() {
        let flow = graph(
            vec![test_node(
                "t",
                FlowNodeType::TriggerCron,
                json!({"cronExpression": "99 * * * *"}),
            )],
            vec![],
        );
        let result = validate_flow_graph(&flow);
        assert_eq!(result.errors.len(), 1);
        assert_eq!(
            result.errors[0].code,
            FlowValidationCode::InvalidCronExpression
        );
        assert_eq!(result.errors[0].node_id.as_deref(), Some("t"));
        assert_eq!(
            result.errors[0].message,
            "Node \"t\" has an invalid cron expression."
        );
    }
}
