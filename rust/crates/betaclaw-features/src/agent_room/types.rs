//! Mirrors `src/server/agent-room/types/index.ts`, which re-exports the canonical
//! types of `src/shared/domain/agentRoom.types.ts`. Only the types used by the pure
//! Agent Room modules are ported. Swarm status and vote types belong to the S8
//! dispatch and the frontend contract.

use serde::{Deserialize, Serialize};

use super::swarm_phases::{ResolvedSwarmUnit, SwarmPhase};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum FrictionLevel {
    Low,
    Medium,
    High,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SwarmFriction {
    pub level: FrictionLevel,
    pub confidence: u32,
    pub hold: bool,
    pub reasons: Vec<String>,
    pub updated_at: String,
}

pub use crate::messages_store::types::{PhaseBufferEntry, SwarmUnit};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentSession {
    pub persona_id: String,
    pub session_id: String,
    pub last_seq: i64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TurnDirectiveResult {
    pub clean_text: String,
    pub consensus_delta: i32,
    pub next_phase: SwarmPhase,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct PhaseAdvanceResult {
    pub next_phase: SwarmPhase,
    pub phase_complete: bool,
    pub swarm_complete: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SpeakerSelectionParams {
    pub turn_count: i64,
    pub lead_persona_id: String,
    pub units: Vec<SwarmUnit>,
    /// Enables role-based weighting per phase. Kept as text, like the TypeScript
    /// side, so an unknown phase name falls back to round-robin.
    pub current_phase: Option<String>,
}

/// `TurnPromptParams`. `searchEnabled` is left out: the simple turn prompt never
/// reads it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TurnPromptParams {
    pub swarm_title: String,
    pub task: String,
    pub phase: SwarmPhase,
    pub speaker: ResolvedSwarmUnit,
    pub lead_persona_id: String,
    pub recent_history: String,
    pub units: Vec<ResolvedSwarmUnit>,
    pub phase_round: Option<u32>,
    pub phase_rounds_total: Option<u32>,
}
