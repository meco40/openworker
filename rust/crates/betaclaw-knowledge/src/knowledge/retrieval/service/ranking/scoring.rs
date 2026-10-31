//! Port of `src/server/knowledge/retrieval/service/ranking/scoring.ts` (1-6)
//! — re-exports of the scoring functions.

pub use crate::knowledge::retrieval::ranking::scoring::{
    compute_token_overlap_score, detect_emotional_tone_in_text,
};
