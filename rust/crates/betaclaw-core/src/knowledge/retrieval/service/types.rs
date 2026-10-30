//! Port of `src/server/knowledge/retrieval/service/types.ts` (1-6).
//!
//! | TypeScript                                    | Rust |
//! | --------------------------------------------- | ---- |
//! | `service/types.ts:3-6` (`RuleEvidenceEntry`)   | [`RuleEvidenceEntry`] |

use crate::knowledge::retrieval::formatters::evidence_builder::EvidenceSourceRef;

/// `RuleEvidenceEntry` from `service/types.ts:3-6`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RuleEvidenceEntry {
    pub text: String,
    pub refs: Vec<EvidenceSourceRef>,
}
