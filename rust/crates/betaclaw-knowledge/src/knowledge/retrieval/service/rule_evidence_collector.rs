//! Port of `src/server/knowledge/retrieval/service/ruleEvidenceCollector.ts` (1-79).
//!
//! | TypeScript                                                          | Rust |
//! | ------------------------------------------------------------------- | ---- |
//! | `service/ruleEvidenceCollector.ts:9-79` (`collectRuleFallbackEvidence`) | [`collect_rule_fallback_evidence`] |
//!
//! # Deviations
//!
//! 1. **`Object.entries(entity.properties)` order.** `properties` is a
//!    [`serde_json::Map`]; whether it iterates in the source's insertion order
//!    depends on the crate feature. The dedup pass keys on the normalized text,
//!    so a different property order can only change the order of *distinct*
//!    evidence entries, not their content.
//! 2. **`String(propertyValue || '')`.** The port renders a [`serde_json::Value`]
//!    as its JSON text, with JavaScript's falsy values (`null`, `false`, `0`,
//!    `""`) becoming the empty string; arrays and objects are not used as
//!    property values in the knowledge schema.
//! 3. **The dedup map preserves insertion order** like a JavaScript `Map`; the
//!    port keeps `(key, entry)` pairs in a [`Vec`] and does a linear lookup.
//! 4. The `key` of `:55` (`text.toLowerCase().replace(/\s+/g, ' ').trim()`) is
//!    [`crate::knowledge::retrieval::service::query::parser::normalize_rule_text`].

use crate::knowledge::entity_graph::KnowledgeEntity;
use crate::knowledge::event_types::KnowledgeEvent;
use crate::knowledge::retrieval::formatters::evidence_builder::EvidenceSourceRef;
use crate::knowledge::retrieval::query::rules_extractor::{
    extract_rule_fragments, is_rule_like_statement,
};
use crate::knowledge::retrieval::service::query::parser::{normalize_rule_text, parse_event_seqs};
use crate::knowledge::retrieval::service::query::rules::has_meaningful_overlap;
use crate::knowledge::retrieval::service::types::RuleEvidenceEntry;
use crate::knowledge::retrieval::utils::unique_strings;

fn property_to_string(value: &serde_json::Value) -> String {
    match value {
        serde_json::Value::Null => String::new(),
        serde_json::Value::Bool(false) => String::new(),
        serde_json::Value::Number(number) if number.as_f64() == Some(0.0) => String::new(),
        serde_json::Value::String(text) => text.clone(),
        other => other.to_string(),
    }
}

fn collect_event_refs(event: &KnowledgeEvent, summary: &str) -> Option<Vec<EvidenceSourceRef>> {
    let seqs = parse_event_seqs(&event.source_seq_json);
    if seqs.is_empty() {
        return None;
    }
    Some(
        seqs.into_iter()
            .map(|seq| EvidenceSourceRef {
                seq,
                quote: summary.to_string(),
            })
            .collect(),
    )
}

fn dedup_refs(a: &[EvidenceSourceRef], b: &[EvidenceSourceRef]) -> Vec<EvidenceSourceRef> {
    unique_strings(
        a.iter()
            .chain(b.iter())
            .map(|reference| format!("{}:{}", reference.seq, reference.quote)),
    )
    .into_iter()
    .filter_map(|value| {
        let split = value.find(':')?;
        let seq = value[..split].parse::<i64>().ok()?;
        Some(EvidenceSourceRef {
            seq,
            quote: value[split + 1..].to_string(),
        })
    })
    .collect()
}

