//! Port of `src/server/knowledge/retrieval/service/query/intent.ts` (1-81).
//!
//! | TypeScript                                                    | Rust |
//! | ------------------------------------------------------------- | ---- |
//! | `service/query/intent.ts:12-16` (`isBinaryRecallQuery`)        | [`is_binary_recall_query`] |
//! | `service/query/intent.ts:18-27` (`extractQueryEvidenceTokens`) | [`extract_query_evidence_tokens`] |
//! | `service/query/intent.ts:29-33` (`hasEvidenceTokenOverlap`)    | [`has_evidence_token_overlap`] |
//! | `service/query/intent.ts:35-78` (`detectBinaryRecallConflict`)| [`detect_binary_recall_conflict`] |
//!
//! # Deviations
//!
//! 1. **The two re-exports at `:81` are not repeated here.** `normalizeLookupText`
//!    and `detectMentionedCounterpart` already live in
//!    [`crate::knowledge::retrieval::query::intent_detector`]; callers import them
//!    there, and `service/query/mod.rs` re-exports `intent` whichever way a file
//!    names it.
//! 2. **`token.length >= 4` is UTF-16** through
//!    [`crate::knowledge::retrieval::js_str_len`].
//! 3. **The seq sets are [`BTreeSet`]s.** `[...set].sort((a, b) => a - b)` is the
//!    ascending order a `BTreeSet` iterates in.

use std::collections::BTreeSet;

use crate::knowledge::retrieval::js_str_len;
use crate::knowledge::retrieval::query::intent_detector::normalize_lookup_text;
use crate::messages_store::StoredMessage;

use super::super::constants::{
    binary_recall_query_pattern, negation_signal_pattern, GENERIC_QUERY_TOKENS,
};

/// The `{ hasConflict, userSeqs, agentSeqs }` of `detectBinaryRecallConflict`
/// (`service/query/intent.ts:35-78`).
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct BinaryRecallConflict {
    pub has_conflict: bool,
    pub user_seqs: Vec<i64>,
    pub agent_seqs: Vec<i64>,
}

/// `isBinaryRecallQuery` from `service/query/intent.ts:12-16`.
pub fn is_binary_recall_query(value: &str) -> bool {
    let normalized = normalize_lookup_text(value);
    if normalized.is_empty() {
        return false;
    }
    binary_recall_query_pattern().is_match(&normalized)
}

/// `extractQueryEvidenceTokens` from `service/query/intent.ts:18-27`.
pub fn extract_query_evidence_tokens(value: &str) -> Vec<String> {
    let normalized = normalize_lookup_text(value);
    if normalized.is_empty() {
        return Vec::new();
    }
    let tokens: Vec<String> = normalized
        .split(' ')
        .map(|token| token.trim().to_string())
        .filter(|token| js_str_len(token) >= 4)
        .collect();
    let specific: Vec<String> = tokens
        .iter()
        .filter(|token| !GENERIC_QUERY_TOKENS.contains(&token.as_str()))
        .cloned()
        .collect();
    if specific.is_empty() {
        tokens
    } else {
        specific
    }
}

/// `hasEvidenceTokenOverlap` from `service/query/intent.ts:29-33`.
pub fn has_evidence_token_overlap(text: &str, tokens: &[String]) -> bool {
    let normalized = normalize_lookup_text(text);
    if normalized.is_empty() || tokens.is_empty() {
        return false;
    }
    tokens
        .iter()
        .any(|token| normalized.contains(token.as_str()))
}

fn message_seq(message: &StoredMessage) -> Option<i64> {
    message.seq.filter(|seq| *seq > 0)
}

