//! Port of `src/server/channels/messages/service/recall/learning/feedback.ts`.

use crate::memory::service::MemoryStoreInput;
use crate::memory::types::{MemoryFeedbackSignal, MemoryType};
use crate::messages_store::Conversation;

use super::super::ports::RecallMemory;
use super::super::utils::now_ms;
use crate::channels::messages::service::types::{
    detect_memory_feedback_signal, extract_correction_content, LastRecallState,
    MEMORY_FEEDBACK_WINDOW_MS,
};

/// `learnFromFeedback`. A negative signal also stores the correction as a fact,
/// unless factual writes are blocked. Failures are logged and swallowed.
///
/// `factual_write_blocked` is `isMem0FactualWriteBlocked()`.
pub async fn learn_from_feedback<M: RecallMemory>(
    memory: &M,
    conversation: &Conversation,
    user_input: &str,
    last_recall: Option<&LastRecallState>,
    factual_write_blocked: bool,
) {
    let Some(persona_id) = conversation.persona_id.as_deref() else {
        return;
    };
    let Some(feedback) = detect_memory_feedback_signal(user_input) else {
        return;
    };
    let Some(last) = last_recall else {
        return;
    };
    if last.persona_id != persona_id {
        return;
    }
    if now_ms() - last.queried_at > MEMORY_FEEDBACK_WINDOW_MS {
        return;
    }

    if let Err(error) = memory
        .register_feedback(persona_id, &last.node_ids, feedback, &last.user_id)
        .await
    {
        tracing::error!(
            error = %crate::safe_error_message(&error),
            "Memory feedback learning failed"
        );
        return;
    }

    if feedback != MemoryFeedbackSignal::Negative || factual_write_blocked {
        return;
    }
    let Some(correction) = extract_correction_content(user_input) else {
        return;
    };
    let mut metadata = serde_json::Map::new();
    metadata.insert("subject".to_string(), "user".into());
    metadata.insert("sourceRole".to_string(), "user".into());
    metadata.insert("sourceType".to_string(), "feedback_correction".into());
    let input = MemoryStoreInput {
        persona_id: persona_id.to_string(),
        workspace_id: None,
        node_type: MemoryType::Fact,
        content: correction,
        importance: 5.0,
        user_id: Some(last.user_id.clone()),
        metadata,
    };
    if let Err(error) = memory.store_memory(&input).await {
        tracing::error!(
            error = %crate::safe_error_message(&error),
            "Memory feedback learning failed"
        );
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::channels::messages::service::recall::testing::{
        conversation, no_memory, FakeMemory,
    };

    fn last(persona: &str, queried_at: i64) -> LastRecallState {
        LastRecallState {
            persona_id: persona.to_string(),
            user_id: "user-1".to_string(),
            node_ids: vec!["n1".to_string(), "n2".to_string()],
            queried_at,
        }
    }

    #[tokio::test]
    async fn negative_feedback_registers_and_stores_the_correction() {
        let memory = FakeMemory::answering(Ok(no_memory()));
        let conv = conversation("WebChat", Some("p1"));
        let state = last("p1", now_ms());
        learn_from_feedback(
            &memory,
            &conv,
            "Das ist falsch, der Termin ist morgen",
            Some(&state),
            false,
        )
        .await;

        let feedback = memory.feedback.lock().unwrap().clone();
        assert_eq!(feedback.len(), 1);
        assert_eq!(feedback[0].1, state.node_ids);
        assert_eq!(feedback[0].2, MemoryFeedbackSignal::Negative);

        let stored = memory.stored.lock().unwrap().clone();
        assert_eq!(stored.len(), 1);
        assert_eq!(stored[0].content, "der Termin ist morgen");
        assert_eq!(stored[0].importance, 5.0);
        assert_eq!(stored[0].node_type, MemoryType::Fact);
        assert_eq!(stored[0].metadata["sourceType"], "feedback_correction");
    }

    #[tokio::test]
    async fn blocked_factual_writes_skip_the_store() {
        let memory = FakeMemory::answering(Ok(no_memory()));
        let conv = conversation("WebChat", Some("p1"));
        let state = last("p1", now_ms());
        learn_from_feedback(
            &memory,
            &conv,
            "Das ist falsch, der Termin ist morgen",
            Some(&state),
            true,
        )
        .await;
        assert_eq!(memory.feedback.lock().unwrap().len(), 1);
        assert!(memory.stored.lock().unwrap().is_empty());
    }

    #[tokio::test]
    async fn stale_or_foreign_state_is_ignored() {
        let memory = FakeMemory::answering(Ok(no_memory()));
        let conv = conversation("WebChat", Some("p1"));
        let stale = last("p1", now_ms() - MEMORY_FEEDBACK_WINDOW_MS - 1_000);
        learn_from_feedback(&memory, &conv, "falsch", Some(&stale), false).await;
        let foreign = last("other", now_ms());
        learn_from_feedback(&memory, &conv, "falsch", Some(&foreign), false).await;
        assert!(memory.feedback.lock().unwrap().is_empty());
    }
}
