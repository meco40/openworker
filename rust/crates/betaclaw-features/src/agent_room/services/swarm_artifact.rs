//! Mirrors `src/server/agent-room/services/swarmArtifact.service.ts`.
//!
//! The 20 000 character cap counts Unicode scalars. The TypeScript side counts UTF-16
//! units. The two only differ for characters outside the Basic Multilingual Plane.

use crate::agent_room::swarm_phases::SwarmPhase;

const ARTIFACT_MAX_CHARS: usize = 20_000;
const ARTIFACT_HISTORY_LIMIT: usize = 24;

/// `clampArtifact`: keeps the last `ARTIFACT_MAX_CHARS` characters.
pub fn clamp_artifact(text: &str) -> String {
    let total = text.chars().count();
    if total <= ARTIFACT_MAX_CHARS {
        return text.to_string();
    }
    text.chars().skip(total - ARTIFACT_MAX_CHARS).collect()
}

/// `pushArtifactSnapshot`: appends a trimmed snapshot unless it repeats the last one.
pub fn push_artifact_snapshot(history: &[String], artifact: &str) -> Vec<String> {
    let normalized = artifact.trim();
    if normalized.is_empty() || history.last().map(String::as_str) == Some(normalized) {
        return history.to_vec();
    }
    let mut next = history.to_vec();
    next.push(normalized.to_string());
    if next.len() <= ARTIFACT_HISTORY_LIMIT {
        return next;
    }
    let start = next.len() - ARTIFACT_HISTORY_LIMIT;
    next[start..].to_vec()
}

/// `buildArtifactWithNewTurn`: appends a turn. When the phase just completed, it
/// also adds the next phase marker.
pub fn build_artifact_with_new_turn(
    existing_artifact: &str,
    turn_line: &str,
    current_phase: SwarmPhase,
    phase_complete: bool,
    next_phase: SwarmPhase,
) -> String {
    let mut content = if existing_artifact.trim().is_empty() {
        format!("--- {} ---\n\n{turn_line}", current_phase.label())
    } else {
        format!("{existing_artifact}\n\n{turn_line}")
    };
    if phase_complete {
        content = format!("{content}\n\n--- {} ---", next_phase.label());
    }
    clamp_artifact(&content)
}

/// `clampConsensusScore`: a finite value, rounded and clamped to 0..=100.
pub fn clamp_consensus_score(value: f64) -> u32 {
    if !value.is_finite() {
        return 0;
    }
    value.round().clamp(0.0, 100.0) as u32
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_artifact_keeps_its_last_characters() {
        let long = "a".repeat(ARTIFACT_MAX_CHARS + 5);
        assert_eq!(clamp_artifact(&long).chars().count(), ARTIFACT_MAX_CHARS);
    }

    #[test]
    fn a_repeated_snapshot_is_not_stored_twice() {
        let history = vec!["x".to_string()];
        assert_eq!(
            push_artifact_snapshot(&history, " x "),
            vec!["x".to_string()]
        );
    }

    #[test]
    fn a_completed_phase_appends_the_next_marker() {
        let artifact = build_artifact_with_new_turn(
            "",
            "**[A]:** hi",
            SwarmPhase::Analysis,
            true,
            SwarmPhase::Research,
        );
        assert_eq!(
            artifact,
            "--- Analysis ---\n\n**[A]:** hi\n\n--- Research ---"
        );
    }
}
