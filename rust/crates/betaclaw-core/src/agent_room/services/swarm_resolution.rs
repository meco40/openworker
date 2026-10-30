//! Mirrors `agent-room/services/swarmResolution.service.ts`.
use crate::agent_room::swarm_phases::ResolvedSwarmUnit;
use crate::messages_store::{AgentRoomSwarmRecord, PhaseBufferEntry};
use std::collections::HashSet;

pub fn resolve_swarm_units(
    swarm: &AgentRoomSwarmRecord,
    mut persona: impl FnMut(&str) -> Option<(String, String)>,
) -> Vec<ResolvedSwarmUnit> {
    let mut seen = HashSet::new();
    let mut units = Vec::new();
    for unit in &swarm.units {
        let id = unit.persona_id.trim();
        if id.is_empty() || !seen.insert(id.to_string()) {
            continue;
        }
        let (name, emoji) = persona(id).unwrap_or_else(|| (id.to_string(), "🤖".into()));
        units.push(ResolvedSwarmUnit {
            persona_id: id.to_string(),
            role: unit.role.clone(),
            name,
            emoji,
        });
    }
    if !seen.contains(&swarm.lead_persona_id) {
        let (name, emoji) = persona(&swarm.lead_persona_id)
            .unwrap_or_else(|| (swarm.lead_persona_id.clone(), "🤖".into()));
        units.insert(
            0,
            ResolvedSwarmUnit {
                persona_id: swarm.lead_persona_id.clone(),
                role: "Orchestrator".into(),
                name,
                emoji,
            },
        );
    }
    units
}

pub fn resolve_speaker_persona_id(
    swarm: &AgentRoomSwarmRecord,
    conversation_persona: Option<&str>,
) -> String {
    swarm
        .phase_buffer
        .iter()
        .find_map(|entry| match entry {
            PhaseBufferEntry::Speaker { persona_id } => Some(persona_id.clone()),
            _ => None,
        })
        .or_else(|| conversation_persona.map(str::to_string))
        .unwrap_or_else(|| swarm.lead_persona_id.clone())
}
