//! Mirrors `src/server/agent-room/prompt/phase.service.ts`.

use crate::agent_room::prompt::text_utils::count_turns_in_current_phase;
use crate::agent_room::swarm_phases::SwarmPhase;
use crate::agent_room::types::PhaseAdvanceResult;

pub const DEFAULT_SIMPLE_SWARM_MAX_TURNS: u32 = 40;
pub const MIN_SIMPLE_SWARM_MAX_TURNS: u32 = 4;
pub const MAX_SIMPLE_SWARM_MAX_TURNS: u32 = 60;

/// `getTurnsRequiredForPhase`
pub fn get_turns_required_for_phase(phase: SwarmPhase, num_agents: usize) -> usize {
    phase.rounds() as usize * num_agents.max(1)
}

/// `computeNextPhaseAfterTurn`
pub fn compute_next_phase_after_turn(
    current_phase: SwarmPhase,
    artifact_after_turn: &str,
    num_agents: usize,
) -> PhaseAdvanceResult {
    let turns_in_phase = count_turns_in_current_phase(artifact_after_turn);
    let required = get_turns_required_for_phase(current_phase, num_agents);
    if turns_in_phase < required {
        return PhaseAdvanceResult {
            next_phase: current_phase,
            phase_complete: false,
            swarm_complete: false,
        };
    }
    match current_phase.next() {
        Some(next) => PhaseAdvanceResult {
            next_phase: next,
            phase_complete: true,
            swarm_complete: false,
        },
        None => PhaseAdvanceResult {
            next_phase: current_phase,
            phase_complete: true,
            swarm_complete: true,
        },
    }
}

/// `getSimpleSwarmMaxTurns` with the two environment values passed in. The first
/// one that is set wins, as `??` does. An empty value falls back to the default.
/// Anything `Number()` cannot read falls back as well.
pub fn simple_swarm_max_turns_from_env(simple: Option<&str>, legacy: Option<&str>) -> u32 {
    let Some(value) = simple.or(legacy) else {
        return DEFAULT_SIMPLE_SWARM_MAX_TURNS;
    };
    if value.is_empty() {
        return DEFAULT_SIMPLE_SWARM_MAX_TURNS;
    }
    let trimmed = value.trim();
    let number = if trimmed.is_empty() {
        0.0
    } else {
        match trimmed.parse::<f64>() {
            Ok(number) if number.is_finite() => number,
            _ => return DEFAULT_SIMPLE_SWARM_MAX_TURNS,
        }
    };
    number.floor().clamp(
        f64::from(MIN_SIMPLE_SWARM_MAX_TURNS),
        f64::from(MAX_SIMPLE_SWARM_MAX_TURNS),
    ) as u32
}

/// `getSimpleSwarmMaxTurns`, read from `AGENT_ROOM_SIMPLE_MAX_TURNS`, then
/// `AGENT_ROOM_MAX_TURNS`.
pub fn get_simple_swarm_max_turns() -> u32 {
    let simple = std::env::var("AGENT_ROOM_SIMPLE_MAX_TURNS").ok();
    let legacy = std::env::var("AGENT_ROOM_MAX_TURNS").ok();
    simple_swarm_max_turns_from_env(simple.as_deref(), legacy.as_deref())
}

/// `shouldCompleteSwarmAfterTurnWithTurnCount`. A negative count counts as zero.
pub fn should_complete_swarm_after_turn_with_turn_count(
    next_turn_count: i64,
    max_turns: u32,
) -> bool {
    next_turn_count.max(0) >= i64::from(max_turns)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn completes_a_phase_after_its_required_turns() {
        let artifact = "--- Research ---\n\n**[A]:** x\n\n**[B]:** y";
        let result = compute_next_phase_after_turn(SwarmPhase::Research, artifact, 2);
        assert!(result.phase_complete);
        assert!(!result.swarm_complete);
        assert_eq!(result.next_phase, SwarmPhase::Ideation);
    }

    #[test]
    fn max_turns_reads_the_first_set_variable_and_clamps() {
        assert_eq!(simple_swarm_max_turns_from_env(None, None), 40);
        assert_eq!(simple_swarm_max_turns_from_env(Some("1"), None), 4);
        assert_eq!(simple_swarm_max_turns_from_env(None, Some("100")), 60);
        assert_eq!(simple_swarm_max_turns_from_env(Some("abc"), None), 40);
    }
}
