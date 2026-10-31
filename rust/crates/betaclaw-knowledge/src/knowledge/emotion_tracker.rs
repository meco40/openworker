//! Port of `src/server/knowledge/emotionTracker.ts` (1-96).
//!
//! | TypeScript                                    | Rust |
//! | --------------------------------------------- | ---- |
//! | `emotionTracker.ts:6-10` (`EmotionalState`)    | [`EmotionalState`] |
//! | `emotionTracker.ts:12` (`RelationshipStatus`)  | [`RelationshipStatus`] |
//! | `emotionTracker.ts:14` (`RelationshipTrend`)   | [`RelationshipTrend`] |
//! | `emotionTracker.ts:22-35` (`EMOTION_PATTERNS`) | [`emotion_patterns`] |
//! | `emotionTracker.ts:37-38` (`INTENSIFIER_*`, `TRIGGER_PATTERN`) | [`intensifier_pattern`], [`trigger_pattern`] |
//! | `emotionTracker.ts:44-67` (`detectEmotion`)    | [`detect_emotion`] |
//! | `emotionTracker.ts:69-81` (`STATUS_ORDER`, `statusIndex`) | [`status_index`] |
//! | `emotionTracker.ts:87-96` (`deriveRelationshipTrend`) | [`derive_relationship_trend`] |
//!
//! Used by RolePlay personas for emotional continuity. Pure functions, no
//! service dependency.
//!
//! # JavaScript semantics that are reproduced explicitly
//!
//! * `EMOTION_PATTERNS` is walked in declaration order and the **first** hit
//!   wins (`:45-46`); the port keeps the order and the exact keywords.
//! * `Math.min(1.0, intensity + 0.15)` (`:51`) is reproduced as `f64::min`, so
//!   the IEEE-754 sums stay what the source computes: `0.7 + 0.15` is `0.85`
//!   and `0.8 + 0.15` is `0.9500000000000001` (both confirmed with Node 24).
//! * `STATUS_ORDER.indexOf(status)` returns `-1` for an unknown status and the
//!   helper maps that to `2` (`neutral`, `:78-81`). The port is total over the
//!   enum, so the `-1` branch is unreachable; the fallback constant is kept in
//!   [`status_index`].
//! * `history.length <= 1` returns `'stable'` before any index lookup (`:88`).
//! * `triggerMatch[1].trim()` (`:56`): the captured group is trimmed, not the
//!   whole match.
//!
//! # Regex justification
//!
//! `TRIGGER_PATTERN` needs a **lazy** quantifier (`.{1,40}?`, `:38`) and a
//! three-way alternation; `regex` — the crate the workspace already depends on —
//! is the only pattern engine in the dependency set with non-greedy matching.

use regex::Regex;
use std::sync::OnceLock;

/// `EmotionalState` (`emotionTracker.ts:6-10`).
#[derive(Debug, Clone, PartialEq)]
pub struct EmotionalState {
    pub emotion: String,
    /// 0.0–1.0
    pub intensity: f64,
    pub trigger: Option<String>,
}

/// `RelationshipStatus` (`emotionTracker.ts:12`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RelationshipStatus {
    Positive,
    Neutral,
    Tense,
    Broken,
    New,
    Rekindled,
}

impl RelationshipStatus {
    /// The TypeScript union member, verbatim.
    pub fn as_str(self) -> &'static str {
        match self {
            RelationshipStatus::Positive => "positive",
            RelationshipStatus::Neutral => "neutral",
            RelationshipStatus::Tense => "tense",
            RelationshipStatus::Broken => "broken",
            RelationshipStatus::New => "new",
            RelationshipStatus::Rekindled => "rekindled",
        }
    }
}

/// `RelationshipTrend` (`emotionTracker.ts:14`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RelationshipTrend {
    Improving,
    Stable,
    Declining,
}

impl RelationshipTrend {
    /// The TypeScript union member, verbatim.
    pub fn as_str(self) -> &'static str {
        match self {
            RelationshipTrend::Improving => "improving",
            RelationshipTrend::Stable => "stable",
            RelationshipTrend::Declining => "declining",
        }
    }
}

/// `EMOTION_PATTERNS` (`emotionTracker.ts:22-35`), in declaration order.
pub fn emotion_patterns() -> &'static [(Regex, &'static str, f64)] {
    static PATTERNS: OnceLock<Vec<(Regex, &'static str, f64)>> = OnceLock::new();
    PATTERNS.get_or_init(|| {
        [
            (r"(?i)\btraurig\b", "traurig", 0.7),
            (r"(?i)\bgluecklich\b", "gluecklich", 0.7),
            (r"(?i)\bfroh\b", "froh", 0.6),
            (r"(?i)\bwuetend\b", "wuetend", 0.8),
            (r"(?i)\bangst\b", "aengstlich", 0.7),
            (r"(?i)\baengstlich\b", "aengstlich", 0.6),
            (r"(?i)\baufgeregt\b", "aufgeregt", 0.6),
            (r"(?i)\benttaeuscht\b", "enttaeuscht", 0.7),
            (r"(?i)\beinsam\b", "einsam", 0.7),
            (r"(?i)\bverliebt\b", "verliebt", 0.8),
            (r"(?i)\bnervoes\b", "nervoes", 0.5),
            (r"(?i)\bstolz\b", "stolz", 0.6),
        ]
        .into_iter()
        .map(|(pattern, emotion, intensity)| {
            (
                Regex::new(pattern).expect("emotion pattern"),
                emotion,
                intensity,
            )
        })
        .collect()
    })
}

/// `INTENSIFIER_PATTERN` (`emotionTracker.ts:37`).
pub fn intensifier_pattern() -> &'static Regex {
    static PATTERN: OnceLock<Regex> = OnceLock::new();
    PATTERN.get_or_init(|| {
        Regex::new(r"(?i)\b(so|sehr|extrem|total|mega|unglaublich|solche)\b")
            .expect("intensifier pattern")
    })
}

