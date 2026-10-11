//! Port of `src/server/memory/subject/detector.ts`.
//!
//! The subject of a node decides the `[Subject: …]` marker on a recall context
//! line, so a wrong classification changes what the model believes a memory is
//! about. Three layers run in a fixed order: explicit metadata, the ingestion
//! markers, then the content patterns.
//!
//! # Word boundaries
//!
//! JavaScript's `\b` is ASCII-only (`\w === [A-Za-z0-9_]`), while the `regex`
//! crate's default `\b` is Unicode-aware. The two disagree when a non-ASCII
//! letter directly abuts a pattern word (`"übermir"` vs `"über mir"`). Every
//! boundary in this module is therefore written as `(?-u:\b)`, which restores
//! the JavaScript definition. `\s` stays Unicode-aware, because JavaScript's
//! `\s` is too (it matches `\u00a0`).
//!
//! # Classification quirks that the port keeps
//!
//! The tables of `detector.ts:5-35` are not linguistically clean, and the port
//! reproduces them verbatim because the subject decides the `[Subject: …]`
//! marker of a recall line:
//!
//! * `mir` / `mich` sit in `PERSONA_SELF_PATTERNS` (`detector.ts:13-14`), and
//!   the persona table runs before the user table (`detector.ts:78-81`), so
//!   `"du hast mir geholfen"` is an *assistant* memory.
//! * The user table has no bare `you`/`du` pattern (`detector.ts:23`), only the
//!   conjugated forms, so `"you asked"` has no subject at all.

use regex::Regex;
use std::sync::OnceLock;

use super::types::{MemoryNode, MemorySubject};

/// `PERSONA_SELF_PATTERNS` from `detector.ts:5-19`.
///
/// Order matters: these are tried before the user-reference patterns, and the
/// German verb pairs inside them are matched before the bare pronoun patterns,
/// so `"kannst du"` reaches `isPersonaSelfReference` through the conjugated
/// pattern only.
fn persona_self_patterns() -> &'static Vec<Regex> {
    static PATTERNS: OnceLock<Vec<Regex>> = OnceLock::new();
    PATTERNS.get_or_init(|| {
        vec![
            regex::Regex::new(r"(?i)(?-u:\b)(?:ich)\s+(?:habe|bin|war|hatte|kann|will|muss|soll|werde|wurde)(?-u:\b)").expect("static regex"),
            regex::Regex::new(r"(?i)(?-u:\b)mein(?-u:\b)").expect("static regex"),
            regex::Regex::new(r"(?i)(?-u:\b)meine(?-u:\b)").expect("static regex"),
            regex::Regex::new(r"(?i)(?-u:\b)meinem(?-u:\b)").expect("static regex"),
            regex::Regex::new(r"(?i)(?-u:\b)meinen(?-u:\b)").expect("static regex"),
            regex::Regex::new(r"(?i)(?-u:\b)meiner(?-u:\b)").expect("static regex"),
            regex::Regex::new(r"(?i)(?-u:\b)meines(?-u:\b)").expect("static regex"),
            regex::Regex::new(r"(?i)(?-u:\b)mir(?-u:\b)").expect("static regex"),
            regex::Regex::new(r"(?i)(?-u:\b)mich(?-u:\b)").expect("static regex"),
            regex::Regex::new(r"(?i)(?-u:\b)i\s+(?:am|have|had|was|will|can|must|should)(?-u:\b)").expect("static regex"),
            regex::Regex::new(r"(?i)(?-u:\b)my(?-u:\b)").expect("static regex"),
            regex::Regex::new(r"(?i)(?-u:\b)mine(?-u:\b)").expect("static regex"),
            regex::Regex::new(r"(?i)(?-u:\b)myself(?-u:\b)").expect("static regex"),
        ]
    })
}

