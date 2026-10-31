//! Port of `src/server/memory/formatters/contextFormatter.ts`.

use super::subject::detect_memory_subject;
use super::types::{MemoryNode, MemorySubject};

/// `formatRecallContextLine` from `contextFormatter.ts:4-20`.
///
/// The base line is `[Type: <type>] <content>`, and the subject marker is only
/// appended for the three known subjects. A `null` subject appends nothing.
pub fn format_recall_context_line(node: &MemoryNode) -> String {
    let base = format!("[Type: {}] {}", node.node_type.as_str(), node.content);
    match detect_memory_subject(node) {
        Some(MemorySubject::Assistant) => {
            // `isPersonaSelfReference` is checked again here, without the
            // metadata layers, to decide the `Self-Reference` suffix.
            if super::subject::is_persona_self_reference(&node.content) {
                format!("{base} [Subject: assistant, Self-Reference]")
            } else {
                format!("{base} [Subject: assistant]")
            }
        }
        Some(MemorySubject::User) => format!("{base} [Subject: user]"),
        Some(MemorySubject::Conversation) => format!("{base} [Subject: conversation]"),
        None => base,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::memory::types::{MemoryMetadata, MemoryType};
    use serde_json::json;

    fn node(content: &str, node_type: MemoryType) -> MemoryNode {
        MemoryNode {
            id: "n".to_string(),
            node_type,
            content: content.to_string(),
            embedding: Vec::new(),
            importance: 3.0,
            confidence: 0.3,
            timestamp: "t".to_string(),
            metadata: None,
        }
    }

    #[test]
    fn a_node_without_a_subject_keeps_the_base_line() {
        assert_eq!(
            format_recall_context_line(&node("likes coffee", MemoryType::Fact)),
            "[Type: fact] likes coffee"
        );
    }

    /// One fixture per marker branch of `contextFormatter.ts:6-19`.
    ///
    /// The fixtures follow the *TypeScript* classification, which is not always
    /// the intuitive one: `"you asked"` matches no user pattern, because
    /// `detector.ts:32` requires `you` plus a listed verb, so the line keeps no
    /// marker; `"your coffee"` is the user reference (`detector.ts:33`).
    /// `"I answered"` reaches the assistant branch through the legacy leading
    /// pattern `^(ich|i)\b` (`detector.ts:85`) and is *not* a persona
    /// self-reference, so `contextFormatter.ts:15` appends the plain
    /// `[Subject: assistant]`; `"I am ready"` matches `detector.ts:15` and gets
    /// the `Self-Reference` suffix of `contextFormatter.ts:13`.
    #[test]
    fn each_subject_has_its_own_marker() {
        assert_eq!(
            format_recall_context_line(&node("you asked", MemoryType::Fact)),
            "[Type: fact] you asked"
        );
        assert_eq!(
            format_recall_context_line(&node("your coffee", MemoryType::Fact)),
            "[Type: fact] your coffee [Subject: user]"
        );
        assert_eq!(
            format_recall_context_line(&node("I answered", MemoryType::Fact)),
            "[Type: fact] I answered [Subject: assistant]"
        );
        assert_eq!(
            format_recall_context_line(&node("I am ready", MemoryType::Fact)),
            "[Type: fact] I am ready [Subject: assistant, Self-Reference]"
        );
        let mut node = node("it was discussed", MemoryType::Fact);
        node.metadata = Some(MemoryMetadata::from_iter([(
            "subject".to_string(),
            json!("conversation"),
        )]));
        assert_eq!(
            format_recall_context_line(&node),
            "[Type: fact] it was discussed [Subject: conversation]"
        );
    }

    /// The `Self-Reference` suffix only appears when the *content* carries a
    /// self reference, even if the metadata already decided the subject.
    #[test]
    fn the_self_reference_suffix_needs_a_content_match() {
        let mut node = node("answered the question", MemoryType::Fact);
        node.metadata = Some(MemoryMetadata::from_iter([(
            "selfReference".to_string(),
            json!(true),
        )]));
        assert_eq!(
            format_recall_context_line(&node),
            "[Type: fact] answered the question [Subject: assistant]"
        );
    }

    #[test]
    fn the_type_is_rendered_with_the_wire_spelling() {
        assert_eq!(
            format_recall_context_line(&node("x", MemoryType::PersonalityTrait)),
            "[Type: personality_trait] x"
        );
    }
}
