//! Port of the subagent run registry as seen by the chat dispatch. The TypeScript
//! source is `src/server/agents/subagentRegistry.ts`, which S12 (Agent-v2 runtime)
//! owns. S8 only needs the record shape and the operations below, so they are a
//! trait here. The real store (JSON file, runtime attach/detach) comes with S12.
//!
//! Field names, the status vocabulary and the optional-field serialisation follow
//! `SubagentRunRecord` in that file so the records can be shared with S12.

use serde::{Deserialize, Serialize};

use crate::channels::messages::service::execution::ports::AbortController;

/// `SubagentRunStatus` from `subagentRegistry.ts:5`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum SubagentRunStatus {
    Running,
    Completed,
    Error,
    Killed,
}

impl SubagentRunStatus {
    pub fn as_str(self) -> &'static str {
        match self {
            SubagentRunStatus::Running => "running",
            SubagentRunStatus::Completed => "completed",
            SubagentRunStatus::Error => "error",
            SubagentRunStatus::Killed => "killed",
        }
    }
}

/// `SubagentRunRecord` from `subagentRegistry.ts:7-29`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SubagentRunRecord {
    pub run_id: String,
    pub requester_conversation_id: String,
    pub requester_user_id: String,
    pub agent_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub profile_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub profile_name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub skill_ids: Option<Vec<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tool_function_names: Option<Vec<String>>,
    pub task: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub guidance: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model_override: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub project_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub workspace_path: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub workspace_relative_path: Option<String>,
    pub status: SubagentRunStatus,
    pub created_at: String,
    pub started_at: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ended_at: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub result_preview: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub replaced_by_run_id: Option<String>,
}

/// `CreateSubagentRunInput` from `subagentRegistry.ts:40-54`.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct CreateSubagentRunInput {
    pub requester_conversation_id: String,
    pub requester_user_id: String,
    pub agent_id: String,
    pub profile_id: Option<String>,
    pub profile_name: Option<String>,
    pub skill_ids: Option<Vec<String>>,
    pub tool_function_names: Option<Vec<String>>,
    pub task: String,
    pub guidance: Option<String>,
    pub model_override: Option<String>,
    pub project_id: Option<String>,
    pub workspace_path: Option<String>,
    pub workspace_relative_path: Option<String>,
}

/// Return value of `listSubagentRunsForConversation`: active runs first, then the
/// runs that ended inside the recent window.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct SubagentRunsView {
    pub active: Vec<SubagentRunRecord>,
    pub recent: Vec<SubagentRunRecord>,
}

/// The operations of `subagentRegistry.ts` that the S8 modules call. The store is
/// infallible here: persistence errors are handled inside the S12 implementation,
/// as in the TypeScript version.
pub trait SubagentRegistry: Send + Sync {
    fn create_run(&self, input: CreateSubagentRunInput) -> SubagentRunRecord;
    fn count_active_runs(&self, requester_conversation_id: &str) -> usize;
    fn list_runs_for_conversation(
        &self,
        requester_conversation_id: &str,
        recent_minutes: u64,
    ) -> SubagentRunsView;
    fn list_active_runs(&self, requester_conversation_id: &str) -> Vec<SubagentRunRecord>;
    /// Aborts the attached runtime if there is one and marks the run killed.
    /// Returns `true` only when a runtime was attached.
    fn abort_run(&self, run_id: &str, reason: &str) -> bool;
    fn mark_run_killed(&self, run_id: &str, reason: &str);
    fn replace_run(&self, previous_run_id: &str, next_run_id: &str);
    fn attach_runtime(&self, run_id: &str, controller: AbortController);
    fn detach_runtime(&self, run_id: &str);
    fn complete_run(&self, run_id: &str, result_preview: Option<&str>);
    fn fail_run(&self, run_id: &str, error: &str);
}