/// `USER_REFERENCE_PATTERNS` from `detector.ts:22-35`.
fn user_reference_patterns() -> &'static Vec<Regex> {
    static PATTERNS: OnceLock<Vec<Regex>> = OnceLock::new();
    PATTERNS.get_or_init(|| {
        vec![
            regex::Regex::new(r"(?i)(?-u:\b)du\s+(?:hast|bist|warst|hattest|kannst|willst|musst|sollst|wirst)(?-u:\b)").expect("static regex"),
            regex::Regex::new(r"(?i)(?-u:\b)dein(?-u:\b)").expect("static regex"),
            regex::Regex::new(r"(?i)(?-u:\b)deine(?-u:\b)").expect("static regex"),
            regex::Regex::new(r"(?i)(?-u:\b)deinem(?-u:\b)").expect("static regex"),
            regex::Regex::new(r"(?i)(?-u:\b)deinen(?-u:\b)").expect("static regex"),
            regex::Regex::new(r"(?i)(?-u:\b)deiner(?-u:\b)").expect("static regex"),
            regex::Regex::new(r"(?i)(?-u:\b)deines(?-u:\b)").expect("static regex"),
            regex::Regex::new(r"(?i)(?-u:\b)dir(?-u:\b)").expect("static regex"),
            regex::Regex::new(r"(?i)(?-u:\b)dich(?-u:\b)").expect("static regex"),
            regex::Regex::new(r"(?i)(?-u:\b)you\s+(?:are|have|had|were|will|can|must|should)(?-u:\b)").expect("static regex"),
            regex::Regex::new(r"(?i)(?-u:\b)your(?-u:\b)").expect("static regex"),
            regex::Regex::new(r"(?i)(?-u:\b)yours(?-u:\b)").expect("static regex"),
        ]
    })
}

/// `/^(ich|i)\b/` and `/^(mein|meine|my)\b/` from `detector.ts:85-86`.
fn leading_self_reference() -> &'static Vec<Regex> {
    static PATTERNS: OnceLock<Vec<Regex>> = OnceLock::new();
    PATTERNS.get_or_init(|| {
        vec![
            regex::Regex::new(r"(?i)^(?:ich|i)(?-u:\b)").expect("static regex"),
            regex::Regex::new(r"(?i)^(?:mein|meine|my)(?-u:\b)").expect("static regex"),
        ]
    })
}

/// `isPersonaSelfReference` from `detector.ts:41-44`.
pub fn is_persona_self_reference(content: &str) -> bool {
    let normalized = content.to_lowercase();
    let trimmed = normalized.trim();
    persona_self_patterns()
        .iter()
        .any(|pattern| pattern.is_match(trimmed))
}

/// `isUserReference` from `detector.ts:51-54`.
pub fn is_user_reference(content: &str) -> bool {
    let normalized = content.to_lowercase();
    let trimmed = normalized.trim();
    user_reference_patterns()
        .iter()
        .any(|pattern| pattern.is_match(trimmed))
}

