//! Mirrors `src/server/agent-room/prompt/speaker.selector.ts`.

use std::collections::HashMap;

use crate::agent_room::types::{SpeakerSelectionParams, SwarmUnit};

/// Role-to-phase affinity weights. A role that is not listed weighs 1.
fn role_phase_weights(phase: &str) -> Option<&'static [(&'static str, u32)]> {
    let weights: &[(&str, u32)] = match phase {
        "analysis" => &[
            ("analyst", 3),
            ("researcher", 3),
            ("architect", 2),
            ("lead", 1),
        ],
        "research" => &[
            ("researcher", 4),
            ("analyst", 2),
            ("investigator", 3),
            ("lead", 1),
        ],
        "ideation" => &[
            ("creative", 3),
            ("innovator", 3),
            ("designer", 2),
            ("lead", 1),
        ],
        "critique" => &[
            ("critic", 3),
            ("reviewer", 3),
            ("quality assurance", 2),
            ("tester", 2),
            ("lead", 1),
        ],
        "best_case" => &[
            ("architect", 3),
            ("strategist", 2),
            ("lead", 2),
            ("optimizer", 2),
        ],
        "result" => &[
            ("lead", 3),
            ("orchestrator", 3),
            ("writer", 2),
            ("synthesizer", 2),
        ],
        _ => return None,
    };
    Some(weights)
}

/// `buildWeightedOrder`: each persona appears `weight` times in a row.
fn build_weighted_order(
    ordered_persona_ids: &[String],
    units: &[SwarmUnit],
    current_phase: Option<&str>,
) -> Vec<String> {
    let Some(weights) = current_phase.and_then(role_phase_weights) else {
        return ordered_persona_ids.to_vec();
    };
    let role_by_persona: HashMap<String, String> = units
        .iter()
        .map(|unit| {
            (
                unit.persona_id.trim().to_string(),
                unit.role.to_lowercase().trim().to_string(),
            )
        })
        .collect();

    let mut expanded = Vec::new();
    for persona_id in ordered_persona_ids {
        let role = role_by_persona
            .get(persona_id)
            .map_or("", |role| role.as_str());
        let weight = weights
            .iter()
            .find(|(name, _)| *name == role)
            .map_or(1, |(_, weight)| *weight);
        for _ in 0..weight {
            expanded.push(persona_id.clone());
        }
    }
    if expanded.is_empty() {
        ordered_persona_ids.to_vec()
    } else {
        expanded
    }
}

/// `chooseNextSpeakerPersonaId`. Returns an empty string when there is no speaker.
pub fn choose_next_speaker_persona_id(params: &SpeakerSelectionParams) -> String {
    let turn_count = params.turn_count.max(0) as usize;
    let lead = params.lead_persona_id.trim();
    let mut ordered: Vec<String> = Vec::new();
    if !lead.is_empty() {
        ordered.push(lead.to_string());
    }
    for unit in &params.units {
        let persona_id = unit.persona_id.trim();
        if persona_id.is_empty() || ordered.iter().any(|id| id.as_str() == persona_id) {
            continue;
        }
        ordered.push(persona_id.to_string());
    }
    if ordered.is_empty() {
        return String::new();
    }

    let weighted = build_weighted_order(&ordered, &params.units, params.current_phase.as_deref());
    weighted[turn_count % weighted.len()].clone()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn unit(persona_id: &str, role: &str) -> SwarmUnit {
        SwarmUnit {
            persona_id: persona_id.to_string(),
            role: role.to_string(),
        }
    }

    #[test]
    fn without_a_phase_the_lead_speaks_first_then_round_robin() {
        let params = SpeakerSelectionParams {
            turn_count: 0,
            lead_persona_id: "lead".to_string(),
            units: vec![unit("a", "analyst")],
            current_phase: None,
        };
        assert_eq!(choose_next_speaker_persona_id(&params), "lead");
    }

    #[test]
    fn critique_weights_the_critic_three_times() {
        let params = SpeakerSelectionParams {
            turn_count: 1,
            lead_persona_id: "l".to_string(),
            units: vec![unit("c", "Critic")],
            current_phase: Some("critique".to_string()),
        };
        // Expanded order: l, c, c, c. Turn 1 picks c.
        assert_eq!(choose_next_speaker_persona_id(&params), "c");
    }

    fn speaks(units: &[SwarmUnit], phase: Option<&str>, who: &str, turns: i64) -> usize {
        (0..turns)
            .filter(|turn| {
                choose_next_speaker_persona_id(&SpeakerSelectionParams {
                    turn_count: *turn,
                    lead_persona_id: "lead".to_string(),
                    units: units.to_vec(),
                    current_phase: phase.map(str::to_string),
                }) == who
            })
            .count()
    }

    #[test]
    fn two_personas_alternate_and_a_lone_lead_always_speaks() {
        let pick = |turn: i64, units: &[SwarmUnit]| {
            choose_next_speaker_persona_id(&SpeakerSelectionParams {
                turn_count: turn,
                lead_persona_id: "lead".to_string(),
                units: units.to_vec(),
                current_phase: None,
            })
        };
        let pair = vec![unit("lead", "lead"), unit("spec-a", "specialist")];
        assert_eq!(pick(0, &pair), "lead");
        assert_eq!(pick(1, &pair), "spec-a");
        assert_eq!(pick(2, &pair), "lead");
        assert_eq!(pick(3, &pair), "spec-a");
        assert_eq!(pick(8, &[unit("lead", "lead")]), "lead");
    }

    #[test]
    fn without_a_phase_or_with_an_unknown_one_every_persona_takes_equal_turns() {
        let units = vec![
            unit("lead", "lead"),
            unit("analyst-1", "analyst"),
            unit("creative-1", "creative"),
            unit("critic-1", "critic"),
        ];
        for phase in [None, Some("unknown_phase")] {
            for who in ["lead", "analyst-1", "creative-1", "critic-1"] {
                assert_eq!(speaks(&units, phase, who, 8), 2);
            }
        }
    }

    #[test]
    fn each_phase_gives_its_role_more_turns() {
        let units = vec![
            unit("lead", "lead"),
            unit("analyst-1", "analyst"),
            unit("creative-1", "creative"),
            unit("critic-1", "critic"),
        ];
        assert!(
            speaks(&units, Some("analysis"), "analyst-1", 20)
                > speaks(&units, Some("analysis"), "creative-1", 20)
        );
        assert!(
            speaks(&units, Some("ideation"), "creative-1", 20)
                > speaks(&units, Some("ideation"), "analyst-1", 20)
        );
        assert!(
            speaks(&units, Some("critique"), "critic-1", 20)
                > speaks(&units, Some("critique"), "analyst-1", 20)
        );
    }

    #[test]
    fn the_lead_is_boosted_in_the_result_phase() {
        let units = vec![unit("lead", "lead"), unit("spec-1", "specialist")];
        assert!(
            speaks(&units, Some("result"), "lead", 8) > speaks(&units, Some("result"), "spec-1", 8)
        );
    }
}
