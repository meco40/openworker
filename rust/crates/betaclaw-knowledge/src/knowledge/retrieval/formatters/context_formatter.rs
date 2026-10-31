//! Port of `src/server/knowledge/retrieval/formatters/contextFormatter.ts` (1-54).
//!
//! | TypeScript                                              | Rust |
//! | ------------------------------------------------------- | ---- |
//! | `formatters/contextFormatter.ts:7-37` (`buildSemanticContextForQuery`) | [`build_semantic_context_for_query`] |
//! | `formatters/contextFormatter.ts:39-54` (`formatProjectGraph`) | [`format_project_graph`] |
//!
//! # Deviations
//!
//! 1. **Structural parameter types become the concrete slice types.**
//!    `formatProjectGraph` takes `Array<{ relationType; targetEntityId }>` and
//!    `Array<{ canonicalName; id?; category }>`; the one call site
//!    (`service/queryPlanning.ts:75`) passes the `EntityRelation[]` and
//!    `KnowledgeEntity[]` of [`crate::knowledge::entity_graph`], which carry
//!    those fields, so the port takes them directly.
//! 2. **`String#length` is UTF-16.** `value.length > 0` (`:31`) is measured with
//!    [`crate::knowledge::retrieval::js_str_len`].
//! 3. `String(entry.node.content || '')` — a missing `content` is the empty
//!    string here (`node.content` is `Option<String>`).

use crate::knowledge::entity_graph::{EntityRelation, KnowledgeEntity};
use crate::knowledge::retrieval::js_str_len;
use crate::knowledge::retrieval::query::intent_detector::is_rules_intent_query;
use crate::knowledge::retrieval::query::rules_extractor::extract_rule_fragments;
use crate::knowledge::retrieval::types::MemoryRecallResult;
use crate::knowledge::retrieval::utils::unique_strings;

/// `buildSemanticContextForQuery` from `formatters/contextFormatter.ts:7-37`.
pub fn build_semantic_context_for_query(query: &str, semantic: &MemoryRecallResult) -> String {
    if is_rules_intent_query(query) {
        let mut fragments: Vec<String> = Vec::new();
        for entry in &semantic.matches {
            let content = entry.node.content.clone().unwrap_or_default();
            fragments.extend(extract_rule_fragments(&content, 3));
        }
        let rule_picks: Vec<String> = unique_strings(fragments)
            .into_iter()
            .take(6)
            .map(|value| format!("[Type: fact] {}", value))
            .collect();
        if !rule_picks.is_empty() {
            return rule_picks.join("\n");
        }

        let fallback_rules: Vec<String> = extract_rule_fragments(&semantic.context, 4)
            .into_iter()
            .map(|value| format!("[Type: fact] {}", value))
            .collect();
        if !fallback_rules.is_empty() {
            return fallback_rules.join("\n");
        }
        return String::new();
    }

    let picks: Vec<String> = semantic
        .matches
        .iter()
        .map(|entry| {
            crate::knowledge::retrieval::truncate_text(
                &entry.node.content.clone().unwrap_or_default(),
                280,
            )
        })
        .filter(|value| js_str_len(value) > 0)
        .take(4)
        .map(|value| format!("[Type: fact] {}", value))
        .collect();

    if !picks.is_empty() {
        return picks.join("\n");
    }
    crate::knowledge::retrieval::truncate_text(&semantic.context, 280)
}

/// `formatProjectGraph` from `formatters/contextFormatter.ts:39-54`.
pub fn format_project_graph(
    project_name: &str,
    relations: &[EntityRelation],
    related_entities: &[KnowledgeEntity],
) -> String {
    let mut lines: Vec<String> = vec![format!("Projekt: {}", project_name)];
    let mut entity_by_id: Vec<(String, String)> = Vec::new();
    for entity in related_entities {
        entity_by_id.push((entity.id.clone(), entity.canonical_name.clone()));
    }
    for relation in relations {
        let name = entity_by_id
            .iter()
            .find(|(id, _)| id == &relation.target_entity_id)
            .map(|(_, name)| name.clone())
            .unwrap_or_else(|| relation.target_entity_id.clone());
        lines.push(format!("{}: {}", relation.relation_type, name));
    }
    lines.join("\n")
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::knowledge::entity_graph::{EntityCategory, EntityOwner};
    use crate::knowledge::retrieval::types::{MemoryRecallMatch, MemoryRecallNode};

    fn match_with(content: &str) -> MemoryRecallMatch {
        MemoryRecallMatch {
            node: MemoryRecallNode {
                id: "n".into(),
                content: Some(content.into()),
            },
        }
    }

    #[test]
    fn a_rules_query_prefers_rule_fragments() {
        let semantic = MemoryRecallResult {
            context: String::new(),
            matches: vec![match_with("1. Immer pruefen 2. Nie hetzen")],
        };
        assert_eq!(
            build_semantic_context_for_query("was sind die Regeln", &semantic),
            "[Type: fact] 1. Immer pruefen\n[Type: fact] 2. Nie hetzen"
        );
    }

    #[test]
    fn a_plain_query_truncates_each_match() {
        let semantic = MemoryRecallResult {
            context: "fallback".into(),
            matches: vec![match_with("kurz"), match_with("   ")],
        };
        assert_eq!(
            build_semantic_context_for_query("was war mit Max", &semantic),
            "[Type: fact] kurz"
        );
    }

    #[test]
    fn the_project_graph_uses_the_entity_name_and_falls_back_to_the_id() {
        let relation = |target: &str, kind: &str| EntityRelation {
            id: "r".into(),
            source_entity_id: "s".into(),
            target_entity_id: target.into(),
            relation_type: kind.into(),
            properties: Default::default(),
            confidence: 1.0,
            created_at: String::new(),
            updated_at: String::new(),
        };
        let entity = KnowledgeEntity {
            id: "e1".into(),
            user_id: "u".into(),
            persona_id: "p".into(),
            canonical_name: "Alpha".into(),
            category: EntityCategory::Project,
            owner: EntityOwner::User,
            properties: Default::default(),
            created_at: String::new(),
            updated_at: String::new(),
        };
        let graph = format_project_graph(
            "Projekt X",
            &[relation("e1", "member"), relation("missing", "owns")],
            &[entity],
        );
        assert_eq!(graph, "Projekt: Projekt X\nmember: Alpha\nowns: missing");
    }
}
