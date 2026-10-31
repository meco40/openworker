//! Port of `src/server/channels/messages/service/recall/types.ts`.

/// `source` of a [`StrictRecallCandidate`] (`types.ts:6`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CandidateSource {
    Chat,
    Memory,
}

impl CandidateSource {
    pub fn as_str(self) -> &'static str {
        match self {
            CandidateSource::Chat => "chat",
            CandidateSource::Memory => "memory",
        }
    }
}

/// `StrictRecallCandidate` (`types.ts:5-14`).
#[derive(Debug, Clone, PartialEq)]
pub struct StrictRecallCandidate {
    pub source: CandidateSource,
    /// `user`, `agent` or `system` for chat rows, `memory` for Mem0 rows. Chat
    /// rows keep the stored value, which the database does not restrict.
    pub role: String,
    pub text: String,
    pub created_at: Option<String>,
    pub normalized: String,
    pub topic_hits: usize,
    pub time_hits: usize,
    pub score: f64,
}
