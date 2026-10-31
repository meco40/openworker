//! Port of `src/server/knowledge/ingestion/qualityChecks.ts` (1-121).
//!
//! | TypeScript | Rust |
//! | --- | --- |
//! | `inferSourceStart` (`:5-9`) | [`infer_source_start`] |
//! | `inferSourceEnd` (`:12-20`) | [`infer_source_end`] |
//! | `normalizeRuleEvidenceText` (`:23-28`) | [`normalize_rule_evidence_text`] |
//! | `tokenizeRuleEvidence` (`:31-38`) | [`tokenize_rule_evidence`] |
//! | `hasRuleEvidenceMatch` (`:41-63`) | [`has_rule_evidence_match`] |
//! | `collectUserRuleEvidenceTexts` (`:66-101`) | [`collect_user_rule_evidence_texts`] |
//! | `keepOnlyEvidenceBackedRuleStatements` (`:104-121`) | [`keep_only_evidence_backed_rule_statements`] |
//!
//! # Deviations
//!
//! * `.toLowerCase()` and the regex `/[^a-z0-9äöüß]+/i` are applied to text that
//!   has already been lowercased, so the `i` flag adds nothing and is dropped.
//!   Lowercasing uses Rust's Unicode rules; for German text they agree.
//! * Token length is counted in UTF-16 units with `js_str_len`, as in JavaScript.

use std::collections::{HashMap, HashSet};
use std::sync::LazyLock;

use regex::Regex;

use crate::knowledge::ingestion_cursor::IngestionWindow;
use crate::knowledge::repository::KnowledgeSourceRef;
use crate::knowledge::retrieval::js_str_len;
use crate::knowledge::retrieval::query::rules_extractor::is_rule_like_statement;

/// `inferSourceStart` (`qualityChecks.ts:5-9`): the first message's seq, else
/// `fromSeqExclusive`, never below zero.
pub fn infer_source_start(window: &IngestionWindow) -> i64 {
    let first = window
        .messages
        .first()
        .and_then(|message| message.seq)
        .filter(|seq| *seq != 0)
        .unwrap_or(window.from_seq_exclusive);
    first.max(0)
}

/// `inferSourceEnd` (`qualityChecks.ts:12-20`): the last message's seq, else
/// `toSeqInclusive`, else `fromSeqExclusive`, never below zero.
pub fn infer_source_end(window: &IngestionWindow) -> i64 {
    let last = window
        .messages
        .last()
        .and_then(|message| message.seq)
        .filter(|seq| *seq != 0)
        .or(Some(window.to_seq_inclusive).filter(|seq| *seq != 0))
        .unwrap_or(window.from_seq_exclusive);
    last.max(0)
}

static WHITESPACE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"\s+").expect("whitespace"));
static NON_TOKEN: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"[^a-z0-9äöüß]+").expect("token separator"));

/// `normalizeRuleEvidenceText` (`qualityChecks.ts:23-28`): lowercase, single
/// spaces, trimmed.
pub fn normalize_rule_evidence_text(value: &str) -> String {
    let lowered = value.to_lowercase();
    WHITESPACE.replace_all(&lowered, " ").trim().to_string()
}

/// `tokenizeRuleEvidence` (`qualityChecks.ts:31-38`): tokens of at least four
/// characters.
pub fn tokenize_rule_evidence(value: &str) -> Vec<String> {
    let normalized = normalize_rule_evidence_text(value);
    NON_TOKEN
        .split(&normalized)
        .map(str::trim)
        .filter(|token| js_str_len(token) >= 4)
        .map(str::to_string)
        .collect()
}

/// `hasRuleEvidenceMatch` (`qualityChecks.ts:41-63`). A containment in either
/// direction, or at least two shared tokens (counted per occurrence), is a match.
pub fn has_rule_evidence_match(rule_fact: &str, evidence_texts: &[String]) -> bool {
    let normalized_rule = normalize_rule_evidence_text(rule_fact);
    if normalized_rule.is_empty() {
        return false;
    }

    let fact_tokens: HashSet<String> = tokenize_rule_evidence(&normalized_rule)
        .into_iter()
        .collect();
    for evidence_text in evidence_texts {
        let normalized_evidence = normalize_rule_evidence_text(evidence_text);
        if normalized_evidence.is_empty() {
            continue;
        }
        if normalized_evidence.contains(&normalized_rule)
            || normalized_rule.contains(&normalized_evidence)
        {
            return true;
        }

        let evidence_tokens = tokenize_rule_evidence(&normalized_evidence);
        if fact_tokens.is_empty() || evidence_tokens.is_empty() {
            continue;
        }
        let overlap = evidence_tokens
            .iter()
            .filter(|token| fact_tokens.contains(token.as_str()))
            .count();
        if overlap >= 2 {
            return true;
        }
    }
    false
}

