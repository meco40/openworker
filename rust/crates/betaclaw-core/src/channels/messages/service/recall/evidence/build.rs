//! Port of `src/server/channels/messages/service/recall/evidence/build.ts`.

use serde_json::{json, Value};

use crate::messages_store::{Conversation, StoredMessage};

use super::super::ports::RecallMemory;
use super::super::search::perform_strict_search;
use super::format::{build_high_confidence_response, build_low_confidence_response};

/// `EvidenceReplyResult`: the reply text and its metadata. The metadata is
/// stored with the message, so its keys keep the TypeScript names.
#[derive(Debug, Clone, PartialEq)]
pub struct EvidenceReply {
    pub content: String,
    pub metadata: Value,
}

/// `buildStrictEvidenceReply`. Returns `None` unless memory is enabled, the
/// conversation has a persona, and strict evidence recall is on
/// (`strict_enabled`).
pub async fn build_strict_evidence_reply<M: RecallMemory>(
    memory: &M,
    conversation: &Conversation,
    user_input: &str,
    is_memory_enabled: bool,
    chat_hits: &[StoredMessage],
    strict_enabled: bool,
) -> Option<EvidenceReply> {
    if !is_memory_enabled {
        return None;
    }
    let persona_id = conversation.persona_id.as_deref()?;
    if !strict_enabled {
        return None;
    }

    let result =
        perform_strict_search(memory, conversation, user_input, chat_hits, persona_id).await;
    let topic_tokens = result.topic_tokens.clone();
    let deduped_count = result.deduped.len();

    match result.winner.as_ref() {
        None => {
            let (content, confidence) = build_low_confidence_response(&result.sorted_context);
            Some(EvidenceReply {
                content,
                metadata: json!({
                    "ok": true,
                    "runtime": "strict-recall",
                    "strictRecall": true,
                    "confidence": confidence.as_str(),
                    "candidateCount": deduped_count,
                    "relevantCount": 0,
                    "topicTokens": topic_tokens,
                }),
            })
        }
        Some(winner) => {
            let (content, confidence) = build_high_confidence_response(
                winner,
                &result.sorted_relevant,
                result.has_conflict,
            );
            Some(EvidenceReply {
                content,
                metadata: json!({
                    "ok": true,
                    "runtime": "strict-recall",
                    "strictRecall": true,
                    "confidence": confidence.as_str(),
                    "conflict": result.has_conflict,
                    "candidateCount": deduped_count,
                    "relevantCount": result.sorted_relevant.len(),
                    "topicTokens": topic_tokens,
                }),
            })
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::channels::messages::service::recall::testing::{
        conversation, memory_match, memory_result, no_memory, stored, FakeMemory,
    };

    #[tokio::test]
    async fn disabled_or_personaless_paths_return_none() {
        let memory = FakeMemory::answering(Ok(no_memory()));
        let with_persona = conversation("WebChat", Some("p1"));
        assert!(
            build_strict_evidence_reply(&memory, &with_persona, "x", false, &[], true)
                .await
                .is_none()
        );
        assert!(
            build_strict_evidence_reply(&memory, &with_persona, "x", true, &[], false)
                .await
                .is_none()
        );
        let personaless = conversation("WebChat", None);
        assert!(
            build_strict_evidence_reply(&memory, &personaless, "x", true, &[], true)
                .await
                .is_none()
        );
    }

    #[tokio::test]
    async fn winner_yields_high_confidence_with_metadata() {
        let memory = FakeMemory::answering(Ok(memory_result(
            "ctx",
            vec![memory_match(
                "n1",
                "Yoga am Dienstag",
                "2026-10-05T10:00:00.000Z",
            )],
        )));
        let conv = conversation("WebChat", Some("p1"));
        let hits = [stored(
            "1",
            "user",
            "Ich wollte Yoga",
            "2026-10-05T09:00:00.000Z",
        )];
        let reply = build_strict_evidence_reply(
            &memory,
            &conv,
            "Welche Übung wollte ich?",
            true,
            &hits,
            true,
        )
        .await
        .expect("reply");
        assert!(reply
            .content
            .starts_with("Nach den belegbaren Erinnerungen"));
        assert_eq!(reply.metadata["runtime"], "strict-recall");
        assert_eq!(reply.metadata["strictRecall"], true);
        assert_eq!(reply.metadata["conflict"], false);
    }

    #[tokio::test]
    async fn no_hits_yield_low_confidence_without_conflict_key() {
        let memory = FakeMemory::answering(Ok(no_memory()));
        let conv = conversation("WebChat", Some("p1"));
        let reply = build_strict_evidence_reply(&memory, &conv, "Pizza", true, &[], true)
            .await
            .expect("reply");
        assert_eq!(reply.metadata["confidence"], "low");
        assert_eq!(reply.metadata["relevantCount"], 0);
        assert!(reply.metadata.get("conflict").is_none());
    }
}