/// `collectRuleFallbackEvidence` from `service/ruleEvidenceCollector.ts:9-79`.
pub fn collect_rule_fallback_evidence(
    entities: &[KnowledgeEntity],
    events: &[KnowledgeEvent],
) -> Vec<RuleEvidenceEntry> {
    let mut event_entries: Vec<RuleEvidenceEntry> = Vec::new();
    for event in events {
        let summary = event.source_summary.trim().to_string();
        if summary.is_empty() {
            continue;
        }
        let Some(refs) = collect_event_refs(event, &summary) else {
            continue;
        };
        let mut candidates: Vec<String> = Vec::new();
        if is_rule_like_statement(&summary) {
            candidates.push(summary.clone());
        }
        candidates.extend(extract_rule_fragments(&summary, 6));
        for fragment in unique_strings(candidates) {
            if !is_rule_like_statement(&fragment) {
                continue;
            }
            event_entries.push(RuleEvidenceEntry {
                text: fragment,
                refs: refs.clone(),
            });
        }
    }

    let mut entity_entries: Vec<RuleEvidenceEntry> = Vec::new();
    for entity in entities {
        for (property_key, property_value) in &entity.properties {
            let raw_value = property_to_string(property_value);
            let raw_value = raw_value.trim();
            if raw_value.is_empty() {
                continue;
            }
            let raw_candidate = format!("{}: {}", property_key, raw_value)
                .trim()
                .to_string();
            let mut candidates: Vec<String> = Vec::new();
            if is_rule_like_statement(&raw_candidate) {
                candidates.push(raw_candidate.clone());
            }
            candidates.extend(extract_rule_fragments(&raw_candidate, 6));

            for fragment in unique_strings(candidates) {
                if !is_rule_like_statement(&fragment) {
                    continue;
                }
                let matched_refs: Vec<EvidenceSourceRef> = event_entries
                    .iter()
                    .filter(|entry| has_meaningful_overlap(&entry.text, &fragment))
                    .flat_map(|entry| entry.refs.clone())
                    .collect();
                if matched_refs.is_empty() {
                    continue;
                }
                entity_entries.push(RuleEvidenceEntry {
                    text: fragment,
                    refs: matched_refs,
                });
            }
        }
    }

    let mut merged: Vec<RuleEvidenceEntry> = event_entries;
    merged.extend(entity_entries);

    let mut dedup: Vec<(String, RuleEvidenceEntry)> = Vec::new();
    for entry in merged {
        let key = normalize_rule_text(&entry.text);
        if key.is_empty() {
            continue;
        }
        match dedup.iter_mut().find(|(existing, _)| existing == &key) {
            None => dedup.push((key, entry)),
            Some((_, current)) => {
                current.refs = dedup_refs(&current.refs, &entry.refs);
            }
        }
    }

    dedup
        .into_iter()
        .map(|(_, entry)| entry)
        .filter(|entry| !entry.refs.is_empty())
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::knowledge::event_types::SpeakerRole;

    fn event(summary: &str, seqs: &str) -> KnowledgeEvent {
        KnowledgeEvent {
            id: "e".into(),
            user_id: "u".into(),
            persona_id: "p".into(),
            conversation_id: "c".into(),
            event_type: "meeting".into(),
            speaker_role: SpeakerRole::User,
            speaker_entity: "u".into(),
            subject_entity: "u".into(),
            counterpart_entity: "max".into(),
            relation_label: None,
            start_date: String::new(),
            end_date: String::new(),
            day_count: 1,
            source_seq_json: seqs.into(),
            source_summary: summary.into(),
            is_confirmation: false,
            confidence: 0.5,
            created_at: String::new(),
            updated_at: String::new(),
        }
    }

    #[test]
    fn a_rule_like_event_summary_becomes_evidence_with_its_seqs() {
        let entries =
            collect_rule_fallback_evidence(&[], &[event("Regel eins gilt fuer alle", "[1,2]")]);
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].text, "Regel eins gilt fuer alle");
        assert_eq!(
            entries[0].refs,
            vec![
                EvidenceSourceRef {
                    seq: 1,
                    quote: "Regel eins gilt fuer alle".into()
                },
                EvidenceSourceRef {
                    seq: 2,
                    quote: "Regel eins gilt fuer alle".into()
                },
            ]
        );
    }

    #[test]
    fn an_event_without_seqs_or_non_rule_text_is_ignored() {
        assert!(collect_rule_fallback_evidence(&[], &[event("Regel eins gilt", "[]")]).is_empty());
        assert!(
            collect_rule_fallback_evidence(&[], &[event("Die Sauna war warm", "[1]")]).is_empty()
        );
        assert!(collect_rule_fallback_evidence(&[], &[]).is_empty());
    }
}
