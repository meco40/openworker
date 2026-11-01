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

    fn strings(list: &[&str]) -> Vec<String> {
        list.iter().map(|value| value.to_string()).collect()
    }

    #[test]
    fn text_within_the_limit_is_returned_unchanged() {
        assert_eq!(clamp_artifact("hello"), "hello");
        assert_eq!(clamp_artifact(""), "");
        let exact = "B".repeat(ARTIFACT_MAX_CHARS);
        assert_eq!(clamp_artifact(&exact), exact);
    }

    #[test]
    fn clamping_keeps_the_tail() {
        let text = format!("{}{}", "H".repeat(15_000), "T".repeat(10_000));
        let clamped = clamp_artifact(&text);
        assert_eq!(clamped.chars().count(), ARTIFACT_MAX_CHARS);
        assert!(clamped.ends_with(&"T".repeat(10_000)));
    }

    #[test]
    fn snapshots_append_skip_blanks_and_keep_non_consecutive_repeats() {
        assert_eq!(
            push_artifact_snapshot(&strings(&["v1"]), "v2"),
            strings(&["v1", "v2"])
        );
        assert_eq!(
            push_artifact_snapshot(&strings(&["v1"]), "   "),
            strings(&["v1"])
        );
        assert_eq!(
            push_artifact_snapshot(&strings(&["v1", "v2"]), "v1"),
            strings(&["v1", "v2", "v1"])
        );
        assert_eq!(
            push_artifact_snapshot(&[], "  hello  "),
            strings(&["hello"])
        );
        assert_eq!(push_artifact_snapshot(&[], "first"), strings(&["first"]));
    }

    #[test]
    fn history_keeps_the_last_24_snapshots() {
        let history: Vec<String> = (0..24).map(|i| format!("v{i}")).collect();
        let next = push_artifact_snapshot(&history, "v24");
        assert_eq!(next.len(), ARTIFACT_HISTORY_LIMIT);
        assert_eq!(next[0], "v1");
        assert_eq!(next[23], "v24");
    }

    #[test]
    fn consensus_score_is_rounded_and_clamped_to_0_100() {
        assert_eq!(clamp_consensus_score(f64::NAN), 0);
        assert_eq!(clamp_consensus_score(f64::INFINITY), 0);
        assert_eq!(clamp_consensus_score(f64::NEG_INFINITY), 0);
        assert_eq!(clamp_consensus_score(-5.0), 0);
        assert_eq!(clamp_consensus_score(150.0), 100);
        assert_eq!(clamp_consensus_score(55.6), 56);
        assert_eq!(clamp_consensus_score(55.4), 55);
        assert_eq!(clamp_consensus_score(0.0), 0);
        assert_eq!(clamp_consensus_score(50.0), 50);
        assert_eq!(clamp_consensus_score(100.0), 100);
    }

    #[test]
    fn the_first_turn_opens_the_phase_and_later_turns_append() {
        assert_eq!(
            build_artifact_with_new_turn(
                "",
                "**[A]:** hi",
                SwarmPhase::Analysis,
                false,
                SwarmPhase::Analysis
            ),
            "--- Analysis ---\n\n**[A]:** hi"
        );
        assert_eq!(
            build_artifact_with_new_turn(
                "   ",
                "**[A]:** start",
                SwarmPhase::Ideation,
                false,
                SwarmPhase::Ideation
            ),
            "--- Ideation ---\n\n**[A]:** start"
        );
        let existing = "--- Analysis ---\n\n**[A]:** first";
        assert_eq!(
            build_artifact_with_new_turn(
                existing,
                "**[B]:** second",
                SwarmPhase::Analysis,
                false,
                SwarmPhase::Analysis
            ),
            "--- Analysis ---\n\n**[A]:** first\n\n**[B]:** second"
        );
    }

    #[test]
    fn a_multi_turn_run_with_a_phase_change_builds_the_expected_artifact() {
        let t1 = build_artifact_with_new_turn(
            "",
            "**[Next.js Dev]:** Initial analysis.",
            SwarmPhase::Analysis,
            false,
            SwarmPhase::Analysis,
        );
        let t2 = build_artifact_with_new_turn(
            &t1,
            "**[Code Reviewer]:** I agree.",
            SwarmPhase::Analysis,
            true,
            SwarmPhase::Ideation,
        );
        let t3 = build_artifact_with_new_turn(
            &t2,
            "**[Next.js Dev]:** Proposal.",
            SwarmPhase::Ideation,
            false,
            SwarmPhase::Ideation,
        );
        assert_eq!(
            t3,
            "--- Analysis ---\n\n**[Next.js Dev]:** Initial analysis.\n\n**[Code Reviewer]:** I agree.\n\n--- Ideation ---\n\n**[Next.js Dev]:** Proposal."
        );
    }

    #[test]
    fn a_long_artifact_is_clamped_after_appending() {
        let existing = "X".repeat(19_990);
        let result = build_artifact_with_new_turn(
            &existing,
            "**[A]:** This is a new turn with content",
            SwarmPhase::Analysis,
            false,
            SwarmPhase::Analysis,
        );
        assert!(result.chars().count() <= ARTIFACT_MAX_CHARS);
    }
}
