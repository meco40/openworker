//! Port of `src/server/knowledge/retrieval/service/formatters/index.ts` (1-13)
//! — the formatter barrel.
//!
//! | Rust | TypeScript |
//! | --- | --- |
//! | [`answer`] | `service/formatters/answer.ts` |
//! | [`context`] | `service/formatters/context.ts` |
//! | [`evidence`] | `service/formatters/evidence.ts` |

pub mod answer;
pub mod context;
pub mod evidence;

pub use answer::*;
pub use context::*;
pub use evidence::*;

// Re-export display utils (index.ts:7-10).
pub use crate::knowledge::retrieval::formatters::display_utils::{
    is_counterpart_match, select_conversation_id,
};
// Re-export budget calculator (index.ts:13).
pub use crate::knowledge::retrieval::formatters::budget_calculator::calculate_and_apply_budget;
