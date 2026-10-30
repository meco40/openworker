//! Port of `src/server/knowledge/retrieval/formatters/` — the section builders.
//!
//! The TypeScript directory has no `index.ts`, so this `mod.rs` only declares
//! the five files; `retrieval/index.ts:36-52` and
//! `service/formatters/*` are mirrored by the re-exports in [`super`] and in
//! [`crate::knowledge::retrieval::service::formatters`].
//!
//! | Rust | TypeScript |
//! | --- | --- |
//! | [`answer_draft_builder`] | `formatters/answerDraftBuilder.ts` |
//! | [`budget_calculator`] | `formatters/budgetCalculator.ts` |
//! | [`context_formatter`] | `formatters/contextFormatter.ts` |
//! | [`display_utils`] | `formatters/displayUtils.ts` |
//! | [`evidence_builder`] | `formatters/evidenceBuilder.ts` |

pub mod answer_draft_builder;
pub mod budget_calculator;
pub mod context_formatter;
pub mod display_utils;
pub mod evidence_builder;
