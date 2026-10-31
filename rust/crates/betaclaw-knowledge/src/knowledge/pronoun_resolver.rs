//! Port of `src/server/knowledge/pronounResolver.ts` (1-39).
//!
//! | TypeScript                                          | Rust |
//! | --------------------------------------------------- | ---- |
//! | `pronounResolver.ts:8-13` (`PronounContext`)        | [`PronounContext`] |
//! | `pronounResolver.ts:20` (`MASCULINE_REFERENCE`)     | [`masculine_reference`] |
//! | `pronounResolver.ts:31-39` (`resolvePronouns`)      | [`resolve_pronouns`] |
//!
//! # JavaScript semantics that are reproduced explicitly
//!
//! * `String.replace(regex, () => …)` inserts the replacement *literally*:
//!   `$&` or `$1` inside `lastMentionedPerson` survive as text. [`NoExpand`]
//!   carries that over — `Regex::replace_all` with a plain `&str` would expand
//!   `$1` into a capture group.
//! * `\b` is JavaScript's ASCII boundary, written `(?-u:\b)` exactly like
//!   [`crate::memory::subject`]. `"DER Baum"` is therefore left alone.
//! * `if (!context.lastMentionedPerson)` (`:32`) is a falsiness test, so the
//!   empty string behaves like `null`; both are reproduced.
//! * The source's `MASCULINE_REFERENCE.test(fact)` (`:33`) leaves `lastIndex`
//!   of the `/g` regex at the end of the match, which is why `:36` resets it.
//!   The port builds a fresh [`Regex`] per call and has no shared state; the
//!   reset makes the JavaScript observable behaviour identical.
//!
//! # Deviation
//!
//! `lastMentionedProject`, `speakerPersonaName` and `speakerUserId` are carried
//! but never read, exactly as in `resolvePronouns` (`:31-38`); they stay on the
//! struct because the ingestion caller fills them
//! (`src/server/knowledge/ingestion/service.ts`).

use regex::{NoExpand, Regex};
use std::sync::OnceLock;

/// `PronounContext` from `pronounResolver.ts:8-13`.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct PronounContext {
    pub last_mentioned_person: Option<String>,
    pub last_mentioned_project: Option<String>,
    pub speaker_persona_name: String,
    pub speaker_user_id: String,
}

/// `MASCULINE_REFERENCE` from `pronounResolver.ts:20`.
///
/// Feminine and neutral pronouns (`sie`, `ihr`, `es`) are deliberately absent:
/// `"sie"` can be `"she"` or `"they"`, so the source keeps the ambiguity.
pub fn masculine_reference() -> &'static Regex {
    static PATTERN: OnceLock<Regex> = OnceLock::new();
    PATTERN.get_or_init(|| {
        Regex::new(r"(?i)(?-u:\b)(er|ihm|sein|seinen|seinem|seiner)(?-u:\b)")
            .expect("masculine reference pattern")
    })
}

/// `resolvePronouns(fact, context)` (`pronounResolver.ts:31-39`).
///
/// Perspective pronouns (`ich`, `mein`, `du`, `dein`) are not part of the
/// pattern and therefore pass through unchanged.
pub fn resolve_pronouns(fact: &str, context: &PronounContext) -> String {
    let person = match context.last_mentioned_person.as_deref() {
        None | Some("") => return fact.to_string(),
        Some(person) => person,
    };

    let pattern = masculine_reference();
    if !pattern.is_match(fact) {
        return fact.to_string();
    }

    pattern.replace_all(fact, NoExpand(person)).into_owned()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn context(person: Option<&str>) -> PronounContext {
        PronounContext {
            last_mentioned_person: person.map(str::to_string),
            last_mentioned_project: Some("Projekt Atlas".to_string()),
            speaker_persona_name: "Nata".to_string(),
            speaker_user_id: "user-1".to_string(),
        }
    }

    #[test]
    fn without_a_mentioned_person_the_fact_is_returned_unchanged() {
        assert_eq!(
            resolve_pronouns("Er hat sein Buch", &context(None)),
            "Er hat sein Buch"
        );
        // The empty string is falsy in the source too (`:32`).
        assert_eq!(
            resolve_pronouns("Er hat sein Buch", &context(Some(""))),
            "Er hat sein Buch"
        );
    }

    #[test]
    fn every_masculine_reference_is_replaced() {
        assert_eq!(
            resolve_pronouns("Er hat sein Buch", &context(Some("Nata"))),
            "Nata hat Nata Buch"
        );
        assert_eq!(
            resolve_pronouns("er und ihm und sein", &context(Some("Nata"))),
            "Nata und Nata und Nata"
        );
    }

    #[test]
    fn perspective_pronouns_and_feminine_forms_stay_untouched() {
        assert_eq!(
            resolve_pronouns("Ich habe mein Buch", &context(Some("Nata"))),
            "Ich habe mein Buch"
        );
        // `seins` is a longer word: the ASCII boundary blocks the match.
        assert_eq!(
            resolve_pronouns("Sein Buch ist seins", &context(Some("Nata"))),
            "Nata Buch ist seins"
        );
        assert_eq!(
            resolve_pronouns("DER Baum", &context(Some("Nata"))),
            "DER Baum"
        );
    }

    /// A functional replacement is literal, so no `$`-expansion happens.
    #[test]
    fn a_dollar_in_the_person_name_is_inserted_literally() {
        assert_eq!(
            resolve_pronouns("er und ihm und sein", &context(Some("$1 & $&"))),
            "$1 & $& und $1 & $& und $1 & $&"
        );
    }
}
