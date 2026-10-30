//! Port of the task types in `src/lib/types.ts` (`TaskStatus`, `TaskPriority`,
//! `Task`, `TaskDeliverable`, `Agent`, `BetaClawSession`) and of the `CHECK`
//! values in `src/lib/db/schema.ts`.
//!
//! The rows keep the stored strings. A legacy database can hold a value that the
//! enum does not know, and the TypeScript backend returns such a value unchanged.

/// `TaskStatus` (`src/lib/types.ts:5-13`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TaskStatus {
    PendingDispatch,
    Planning,
    Inbox,
    Assigned,
    InProgress,
    Testing,
    Review,
    Done,
}

impl TaskStatus {
    pub const ALL: [TaskStatus; 8] = [
        TaskStatus::PendingDispatch,
        TaskStatus::Planning,
        TaskStatus::Inbox,
        TaskStatus::Assigned,
        TaskStatus::InProgress,
        TaskStatus::Testing,
        TaskStatus::Review,
        TaskStatus::Done,
    ];

    pub fn as_str(self) -> &'static str {
        match self {
            TaskStatus::PendingDispatch => "pending_dispatch",
            TaskStatus::Planning => "planning",
            TaskStatus::Inbox => "inbox",
            TaskStatus::Assigned => "assigned",
            TaskStatus::InProgress => "in_progress",
            TaskStatus::Testing => "testing",
            TaskStatus::Review => "review",
            TaskStatus::Done => "done",
        }
    }

    pub fn parse(value: &str) -> Option<Self> {
        Self::ALL
            .into_iter()
            .find(|status| status.as_str() == value)
    }
}

/// `TaskPriority` (`src/lib/types.ts:15`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TaskPriority {
    Low,
    Normal,
    High,
    Urgent,
}

impl TaskPriority {
    pub const ALL: [TaskPriority; 4] = [
        TaskPriority::Low,
        TaskPriority::Normal,
        TaskPriority::High,
        TaskPriority::Urgent,
    ];

    pub fn as_str(self) -> &'static str {
        match self {
            TaskPriority::Low => "low",
            TaskPriority::Normal => "normal",
            TaskPriority::High => "high",
            TaskPriority::Urgent => "urgent",
        }
    }

    pub fn parse(value: &str) -> Option<Self> {
        Self::ALL
            .into_iter()
            .find(|priority| priority.as_str() == value)
    }
}

/// A `tasks` row joined with the names and emojis of its two agents, as
/// `hydrateTaskRelations` returns it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Task {
    pub id: String,
    pub title: String,
    pub description: Option<String>,
    pub status: String,
    pub priority: String,
    pub assigned_agent_id: Option<String>,
    pub created_by_agent_id: Option<String>,
    pub workspace_id: String,
    pub business_id: String,
    pub due_date: Option<String>,
    pub created_at: String,
    pub updated_at: String,
    pub assigned_agent_name: Option<String>,
    pub assigned_agent_emoji: Option<String>,
    pub created_by_agent_name: Option<String>,
    pub created_by_agent_emoji: Option<String>,
}

/// A `task_deliverables` row (`src/lib/types.ts:191-199`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TaskDeliverable {
    pub id: String,
    pub task_id: String,
    pub deliverable_type: String,
    pub title: String,
    pub path: Option<String>,
    pub description: Option<String>,
    pub created_at: String,
}

/// The columns of `agents` that the task code reads.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AgentRow {
    pub id: String,
    pub name: String,
    pub role: String,
    pub is_master: bool,
}

/// The columns of `betaclaw_sessions` that the dispatch reads.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SessionRow {
    pub id: String,
    pub agent_id: Option<String>,
    pub betaclaw_session_id: String,
    pub status: String,
}
