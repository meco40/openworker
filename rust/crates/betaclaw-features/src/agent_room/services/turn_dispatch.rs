//! Mirrors `agent-room/services/turnDispatch.service.ts`; effects use the existing session port.
use crate::agent_room::prompt::{
    speaker_selector::choose_next_speaker_persona_id,
    text_utils::{
        count_structured_turns, count_turns_in_current_phase, extract_recent_turn_history,
    },
    turn_prompt::build_simple_turn_prompt,
};
use crate::agent_room::{
    swarm_phases::{ResolvedSwarmUnit, SwarmPhase},
    types::{SpeakerSelectionParams, TurnPromptParams},
};
use crate::messages_store::{AgentRoomSwarmRecord, PhaseBufferEntry};

pub struct TurnPlan {
    pub speaker_id: String,
    pub prompt: String,
    pub turn_count: i64,
}

pub fn plan_turn(swarm: &AgentRoomSwarmRecord, units: &[ResolvedSwarmUnit]) -> Option<TurnPlan> {
    let count = count_structured_turns(&swarm.artifact) as i64;
    let phase = SwarmPhase::parse(swarm.current_phase.as_str()).unwrap_or(SwarmPhase::Analysis);
    let summary = swarm.phase_buffer.iter().find_map(|entry| match entry {
        PhaseBufferEntry::PhaseSummaryPending { from_phase } => Some(from_phase),
        _ => None,
    });
    let override_id = swarm.phase_buffer.iter().find_map(|entry| match entry {
        PhaseBufferEntry::SpeakerOverride { persona_id } => Some(persona_id.clone()),
        _ => None,
    });
    let speaker_id = if summary.is_some() {
        swarm.lead_persona_id.clone()
    } else {
        override_id.unwrap_or_else(|| {
            choose_next_speaker_persona_id(&SpeakerSelectionParams {
                turn_count: count,
                lead_persona_id: swarm.lead_persona_id.clone(),
                units: swarm.units.clone(),
                current_phase: Some(phase.as_str().into()),
            })
        })
    };
    let speaker = units
        .iter()
        .find(|u| u.persona_id == speaker_id)
        .or_else(|| units.iter().find(|u| u.persona_id == swarm.lead_persona_id))
        .or(units.first())?;
    let recent = extract_recent_turn_history(&swarm.artifact, 8);
    let rounds = phase.rounds();
    let round = (count_turns_in_current_phase(&swarm.artifact) / units.len().max(1) + 1)
        .max(1)
        .min(rounds as usize) as u32;
    let prompt = if let Some(from) = summary {
        let label = SwarmPhase::parse(from)
            .unwrap_or(SwarmPhase::Analysis)
            .label();
        format!("You are the lead agent for \"{}\".\nThe \"{label}\" phase has just concluded.\n\nProvide a concise synthesis of the key findings, decisions, and outcomes from this phase.\nFocus on:\n- Main conclusions reached\n- Points of agreement and disagreement\n- Key insights that should inform the next phase\n\nRecent discussion:\n{}", swarm.title, if recent.is_empty() { "(no prior turns)" } else { &recent })
    } else {
        build_simple_turn_prompt(&TurnPromptParams {
            swarm_title: swarm.title.clone(),
            task: swarm.task.clone(),
            phase,
            speaker: speaker.clone(),
            lead_persona_id: swarm.lead_persona_id.clone(),
            recent_history: recent,
            units: units.to_vec(),
            phase_round: Some(round),
            phase_rounds_total: Some(rounds),
        })
    };
    Some(TurnPlan {
        speaker_id: speaker.persona_id.clone(),
        prompt,
        turn_count: count,
    })
}
