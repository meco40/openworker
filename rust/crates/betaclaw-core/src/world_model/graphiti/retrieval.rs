//! Port of `src/server/world-model/graphiti/retrieval.ts:1-199` query variants and reranking.

use std::collections::HashSet;

use crate::world_model::retrieval::index::GraphitiFact;

const STOP_WORDS: &[&str] = &[
    "and", "for", "the", "with", "from", "this", "that", "is", "are", "has", "have", "not", "von",
    "der", "die", "das", "den", "dem", "des", "und", "oder", "ist", "sind", "ein", "eine", "einer",
    "einem", "einen", "zu", "im", "in", "auf",
];

fn tokenize(value: &str) -> Vec<String> {
    let mut tokens = Vec::new();
    let mut current = String::new();
    for character in value.to_lowercase().chars() {
        if character.is_alphanumeric() {
            current.push(character);
        } else if !current.is_empty() {
            push_token(&mut tokens, std::mem::take(&mut current));
        }
    }
    if !current.is_empty() {
        push_token(&mut tokens, current);
    }
    tokens
}

fn push_token(tokens: &mut Vec<String>, token: String) {
    if token.chars().count() >= 3 && !STOP_WORDS.contains(&token.as_str()) {
        tokens.push(token);
    }
}

fn unique(values: impl IntoIterator<Item = String>) -> Vec<String> {
    let mut seen = HashSet::new();
    values
        .into_iter()
        .filter_map(|value| {
            let cleaned = value.trim().to_string();
            let key = cleaned.to_lowercase();
            if cleaned.is_empty() || !seen.insert(key) {
                None
            } else {
                Some(cleaned)
            }
        })
        .collect()
}

pub fn build_query_variants(text: &str, terms: &[String], max_variants: usize) -> Vec<String> {
    let base = text.split_whitespace().collect::<Vec<_>>().join(" ");
    if base.is_empty() {
        return Vec::new();
    }
    let tokens = unique(terms.iter().cloned().chain(tokenize(&base)));
    unique([base, tokens.join(" ")])
        .into_iter()
        .take(max_variants.max(1))
        .collect()
}

#[derive(Debug)]
pub struct RankedFact {
    pub fact: GraphitiFact,
    pub score: f64,
    pub focus_matches: usize,
}

fn token_matches(query: &str, fact: &str) -> bool {
    if query == fact {
        return true;
    }
    query.chars().count() >= 5
        && fact.chars().count() >= 5
        && query.chars().take(5).eq(fact.chars().take(5))
}

pub fn rank_facts(text: &str, terms: &[String], facts: Vec<GraphitiFact>) -> Vec<RankedFact> {
    let query_tokens = unique(terms.iter().cloned().chain(tokenize(text)))
        .into_iter()
        .flat_map(|token| tokenize(&token))
        .collect::<Vec<_>>();
    let mut seen_tokens = HashSet::new();
    let query_tokens = query_tokens
        .into_iter()
        .filter(|token| seen_tokens.insert(token.clone()))
        .collect::<Vec<_>>();
    if query_tokens.is_empty() {
        return Vec::new();
    }
    let focus_tokens = terms
        .iter()
        .flat_map(|term| tokenize(term))
        .collect::<Vec<_>>();
    let normalized_query = text.trim().to_lowercase();
    let mut seen_facts = HashSet::new();
    let mut ranked = facts
        .into_iter()
        .filter_map(|fact| {
            let normalized_fact = fact
                .fact
                .split_whitespace()
                .collect::<Vec<_>>()
                .join(" ")
                .to_lowercase();
            if !seen_facts.insert(normalized_fact.clone()) {
                return None;
            }
            let fact_tokens = tokenize(&format!(
                "{} {}",
                fact.name.as_deref().unwrap_or(""),
                fact.fact
            ));
            let matched = query_tokens
                .iter()
                .filter(|query| fact_tokens.iter().any(|token| token_matches(query, token)))
                .count();
            let focus_matches = focus_tokens
                .iter()
                .filter(|query| fact_tokens.iter().any(|token| token_matches(query, token)))
                .count();
            let token_coverage = matched as f64 / query_tokens.len() as f64;
            let focus_coverage = if focus_tokens.is_empty() {
                token_coverage
            } else {
                focus_matches as f64 / focus_tokens.len() as f64
            };
            let phrase_match = normalized_query.chars().count() >= 12
                && fact.fact.to_lowercase().contains(&normalized_query);
            let score = (token_coverage * 0.45
                + focus_coverage * 0.3
                + if phrase_match { 0.15 } else { 0.0 })
            .min(1.0);
            Some(RankedFact {
                fact,
                score,
                focus_matches,
            })
        })
        .collect::<Vec<_>>();
    ranked.sort_by(|left, right| {
        right
            .score
            .total_cmp(&left.score)
            .then_with(|| left.fact.fact.cmp(&right.fact.fact))
    });
    ranked
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fact(text: &str) -> GraphitiFact {
        GraphitiFact {
            fact: text.into(),
            ..GraphitiFact::default()
        }
    }

    #[test]
    fn variants_keep_the_original_query_and_compact_terms() {
        assert_eq!(
            build_query_variants("  Mira   geht ins Kino ", &["Kino".into()], 3),
            vec!["Mira geht ins Kino", "Kino mira geht ins"]
        );
        assert!(build_query_variants("  ", &[], 3).is_empty());
    }

    #[test]
    fn ranking_deduplicates_content_and_drops_irrelevant_facts() {
        let ranked = rank_facts(
            "Mira geht ins Kino",
            &["Kino".into()],
            vec![
                fact("Mira geht ins Kino"),
                fact(" Mira   geht ins Kino "),
                fact("Ferner Wetterbericht"),
            ],
        );
        assert_eq!(
            ranked.len(),
            2,
            "duplicate content collapses; ranking leaves the relevance gate to its caller"
        );
        assert_eq!(ranked[0].fact.fact, "Mira geht ins Kino");
        assert!(ranked[0].score >= 0.3);
        assert_eq!(ranked[1].score, 0.0);
    }
}
