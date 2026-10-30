//! Port of `src/server/knowledge/recallBudgetCalculator.ts` (1-112).
//!
//! | TypeScript                                        | Rust |
//! | ------------------------------------------------- | ---- |
//! | `recallBudgetCalculator.ts:8` (`QueryComplexity`)  | [`QueryComplexity`] |
//! | `recallBudgetCalculator.ts:10-14` (`RecallBudgetRequest`) | [`RecallBudgetRequest`] |
//! | `recallBudgetCalculator.ts:16-24` (`RecallBudget`) | [`RecallBudget`] |
//! | `recallBudgetCalculator.ts:26-33` (`BudgetPreset`) | [`BudgetPreset`] |
//! | `recallBudgetCalculator.ts:35-68` (`BUDGET_PRESETS`) | [`preset`] |
//! | `recallBudgetCalculator.ts:73-83` (`detectQueryComplexity`) | [`detect_query_complexity`] |
//! | `recallBudgetCalculator.ts:88-112` (`calculateRecallBudget`) | [`calculate_recall_budget`] |
//!
//! Dependency of `retrieval/formatters/budgetCalculator.ts:8-11`; it lives at
//! the knowledge root because that is where its TypeScript original lives.
//!
//! # Pattern transcription
//!
//! The three `detectQueryComplexity` patterns are transcribed verbatim, with
//! two mechanical changes: `/i` becomes `(?i)` and every `\b` becomes
//! `(?-u:\b)`. Both are required for equivalence — JavaScript defines `\b`/`\w`
//! through the ASCII class `[A-Za-z0-9_]`, the Rust `regex` crate defines them
//! through the Unicode `\w` by default (`memory/poisoning.rs` uses the same
//! convention). `(?:…)` non-capturing groups exist in both engines.
//!
//! `availableSourceCount` is part of the request shape but is never read by the
//! calculation (`recallBudgetCalculator.ts:88-111`); the port keeps the field so
//! the caller's object literal stays reviewable.

use std::sync::OnceLock;

use regex::Regex;

/// `QueryComplexity` from `recallBudgetCalculator.ts:8`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum QueryComplexity {
    Simple,
    Medium,
    Complex,
    Comprehensive,
}

/// `RecallBudgetRequest` from `recallBudgetCalculator.ts:10-14`.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct RecallBudgetRequest {
    pub query_complexity: QueryComplexity,
    pub entity_count: f64,
    pub available_source_count: f64,
}

/// `BudgetPreset` from `recallBudgetCalculator.ts:26-33`.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct BudgetPreset {
    pub knowledge: f64,
    pub memory: f64,
    pub chat: f64,
    pub entity_context: f64,
    pub computed_answer: f64,
    pub summary: f64,
}

/// `RecallBudget` from `recallBudgetCalculator.ts:16-24`.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct RecallBudget {
    pub total: f64,
    pub knowledge: f64,
    pub memory: f64,
    pub chat: f64,
    pub entity_context: f64,
    pub computed_answer: f64,
    pub summary: f64,
}

/// `BUDGET_PRESETS[complexity]` (`recallBudgetCalculator.ts:35-68`).
///
/// The record is total: `?? BUDGET_PRESETS.medium` (`:89`) is a lookup-miss
/// guard, which a closed enum cannot produce.
fn preset(complexity: QueryComplexity) -> BudgetPreset {
    match complexity {
        QueryComplexity::Simple => BudgetPreset {
            knowledge: 1000.0,
            memory: 800.0,
            chat: 1200.0,
            entity_context: 500.0,
            computed_answer: 300.0,
            summary: 0.0,
        },
        QueryComplexity::Medium => BudgetPreset {
            knowledge: 2500.0,
            memory: 1500.0,
            chat: 2500.0,
            entity_context: 1000.0,
            computed_answer: 500.0,
            summary: 2000.0,
        },
        QueryComplexity::Complex => BudgetPreset {
            knowledge: 3000.0,
            memory: 2000.0,
            chat: 3000.0,
            entity_context: 1500.0,
            computed_answer: 1000.0,
            summary: 2500.0,
        },
        QueryComplexity::Comprehensive => BudgetPreset {
            knowledge: 4000.0,
            memory: 3000.0,
            chat: 3000.0,
            entity_context: 3000.0,
            computed_answer: 0.0,
            summary: 5000.0,
        },
    }
}

/// The three `detectQueryComplexity` patterns in the source's test order
/// (`recallBudgetCalculator.ts:74-82`).
fn complexity_patterns() -> &'static [Regex] {
    static PATTERNS: OnceLock<Vec<Regex>> = OnceLock::new();
    PATTERNS.get_or_init(|| {
        vec![
            Regex::new(
                r"(?i)(?-u:\b)(?:was weisst du|erzaehl|zusammenfassung|alles ueber|ueberblick)(?-u:\b)",
            )
            .expect("static regex"),
            Regex::new(
                r"(?i)(?-u:\b)(?:wie (?:viele|oft|lange)|insgesamt|seit wann|vergleich)(?-u:\b)",
            )
            .expect("static regex"),
            Regex::new(
                r"(?i)(?-u:\b)(?:wann|warum|was (?:hast|haben|wurde)|letzte woche|letzten monat)(?-u:\b)",
            )
            .expect("static regex"),
        ]
    })
}