/// `detectBinaryRecallConflict` from `service/query/intent.ts:35-78`.
pub fn detect_binary_recall_conflict(
    messages: &[StoredMessage],
    query: &str,
) -> BinaryRecallConflict {
    if !is_binary_recall_query(query) {
        return BinaryRecallConflict::default();
    }
    let tokens = extract_query_evidence_tokens(query);
    if tokens.is_empty() {
        return BinaryRecallConflict::default();
    }

    let relevant: Vec<&StoredMessage> = messages
        .iter()
        .filter(|message| has_evidence_token_overlap(&message.content, &tokens))
        .collect();
    let user_messages: Vec<&StoredMessage> = relevant
        .iter()
        .copied()
        .filter(|message| message.role == "user")
        .collect();
    let agent_messages: Vec<&StoredMessage> = relevant
        .iter()
        .copied()
        .filter(|message| message.role == "agent")
        .collect();

    let mut user_seqs: BTreeSet<i64> = BTreeSet::new();
    let mut agent_seqs: BTreeSet<i64> = BTreeSet::new();
    for user_message in &user_messages {
        for agent_message in &agent_messages {
            let user_has_negation =
                negation_signal_pattern().is_match(&normalize_lookup_text(&user_message.content));
            let agent_has_negation =
                negation_signal_pattern().is_match(&normalize_lookup_text(&agent_message.content));
            if user_has_negation == agent_has_negation {
                continue;
            }
            if let Some(seq) = message_seq(user_message) {
                user_seqs.insert(seq);
            }
            if let Some(seq) = message_seq(agent_message) {
                agent_seqs.insert(seq);
            }
        }
    }

    BinaryRecallConflict {
        has_conflict: !user_seqs.is_empty() && !agent_seqs.is_empty(),
        user_seqs: user_seqs.into_iter().collect(),
        agent_seqs: agent_seqs.into_iter().collect(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn message(seq: Option<i64>, role: &str, content: &str) -> StoredMessage {
        StoredMessage {
            id: format!("m{}", seq.unwrap_or(0)),
            conversation_id: "c".into(),
            seq,
            role: role.into(),
            content: content.into(),
            platform: "webchat".into(),
            external_msg_id: None,
            sender_name: None,
            metadata: None,
            created_at: String::new(),
        }
    }

    #[test]
    fn only_the_binary_phrasings_trigger_the_check() {
        assert!(is_binary_recall_query("Waren wir in der Sauna?"));
        assert!(!is_binary_recall_query("die Sauna war warm"));
        assert!(!is_binary_recall_query(""));
    }

    #[test]
    fn generic_tokens_are_dropped_when_specific_ones_exist() {
        assert_eq!(
            extract_query_evidence_tokens("waren wir beim vertrag"),
            vec!["beim".to_string(), "vertrag".to_string()]
        );
        // Nothing specific stays: the generic list is returned unchanged.
        assert_eq!(
            extract_query_evidence_tokens("waren wir schon einmal"),
            vec![
                "waren".to_string(),
                "schon".to_string(),
                "einmal".to_string()
            ]
        );
        assert!(extract_query_evidence_tokens("").is_empty());
    }

    #[test]
    fn a_negation_mismatch_between_user_and_agent_is_a_conflict() {
        let messages = vec![
            message(Some(1), "user", "Wir waren beim vertrag"),
            message(Some(2), "agent", "Nein, wir waren nicht beim vertrag"),
        ];
        let conflict = detect_binary_recall_conflict(&messages, "waren wir beim vertrag?");
        assert!(conflict.has_conflict);
        assert_eq!(conflict.user_seqs, vec![1]);
        assert_eq!(conflict.agent_seqs, vec![2]);
    }

    #[test]
    fn matching_negation_is_not_a_conflict() {
        let messages = vec![
            message(Some(1), "user", "Wir waren nicht beim vertrag"),
            message(Some(2), "agent", "Nein, nicht beim vertrag"),
        ];
        let conflict = detect_binary_recall_conflict(&messages, "waren wir beim vertrag?");
        assert!(!conflict.has_conflict);
        assert!(conflict.user_seqs.is_empty() && conflict.agent_seqs.is_empty());
    }
}
