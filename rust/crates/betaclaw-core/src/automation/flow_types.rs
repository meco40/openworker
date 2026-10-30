//! Port of `src/server/automation/flowTypes.ts`. That file re-exports the canonical
//! `src/shared/flowTypes.ts`, which the UI shares.
//!
//! The graph is stored as JSON in `automation_rules.flow_graph`, so the serde names
//! match the TypeScript keys exactly.

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

/// `FlowNodeType` in `src/shared/flowTypes.ts`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum FlowNodeType {
    #[serde(rename = "trigger.cron")]
    TriggerCron,
    #[serde(rename = "trigger.webhook")]
    TriggerWebhook,
    #[serde(rename = "trigger.manual")]
    TriggerManual,
    #[serde(rename = "condition.filter")]
    ConditionFilter,
    #[serde(rename = "condition.ai_classifier")]
    ConditionAiClassifier,
    #[serde(rename = "condition.regex")]
    ConditionRegex,
    #[serde(rename = "action.run_prompt")]
    ActionRunPrompt,
    #[serde(rename = "action.skill")]
    ActionSkill,
    #[serde(rename = "action.send_message")]
    ActionSendMessage,
    #[serde(rename = "action.notify")]
    ActionNotify,
}

impl FlowNodeType {
    /// `node.type.startsWith('trigger.')`.
    pub fn is_trigger(self) -> bool {
        matches!(
            self,
            Self::TriggerCron | Self::TriggerWebhook | Self::TriggerManual
        )
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct FlowNodeData {
    pub label: String,
    pub config: Map<String, Value>,
    /// The TypeScript type allows extra keys (`[key: string]: unknown`); they are kept.
    #[serde(flatten)]
    pub extra: Map<String, Value>,
}

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct FlowPosition {
    pub x: f64,
    pub y: f64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FlowNode {
    pub id: String,
    #[serde(rename = "type")]
    pub node_type: FlowNodeType,
    pub position: FlowPosition,
    pub data: FlowNodeData,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FlowEdge {
    pub id: String,
    pub source: String,
    pub target: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source_handle: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub label: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FlowGraph {
    pub version: u32,
    pub nodes: Vec<FlowNode>,
    pub edges: Vec<FlowEdge>,
}

#[cfg(test)]
pub(crate) fn test_node(id: &str, node_type: FlowNodeType, config: Value) -> FlowNode {
    FlowNode {
        id: id.to_string(),
        node_type,
        position: FlowPosition { x: 0.0, y: 0.0 },
        data: FlowNodeData {
            label: id.to_string(),
            config: config.as_object().cloned().unwrap_or_default(),
            extra: Map::new(),
        },
    }
}

#[cfg(test)]
pub(crate) fn test_edge(id: &str, source: &str, target: &str) -> FlowEdge {
    FlowEdge {
        id: id.to_string(),
        source: source.to_string(),
        target: target.to_string(),
        source_handle: None,
        label: None,
    }
}
