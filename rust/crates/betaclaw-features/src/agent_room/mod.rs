//! Port of `src/server/agent-room/` (S12b, pure part): swarm phases, turn prompts,
//! speaker selection, turn directives, conflict radar and artifact helpers.
//!
//! Orchestration planning lives here; the gateway owns timers and Agent-v2 effects.
//! `swarm_phases` mirrors `src/shared/domain/swarmPhases.ts`.

pub mod orchestrator;
pub mod prompt;
pub mod services;
pub mod swarm_phases;
pub mod types;
