//! Port of `src/server/channels/messages/service/recall/search/knowledge.ts`
//! (recall from the Knowledge layer, S7).

use super::super::ports::{KnowledgeRetrieveInput, RecallKnowledge};
use crate::channels::messages::service::types::normalize_memory_context;

/// Options of `recallFromKnowledge`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct KnowledgeRecallOptions {
    /// `skipPreIngest`: an explicit recall command skips the pre-ingest.
    pub skip_pre_ingest: bool,
    /// `includeSemantic`.
    pub include_semantic: bool,
    /// `isKnowledgePreIngestOnRecallEnabled()`.
    pub pre_ingest_on_recall: bool,
}

/// `recallFromKnowledge`. `knowledge` is `None` when the retrieval service is
/// not active (`getKnowledgeRetrievalService()` returned null). Pre-ingest and
/// retrieval errors are logged, and the next user id is tried.
pub async fn recall_from_knowledge<K: RecallKnowledge>(
    knowledge: Option<&K>,
    memory_user_ids: &[String],
    conversation_id: &str,
    persona_id: &str,
    user_input: &str,
    options: KnowledgeRecallOptions,
) -> Option<String> {
    let knowledge = knowledge?;
    for user_id in memory_user_ids {
        if !options.skip_pre_ingest && options.pre_ingest_on_recall {
            if let Err(error) = knowledge
                .ensure_ingested(conversation_id, user_id, persona_id)
                .await
            {
                tracing::error!(
                    error = %crate::safe_error_message(&error),
                    "Knowledge pre-ingest failed"
                );
            }
        }
        let input = KnowledgeRetrieveInput {
            user_id,
            persona_id,
            conversation_id,
            query: user_input,
            include_semantic: options.include_semantic,
        };
        match knowledge.retrieve(&input).await {
            Ok(context) => {
                if let Some(normalized) = normalize_memory_context(&context) {
                    return Some(normalized);
                }
            }
            Err(error) => tracing::error!(
                error = %crate::safe_error_message(&error),
                "Knowledge recall failed"
            ),
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::channels::messages::service::recall::testing::FakeKnowledge;

    const OPTIONS: KnowledgeRecallOptions = KnowledgeRecallOptions {
        skip_pre_ingest: false,
        include_semantic: true,
        pre_ingest_on_recall: true,
    };

    #[tokio::test]
    async fn inactive_service_returns_none_without_calls() {
        let fake = FakeKnowledge::with_context("ctx");
        let result =
            recall_from_knowledge::<FakeKnowledge>(None, &["u1".into()], "c", "p", "q", OPTIONS)
                .await;
        assert_eq!(result, None);
        assert!(fake.ingested_users.lock().unwrap().is_empty());
    }

    #[tokio::test]
    async fn pre_ingest_runs_before_retrieval_and_unless_skipped() {
        let fake = FakeKnowledge::with_context("Meeting am Montag");
        let users = ["u1".to_string()];
        let result = recall_from_knowledge(Some(&fake), &users, "c", "p", "q", OPTIONS).await;
        assert_eq!(result.as_deref(), Some("Meeting am Montag"));
        assert_eq!(fake.ingested_users.lock().unwrap().as_slice(), ["u1"]);

        let skipped = KnowledgeRecallOptions {
            skip_pre_ingest: true,
            ..OPTIONS
        };
        let fake = FakeKnowledge::with_context("Meeting am Montag");
        recall_from_knowledge(Some(&fake), &users, "c", "p", "q", skipped).await;
        assert!(fake.ingested_users.lock().unwrap().is_empty());
    }

    #[tokio::test]
    async fn sentinel_context_is_no_hit() {
        let fake = FakeKnowledge::with_context("No relevant memories found.");
        let users = ["u1".to_string()];
        let result = recall_from_knowledge(Some(&fake), &users, "c", "p", "q", OPTIONS).await;
        assert_eq!(result, None);
    }
}
