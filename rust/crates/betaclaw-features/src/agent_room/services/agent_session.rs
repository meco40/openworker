//! Mirrors `src/server/agent-room/services/agentSession.service.ts`.

use crate::agent_room::types::{AgentSession, PhaseBufferEntry};

fn session_entry(session: &AgentSession) -> PhaseBufferEntry {
    PhaseBufferEntry::AgentSession {
        persona_id: session.persona_id.clone(),
        session_id: session.session_id.clone(),
        last_seq: session.last_seq,
    }
}

/// `parseAgentSessions`
pub fn parse_agent_sessions(phase_buffer: &[PhaseBufferEntry]) -> Vec<AgentSession> {
    phase_buffer
        .iter()
        .filter_map(|entry| match entry {
            PhaseBufferEntry::AgentSession {
                persona_id,
                session_id,
                last_seq,
            } => Some(AgentSession {
                persona_id: persona_id.clone(),
                session_id: session_id.clone(),
                last_seq: *last_seq,
            }),
            _ => None,
        })
        .collect()
}

/// `getAgentSessionEntry`
pub fn get_agent_session_entry(
    phase_buffer: &[PhaseBufferEntry],
    persona_id: &str,
) -> Option<AgentSession> {
    parse_agent_sessions(phase_buffer)
        .into_iter()
        .find(|session| session.persona_id == persona_id)
}

/// `updatePhaseBufferSessions`: replaces every session entry of the persona, or
/// appends one when there is none.
pub fn update_phase_buffer_sessions(
    phase_buffer: &[PhaseBufferEntry],
    updated: &AgentSession,
) -> Vec<PhaseBufferEntry> {
    let mut found = false;
    let mut result: Vec<PhaseBufferEntry> = phase_buffer
        .iter()
        .map(|entry| match entry {
            PhaseBufferEntry::AgentSession { persona_id, .. }
                if *persona_id == updated.persona_id =>
            {
                found = true;
                session_entry(updated)
            }
            other => other.clone(),
        })
        .collect();
    if !found {
        result.push(session_entry(updated));
    }
    result
}

/// `extractSpeakerFromPhaseBuffer`
pub fn extract_speaker_from_phase_buffer(
    phase_buffer: Option<&[PhaseBufferEntry]>,
) -> Option<String> {
    phase_buffer?.iter().find_map(|entry| match entry {
        PhaseBufferEntry::Speaker { persona_id } => Some(persona_id.clone()),
        _ => None,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn updating_a_session_replaces_its_entry_in_place() {
        let buffer = vec![
            PhaseBufferEntry::AgentSession {
                persona_id: "p1".to_string(),
                session_id: "s1".to_string(),
                last_seq: 1,
            },
            PhaseBufferEntry::Speaker {
                persona_id: "p1".to_string(),
            },
        ];
        let updated = AgentSession {
            persona_id: "p1".to_string(),
            session_id: "s2".to_string(),
            last_seq: 5,
        };
        let result = update_phase_buffer_sessions(&buffer, &updated);
        assert_eq!(result.len(), 2);
        assert_eq!(get_agent_session_entry(&result, "p1"), Some(updated));
        assert_eq!(
            extract_speaker_from_phase_buffer(Some(&result)),
            Some("p1".to_string())
        );
    }
}
