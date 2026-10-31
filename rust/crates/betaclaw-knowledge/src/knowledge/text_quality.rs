//! Port of `src/server/knowledge/textQuality.ts` (1-129).
//!
//! | TypeScript | Rust |
//! | --- | --- |
//! | `normalize` (`:1-5`, private) | [`normalize`] (private) |
//! | `isGreetingOnly` (`:7-9`, private) | [`is_greeting_only`] (private) |
//! | `isCommandOrMeta` (`:11-20`, private) | [`is_command_or_meta`] (private) |
//! | `splitNumberedRules` (`:22-30`, private) | [`split_numbered_rules`] (private) |
//! | `isMeaningfulKnowledgeText` (`:32-42`) | [`is_meaningful_knowledge_text`] |
//! | `isNoiseMemoryFact` (`:44-46`) | [`is_noise_memory_fact`] |
//! | `sanitizeKnowledgeFacts` (`:48-64`) | [`sanitize_knowledge_facts`] |
//! | `FactScope` (`:68`) | [`FactScope`] |
//! | `TextClassification` (`:70-76`) | [`TextClassification`] |
//! | `NEGATION_MARKERS` ... `QUOTE_MARKERS` (`:78-85`) | the `LazyLock` statics below |
//! | `classifyTextReliability` (`:87-107`) | [`classify_text_reliability`] |
//! | `TemporalStatus` (`:111`) | [`TemporalStatus`] |
//! | `detectTemporalStatus` (`:113-129`) | [`detect_temporal_status`] |
//!
//! # JavaScript semantics that are reproduced explicitly
//!
//! * `String#replace(/\s+/g, ' ').trim()` is `split_whitespace().join(" ")`.
//! * `String#length` (used by the `< 8` check) counts UTF-16 code units, so the
//!   port goes through [`js_str_len`].
//! * `value.split(/\s(?=\d+\s*[.)-]\s)/)` has a lookahead, which the `regex`
//!   crate does not support. [`split_on_numbered_boundaries`] reproduces it by
//!   testing the remainder after each whitespace character.
//! * `\w` is ASCII in JavaScript; the classes below spell `[0-9A-Za-z_]` out.
//! * `\b` is Unicode-aware in the `regex` crate and ASCII in JavaScript. The
//!   difference only shows for a marker word that touches a non-ASCII letter;
//!   the port keeps `\b` like `correction_detector.rs` does.
//!
//! # Deviation
//!
//! `sanitizeKnowledgeFacts` takes `String(raw || '')`. A Rust `&str` cannot be
//! `undefined`, so that branch does not exist; the result is the same.

use std::collections::HashSet;
use std::sync::LazyLock;

use regex::Regex;

use crate::knowledge::retrieval::js_str_len;

/// `normalize` (`textQuality.ts:1-5`): collapse whitespace runs, trim.
fn normalize(value: &str) -> String {
    value.split_whitespace().collect::<Vec<_>>().join(" ")
}

static GREETING_ONLY: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?i)^(hallo|hi|hey|moin|servus|ok|okay|ja|nein|danke|thx|merci)[.!?]*$")
        .expect("greeting pattern")
});

/// `isGreetingOnly` (`textQuality.ts:7-9`).
fn is_greeting_only(value: &str) -> bool {
    GREETING_ONLY.is_match(value)
}

static COMMAND_PREFIX: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?i)^/[0-9a-z_-]+").expect("command prefix pattern"));
static SAVE_COMMAND: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?i)^\s*(speichere\s+ab|save\s+memory)\b").expect("save command pattern")
});
static META_NOTICE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(
        r"(?i)\b(neue konversation erstellt|new conversation created|persona gewechselt|switched persona)\b",
    )
    .expect("meta notice pattern")
});
static STORED_NOTICE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?i)\b(gespeichert:|stored:)\b").expect("stored notice pattern"));

/// `isCommandOrMeta` (`textQuality.ts:11-20`).
fn is_command_or_meta(value: &str) -> bool {
    COMMAND_PREFIX.is_match(value)
        || SAVE_COMMAND.is_match(value)
        || META_NOTICE.is_match(value)
        || STORED_NOTICE.is_match(value)
}

static RULE_HEADER: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?i)^(regeln?|rules?|richtlinien?|vorgaben?)\s*:\s*").expect("rule header pattern")
});
static NUMBERED_BOUNDARY: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^[0-9]+\s*[.)-]\s").expect("numbered boundary pattern"));
static NUMBERED_PART: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^[0-9]+\s*[.)-]\s+").expect("numbered part pattern"));

/// `value.split(/\s(?=\d+\s*[.)-]\s)/)` (`textQuality.ts:28`). The whitespace
/// character is dropped, like JavaScript does for a split separator.
fn split_on_numbered_boundaries(text: &str) -> Vec<&str> {
    let mut parts = Vec::new();
    let mut start = 0;
    for (index, ch) in text.char_indices() {
        let after = index + ch.len_utf8();
        if ch.is_whitespace() && NUMBERED_BOUNDARY.is_match(&text[after..]) {
            parts.push(&text[start..index]);
            start = after;
        }
    }
    parts.push(&text[start..]);
    parts
}

