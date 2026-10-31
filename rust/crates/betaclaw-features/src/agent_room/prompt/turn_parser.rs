//! Mirrors `src/server/agent-room/prompt/turn.parser.ts`.

use std::sync::LazyLock;

use regex::Regex;

use crate::agent_room::swarm_phases::SwarmPhase;
use crate::agent_room::types::TurnDirectiveResult;

const VOTE_UP_DELTA: i32 = 8;
const VOTE_DOWN_DELTA: i32 = -12;

static VOTE_DOWN: LazyLock<Regex> = LazyLock::new(|| re(r"(?i)\[VOTE:DOWN\]"));
static VOTE_UP: LazyLock<Regex> = LazyLock::new(|| re(r"(?i)\[VOTE:UP\]"));
static VOTE_MARKERS: LazyLock<Regex> = LazyLock::new(|| re(r"(?i)\[VOTE:UP\]|\[VOTE:DOWN\]"));
static CHANGE_PHASE: LazyLock<Regex> = LazyLock::new(|| re(r"(?i)\[CHANGE_PHASE:[^\]]+\]"));

fn re(pattern: &str) -> Regex {
    Regex::new(pattern).expect("valid turn directive pattern")
}

/// `parseTurnDirectives`. Phase transitions are server-controlled, so the phase
/// passes through unchanged.
pub fn parse_turn_directives(raw_text: &str, current_phase: SwarmPhase) -> TurnDirectiveResult {
    let raw = raw_text.trim();
    let consensus_delta = if VOTE_DOWN.is_match(raw) {
        VOTE_DOWN_DELTA
    } else if VOTE_UP.is_match(raw) {
        VOTE_UP_DELTA
    } else {
        0
    };
    let without_votes = VOTE_MARKERS.replace_all(raw, "");
    let clean_text = CHANGE_PHASE.replace_all(&without_votes, "");
    TurnDirectiveResult {
        clean_text: clean_text.trim().to_string(),
        consensus_delta,
        next_phase: current_phase,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_down_vote_wins_and_the_markers_are_removed() {
        let result = parse_turn_directives(
            "Text [VOTE:DOWN] more [CHANGE_PHASE:result]",
            SwarmPhase::Ideation,
        );
        assert_eq!(result.consensus_delta, -12);
        assert_eq!(result.clean_text, "Text  more");
        assert_eq!(result.next_phase, SwarmPhase::Ideation);
    }

    #[test]
    fn an_up_vote_adds_eight() {
        assert_eq!(
            parse_turn_directives("ok [vote:up]", SwarmPhase::Analysis).consensus_delta,
            8
        );
    }
}
