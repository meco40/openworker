//! Mirrors `src/server/agent-room/prompt/text.utils.ts`.
//!
//! Known deviations: `to_lowercase` and byte offsets stand in for JavaScript's
//! UTF-16 offsets. They agree for ASCII names and for all text the server writes.

use std::sync::LazyLock;

use regex::Regex;

/// `^\s*\*\*\[[^\]\n*]+?\]:\*\*` on every line: one structured turn header.
static TURN_HEADER: LazyLock<Regex> = LazyLock::new(|| re(r"(?m)^\s*\*\*\[[^\]\n*]+?\]:\*\*"));

/// `^---\s+.+?\s+---$` on every line: one phase marker.
static PHASE_MARKER: LazyLock<Regex> = LazyLock::new(|| re(r"(?m)^---\s+.+?\s+---$"));

/// `\n{2,}`: a paragraph break between two artifact chunks.
static BLANK_LINES: LazyLock<Regex> = LazyLock::new(|| re(r"\n{2,}"));

fn re(pattern: &str) -> Regex {
    Regex::new(pattern).expect("valid agent room pattern")
}

/// `buildSpeakerPrefixes`
fn build_speaker_prefixes(speaker_name: &str, include_plain_label: bool) -> Vec<String> {
    let name = speaker_name.trim();
    if name.is_empty() {
        return Vec::new();
    }
    let mut prefixes = vec![
        format!("**[{name}]:**"),
        format!("**{name}:**"),
        format!("[{name}]:"),
    ];
    if include_plain_label {
        prefixes.push(format!("{name}:"));
    }
    prefixes
}

/// Drops the first `count` characters. Empty when the text is shorter.
fn skip_chars(text: &str, count: usize) -> &str {
    match text.char_indices().nth(count) {
        Some((index, _)) => &text[index..],
        None => "",
    }
}

/// `stripLeadingSpeakerPrefix`
pub fn strip_leading_speaker_prefix(text: &str, speaker_name: &str) -> String {
    let raw = text.trim_start();
    let prefixes = build_speaker_prefixes(speaker_name, true);
    if raw.is_empty() || prefixes.is_empty() {
        return raw.to_string();
    }
    let lower_raw = raw.to_lowercase();
    for prefix in &prefixes {
        if lower_raw.starts_with(&prefix.to_lowercase()) {
            return skip_chars(raw, prefix.chars().count()).trim().to_string();
        }
    }
    raw.to_string()
}

/// `stripTrailingOtherSpeakerTurns`: cuts the text where another participant's turn
/// header starts.
pub fn strip_trailing_other_speaker_turns(
    text: &str,
    active_speaker_name: &str,
    participant_names: &[String],
) -> String {
    let raw = text.trim();
    if raw.is_empty() {
        return String::new();
    }
    let active = active_speaker_name.trim().to_lowercase();
    let mut other_names: Vec<&str> = Vec::new();
    for name in participant_names {
        let name = name.trim();
        if !name.is_empty() && name.to_lowercase() != active && !other_names.contains(&name) {
            other_names.push(name);
        }
    }
    if other_names.is_empty() {
        return raw.to_string();
    }

    let lower_raw = raw.to_lowercase();
    let mut cut_index: Option<usize> = None;
    for name in other_names {
        for prefix in build_speaker_prefixes(name, false) {
            if let Some(index) = lower_raw.find(&prefix.to_lowercase()) {
                if index > 0 && cut_index.is_none_or(|cut| index < cut) {
                    cut_index = Some(index);
                }
            }
        }
    }
    match cut_index.and_then(|cut| raw.get(..cut)) {
        Some(head) => head.trim().to_string(),
        None => raw.to_string(),
    }
}

/// `countStructuredTurns`
pub fn count_structured_turns(artifact: &str) -> usize {
    if artifact.trim().is_empty() {
        return 0;
    }
    TURN_HEADER.find_iter(artifact).count()
}

/// `countTurnsInCurrentPhase`: turn headers after the last phase marker.
pub fn count_turns_in_current_phase(artifact: &str) -> usize {
    let text = artifact.trim();
    if text.is_empty() {
        return 0;
    }
    let last_marker_end = PHASE_MARKER
        .find_iter(text)
        .last()
        .map_or(0, |marker| marker.end());
    TURN_HEADER.find_iter(&text[last_marker_end..]).count()
}

/// `extractRecentTurnHistory`: the last `max_turns` paragraphs, at least one.
pub fn extract_recent_turn_history(artifact: &str, max_turns: usize) -> String {
    let text = artifact.trim();
    if text.is_empty() {
        return String::new();
    }
    let chunks: Vec<&str> = BLANK_LINES
        .split(text)
        .filter(|chunk| !chunk.trim().is_empty())
        .collect();
    let keep = max_turns.max(1);
    chunks[chunks.len().saturating_sub(keep)..].join("\n\n")
}

#[cfg(test)]
mod tests {
    use super::*;

    const ARTIFACT: &str =
        "--- Analysis ---\n\n**[A]:** one\n\n**[B]:** two\n\n--- Research ---\n\n**[A]:** three";

    #[test]
    fn counts_turns_overall_and_in_the_current_phase() {
        assert_eq!(count_structured_turns(ARTIFACT), 3);
        assert_eq!(count_turns_in_current_phase(ARTIFACT), 1);
    }

    #[test]
    fn strips_the_leading_speaker_label() {
        assert_eq!(
            strip_leading_speaker_prefix("**[Ada]:** hello", "Ada"),
            "hello"
        );
    }

    #[test]
    fn cuts_the_text_where_another_speaker_starts() {
        let names = vec!["Ada".to_string(), "Bo".to_string()];
        assert_eq!(
            strip_trailing_other_speaker_turns("My answer **[Bo]:** other", "Ada", &names),
            "My answer"
        );
    }

    #[test]
    fn keeps_the_last_paragraphs() {
        assert_eq!(extract_recent_turn_history("a\n\nb\n\nc", 2), "b\n\nc");
    }
}
