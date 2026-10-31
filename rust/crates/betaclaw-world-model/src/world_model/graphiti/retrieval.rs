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

/// `GraphitiQueryInput` from `retrieval.ts:3-7`.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct GraphitiQueryInput {
    pub text: String,
    pub terms: Vec<String>,
    pub aliases: Vec<String>,
}

/// `GraphitiRerankOptions` from `retrieval.ts:17-23`.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct GraphitiRerankOptions {
    pub max_candidates: Option<usize>,
    pub max_results: Option<usize>,
    pub max_query_variants: Option<usize>,
    pub expected_source_node_uuid: Option<String>,
    pub expected_target_node_uuid: Option<String>,
}

/// `RankedGraphitiFact` from `retrieval.ts:9-15`.
#[derive(Debug, Clone, PartialEq)]
pub struct RankedGraphitiFact {
    pub fact: GraphitiFact,
    pub score: f64,
    pub matched_tokens: Vec<String>,
    pub focus_matched_tokens: Vec<String>,
    pub provenance_match: bool,
}

/// The raw fact search the reranker fans out over — `searchGraphitiFacts`
/// (`client.ts`). Split out so the evaluator and the tests can supply a stub.
pub trait GraphitiFactSearch {
    fn search_facts<'a>(
        &'a self,
        group_id: &'a str,
        query: &'a str,
        max_facts: usize,
    ) -> crate::world_model::db::BoxFuture<
        'a,
        Result<Vec<GraphitiFact>, crate::world_model::db::PgError>,
    >;
}

impl GraphitiFactSearch for crate::world_model::graphiti::client::GraphitiRestClient {
    fn search_facts<'a>(
        &'a self,
        group_id: &'a str,
        query: &'a str,
        max_facts: usize,
    ) -> crate::world_model::db::BoxFuture<
        'a,
        Result<Vec<GraphitiFact>, crate::world_model::db::PgError>,
    > {
        Box::pin(async move { self.search(group_id, query, max_facts).await })
    }
}

/// `normalizeFactKey(fact)` — `retrieval.ts:83-92`.
fn normalize_fact_key(fact: &GraphitiFact) -> String {
    let content = fact
        .fact
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .to_lowercase();
    format!("content:{content}")
}

/// `deduplicateGraphitiFacts(facts)` — `retrieval.ts:101-109`.
pub fn deduplicate_graphiti_facts(facts: Vec<GraphitiFact>) -> Vec<GraphitiFact> {
    let mut seen = HashSet::new();
    facts
        .into_iter()
        .filter(|fact| seen.insert(normalize_fact_key(fact)))
        .collect()
}

/// `buildGraphitiQueryVariants(input, maxVariants)` — `retrieval.ts:116-131`.
pub fn build_graphiti_query_variants(
    input: &GraphitiQueryInput,
    max_variants: usize,
) -> Vec<String> {
    let base = input.text.split_whitespace().collect::<Vec<_>>().join(" ");
    if base.is_empty() {
        return Vec::new();
    }
    let terms = unique(input.terms.iter().cloned().chain(tokenize(&base)));
    let aliases = unique(input.aliases.iter().cloned());
    let mut variants = vec![base, terms.join(" ")];
    if !aliases.is_empty() {
        let mut third: Vec<String> = terms.iter().take(8).cloned().collect();
        third.extend(aliases.iter().take(8).cloned());
        variants.push(third.join(" "));
    }
    unique(variants).into_iter().take(max_variants).collect()
}

fn dedup_tokens(tokens: Vec<String>) -> Vec<String> {
    let mut seen = HashSet::new();
    tokens
        .into_iter()
        .filter(|token| seen.insert(token.clone()))
        .collect()
}