/// `TRIGGER_PATTERN` (`emotionTracker.ts:38`).
pub fn trigger_pattern() -> &'static Regex {
    static PATTERN: OnceLock<Regex> = OnceLock::new();
    PATTERN
        .get_or_init(|| Regex::new(r"(?i)\b(wegen\s+.{1,40}?)(?:\.|,|$)").expect("trigger pattern"))
}

/// `STATUS_ORDER` (`emotionTracker.ts:69-76`).
pub const STATUS_ORDER: &[RelationshipStatus] = &[
    RelationshipStatus::Broken,
    RelationshipStatus::Tense,
    RelationshipStatus::Neutral,
    RelationshipStatus::New,
    RelationshipStatus::Positive,
    RelationshipStatus::Rekindled,
];

/// `statusIndex(status)` (`emotionTracker.ts:78-81`): the index in
/// [`STATUS_ORDER`], defaulting to the `neutral` index for an unknown status.
pub fn status_index(status: RelationshipStatus) -> usize {
    STATUS_ORDER
        .iter()
        .position(|entry| *entry == status)
        .unwrap_or(2)
}

/// `detectEmotion(text)` (`emotionTracker.ts:44-67`).
pub fn detect_emotion(text: &str) -> Option<EmotionalState> {
    for (keyword, emotion, base_intensity) in emotion_patterns() {
        if !keyword.is_match(text) {
            continue;
        }
        let mut intensity = *base_intensity;
        if intensifier_pattern().is_match(text) {
            intensity = 1.0_f64.min(intensity + 0.15);
        }
        let trigger = trigger_pattern()
            .captures(text)
            .and_then(|captures| captures.get(1))
            .map(|matched| matched.as_str().trim().to_string());
        return Some(EmotionalState {
            emotion: (*emotion).to_string(),
            intensity,
            trigger,
        });
    }
    None
}

/// `deriveRelationshipTrend(history)` (`emotionTracker.ts:87-96`).
///
/// The history is ordered chronologically (oldest first, newest last).
pub fn derive_relationship_trend(history: &[RelationshipStatus]) -> RelationshipTrend {
    if history.len() <= 1 {
        return RelationshipTrend::Stable;
    }
    let first = status_index(history[0]);
    let last = status_index(history[history.len() - 1]);
    if last > first {
        return RelationshipTrend::Improving;
    }
    if last < first {
        return RelationshipTrend::Declining;
    }
    RelationshipTrend::Stable
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_first_matching_pattern_wins() {
        let state = detect_emotion("ich bin so traurig").expect("emotion");
        assert_eq!(state.emotion, "traurig");
        // `0.7 + 0.15` — Node 24 prints the same double.
        assert_eq!(state.intensity, 0.85);
        assert_eq!(state.trigger, None);
    }

    #[test]
    fn an_intensifier_is_required_for_the_boost() {
        let plain = detect_emotion("ich bin traurig").expect("emotion");
        assert_eq!(plain.intensity, 0.7);
    }

    #[test]
    fn the_intensity_never_passes_one() {
        let state = detect_emotion("extrem wuetend").expect("emotion");
        assert_eq!(state.emotion, "wuetend");
        // `0.8 + 0.15` is `0.9500000000000001` in IEEE-754.
        assert_eq!(state.intensity, 0.9500000000000001);
    }

    #[test]
    fn a_wegen_trigger_is_trimmed_and_bounded() {
        let state = detect_emotion("ich bin traurig wegen des Streits.").expect("emotion");
        assert_eq!(state.trigger.as_deref(), Some("wegen des Streits"));

        // The lazy quantifier stops at the first terminator.
        let state =
            detect_emotion("traurig wegen des Streits, weil er zu spaet kam").expect("emotion");
        assert_eq!(state.trigger.as_deref(), Some("wegen des Streits"));

        // More than 40 characters without a terminator leave no match at all.
        let long = format!("traurig wegen {}", "x".repeat(50));
        assert_eq!(detect_emotion(&long).expect("emotion").trigger, None);
    }

    #[test]
    fn text_without_an_emotion_yields_nothing() {
        assert_eq!(detect_emotion("Nata hat einen Bruder"), None);
    }

    #[test]
    fn the_status_order_matches_the_typescript_array() {
        assert_eq!(
            STATUS_ORDER.iter().map(|s| s.as_str()).collect::<Vec<_>>(),
            vec!["broken", "tense", "neutral", "new", "positive", "rekindled"]
        );
        assert_eq!(status_index(RelationshipStatus::Broken), 0);
        assert_eq!(status_index(RelationshipStatus::Neutral), 2);
        assert_eq!(status_index(RelationshipStatus::Rekindled), 5);
    }

    #[test]
    fn a_trend_compares_the_first_and_the_last_snapshot() {
        use RelationshipStatus::*;
        assert_eq!(derive_relationship_trend(&[]), RelationshipTrend::Stable);
        assert_eq!(
            derive_relationship_trend(&[Positive]),
            RelationshipTrend::Stable
        );
        assert_eq!(
            derive_relationship_trend(&[Broken, Tense, Neutral, Positive]),
            RelationshipTrend::Improving
        );
        assert_eq!(
            derive_relationship_trend(&[Positive, Tense, Broken]),
            RelationshipTrend::Declining
        );
        // `new` (3) → `tense` (1) is a decline even though both look "calm".
        assert_eq!(
            derive_relationship_trend(&[New, Tense]),
            RelationshipTrend::Declining
        );
    }
}