/// `detectQueryComplexity` from `recallBudgetCalculator.ts:73-83`.
pub fn detect_query_complexity(query: &str) -> QueryComplexity {
    let patterns = complexity_patterns();
    if patterns[0].is_match(query) {
        return QueryComplexity::Comprehensive;
    }
    if patterns[1].is_match(query) {
        return QueryComplexity::Complex;
    }
    if patterns[2].is_match(query) {
        return QueryComplexity::Medium;
    }
    QueryComplexity::Simple
}

/// `calculateRecallBudget` from `recallBudgetCalculator.ts:88-112`.
///
/// `Math.min(2.0, 1.0 + entityCount * 0.1)` caps the entity-context scale and
/// `Math.round` rounds it — `crate::memory::validators::js_round`, so a value
/// exactly between two integers rounds up like JavaScript, not away from zero.
pub fn calculate_recall_budget(request: &RecallBudgetRequest) -> RecallBudget {
    let preset = preset(request.query_complexity);

    let entity_scale = 2.0_f64.min(1.0 + request.entity_count * 0.1);
    let scaled_entity_context =
        crate::memory::validators::js_round(preset.entity_context * entity_scale);

    let knowledge = preset.knowledge;
    let memory = preset.memory;
    let chat = preset.chat;
    let computed_answer = preset.computed_answer;
    let summary = preset.summary;

    let total = knowledge + memory + chat + scaled_entity_context + computed_answer + summary;

    RecallBudget {
        total,
        knowledge,
        memory,
        chat,
        entity_context: scaled_entity_context,
        computed_answer,
        summary,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_complexity_detection_follows_the_source_order() {
        assert_eq!(
            detect_query_complexity("Was weisst du ueber das Projekt?"),
            QueryComplexity::Comprehensive
        );
        assert_eq!(
            detect_query_complexity("zusammenfassung bitte"),
            QueryComplexity::Comprehensive
        );
        assert_eq!(
            detect_query_complexity("Wie viele Tage war das?"),
            QueryComplexity::Complex
        );
        assert_eq!(
            detect_query_complexity("vergleich der Termine"),
            QueryComplexity::Complex
        );
        assert_eq!(
            detect_query_complexity("wann war das Treffen"),
            QueryComplexity::Medium
        );
        assert_eq!(
            detect_query_complexity("letzte woche war es ruhig"),
            QueryComplexity::Medium
        );
        assert_eq!(
            detect_query_complexity("Sauna war gut"),
            QueryComplexity::Simple
        );
        assert_eq!(detect_query_complexity(""), QueryComplexity::Simple);
    }

    #[test]
    fn a_word_boundary_inside_a_longer_word_does_not_match() {
        // JavaScript's ASCII `\b`: "ueberblickend" must not match `\bueberblick\b`.
        assert_eq!(
            detect_query_complexity("ueberblickend war es schoen"),
            QueryComplexity::Simple
        );
    }

    #[test]
    fn the_entity_scale_is_capped_at_two() {
        let simple = |entity_count: f64| RecallBudgetRequest {
            query_complexity: QueryComplexity::Simple,
            entity_count,
            available_source_count: 0.0,
        };

        let none = calculate_recall_budget(&simple(0.0));
        assert_eq!(none.entity_context, 500.0);
        assert_eq!(none.total, 1000.0 + 800.0 + 1200.0 + 500.0 + 300.0 + 0.0);

        // 1 + 3 * 0.1 = 1.3 -> round(650) = 650.
        assert_eq!(calculate_recall_budget(&simple(3.0)).entity_context, 650.0);
        // The scale saturates at 2.0, so 500 * 2 = 1000.
        assert_eq!(
            calculate_recall_budget(&simple(50.0)).entity_context,
            1000.0
        );
        // A fractional scale rounds like JavaScript: 1 + 1*0.1 = 1.1 -> 550.
        assert_eq!(calculate_recall_budget(&simple(1.0)).entity_context, 550.0);
    }

    #[test]
    fn the_presets_are_the_numbers_of_the_source_table() {
        let comprehensive = preset(QueryComplexity::Comprehensive);
        assert_eq!(comprehensive.knowledge, 4000.0);
        assert_eq!(comprehensive.computed_answer, 0.0);
        assert_eq!(preset(QueryComplexity::Medium).summary, 2000.0);
        assert_eq!(preset(QueryComplexity::Simple).memory, 800.0);
    }
}
