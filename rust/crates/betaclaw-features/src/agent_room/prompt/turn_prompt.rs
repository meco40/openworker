//! Mirrors `src/server/agent-room/prompt/turnPrompt.builder.ts`.

use crate::agent_room::swarm_phases::SwarmPhase;
use crate::agent_room::types::TurnPromptParams;

/// `buildPhaseGuidance`
pub fn build_phase_guidance(phase: SwarmPhase, round: u32) -> &'static str {
    match phase {
        SwarmPhase::Analysis => {
            "Identify key assumptions, risks, constraints, and open questions about the task."
        }
        SwarmPhase::Research => {
            "Research factual evidence from external sources. Use web search to collect up-to-date references and cite concrete URLs."
        }
        SwarmPhase::Ideation if round == 1 => {
            "Propose your concrete solution approach with clear trade-offs. Be creative and specific."
        }
        SwarmPhase::Ideation => {
            "Respond to the other participant's ideas. Build on strengths, challenge weaknesses, and refine the approach together."
        }
        SwarmPhase::Critique if round == 1 => {
            "Critically examine the proposed ideas. Find weaknesses, gaps, and contradictions."
        }
        SwarmPhase::Critique if round == 2 => {
            "Respond to the first round of critique. Defend, refine, or withdraw ideas based on the feedback."
        }
        SwarmPhase::Critique => {
            "Final critique round. Converge on the strongest approach. Identify remaining risks."
        }
        SwarmPhase::BestCase => {
            "Agree on the single best solution with clear justification. Resolve any remaining disagreements."
        }
        SwarmPhase::Result => {
            "Deliver the final, actionable result with a concise rationale and a summary diagram."
        }
    }
}

/// `buildSimpleTurnPrompt`. The prompt is English, as the TypeScript side sends it.
pub fn build_simple_turn_prompt(params: &TurnPromptParams) -> String {
    let participants = params
        .units
        .iter()
        .map(|unit| format!("- {} ({})", unit.name, unit.role))
        .collect::<Vec<_>>()
        .join("\n");
    let round_info = match (params.phase_round, params.phase_rounds_total) {
        (Some(round), Some(total)) if round != 0 && total > 1 => {
            format!(" (Round {round} of {total})")
        }
        _ => String::new(),
    };
    let guidance = build_phase_guidance(params.phase, params.phase_round.unwrap_or(1));
    let speaker = &params.speaker;

    let lines = [
        format!(
            "You are {} ({}) in a multi-persona swarm.",
            speaker.name, speaker.role
        ),
        format!("ROOM: {}", params.swarm_title),
        format!("GOAL: {}", params.task),
        format!("PHASE: {}{round_info}", params.phase.label()),
        format!("PARTICIPANTS:\n{participants}"),
        if params.recent_history.is_empty() {
            String::new()
        } else {
            format!("RECENT CONVERSATION:\n{}", params.recent_history)
        },
        if guidance.is_empty() {
            String::new()
        } else {
            format!("PHASE GUIDANCE: {guidance}")
        },
        "RULES:".to_string(),
        format!("1) Start exactly with **[{}]:**", speaker.name),
        format!("2) Speak only as {}.", speaker.name),
        "3) Respond directly to what the other participants said — this is a live discussion."
            .to_string(),
        "4) Keep it concise and concrete.".to_string(),
        "5) Do not output another participant label (for example **[Other Agent]:**).".to_string(),
        "6) Do not change phase — phases are managed automatically.".to_string(),
        if params.phase == SwarmPhase::Research {
            "7) In this phase, actively use the \"web_search\" tool for internet research and include source URLs in your answer.".to_string()
        } else {
            String::new()
        },
        if params.phase == SwarmPhase::Result {
            "8) Include a mermaid code block summarizing the final decision as a diagram."
                .to_string()
        } else {
            "8) If useful, include a mermaid code block for flow/architecture.".to_string()
        },
    ];
    lines
        .into_iter()
        .filter(|line| !line.is_empty())
        .collect::<Vec<_>>()
        .join("\n\n")
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::agent_room::swarm_phases::ResolvedSwarmUnit;

    #[test]
    fn critique_round_two_guidance_is_the_second_round_text() {
        assert!(build_phase_guidance(SwarmPhase::Critique, 2)
            .starts_with("Respond to the first round of critique."));
    }

    #[test]
    fn the_prompt_names_the_round_and_the_speaker() {
        let speaker = ResolvedSwarmUnit {
            persona_id: "a".to_string(),
            role: "analyst".to_string(),
            name: "Ada".to_string(),
            emoji: "🧠".to_string(),
        };
        let params = TurnPromptParams {
            swarm_title: "Room".to_string(),
            task: "Ship".to_string(),
            phase: SwarmPhase::Research,
            speaker: speaker.clone(),
            lead_persona_id: "a".to_string(),
            recent_history: String::new(),
            units: vec![speaker],
            phase_round: Some(1),
            phase_rounds_total: Some(2),
        };
        let prompt = build_simple_turn_prompt(&params);
        assert!(prompt.contains("PHASE: Research (Round 1 of 2)"));
        assert!(prompt.contains("1) Start exactly with **[Ada]:**"));
    }
}
