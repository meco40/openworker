//! Mirrors the pure planning/completion services of `src/server/agent-room/services/`.
//! Runtime effects use the gateway Agent-v2 ports. The optional LLM-friction helper
//! has no orchestrator caller in TypeScript; completion uses the shared conflict radar.

pub mod agent_session;
pub mod conflict_radar;
pub mod swarm_artifact;
pub mod swarm_resolution;
pub mod turn_completion;
pub mod turn_dispatch;
