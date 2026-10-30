//! Port of `src/server/knowledge/personaTypeDetector.ts` (1-116).
//!
//! | TypeScript                                       | Rust |
//! | ------------------------------------------------ | ---- |
//! | `personaTypeDetector.ts:11-12` (`PersonaType` import + re-export) | [`crate::personas::types::MemoryPersonaType`] |
//! | `personaTypeDetector.ts:14-34` (`BUILDER_KEYWORDS`) | [`BUILDER_KEYWORDS`] |
//! | `personaTypeDetector.ts:36-54` (`ROLEPLAY_KEYWORDS`) | [`ROLEPLAY_KEYWORDS`] |
//! | `personaTypeDetector.ts:56-73` (`ASSISTANT_KEYWORDS`) | [`ASSISTANT_KEYWORDS`] |
//! | `personaTypeDetector.ts:75` (`MIN_SCORE_THRESHOLD`)  | [`MIN_SCORE_THRESHOLD`] |
//! | `personaTypeDetector.ts:77-85` (`countMatches`)      | [`count_matches`] |
//! | `personaTypeDetector.ts:92-116` (`detectPersonaType`) | [`detect_persona_type`] |
//!
//! Auto-detects the persona archetype from `SOUL.md` / `IDENTITY.md` content.
//! Pure function, no service dependency.
//!
//! # JavaScript semantics that are reproduced explicitly
//!
//! * `Object.values(files)` iterates in insertion order; the port takes an
//!   ordered iterator so the join is built in the same order. Order only matters
//!   for a keyword that contains a space (`'app router'`) that would otherwise
//!   straddle a file boundary.
//! * `filter((v): v is string => typeof v === 'string')` drops `undefined` and
//!   every non-string; the port's `Option<T>` is that filter.
//! * `countMatches` counts each keyword **at most once**, no matter how often it
//!   occurs — it is an `includes` count, not an occurrence count. A keyword that
//!   is a substring of another word still counts (`'git'` inside `'github'`).
//! * The scores are `[builder, roleplay, assistant]` (`:104-108`) and
//!   `Array.prototype.sort` is stable, so a tie always resolves to the earlier
//!   entry: `builder` beats `roleplay`, which beats `assistant`. The port uses
//!   `sort_by`, which is stable as well.
//! * `if (best[1] < MIN_SCORE_THRESHOLD)` (`:113`) is strict, so exactly three
//!   matches are already enough, and a tie below the threshold still returns
//!   `'general'`.
//! * `if (!allContent.trim())` (`:98`) also catches the whitespace-only result
//!   of joining blank files.
//!
//! All expected values below were produced with Node 24 against the TypeScript
//! source.

use crate::personas::types::MemoryPersonaType;

/// `BUILDER_KEYWORDS` (`personaTypeDetector.ts:14-34`).
pub const BUILDER_KEYWORDS: &[&str] = &[
    "entwickl",
    "code",
    "programm",
    "next.js",
    "react",
    "typescript",
    "framework",
    "deploy",
    "api",
    "database",
    "prisma",
    "bug",
    "feature",
    "build",
    "test",
    "commit",
    "git",
    "docker",
    "app router",
];

/// `ROLEPLAY_KEYWORDS` (`personaTypeDetector.ts:36-54`).
pub const ROLEPLAY_KEYWORDS: &[&str] = &[
    "gefuehl",
    "empathie",
    "freund",
    "liebe",
    "beziehung",
    "emotion",
    "rollenspi",
    "charakter",
    "persoenlichkeit",
    "locker",
    "warmherzig",
    "zuhoer",
    "humor",
    "erinner",
    "story",
    "erzaehl",
    "erlebnis",
];

/// `ASSISTANT_KEYWORDS` (`personaTypeDetector.ts:56-73`).
pub const ASSISTANT_KEYWORDS: &[&str] = &[
    "aufgabe",
    "termin",
    "deadline",
    "erinnerung",
    "kalender",
    "plan",
    "organis",
    "todo",
    "priorit",
    "zeitmanagement",
    "assistent",
    "hilfe",
    "alltag",
    "buero",
    "produktiv",
    "workflow",
];

/// `MIN_SCORE_THRESHOLD` (`personaTypeDetector.ts:75`).
pub const MIN_SCORE_THRESHOLD: usize = 3;

/// `countMatches(text, keywords)` (`personaTypeDetector.ts:77-85`).
pub fn count_matches(text: &str, keywords: &[&str]) -> usize {
    keywords
        .iter()
        .filter(|keyword| text.contains(**keyword))
        .count()
}

