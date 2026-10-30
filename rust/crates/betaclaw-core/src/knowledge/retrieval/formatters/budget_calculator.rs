//! Port of `src/server/knowledge/retrieval/formatters/budgetCalculator.ts` (1-91).
//!
//! | TypeScript                                            | Rust |
//! | ----------------------------------------------------- | ---- |
//! | `formatters/budgetCalculator.ts:14-20` (`BudgetContext`) | [`BudgetContext`] |
//! | `formatters/budgetCalculator.ts:22-28` (`BudgetResult`)  | [`BudgetResult`] |
//! | `formatters/budgetCalculator.ts:30-91` (`calculateAndApplyBudget`) | [`calculate_and_apply_budget`] |
//!
//! # Deviations
//!
//! 1. **`stageStats` is a `BTreeMap<String, f64>`.** The TypeScript reads it as
//!    `stageStats.ledger + stageStats.episodes + stageStats.semantic`; the port
//!    reads the three keys with a `0.0` default, which is the `undefined` sum
//!    the source never produces.
//! 2. **`Math.round` is [`crate::js::js_round`]** and `Math.min`/`Math.max` are
//!    Rust's `f64::min`/`f64::max` on the same operands, so the budget
//!    arithmetic is bit-identical to the TypeScript.

use std::collections::BTreeMap;

use crate::js::js_round;
use crate::knowledge::answer_safety_policy::{
    assess_answer_safety, build_safety_instruction, EvidenceAssessment,
};
use crate::knowledge::recall_budget_calculator::{
    calculate_recall_budget, detect_query_complexity, RecallBudgetRequest,
};
use crate::knowledge::retrieval::types::KnowledgeRetrievalSections;
use crate::knowledge::token_budget::{
    enforce_section_budgets, estimate_token_count, trim_to_token_budget, SectionWeights,
};

/// `BudgetContext` from `formatters/budgetCalculator.ts:14-20`.
#[derive(Debug, Clone, PartialEq)]
pub struct BudgetContext {
    pub query: String,
    pub counterpart_aliases_length: f64,
    pub stage_stats: BTreeMap<String, f64>,
    pub computed_answer_text: Option<String>,
    pub max_context_tokens: f64,
}

/// `BudgetResult` from `formatters/budgetCalculator.ts:22-28`.
#[derive(Debug, Clone, PartialEq)]
pub struct BudgetResult {
    pub effective_max_tokens: f64,
    pub budgeted_sections: KnowledgeRetrievalSections,
    pub safety_instruction: Option<String>,
    pub context: String,
    pub token_count: f64,
}

fn stage(stats: &BTreeMap<String, f64>, key: &str) -> f64 {
    stats.get(key).copied().unwrap_or(0.0)
}

/// `calculateAndApplyBudget` from `formatters/budgetCalculator.ts:30-91`.
pub fn calculate_and_apply_budget(
    raw_sections: &KnowledgeRetrievalSections,
    context: &BudgetContext,
) -> BudgetResult {
    let ledger = stage(&context.stage_stats, "ledger");
    let episodes = stage(&context.stage_stats, "episodes");
    let semantic = stage(&context.stage_stats, "semantic");

    let query_complexity = detect_query_complexity(&context.query);
    let recall_budget = calculate_recall_budget(&RecallBudgetRequest {
        query_complexity,
        entity_count: context.counterpart_aliases_length,
        available_source_count: ledger + episodes + semantic,
    });

    let dynamic_tokens = js_round(recall_budget.total / 4.0);
    let effective_max_tokens =
        (context.max_context_tokens * 3.0).min(context.max_context_tokens.max(dynamic_tokens));

    let budgeted_sections = enforce_section_budgets(
        raw_sections,
        effective_max_tokens,
        &SectionWeights {
            answer_draft: 0.4,
            key_decisions: 0.25,
            open_points: 0.15,
            evidence: 0.2,
        },
    );

    let evidence_assessment = EvidenceAssessment {
        total_sources: ledger + episodes + semantic,
        avg_confidence: if ledger + episodes > 0.0 {
            0.7
        } else if semantic > 0.0 {
            0.5
        } else {
            0.0
        },
        has_computed_answer: context.computed_answer_text.is_some(),
        has_contradiction: false,
    };
    let safety_level = assess_answer_safety(&evidence_assessment);
    let safety_instruction = build_safety_instruction(safety_level);

    let mut parts: Vec<String> = Vec::new();
    if let Some(instruction) = &safety_instruction {
        parts.push(instruction.clone());
    }
    parts.push(format!("AnswerDraft:\n{}", budgeted_sections.answer_draft));
    parts.push(format!(
        "KeyDecisions:\n{}",
        budgeted_sections.key_decisions
    ));
    parts.push(format!("OpenPoints:\n{}", budgeted_sections.open_points));
    parts.push(format!("Evidence:\n{}", budgeted_sections.evidence));
    let mut full_context = parts.join("\n\n");

    if estimate_token_count(&full_context) > effective_max_tokens {
        full_context = trim_to_token_budget(&full_context, effective_max_tokens);
    }

    let token_count = estimate_token_count(&full_context);

    BudgetResult {
        effective_max_tokens,
        budgeted_sections,
        safety_instruction,
        context: full_context,
        token_count,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn context(max_context_tokens: f64, stage_stats: BTreeMap<String, f64>) -> BudgetContext {
        BudgetContext {
            query: "Sauna war gut".to_string(),
            counterpart_aliases_length: 0.0,
            stage_stats,
            computed_answer_text: None,
            max_context_tokens,
        }
    }

    #[test]
    fn a_small_dynamic_budget_keeps_the_configured_maximum() {
        let mut stats = BTreeMap::new();
        stats.insert("ledger".to_string(), 1.0);
        let sections = KnowledgeRetrievalSections {
            answer_draft: "kurz".to_string(),
            ..KnowledgeRetrievalSections::default()
        };
        let result = calculate_and_apply_budget(&sections, &context(1200.0, stats));
        assert_eq!(result.effective_max_tokens, 1200.0);
        assert_eq!(result.budgeted_sections.answer_draft, "kurz");
        assert!(result
            .safety_instruction
            .as_deref()
            .is_some_and(|text| text.contains("moderat")));
        assert!(result.context.contains("AnswerDraft:\nkurz"));
    }

    #[test]
    fn no_sources_select_the_decline_instruction() {
        let result = calculate_and_apply_budget(
            &KnowledgeRetrievalSections::default(),
            &context(1200.0, BTreeMap::new()),
        );
        assert!(result
            .safety_instruction
            .as_deref()
            .is_some_and(|text| text.contains("keine zuverlaessige Erinnerung")));
        assert_eq!(result.token_count, estimate_token_count(&result.context));
    }
}
