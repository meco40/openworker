//! Port of `src/server/knowledge/retrieval/formatters/evidenceBuilder.ts` (1-71).
//!
//! | TypeScript                                          | Rust |
//! | --------------------------------------------------- | ---- |
//! | `formatters/evidenceBuilder.ts:5-8` (`EvidenceSourceRef`) | [`EvidenceSourceRef`] |
//! | `formatters/evidenceBuilder.ts:10-71` (`buildEvidence`) | [`build_evidence`] |
//!
//! # Deviations
//!
//! 1. **The optional options object is a struct.** `options = {}` with
//!    `extraRefs` and `allowMessageFallback ?? true` becomes [`EvidenceOptions`],
//!    whose [`Default`] is the same `{}` (empty refs, fallback on).
//! 2. **`refs.length > 0` is a UTF-16 length.** `ref.quote.length > 0` (`:31`)
//!    uses [`crate::knowledge::retrieval::js_str_len`], like the source's
//!    `String#length`.
//! 3. `Math.floor(Number(seq || 0))` over an `i64` is the identity for the
//!    stored integer, so the port keeps `i64` throughout; `Number.isFinite`
//!    cannot fail for it.

use std::collections::HashMap;

use crate::knowledge::repository::{KnowledgeEpisode, MeetingLedgerEntry};
use crate::knowledge::retrieval::js_str_len;
use crate::knowledge::retrieval::utils::unique_strings;
use crate::messages_store::StoredMessage;

/// `EvidenceSourceRef` from `formatters/evidenceBuilder.ts:5-8`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct EvidenceSourceRef {
    pub seq: i64,
    pub quote: String,
}

/// `options` of `buildEvidence` (`formatters/evidenceBuilder.ts:14-17`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct EvidenceOptions {
    pub extra_refs: Vec<EvidenceSourceRef>,
    pub allow_message_fallback: bool,
}

impl Default for EvidenceOptions {
    fn default() -> Self {
        Self {
            extra_refs: Vec::new(),
            allow_message_fallback: true,
        }
    }
}

/// The `{ evidenceText, references }` of `buildEvidence` (`:18`).
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct EvidenceResult {
    pub evidence_text: String,
    pub references: Vec<String>,
}

fn normalized_ref(seq: i64, quote: &str) -> Option<EvidenceSourceRef> {
    let quote = quote.trim().to_string();
    if seq > 0 && js_str_len(&quote) > 0 {
        Some(EvidenceSourceRef { seq, quote })
    } else {
        None
    }
}

fn message_seq(message: &StoredMessage) -> Option<i64> {
    message.seq.filter(|seq| *seq > 0)
}

/// `buildEvidence` from `formatters/evidenceBuilder.ts:10-71`.
pub fn build_evidence(
    messages: &[StoredMessage],
    episodes: &[KnowledgeEpisode],
    ledger_rows: &[MeetingLedgerEntry],
    options: &EvidenceOptions,
) -> EvidenceResult {
    let mut refs: Vec<EvidenceSourceRef> = Vec::new();
    for row in ledger_rows {
        for reference in &row.source_refs {
            if let Some(normalized) = normalized_ref(reference.seq, &reference.quote) {
                refs.push(normalized);
            }
        }
    }
    for row in episodes {
        for reference in &row.source_refs {
            if let Some(normalized) = normalized_ref(reference.seq, &reference.quote) {
                refs.push(normalized);
            }
        }
    }
    for reference in &options.extra_refs {
        if let Some(normalized) = normalized_ref(reference.seq, &reference.quote) {
            refs.push(normalized);
        }
    }

    let deduped_keys = unique_strings(refs.iter().map(|r| format!("{}:{}", r.seq, r.quote)));
    let deduped_refs: Vec<EvidenceSourceRef> = deduped_keys
        .into_iter()
        .filter_map(|entry| {
            let split = entry.find(':')?;
            let seq = entry[..split].parse::<i64>().ok()?;
            Some(EvidenceSourceRef {
                seq,
                quote: entry[split + 1..].to_string(),
            })
        })
        .collect();

    let mut by_seq: HashMap<i64, &StoredMessage> = HashMap::new();
    for message in messages {
        if let Some(seq) = message_seq(message) {
            by_seq.insert(seq, message);
        }
    }

    let mut evidence_lines: Vec<String> = Vec::new();
    let mut references: Vec<String> = Vec::new();
    for reference in deduped_refs.iter().take(8) {
        let text = match by_seq.get(&reference.seq) {
            Some(message) => message.content.trim().to_string(),
            None => reference.quote.clone(),
        };
        let text = if text.is_empty() {
            reference.quote.clone()
        } else {
            text
        };
        evidence_lines.push(format!("- [seq:{}] {}", reference.seq, text));
        references.push(format!("seq:{}", reference.seq));
    }

    if options.allow_message_fallback && evidence_lines.is_empty() {
        for message in messages.iter().take(4) {
            let Some(seq) = message_seq(message) else {
                continue;
            };
            evidence_lines.push(format!("- [seq:{}] {}", seq, message.content.trim()));
            references.push(format!("seq:{}", seq));
        }
    }

    EvidenceResult {
        evidence_text: evidence_lines.join("\n"),
        references,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::knowledge::repository::{KnowledgeEpisode, KnowledgeSourceRef};

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
            created_at: "2024-06-15T10:30:00.000Z".into(),
        }
    }

    fn episode_with_refs(refs: Vec<(i64, &str)>) -> KnowledgeEpisode {
        KnowledgeEpisode {
            id: "e".into(),
            user_id: "u".into(),
            persona_id: "p".into(),
            conversation_id: "c".into(),
            topic_key: "t".into(),
            counterpart: None,
            teaser: String::new(),
            episode: String::new(),
            facts: Vec::new(),
            source_seq_start: 1,
            source_seq_end: 1,
            source_refs: refs
                .into_iter()
                .map(|(seq, quote)| KnowledgeSourceRef {
                    seq,
                    quote: quote.into(),
                })
                .collect(),
            memory_ids: Vec::new(),
            event_at: None,
            updated_at: String::new(),
        }
    }

    #[test]
    fn refs_are_deduped_and_the_message_content_wins() {
        let messages = vec![message(Some(3), "user", "Der wahre Inhalt")];
        let episodes = vec![episode_with_refs(vec![
            (3, "Zitat aus Episode"),
            (3, "Zitat aus Episode"),
            (0, "verworfen"),
        ])];
        let result = build_evidence(&messages, &episodes, &[], &EvidenceOptions::default());
        assert_eq!(result.evidence_text, "- [seq:3] Der wahre Inhalt");
        assert_eq!(result.references, vec!["seq:3".to_string()]);
    }

    #[test]
    fn the_fallback_lists_the_first_messages_when_no_refs_exist() {
        let messages = vec![
            message(Some(1), "user", "hallo"),
            message(Some(2), "agent", "hi"),
        ];
        let result = build_evidence(&messages, &[], &[], &EvidenceOptions::default());
        assert_eq!(result.evidence_text, "- [seq:1] hallo\n- [seq:2] hi");
        assert_eq!(
            result.references,
            vec!["seq:1".to_string(), "seq:2".to_string()]
        );
    }

    #[test]
    fn the_fallback_can_be_disabled() {
        let messages = vec![message(Some(1), "user", "hallo")];
        let options = EvidenceOptions {
            allow_message_fallback: false,
            ..EvidenceOptions::default()
        };
        let result = build_evidence(&messages, &[], &[], &options);
        assert_eq!(result.evidence_text, "");
        assert!(result.references.is_empty());
    }
}
