//! Mirrors `agent-room/services/turnCompletion.service.ts` without runtime effects.
use super::{
    agent_session::{get_agent_session_entry, update_phase_buffer_sessions},
    conflict_radar::derive_conflict_radar,
    swarm_artifact::{build_artifact_with_new_turn, clamp_consensus_score, push_artifact_snapshot},
};
use crate::agent_room::prompt::{
    phase_service::{
        compute_next_phase_after_turn, get_simple_swarm_max_turns,
        should_complete_swarm_after_turn_with_turn_count,
    },
    text_utils::{
        count_structured_turns, strip_leading_speaker_prefix, strip_trailing_other_speaker_turns,
    },
    turn_parser::parse_turn_directives,
};
use crate::agent_room::{
    swarm_phases::{ResolvedSwarmUnit, SwarmPhase},
    types::{AgentSession, FrictionLevel},
};
use crate::messages_store::{
    AgentRoomSwarmPatch, AgentRoomSwarmPhase, AgentRoomSwarmRecord, AgentRoomSwarmStatus,
    PhaseBufferEntry, SwarmFriction,
};
use serde_json::Value;

pub fn find_completion_event<'a>(events: &'a [Value], command: &str) -> Option<&'a Value> {
    events.iter().find(|event| {
        event["commandId"].as_str() == Some(command)
            && matches!(
                event["type"].as_str(),
                Some("agent.v2.command.completed" | "agent.v2.error")
            )
    })
}
pub fn extract_completed_text(event: &Value) -> &str {
    let payload = &event["payload"];
    [
        &payload["result"]["message"],
        &payload["result"]["content"],
        &payload["text"],
        &payload["content"],
        &payload["message"],
    ]
    .into_iter()
    .find_map(Value::as_str)
    .unwrap_or("")
}
pub fn completion_patch(
    swarm: &AgentRoomSwarmRecord,
    event: &Value,
    new_seq: i64,
    units: &[ResolvedSwarmUnit],
    speaker_id: &str,
    now: &str,
) -> AgentRoomSwarmPatch {
    if event["type"] == "agent.v2.error" {
        return AgentRoomSwarmPatch {
            current_deploy_command_id: Some(None),
            status: Some(AgentRoomSwarmStatus::Error),
            hold_flag: Some(true),
            last_seq: Some(new_seq),
            phase_buffer: Some(
                swarm
                    .phase_buffer
                    .iter()
                    .filter(|e| matches!(e, PhaseBufferEntry::AgentSession { .. }))
                    .cloned()
                    .collect(),
            ),
            ..Default::default()
        };
    }
    let phase = SwarmPhase::parse(swarm.current_phase.as_str()).unwrap_or(SwarmPhase::Analysis);
    let speaker = units
        .iter()
        .find(|u| u.persona_id == speaker_id)
        .or_else(|| units.iter().find(|u| u.persona_id == swarm.lead_persona_id))
        .or(units.first());
    let name = speaker.map_or("Agent", |s| s.name.as_str());
    let raw = extract_completed_text(event);
    let parsed = parse_turn_directives(raw, phase);
    let normalized = strip_leading_speaker_prefix(
        if parsed.clean_text.is_empty() {
            raw
        } else {
            &parsed.clean_text
        },
        name,
    );
    let bounded = strip_trailing_other_speaker_turns(
        if normalized.is_empty() {
            raw
        } else {
            &normalized
        },
        name,
        &units.iter().map(|u| u.name.clone()).collect::<Vec<_>>(),
    );
    let text = if !bounded.is_empty() {
        &bounded
    } else if !normalized.is_empty() {
        &normalized
    } else {
        "(no content)"
    };
    let line = format!("**[{name}]:** {text}");
    let after = if swarm.artifact.is_empty() {
        line.clone()
    } else {
        format!("{}\n\n{line}", swarm.artifact)
    };
    let advance = compute_next_phase_after_turn(phase, &after, units.len());
    let complete = advance.swarm_complete
        || should_complete_swarm_after_turn_with_turn_count(
            count_structured_turns(&after) as i64,
            get_simple_swarm_max_turns(),
        );
    let next = if complete { phase } else { advance.next_phase };
    let artifact = build_artifact_with_new_turn(
        &swarm.artifact,
        &line,
        phase,
        advance.phase_complete && !complete,
        next,
    );
    let friction = derive_conflict_radar(&artifact, now);
    let mut buffer = match get_agent_session_entry(
        &swarm.phase_buffer,
        speaker.map_or("", |s| s.persona_id.as_str()),
    ) {
        Some(entry) => update_phase_buffer_sessions(
            &swarm
                .phase_buffer
                .iter()
                .filter(|e| !matches!(e, PhaseBufferEntry::Speaker { .. }))
                .cloned()
                .collect::<Vec<_>>(),
            &AgentSession {
                last_seq: new_seq,
                ..entry
            },
        ),
        None => swarm
            .phase_buffer
            .iter()
            .filter(|e| matches!(e, PhaseBufferEntry::AgentSession { .. }))
            .cloned()
            .collect(),
    };
    if advance.phase_complete && !complete {
        buffer.push(PhaseBufferEntry::PhaseSummaryPending {
            from_phase: phase.as_str().into(),
        });
    }
    let pause = advance.phase_complete && !complete && swarm.pause_between_phases;
    AgentRoomSwarmPatch {
        current_deploy_command_id: Some(None),
        artifact_history: Some(push_artifact_snapshot(&swarm.artifact_history, &artifact)),
        artifact: Some(artifact),
        friction: Some(SwarmFriction {
            level: match friction.level {
                FrictionLevel::Low => "low",
                FrictionLevel::Medium => "medium",
                FrictionLevel::High => "high",
            }
            .into(),
            confidence: f64::from(friction.confidence),
            hold: friction.hold,
            reasons: friction.reasons,
            updated_at: friction.updated_at,
        }),
        consensus_score: Some(if advance.phase_complete && !complete {
            50
        } else {
            i64::from(clamp_consensus_score(
                (swarm.consensus_score + i64::from(parsed.consensus_delta)) as f64,
            ))
        }),
        current_phase: Some(AgentRoomSwarmPhase::parse_or_analysis(next.as_str())),
        hold_flag: Some(pause),
        status: Some(if complete {
            AgentRoomSwarmStatus::Completed
        } else if pause {
            AgentRoomSwarmStatus::Hold
        } else {
            AgentRoomSwarmStatus::Running
        }),
        last_seq: Some(new_seq),
        phase_buffer: Some(buffer),
        ..Default::default()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    #[test]
    fn completion_selection_ignores_other_commands_and_extracts_nested_result() {
        let events = vec![
            json!({"commandId":"other","type":"agent.v2.command.completed"}),
            json!({"commandId":"c","type":"agent.v2.command.completed","payload":{"result":{"message":"done"}}}),
        ];
        assert_eq!(
            extract_completed_text(find_completion_event(&events, "c").unwrap()),
            "done"
        );
        assert!(find_completion_event(&events, "missing").is_none());
    }

    #[test]
    fn the_lookup_takes_the_first_terminal_event_of_the_command() {
        assert!(find_completion_event(&[], "c").is_none());
        let deltas = vec![
            json!({"commandId":"c","type":"agent.v2.model.delta","seq":1}),
            json!({"commandId":"c","type":"agent.v2.tool.started","seq":2}),
        ];
        assert!(find_completion_event(&deltas, "c").is_none());
        let error = vec![json!({"commandId":"c","type":"agent.v2.error","seq":1})];
        assert_eq!(
            find_completion_event(&error, "c").unwrap()["type"],
            "agent.v2.error"
        );
        let mixed = vec![
            json!({"commandId":"c","type":"agent.v2.model.delta","seq":1}),
            json!({"commandId":"c","type":"agent.v2.command.completed","seq":2}),
            json!({"commandId":"c","type":"agent.v2.error","seq":3}),
        ];
        assert_eq!(find_completion_event(&mixed, "c").unwrap()["seq"], 2);
        let skipping = vec![
            json!({"commandId":"other","type":"agent.v2.command.completed","seq":1}),
            json!({"commandId":"c","type":"agent.v2.model.delta","seq":2}),
            json!({"commandId":"c","type":"agent.v2.command.completed","seq":3}),
        ];
        assert_eq!(find_completion_event(&skipping, "c").unwrap()["seq"], 3);
    }

    #[test]
    fn the_completed_text_comes_from_the_first_known_field() {
        let content = json!({"payload":{"result":{"content":"Generated content."}}});
        assert_eq!(extract_completed_text(&content), "Generated content.");
        let both =
            json!({"payload":{"result":{"message":"From message.","content":"From content."}}});
        assert_eq!(extract_completed_text(&both), "From message.");
        assert_eq!(
            extract_completed_text(&json!({"payload":{"text":"Fallback text."}})),
            "Fallback text."
        );
        assert_eq!(
            extract_completed_text(&json!({"payload":{"content":"Content fallback."}})),
            "Content fallback."
        );
        assert_eq!(
            extract_completed_text(&json!({"payload":{"message":"Message fallback."}})),
            "Message fallback."
        );
    }

    #[test]
    fn no_known_text_field_gives_an_empty_string() {
        assert_eq!(
            extract_completed_text(&json!({"payload":{"foo":"bar"}})),
            ""
        );
        assert_eq!(extract_completed_text(&json!({"payload":{}})), "");
        assert_eq!(
            extract_completed_text(&json!({"payload":{"result":"string-result"}})),
            ""
        );
    }
}
