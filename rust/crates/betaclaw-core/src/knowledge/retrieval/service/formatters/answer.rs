//! Port of `src/server/knowledge/retrieval/service/formatters/answer.ts` (1-6)
//! — re-exports of the answer drafting helpers.

pub use crate::knowledge::retrieval::formatters::answer_draft_builder::{
    build_answer_draft, extract_counterpart_and_lists, filter_lists_for_rules_intent,
};