/// `detectPersonaType(files)` (`personaTypeDetector.ts:92-116`).
///
/// Returns the archetype with the highest keyword match count, or
/// [`MemoryPersonaType::General`] if no archetype reaches
/// [`MIN_SCORE_THRESHOLD`].
pub fn detect_persona_type<S, T>(
    files: impl IntoIterator<Item = (S, Option<T>)>,
) -> MemoryPersonaType
where
    S: AsRef<str>,
    T: AsRef<str>,
{
    let all_content = files
        .into_iter()
        .filter_map(|(_, value)| value)
        .map(|value| value.as_ref().to_string())
        .collect::<Vec<_>>()
        .join(" ")
        .to_lowercase();

    if all_content.trim().is_empty() {
        return MemoryPersonaType::General;
    }

    let mut scores = [
        (
            MemoryPersonaType::Builder,
            count_matches(&all_content, BUILDER_KEYWORDS),
        ),
        (
            MemoryPersonaType::Roleplay,
            count_matches(&all_content, ROLEPLAY_KEYWORDS),
        ),
        (
            MemoryPersonaType::Assistant,
            count_matches(&all_content, ASSISTANT_KEYWORDS),
        ),
    ];
    // Stable descending sort: a tie keeps the declaration order above.
    scores.sort_by(|left, right| right.1.cmp(&left.1));

    let (best_type, best_score) = scores[0];
    if best_score < MIN_SCORE_THRESHOLD {
        return MemoryPersonaType::General;
    }
    best_type
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn three_builder_keywords_are_enough() {
        assert_eq!(
            detect_persona_type([("soul", Some("entwickl code programm")), ("identity", None)]),
            MemoryPersonaType::Builder
        );
        assert_eq!(
            detect_persona_type([("soul", Some("ENTWICKL CODE PROGRAMM"))]),
            MemoryPersonaType::Builder
        );
    }

    #[test]
    fn two_matches_stay_general() {
        assert_eq!(
            detect_persona_type([("a", Some("nur zwei")), ("b", Some("entwickl code"))]),
            MemoryPersonaType::General
        );
    }

    #[test]
    fn blank_and_missing_files_yield_general() {
        assert_eq!(
            detect_persona_type([("soul", Some("   "))]),
            MemoryPersonaType::General
        );
        assert_eq!(
            detect_persona_type([("soul", None::<&str>)]),
            MemoryPersonaType::General
        );
        assert_eq!(
            detect_persona_type(Vec::<(&str, Option<&str>)>::new()),
            MemoryPersonaType::General
        );
    }

    #[test]
    fn a_tie_above_the_threshold_resolves_to_the_declared_order() {
        // builder, roleplay and assistant score four each; builder is first.
        assert_eq!(
            detect_persona_type([(
                "soul",
                Some("feature react bug git gefuehl liebe emotion humor aufgabe termin deadline kalender")
            )]),
            MemoryPersonaType::Builder
        );
        // Without the builder pair, roleplay (3) beats assistant (3).
        assert_eq!(
            detect_persona_type([(
                "soul",
                Some("gefuehl liebe emotion aufgabe termin deadline")
            )]),
            MemoryPersonaType::Roleplay
        );
        assert_eq!(
            detect_persona_type([("soul", Some("aufgabe termin deadline"))]),
            MemoryPersonaType::Assistant
        );
    }

    #[test]
    fn a_tie_below_the_threshold_still_returns_general() {
        // Every archetype scores two — below MIN_SCORE_THRESHOLD.
        assert_eq!(
            detect_persona_type([("soul", Some("feature react gefuehl liebe aufgabe termin"))]),
            MemoryPersonaType::General
        );
    }

    #[test]
    fn a_keyword_is_counted_once_no_matter_how_often_it_occurs() {
        assert_eq!(count_matches("code code code", BUILDER_KEYWORDS), 1);
        // `git` is a substring of `github`, and `commit` follows: Node 24
        // counts two, not three — `countMatches` is an `includes` count.
        assert_eq!(count_matches("github commit", BUILDER_KEYWORDS), 2);
    }

    #[test]
    fn the_keyword_lists_keep_the_source_order_and_length() {
        assert_eq!(BUILDER_KEYWORDS.len(), 19);
        assert_eq!(ROLEPLAY_KEYWORDS.len(), 17);
        assert_eq!(ASSISTANT_KEYWORDS.len(), 16);
        assert_eq!(BUILDER_KEYWORDS[3], "next.js");
        assert_eq!(BUILDER_KEYWORDS[18], "app router");
        assert_eq!(ASSISTANT_KEYWORDS[0], "aufgabe");
        assert_eq!(ASSISTANT_KEYWORDS[15], "workflow");
    }
}
