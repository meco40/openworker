//! Port of `src/server/knowledge/ingestion/taskCompletion.ts` (1-105).
//!
//! | TypeScript | Rust |
//! | --- | --- |
//! | `TaskCompletionResult` (`:7-11`) | [`TaskCompletionResult`] |
//! | `TaskCompletionContext` (`:13-18`) | [`TaskCompletionContext`] |
//! | `storeTaskCompletions` (`:24-105`) | [`store_task_completions`] |
//! | `export type { TrackedTask }` (`:104`) | re-exported from [`crate::knowledge::task_tracker`] |
//!
//! # Deviations
//!
//! * `new Date().toISOString()` is read once per call, not once per action item.
//!   The value only fills `createdAt` of a tracked task that is matched in memory.
//! * `setTimeout(MEM0_RATE_LIMIT_DELAY_MS)` becomes [`tokio::time::sleep`].

use std::time::Duration;

use serde_json::{json, Map};
use tracing::debug;

use crate::knowledge::ingestion::constants::{DEFAULT_TOPIC_KEY, MEM0_RATE_LIMIT_DELAY_MS};
use crate::knowledge::ingestion::types::{FactStoreInput, MemoryFactService};
use crate::knowledge::ingestion::world_model_port::WorldModelPort;
use crate::knowledge::ingestion_cursor::IngestionWindow;
use crate::knowledge::repositories::now_iso;
use crate::memory::utils::create_memory_idempotency_key;

// `export type { TrackedTask }` (`taskCompletion.ts:104`) and the names the body uses.
pub use crate::knowledge::task_tracker::{
    detect_task_completion, TaskStatus, TaskType, TrackedTask,
};

/// `TaskCompletionResult` (`taskCompletion.ts:7-11`).
#[derive(Debug, Clone, PartialEq)]
pub struct TaskCompletionResult {
    pub task: TrackedTask,
    pub match_confidence: f64,
    pub stored: bool,
}

/// `TaskCompletionContext` (`taskCompletion.ts:13-18`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TaskCompletionContext {
    pub user_id: String,
    pub persona_id: String,
    pub conversation_id: String,
    pub topic_key: Option<String>,
}

/// `storeTaskCompletions(memoryService, window, actionItems, context)`
/// (`taskCompletion.ts:24-105`). Finds completed action items in the user
/// messages and stores each completion as a fact. A failed store is not an
/// error: the result is still returned, with `stored = false`.
pub async fn store_task_completions<M, W>(
    memory: Option<&M>,
    window: &IngestionWindow,
    action_items: &[String],
    context: &TaskCompletionContext,
    world_model: &W,
) -> Vec<TaskCompletionResult>
where
    M: MemoryFactService + Sync + ?Sized,
    W: WorldModelPort + Sync + ?Sized,
{
    let Some(memory) = memory else {
        return Vec::new();
    };
    if action_items.is_empty() {
        return Vec::new();
    }
    // In canonical mode a task completion is a canonical task transition, not a
    // factual Mem0 entry.
    if world_model.is_mem0_factual_write_blocked() {
        return Vec::new();
    }

    let topic_key = match context.topic_key.as_deref().unwrap_or("").trim() {
        "" => DEFAULT_TOPIC_KEY.to_string(),
        trimmed => trimmed.to_string(),
    };
    let created_at = now_iso();

    let open_tasks: Vec<TrackedTask> = action_items
        .iter()
        .enumerate()
        .map(|(index, item)| TrackedTask {
            id: format!("action-{index}"),
            user_id: context.user_id.clone(),
            persona_id: context.persona_id.clone(),
            title: item.clone(),
            description: None,
            task_type: TaskType::OneTime,
            status: TaskStatus::Open,
            deadline: None,
            recurrence: None,
            location: None,
            related_entity_id: None,
            created_at: created_at.clone(),
            completed_at: None,
            source_conversation_id: context.conversation_id.clone(),
        })
        .collect();

    let mut results = Vec::new();
    for message in window
        .messages
        .iter()
        .filter(|message| message.role == "user")
    {
        let Some(completion) = detect_task_completion(&message.content, &open_tasks) else {
            continue;
        };
        let mut result = TaskCompletionResult {
            task: completion.task.clone(),
            match_confidence: completion.match_confidence,
            stored: false,
        };

        // Rate limit between Mem0 store calls.
        tokio::time::sleep(Duration::from_millis(MEM0_RATE_LIMIT_DELAY_MS)).await;
        let content = format!("Aufgabe erledigt: {}", completion.task.title);
        let mut metadata = Map::new();
        metadata.insert("topicKey".into(), json!(topic_key));
        metadata.insert("conversationId".into(), json!(context.conversation_id));
        metadata.insert("sourceType".into(), json!("task_completion"));
        metadata.insert("artifactType".into(), json!("task_status"));
        metadata.insert("taskTitle".into(), json!(completion.task.title));
        metadata.insert(
            "completionConfidence".into(),
            json!(completion.match_confidence),
        );
        metadata.insert("lifecycleStatus".into(), json!("confirmed"));
        metadata.insert(
            "idempotencyKey".into(),
            json!(create_memory_idempotency_key(&[
                Some("task-completion".to_string()),
                Some(context.user_id.clone()),
                Some(context.persona_id.clone()),
                Some(context.conversation_id.clone()),
                Some(completion.task.title.clone()),
            ])),
        );

        let input = FactStoreInput {
            persona_id: context.persona_id.clone(),
            content,
            importance: 4,
            user_id: context.user_id.clone(),
            metadata,
        };
        match memory.store_fact(input).await {
            Ok(_) => result.stored = true,
            // Task-completion Mem0 failures are non-critical.
            Err(error) => debug!(error = %error, "task completion was not stored"),
        }
        results.push(result);
    }

    results
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::knowledge::ingestion::test_support::{FakeMemory, FakeWorldModel};

    fn window() -> IngestionWindow {
        IngestionWindow {
            conversation_id: "c-1".into(),
            user_id: "u-1".into(),
            persona_id: "p-1".into(),
            workspace_id: None,
            from_seq_exclusive: 0,
            to_seq_inclusive: 1,
            messages: vec![],
        }
    }

    fn context() -> TaskCompletionContext {
        TaskCompletionContext {
            user_id: "u-1".into(),
            persona_id: "p-1".into(),
            conversation_id: "c-1".into(),
            topic_key: None,
        }
    }

    #[tokio::test]
    async fn no_memory_service_or_no_action_items_means_no_completions() {
        let items = vec!["Müll rausbringen".to_string()];
        let none: Option<&FakeMemory> = None;
        assert!(store_task_completions(
            none,
            &window(),
            &items,
            &context(),
            &FakeWorldModel::default()
        )
        .await
        .is_empty());
        assert!(store_task_completions(
            Some(&FakeMemory),
            &window(),
            &[],
            &context(),
            &FakeWorldModel::default()
        )
        .await
        .is_empty());
    }

    #[tokio::test]
    async fn canonical_mode_stores_no_task_completion_as_a_fact() {
        let items = vec!["Müll rausbringen".to_string()];
        let blocked = FakeWorldModel {
            blocked: true,
            ..Default::default()
        };
        assert!(
            store_task_completions(Some(&FakeMemory), &window(), &items, &context(), &blocked)
                .await
                .is_empty()
        );
    }
}
