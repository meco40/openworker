//! Mirrors `src/server/agent-room/services/conflictRadar.service.ts`.
//!
//! `now` is passed in as the ISO timestamp for `updatedAt` (the TypeScript side reads
//! the clock itself), so the function stays pure. Keyword matches use an ASCII word
//! boundary, as JavaScript's `\b` does without the `u` flag.

use std::sync::LazyLock;

use regex::Regex;

use crate::agent_room::types::{FrictionLevel, SwarmFriction};

/// `^---\s+.+?\s+---$` on every line: one phase marker.
static PHASE_MARKER: LazyLock<Regex> = LazyLock::new(|| re(r"(?m)^---\s+.+?\s+---$"));

struct SignalDef {
    pattern: Regex,
    label: &'static str,
    severe: bool,
}

static SIGNALS: LazyLock<Vec<SignalDef>> = LazyLock::new(|| {
    vec![
        SignalDef {
            pattern: re(r"(?i)(?-u:\b)(fehl|risiko|konflikt|blocker|unsicher)(?-u:\b)"),
            label: "Risk keywords (DE)",
            severe: false,
        },
        SignalDef {
            pattern: re(r"(?i)(?-u:\b)(doubt|risk|conflict|blocker|unclear)(?-u:\b)"),
            label: "Risk keywords (EN)",
            severe: false,
        },
        SignalDef {
            pattern: re(r"(?i)(?-u:\b)(contradict|inconsistent|disagree)(?-u:\b)"),
            label: "Disagreement signal",
            severe: false,
        },
        SignalDef {
            pattern: re(r"(?i)(?-u:\b)(fatal|critical failure|impossible)(?-u:\b)"),
            label: "Critical blocker",
            severe: true,
        },
        SignalDef {
            pattern: re(r"(?i)\[VOTE:DOWN\]"),
            label: "Agent voted DOWN",
            severe: true,
        },
    ]
});

fn re(pattern: &str) -> Regex {
    Regex::new(pattern).expect("valid conflict radar pattern")
}

fn quiet_friction(now: &str) -> SwarmFriction {
    SwarmFriction {
        level: FrictionLevel::Low,
        confidence: 0,
        hold: false,
        reasons: Vec::new(),
        updated_at: now.to_string(),
    }
}

/// `text.split(/(?<=[.!?])\s+|\n+/)`. The regex crate has no lookbehind, so the
/// split is written out. A whitespace run after `.`, `!` or `?` splits, and so does
/// a run of newlines.
fn split_sentences(text: &str) -> Vec<&str> {
    let chars: Vec<(usize, char)> = text.char_indices().collect();
    let mut parts = Vec::new();
    let mut start = 0;
    let mut k = 0;
    while k < chars.len() {
        let (position, current) = chars[k];
        let after_terminal = k > 0 && matches!(chars[k - 1].1, '.' | '!' | '?');
        let whitespace_split = current.is_whitespace() && after_terminal;
        if !whitespace_split && current != '\n' {
            k += 1;
            continue;
        }
        let mut end = k;
        if whitespace_split {
            while end < chars.len() && chars[end].1.is_whitespace() {
                end += 1;
            }
        } else {
            while end < chars.len() && chars[end].1 == '\n' {
                end += 1;
            }
        }
        parts.push(&text[start..position]);
        start = chars.get(end).map_or(text.len(), |(next, _)| *next);
        k = end;
    }
    parts.push(&text[start..]);
    parts
}

/// `deriveConflictRadar`
pub fn derive_conflict_radar(artifact: &str, now: &str) -> SwarmFriction {
    if artifact.trim().is_empty() {
        return quiet_friction(now);
    }
    let last_marker_end = PHASE_MARKER
        .find_iter(artifact)
        .last()
        .map_or(0, |marker| marker.end());
    let text = &artifact[last_marker_end..];
    if text.trim().is_empty() {
        return quiet_friction(now);
    }

    let mut risk_hits: u32 = 0;
    let mut severe_hits: u32 = 0;
    let mut reasons = Vec::new();
    for signal in SIGNALS.iter() {
        if !signal.pattern.is_match(text) {
            continue;
        }
        if signal.severe {
            severe_hits += 1;
        } else {
            risk_hits += 1;
        }
        let excerpt = split_sentences(text).into_iter().find(|sentence| {
            sentence.trim().chars().count() > 10 && signal.pattern.is_match(sentence)
        });
        match excerpt {
            Some(sentence) => {
                let trimmed = sentence.trim();
                let shown: String = trimmed.chars().take(120).collect();
                let cut_short = shown.chars().count() < trimmed.chars().count();
                let shown = if cut_short {
                    format!("{shown}…")
                } else {
                    shown
                };
                reasons.push(format!("{}: \"{shown}\"", signal.label));
            }
            None => reasons.push(signal.label.to_string()),
        }
    }

    let score = (risk_hits * 25 + severe_hits * 35).min(100);
    let level = if score >= 65 {
        FrictionLevel::High
    } else if score >= 30 {
        FrictionLevel::Medium
    } else {
        FrictionLevel::Low
    };
    SwarmFriction {
        level,
        confidence: score,
        hold: false,
        reasons,
        updated_at: now.to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const NOW: &str = "2026-10-11T00:00:00.000Z";

    #[test]
    fn an_empty_artifact_is_quiet() {
        let friction = derive_conflict_radar("   ", NOW);
        assert_eq!(friction.level, FrictionLevel::Low);
        assert_eq!(friction.confidence, 0);
    }

    #[test]
    fn a_critical_blocker_scores_35_and_quotes_its_sentence() {
        let friction = derive_conflict_radar("Das ist fatal und unmöglich.", NOW);
        assert_eq!(friction.level, FrictionLevel::Medium);
        assert_eq!(friction.confidence, 35);
        assert_eq!(
            friction.reasons,
            vec!["Critical blocker: \"Das ist fatal und unmöglich.\"".to_string()]
        );
    }
}