/// `detectMemorySubject` from `detector.ts:54-88`.
pub fn detect_memory_subject(node: &MemoryNode) -> Option<MemorySubject> {
    // 1. Explicit metadata, set during ingestion.
    match node.metadata_text("subject").trim().to_lowercase().as_str() {
        "user" => return Some(MemorySubject::User),
        "assistant" | "persona" => return Some(MemorySubject::Assistant),
        "conversation" => return Some(MemorySubject::Conversation),
        _ => {}
    }

    // 2. The self-reference marker from ingestion.
    if node.metadata_flag("selfReference") {
        return Some(MemorySubject::Assistant);
    }

    // 3. The source role.
    match node
        .metadata_text("sourceRole")
        .trim()
        .to_lowercase()
        .as_str()
    {
        "user" => return Some(MemorySubject::User),
        "assistant" | "agent" | "persona" => return Some(MemorySubject::Assistant),
        _ => {}
    }

    // 4. Content patterns.
    let content = node.content.trim();
    if is_persona_self_reference(content) {
        return Some(MemorySubject::Assistant);
    }
    if is_user_reference(content) {
        return Some(MemorySubject::User);
    }

    // 5. Legacy leading-pattern fallback.
    let lowered = content.to_lowercase();
    if leading_self_reference()
        .iter()
        .any(|pattern| pattern.is_match(&lowered))
    {
        return Some(MemorySubject::Assistant);
    }

    None
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::memory::types::{MemoryMetadata, MemoryType};
    use serde_json::json;

    fn node(content: &str) -> MemoryNode {
        MemoryNode {
            id: "n".to_string(),
            node_type: MemoryType::Fact,
            content: content.to_string(),
            embedding: Vec::new(),
            importance: 3.0,
            confidence: 0.3,
            timestamp: "t".to_string(),
            metadata: None,
        }
    }

    #[test]
    fn an_explicit_metadata_subject_wins_over_the_content() {
        let mut explicit = node("du hast recht");
        explicit.metadata = Some(MemoryMetadata::from_iter([(
            "subject".to_string(),
            json!("assistant"),
        )]));
        assert_eq!(
            detect_memory_subject(&explicit),
            Some(MemorySubject::Assistant)
        );

        let mut lowercase = node("ich bin müde");
        lowercase.metadata = Some(MemoryMetadata::from_iter([(
            "subject".to_string(),
            json!("USER"),
        )]));
        assert_eq!(detect_memory_subject(&lowercase), Some(MemorySubject::User));
    }

    /// `persona` is accepted as an alias of `assistant` in both the explicit
    /// metadata and the source role, because the ingestion writers use either
    /// spelling.
    #[test]
    fn persona_is_an_alias_for_assistant() {
        let mut via_subject = node("x");
        via_subject.metadata = Some(MemoryMetadata::from_iter([(
            "subject".to_string(),
            json!("persona"),
        )]));
        assert_eq!(
            detect_memory_subject(&via_subject),
            Some(MemorySubject::Assistant)
        );

        let mut via_source_role = node("x");
        via_source_role.metadata = Some(MemoryMetadata::from_iter([(
            "sourceRole".to_string(),
            json!("agent"),
        )]));
        assert_eq!(
            detect_memory_subject(&via_source_role),
            Some(MemorySubject::Assistant)
        );
    }

    #[test]
    fn the_self_reference_marker_short_circuits_the_content_scan() {
        let mut self_reference = node("du hast recht");
        self_reference.metadata = Some(MemoryMetadata::from_iter([(
            "selfReference".to_string(),
            json!(true),
        )]));
        assert_eq!(
            detect_memory_subject(&self_reference),
            Some(MemorySubject::Assistant)
        );

        // Only `=== true` counts; a truthy string does not.
        let mut truthy_string = node("du hast recht");
        truthy_string.metadata = Some(MemoryMetadata::from_iter([(
            "selfReference".to_string(),
            json!("yes"),
        )]));
        assert_eq!(
            detect_memory_subject(&truthy_string),
            Some(MemorySubject::User)
        );
    }

    #[test]
    fn conjugated_pronouns_are_classified_by_content() {
        assert_eq!(
            detect_memory_subject(&node("ich habe heute gelernt")),
            Some(MemorySubject::Assistant)
        );
        // `mir` is a *persona* pattern (`detector.ts:13`) and the persona table
        // is tested before the user table (`detector.ts:78-81`), so the
        // TypeScript source reports `assistant` even though the sentence
        // addresses the user.
        assert_eq!(
            detect_memory_subject(&node("du hast mir geholfen")),
            Some(MemorySubject::Assistant)
        );
        assert_eq!(
            detect_memory_subject(&node("I am ready")),
            Some(MemorySubject::Assistant)
        );
        assert_eq!(
            detect_memory_subject(&node("your coffee")),
            Some(MemorySubject::User)
        );
        assert_eq!(detect_memory_subject(&node("plain fact")), None);
    }

    /// The self-reference patterns are checked first, so a node that contains
    /// both is reported as an assistant memory.
    #[test]
    fn self_reference_wins_over_user_reference() {
        // `ich habe` (`detector.ts:6`) and `dich` (`detector.ts:31`) both
        // match, and the persona branch returns first (`detector.ts:78`).
        assert_eq!(
            detect_memory_subject(&node("ich habe dich gefragt")),
            Some(MemorySubject::Assistant)
        );
        // The fixture this test used to carry is *not* such a node: `ich mag`
        // is not `ich` plus a listed verb (`detector.ts:6`), so only `deine`
        // (`detector.ts:26`) matches and the user branch decides
        // (`detector.ts:81`).
        assert_eq!(
            detect_memory_subject(&node("ich mag deine Fragen")),
            Some(MemorySubject::User)
        );
    }

    /// `/^(ich|i)\b/` is the last resort and needs a word boundary, so
    /// `"ich"` inside a larger word must not classify.
    #[test]
    fn the_leading_pattern_needs_a_word_boundary() {
        assert_eq!(
            detect_memory_subject(&node("ich")),
            Some(MemorySubject::Assistant)
        );
        assert_eq!(detect_memory_subject(&node("ichneumon")), None);
        assert_eq!(detect_memory_subject(&node("myth")), None);
    }

    /// JavaScript's `\b` is ASCII-only. `"übermir"` has an `r` before `mir`, so
    /// no boundary in either engine; `"über mir"` has a space, so both match.
    /// The interesting case is a non-ASCII letter directly before the word:
    /// JavaScript treats `ü` as a non-word character and the port must too.
    #[test]
    fn word_boundaries_are_ascii_like_javascript() {
        assert!(is_persona_self_reference("über mich"));
        assert!(is_persona_self_reference("für mich"));
        // No `\b` before `mich` in either engine: `r` is a word character.
        assert!(!is_persona_self_reference("übermich"));
        assert!(is_user_reference("an dich"));
    }
}