/// `collectUserRuleEvidenceTexts` (`qualityChecks.ts:66-101`): the user's
/// messages and the source quotes that point at a user message. Duplicates are
/// removed by the trimmed text, in first-seen order.
pub fn collect_user_rule_evidence_texts(
    window: &IngestionWindow,
    source_refs: &[KnowledgeSourceRef],
) -> Vec<String> {
    let mut seq_to_role: HashMap<i64, String> = HashMap::new();
    for message in &window.messages {
        let seq = message.seq.unwrap_or(0);
        if seq > 0 {
            seq_to_role.insert(seq, message.role.to_lowercase());
        }
    }

    let user_messages = window
        .messages
        .iter()
        .filter(|message| message.role.to_lowercase() == "user")
        .map(|message| message.content.trim().to_string());

    let user_source_quotes = source_refs
        .iter()
        .filter(|reference| seq_to_role.get(&reference.seq).map(String::as_str) == Some("user"))
        .map(|reference| reference.quote.trim().to_string());

    let mut seen = HashSet::new();
    let mut unique = Vec::new();
    for text in user_messages.chain(user_source_quotes) {
        if normalize_rule_evidence_text(&text).is_empty() {
            continue;
        }
        let trimmed = text.trim().to_string();
        if seen.insert(trimmed.clone()) {
            unique.push(trimmed);
        }
    }
    unique
}

/// `keepOnlyEvidenceBackedRuleStatements` (`qualityChecks.ts:104-121`). Rule-like
/// statements without evidence are dropped; everything else is kept.
pub fn keep_only_evidence_backed_rule_statements(
    values: &[String],
    evidence_texts: &[String],
) -> Vec<String> {
    let mut output = Vec::new();
    for value in values {
        let statement = value.trim().to_string();
        if statement.is_empty() {
            continue;
        }
        if !is_rule_like_statement(&statement)
            || has_rule_evidence_match(&statement, evidence_texts)
        {
            output.push(statement);
        }
    }
    output
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::messages_store::StoredMessage;

    fn message(seq: Option<i64>, role: &str, content: &str) -> StoredMessage {
        StoredMessage {
            id: format!("m{seq:?}"),
            conversation_id: "c".into(),
            seq,
            role: role.into(),
            content: content.into(),
            platform: "web".into(),
            external_msg_id: None,
            sender_name: None,
            metadata: None,
            created_at: String::new(),
        }
    }

    fn window(from: i64, to: i64, messages: Vec<StoredMessage>) -> IngestionWindow {
        IngestionWindow {
            conversation_id: "c".into(),
            user_id: "u".into(),
            persona_id: "p".into(),
            workspace_id: None,
            from_seq_exclusive: from,
            to_seq_inclusive: to,
            messages,
        }
    }

    #[test]
    fn source_bounds_fall_back_to_the_window_edges() {
        let w = window(
            4,
            9,
            vec![message(Some(5), "user", "a"), message(None, "agent", "b")],
        );
        assert_eq!(infer_source_start(&w), 5);
        // The last message has no seq, so the window's `toSeqInclusive` is used.
        assert_eq!(infer_source_end(&w), 9);
        let empty = window(4, 0, vec![]);
        assert_eq!(infer_source_start(&empty), 4);
        assert_eq!(infer_source_end(&empty), 4);
    }

    #[test]
    fn tokens_shorter_than_four_characters_are_dropped() {
        assert_eq!(
            tokenize_rule_evidence("Der Rabatt ist groß"),
            vec!["rabatt", "groß"]
        );
    }

    #[test]
    fn a_containment_or_two_shared_tokens_is_evidence() {
        let evidence = vec!["Wir haben einen Rabatt von zehn Prozent vereinbart".to_string()];
        assert!(has_rule_evidence_match(
            "Rabatt von zehn Prozent",
            &evidence
        ));
        assert!(has_rule_evidence_match(
            "zehn Prozent Rabatt Sonderpreis",
            &evidence
        ));
        assert!(!has_rule_evidence_match("Kaffee am Morgen", &evidence));
        assert!(!has_rule_evidence_match("   ", &evidence));
    }

    #[test]
    fn user_evidence_is_deduplicated_and_limited_to_user_messages() {
        let w = window(
            0,
            3,
            vec![
                message(Some(1), "user", "  Regel: Immer Deutsch  "),
                message(Some(2), "agent", "Verstanden"),
                message(Some(3), "user", "Regel: Immer Deutsch"),
            ],
        );
        let refs = vec![KnowledgeSourceRef {
            seq: 2,
            quote: "Verstanden".into(),
        }];
        assert_eq!(
            collect_user_rule_evidence_texts(&w, &refs),
            vec!["Regel: Immer Deutsch".to_string()]
        );
    }

    #[test]
    fn statements_that_are_not_rules_are_always_kept() {
        let kept = keep_only_evidence_backed_rule_statements(
            &["  Kaffee gerne  ".to_string(), String::new()],
            &[],
        );
        assert_eq!(kept, vec!["Kaffee gerne".to_string()]);
    }
}
