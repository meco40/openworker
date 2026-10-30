//! Port of `src/server/channels/messages/service/recall/evidence/index.ts`.

pub mod build;
pub mod format;

pub use build::{build_strict_evidence_reply, EvidenceReply};
pub use format::{
    build_high_confidence_response, build_low_confidence_response, format_evidence_lines,
    EvidenceConfidence,
};