/// `splitNumberedRules` (`textQuality.ts:22-30`).
fn split_numbered_rules(value: &str) -> Vec<String> {
    let normalized = normalize(value);
    if normalized.is_empty() {
        return Vec::new();
    }
    let scan = RULE_HEADER.replace(&normalized, "");
    let numbered: Vec<String> = split_on_numbered_boundaries(&scan)
        .into_iter()
        .map(normalize)
        .filter(|part| NUMBERED_PART.is_match(part))
        .collect();
    if numbered.is_empty() {
        vec![normalized]
    } else {
        numbered
    }
}

/// `isMeaningfulKnowledgeText` (`textQuality.ts:32-42`).
pub fn is_meaningful_knowledge_text(value: &str) -> bool {
    let normalized = normalize(value);
    if normalized.is_empty() {
        return false;
    }
    if js_str_len(&normalized) < 8 {
        return false;
    }
    if is_greeting_only(&normalized) || is_command_or_meta(&normalized) {
        return false;
    }
    // `replace(/[^a-zA-Z0-9]/g, '')` keeps ASCII alphanumerics only.
    let letters = normalized
        .chars()
        .filter(|ch| ch.is_ascii_alphanumeric())
        .count();
    letters >= 6
}

/// `isNoiseMemoryFact` (`textQuality.ts:44-46`).
pub fn is_noise_memory_fact(value: &str) -> bool {
    !is_meaningful_knowledge_text(value)
}

/// `sanitizeKnowledgeFacts` (`textQuality.ts:48-64`): split numbered rules,
/// keep the meaningful chunks, drop case-insensitive duplicates, keep order.
pub fn sanitize_knowledge_facts<S: AsRef<str>>(values: &[S]) -> Vec<String> {
    let mut output = Vec::new();
    let mut seen = HashSet::new();
    for raw in values {
        for chunk in split_numbered_rules(raw.as_ref()) {
            let normalized = normalize(&chunk);
            if !is_meaningful_knowledge_text(&normalized) {
                continue;
            }
            if seen.insert(normalized.to_lowercase()) {
                output.push(normalized);
            }
        }
    }
    output
}

/// `FactScope` (`textQuality.ts:68`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FactScope {
    Real,
    Hypothetical,
    Roleplay,
    Quoted,
}

impl FactScope {
    /// The TypeScript union member, verbatim.
    pub fn as_str(self) -> &'static str {
        match self {
            FactScope::Real => "real",
            FactScope::Hypothetical => "hypothetical",
            FactScope::Roleplay => "roleplay",
            FactScope::Quoted => "quoted",
        }
    }
}

/// `TextClassification` (`textQuality.ts:70-76`).
#[derive(Debug, Clone, PartialEq)]
pub struct TextClassification {
    pub is_negated: bool,
    pub is_conditional: bool,
    pub is_hypothetical: bool,
    pub fact_scope: FactScope,
    pub factual_confidence: f64,
}

static NEGATION_MARKERS: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?i)\b(nicht|kein|keine|keinen|keinem|nie|niemals|ohne|weder)\b")
        .expect("negation pattern")
});
static CONDITIONAL_MARKERS: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?i)\b(wenn|falls)\b").expect("conditional pattern"));
static CONDITIONAL_CONSEQUENCE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?i)\b(dann|gehe|mache|fliege|fahre|kaufe|esse|trinke|schwimmen)\b")
        .expect("conditional consequence pattern")
});
static HYPOTHETICAL_MARKERS: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?i)\b(wuerde|wuerden|koennte|koennten|haette|haetten|wuensche|traeume)\b")
        .expect("hypothetical pattern")
});
static ROLEPLAY_MARKERS: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(
        r"(?i)\b(stell dir vor|lass uns so tun|in character|ooc|ic:|im spiel|fantasy|szenario)\b",
    )
    .expect("roleplay pattern")
});
static QUOTE_MARKERS: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?i)\b(hat gesagt|meinte|sagte|laut|zitat)\b").expect("quote pattern")
});

/// `classifyTextReliability` (`textQuality.ts:87-107`).
pub fn classify_text_reliability(text: &str) -> TextClassification {
    let is_negated = NEGATION_MARKERS.is_match(text);
    let is_conditional =
        CONDITIONAL_MARKERS.is_match(text) && CONDITIONAL_CONSEQUENCE.is_match(text);
    let is_hypothetical = HYPOTHETICAL_MARKERS.is_match(text);
    let is_roleplay = ROLEPLAY_MARKERS.is_match(text);
    let is_quoted = QUOTE_MARKERS.is_match(text);

    let fact_scope = if is_roleplay {
        FactScope::Roleplay
    } else if is_quoted {
        FactScope::Quoted
    } else if is_hypothetical || is_conditional {
        FactScope::Hypothetical
    } else {
        FactScope::Real
    };

    let factual_confidence = if is_roleplay {
        0.1
    } else if is_hypothetical {
        0.2
    } else if is_conditional {
        0.4
    } else if is_quoted {
        0.5
    } else if is_negated {
        0.7
    } else {
        1.0
    };

    TextClassification {
        is_negated,
        is_conditional,
        is_hypothetical,
        fact_scope,
        factual_confidence,
    }
}