/// `rankGraphitiFacts(input, facts, options)` — `retrieval.ts:132-175`.
pub fn rank_graphiti_facts(
    input: &GraphitiQueryInput,
    facts: Vec<GraphitiFact>,
    options: &GraphitiRerankOptions,
) -> Vec<RankedGraphitiFact> {
    let query_tokens = unique(
        input
            .terms
            .iter()
            .cloned()
            .chain(input.aliases.iter().cloned())
            .chain(tokenize(&input.text)),
    )
    .into_iter()
    .flat_map(|token| tokenize(&token))
    .collect::<Vec<_>>();
    let unique_query_tokens = dedup_tokens(query_tokens);
    if unique_query_tokens.is_empty() {
        return Vec::new();
    }

    let normalized_query = input.text.trim().to_lowercase();
    let focus_tokens = unique(input.terms.iter().cloned())
        .into_iter()
        .flat_map(|token| tokenize(&token))
        .collect::<Vec<_>>();

    let mut ranked = deduplicate_graphiti_facts(facts)
        .into_iter()
        .map(|fact| {
            let fact_tokens = tokenize(&format!(
                "{} {}",
                fact.name.as_deref().unwrap_or(""),
                fact.fact
            ));
            let matched_tokens: Vec<String> = unique_query_tokens
                .iter()
                .filter(|query| fact_tokens.iter().any(|token| token_matches(query, token)))
                .cloned()
                .collect();
            let token_coverage = matched_tokens.len() as f64 / unique_query_tokens.len() as f64;
            let focus_matched_tokens: Vec<String> = focus_tokens
                .iter()
                .filter(|query| fact_tokens.iter().any(|token| token_matches(query, token)))
                .cloned()
                .collect();
            let focus_coverage = if focus_tokens.is_empty() {
                token_coverage
            } else {
                focus_matched_tokens.len() as f64 / focus_tokens.len() as f64
            };
            let normalized_fact = fact.fact.to_lowercase();
            let phrase_match = normalized_query.chars().count() >= 12
                && normalized_fact.contains(&normalized_query);
            let provenance_match = options
                .expected_source_node_uuid
                .as_deref()
                .is_some_and(|uuid| fact.source_node_uuid.as_deref() == Some(uuid))
                || options
                    .expected_target_node_uuid
                    .as_deref()
                    .is_some_and(|uuid| fact.target_node_uuid.as_deref() == Some(uuid));
            let score = (token_coverage * 0.45
                + focus_coverage * 0.3
                + if phrase_match { 0.15 } else { 0.0 }
                + if provenance_match { 0.1 } else { 0.0 })
            .min(1.0);
            RankedGraphitiFact {
                fact,
                score,
                matched_tokens,
                focus_matched_tokens,
                provenance_match,
            }
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

/// `isRelevantRankedGraphitiFact(candidate, minimumScore)` —
/// `retrieval.ts:177-184`.
pub fn is_relevant_ranked_graphiti_fact(
    candidate: &RankedGraphitiFact,
    minimum_score: f64,
) -> bool {
    if candidate.provenance_match {
        return true;
    }
    if candidate.focus_matched_tokens.len() >= 2 {
        return candidate.score >= minimum_score;
    }
    candidate.score >= minimum_score.max(0.45)
}

/// `Number(process.env.<key>) || fallback` of `retrieval.ts:191-202`.
fn env_count(key: &str, fallback: usize) -> usize {
    std::env::var(key)
        .ok()
        .map(|raw| crate::js::js_number_str(&raw))
        .filter(|number| number.is_finite() && *number != 0.0)
        .map(|number| number.max(0.0) as usize)
        .unwrap_or(fallback)
}

/// `searchGraphitiFactsWithRerank(groupId, input, options)` —
/// `retrieval.ts:186-216`.
pub async fn search_graphiti_facts_with_rerank(
    search: &dyn GraphitiFactSearch,
    group_id: &str,
    input: &GraphitiQueryInput,
    options: &GraphitiRerankOptions,
) -> Result<Vec<GraphitiFact>, crate::world_model::db::PgError> {
    let max_candidates = options
        .max_candidates
        .unwrap_or_else(|| env_count("GRAPHITI_SEARCH_CANDIDATES", 20))
        .clamp(5, 100);
    let max_results = options
        .max_results
        .unwrap_or_else(|| env_count("GRAPHITI_SEARCH_RESULTS", 5))
        .clamp(1, 50);
    let max_variants = options
        .max_query_variants
        .unwrap_or_else(|| env_count("GRAPHITI_QUERY_VARIANTS", 3))
        .clamp(1, 5);
    let variants = build_graphiti_query_variants(input, max_variants);
    let mut candidates: Vec<GraphitiFact> = Vec::new();
    for variant in variants {
        candidates.extend(
            search
                .search_facts(group_id, &variant, max_candidates)
                .await?,
        );
    }
    Ok(rank_graphiti_facts(input, candidates, options)
        .into_iter()
        .filter(|candidate| is_relevant_ranked_graphiti_fact(candidate, 0.3))
        .take(max_results)
        .map(|candidate| candidate.fact)
        .collect())
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
