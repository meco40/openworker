//! Port of `src/server/master/delegation/sessionTypes.ts:1-18`.
//!
//! The two shapes `sessionService.ts` reads and writes. Both hold the record
//! types of [`crate::master::types`] verbatim.

use crate::master::types::{MasterDelegationEvent, MasterDelegationJob, MasterSubagentSession};

/// `SubagentSessionDetail` from `sessionTypes.ts:5-9`.
#[derive(Debug, Clone, PartialEq)]
pub struct SubagentSessionDetail {
    pub session: MasterSubagentSession,
    pub job: Option<MasterDelegationJob>,
    pub events: Vec<MasterDelegationEvent>,
}

/// `ClaimSubagentSessionInput` from `sessionTypes.ts:11-16`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ClaimSubagentSessionInput {
    pub owner_id: String,
    /// `now?: string` — absent means `nowIso()`.
    pub now: Option<String>,
    pub lease_ms: Option<i64>,
    /// `runId?: string` — only `claimNextSubagentSession` reads it.
    pub run_id: Option<String>,
}