/// `TemporalStatus` (`textQuality.ts:111`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TemporalStatus {
    Current,
    Past,
    Planned,
    Unknown,
}

impl TemporalStatus {
    /// The TypeScript union member, verbatim.
    pub fn as_str(self) -> &'static str {
        match self {
            TemporalStatus::Current => "current",
            TemporalStatus::Past => "past",
            TemporalStatus::Planned => "planned",
            TemporalStatus::Unknown => "unknown",
        }
    }
}

static PAST_TENSE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?i)\b(frueher|damals|ehemals|ehemalig|war\s+mal|habe\s+mal)\b")
        .expect("past pattern")
});
static PLANNED: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?i)\b(werde|werden|naechste|naechsten|morgen|demnaechst|bald|plane|vorhabe)\b")
        .expect("planned pattern")
});
static PRESENT: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?i)\b(bin|ist|arbeite|wohne|habe|mag|liebe|heisse)\b").expect("present pattern")
});
static PAST_MARKER_AFTER_PRESENT: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?i)\b(war|hatte|habe\s+[0-9A-Za-z_]+t)\b").expect("past-after-present pattern")
});

/// `detectTemporalStatus` (`textQuality.ts:113-129`).
pub fn detect_temporal_status(text: &str) -> TemporalStatus {
    if PAST_TENSE.is_match(text) {
        return TemporalStatus::Past;
    }
    if PLANNED.is_match(text) {
        return TemporalStatus::Planned;
    }
    if PRESENT.is_match(text) && !PAST_MARKER_AFTER_PRESENT.is_match(text) {
        return TemporalStatus::Current;
    }
    TemporalStatus::Unknown
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn greetings_commands_and_short_text_are_not_meaningful() {
        assert!(!is_meaningful_knowledge_text("Hallo!"));
        assert!(!is_meaningful_knowledge_text("/persona wechseln"));
        assert!(!is_meaningful_knowledge_text("ab"));
        assert!(is_meaningful_knowledge_text("Ich wohne in Berlin"));
        assert!(is_noise_memory_fact("danke"));
    }

    #[test]
    fn a_stored_notice_needs_a_word_after_the_colon() {
        // `\b` after `:` only matches before a word character, as in JavaScript:
        // "Gespeichert: Kaffee" has no boundary after the colon and passes.
        assert!(is_meaningful_knowledge_text("Gespeichert: Kaffee"));
        assert!(!is_meaningful_knowledge_text("Gespeichert:Kaffee ist gut"));
    }

    #[test]
    fn numbered_rules_are_split_after_their_header() {
        assert_eq!(
            split_numbered_rules("Regeln: 1. Immer Deutsch 2. Kurz bleiben"),
            vec![
                "1. Immer Deutsch".to_string(),
                "2. Kurz bleiben".to_string()
            ]
        );
    }

    #[test]
    fn a_number_inside_a_sentence_does_not_split_it() {
        assert_eq!(
            split_numbered_rules("Ich bin 1990 geboren"),
            vec!["Ich bin 1990 geboren".to_string()]
        );
    }

    #[test]
    fn sanitize_drops_duplicates_case_insensitively() {
        let out = sanitize_knowledge_facts(&["Ich wohne in Berlin", "ich wohne in berlin", "Hi"]);
        assert_eq!(out, vec!["Ich wohne in Berlin".to_string()]);
    }

    #[test]
    fn a_conditional_with_a_consequence_is_hypothetical() {
        let result = classify_text_reliability("Wenn ich nach Hause komme, dann esse ich");
        assert!(result.is_conditional);
        assert_eq!(result.fact_scope, FactScope::Hypothetical);
        assert_eq!(result.factual_confidence, 0.4);
    }

    #[test]
    fn roleplay_outranks_quotes_and_hypotheticals() {
        let result = classify_text_reliability("Stell dir vor, ich wuerde fliegen");
        assert_eq!(result.fact_scope, FactScope::Roleplay);
        assert_eq!(result.factual_confidence, 0.1);
    }

    #[test]
    fn temporal_status_prefers_past_then_planned_then_current() {
        assert_eq!(
            detect_temporal_status("Ich war mal in Rom"),
            TemporalStatus::Past
        );
        assert_eq!(
            detect_temporal_status("Morgen fahre ich los"),
            TemporalStatus::Planned
        );
        assert_eq!(
            detect_temporal_status("Ich wohne in Berlin"),
            TemporalStatus::Current
        );
        // `habe ...t` (e.g. "habe gelernt") is a past marker, so the present rule fails.
        assert_eq!(
            detect_temporal_status("Ich habe gelernt"),
            TemporalStatus::Unknown
        );
    }
}
