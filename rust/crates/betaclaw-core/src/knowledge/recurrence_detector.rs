//! Port of `src/server/knowledge/recurrenceDetector.ts` (1-54).
//!
//! | TypeScript                                       | Rust |
//! | ------------------------------------------------ | ---- |
//! | `recurrenceDetector.ts:8` (`RecurrenceType`)       | [`RecurrenceType`] |
//! | `recurrenceDetector.ts:10-13` (`RecurrenceInfo`)   | [`RecurrenceInfo`] |
//! | `recurrenceDetector.ts:19-54` (`detectRecurrence`) | [`detect_recurrence`] |
//!
//! Detects recurring patterns in German text. Pure function, no service
//! dependency.
//!
//! # JavaScript semantics that are reproduced explicitly
//!
//! * `const lower = text.toLowerCase()` (`:20`) runs first, and every pattern is
//!   still case-insensitive; the port keeps both steps.
//! * The checks run in a fixed order — daily, weekday, weekly, monthly,
//!   generic — and the first hit returns (`:23-51`). `"jeden montag"` therefore
//!   yields `weekly` with `day`, not `daily`, although it is arguably both.
//! * `text.toLowerCase()` is the Unicode default mapping, so `'Ä'` becomes `'ä'`
//!   before the patterns run.
//!
//! # Word boundaries — JavaScript's `\b` is ASCII, the crate's is Unicode
//!
//! `\b` in JavaScript is defined over `\w === [A-Za-z0-9_]`; the Rust `regex`
//! crate's `\b` is Unicode-aware. The two disagree as soon as a non-ASCII
//! letter abuts a pattern word, and that is reachable in ordinary German input:
//! JavaScript classifies `"ütaeglich"` and `"maßtaeglich"` as daily, a Unicode
//! `\b` would not. Every boundary of this module is therefore written as
//! `(?-u:\b)`, the spelling [`crate::memory::subject`] already uses.
//!
//! `(?-u:\b)` cannot sit next to a non-ASCII literal, and the `üblicherweise`
//! alternative (`recurrenceDetector.ts:47`) starts with one. In JavaScript the
//! boundary *before* `ü` can only hold when the preceding character is an ASCII
//! word character — `ü` is not a word character, so the right-hand side never
//! supplies the word. [`recurring_umlaut_pattern`] spells that out as
//! `[0-9A-Za-z_]üblicherweise(?:[^0-9A-Za-z_]|$)`; the consequence is
//! reproduced on purpose: `"üblicherweise"` is **not** recurring while
//! `"xüblicherweise"` is, exactly as in Node 24.
//!
//! `\s` is spelled out as [`JS_WHITESPACE`] for the same reason: JavaScript's
//! `\s` contains `\u{FEFF}` but not `\u{0085}`, and the crate's Unicode `\s`
//! differs on both.
//!
//! # Regex justification
//!
//! Every check needs case-insensitive alternation plus the boundaries above;
//! hand-rolling that would be less faithful than `regex`, which the workspace
//! already depends on for exactly this class of pattern (see the `regex`
//! comment in `rust/Cargo.toml`).

use regex::Regex;
use std::sync::OnceLock;

/// `RecurrenceType` (`recurrenceDetector.ts:8`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RecurrenceType {
    Daily,
    Weekly,
    Monthly,
    Recurring,
}

impl RecurrenceType {
    /// The TypeScript union member, verbatim.
    pub fn as_str(self) -> &'static str {
        match self {
            RecurrenceType::Daily => "daily",
            RecurrenceType::Weekly => "weekly",
            RecurrenceType::Monthly => "monthly",
            RecurrenceType::Recurring => "recurring",
        }
    }
}

/// `RecurrenceInfo` (`recurrenceDetector.ts:10-13`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RecurrenceInfo {
    pub recurrence_type: RecurrenceType,
    pub day: Option<String>,
}

/// JavaScript's `\s` (`ES2015+`):
/// `[ \t\n\v\f\r\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000\ufeff]`.
///
/// Spelled out because neither the crate's Unicode `\s` (which adds
/// `\u{0085}`) nor a naive `[ \t\n]` matches it. `pub(crate)` so the other
/// knowledge-root modules that split on JavaScript whitespace reuse the very
/// same fragment instead of restating it.
pub(crate) const JS_WHITESPACE: &str = r"[\t\n\x0B\x0C\r \u{00A0}\u{1680}\u{2000}-\u{200A}\u{2028}\u{2029}\u{202F}\u{205F}\u{3000}\u{FEFF}]";

/// `/\b(taeglich|täglich|jeden\s+tag)\b/i` (`recurrenceDetector.ts:23`).
fn daily_pattern() -> &'static Regex {
    static PATTERN: OnceLock<Regex> = OnceLock::new();
    PATTERN.get_or_init(|| {
        Regex::new(&format!(
            r"(?i)(?-u:\b)(taeglich|täglich|jeden{JS_WHITESPACE}+tag)(?-u:\b)"
        ))
        .expect("daily pattern")
    })
}

/// `/\bjeden\s+(montag|…|sonntag)\b/i` (`recurrenceDetector.ts:28-29`).
fn weekday_pattern() -> &'static Regex {
    static PATTERN: OnceLock<Regex> = OnceLock::new();
    PATTERN.get_or_init(|| {
        Regex::new(&format!(
            r"(?i)(?-u:\b)jeden{JS_WHITESPACE}+(montag|dienstag|mittwoch|donnerstag|freitag|samstag|sonntag)(?-u:\b)"
        ))
        .expect("weekday pattern")
    })
}

/// `/\b(woechentlich|wöchentlich)\b/i` (`recurrenceDetector.ts:35`).
fn weekly_pattern() -> &'static Regex {
    static PATTERN: OnceLock<Regex> = OnceLock::new();
    PATTERN.get_or_init(|| {
        Regex::new(r"(?i)(?-u:\b)(woechentlich|wöchentlich)(?-u:\b)").expect("weekly pattern")
    })
}

/// `/\b(monatlich|jeden\s+monat)\b/i` (`recurrenceDetector.ts:40`).
fn monthly_pattern() -> &'static Regex {
    static PATTERN: OnceLock<Regex> = OnceLock::new();
    PATTERN.get_or_init(|| {
        Regex::new(&format!(
            r"(?i)(?-u:\b)(monatlich|jeden{JS_WHITESPACE}+monat)(?-u:\b)"
        ))
        .expect("monthly pattern")
    })
}

/// `/\b(immer|regelmaessig|regelmäßig|normalerweise|gewoehnlich|gewöhnlich|ueblicherweise)\b/i`
/// (`recurrenceDetector.ts:45-48`) — the ASCII-initial alternatives; the
/// `üblicherweise` alternative needs its own pattern, see
/// [`recurring_umlaut_pattern`].
fn recurring_pattern() -> &'static Regex {
    static PATTERN: OnceLock<Regex> = OnceLock::new();
    PATTERN.get_or_init(|| {
        Regex::new(
            r"(?i)(?-u:\b)(immer|regelmaessig|regelmäßig|normalerweise|gewoehnlich|gewöhnlich|ueblicherweise)(?-u:\b)",
        )
        .expect("recurring pattern")
    })
}

/// The `üblicherweise` alternative of `recurrenceDetector.ts:47`, with the
/// JavaScript boundary of a literal that *starts* with a non-word character:
/// the preceding character has to be an ASCII word character and the following
/// one must not be. `(?-u:\b)` cannot express this next to a non-ASCII literal.
fn recurring_umlaut_pattern() -> &'static Regex {
    static PATTERN: OnceLock<Regex> = OnceLock::new();
    PATTERN.get_or_init(|| {
        Regex::new(r"(?i)[0-9A-Za-z_]üblicherweise(?:[^0-9A-Za-z_]|$)").expect("umlaut pattern")
    })
}

/// `detectRecurrence(text)` (`recurrenceDetector.ts:19-54`).
///
/// The checks run in the order of the source; the first hit wins (`:23-51`).
pub fn detect_recurrence(text: &str) -> Option<RecurrenceInfo> {
    let lower = text.to_lowercase();

    if daily_pattern().is_match(&lower) {
        return Some(RecurrenceInfo {
            recurrence_type: RecurrenceType::Daily,
            day: None,
        });
    }

    if let Some(captures) = weekday_pattern().captures(&lower) {
        let day = captures
            .get(1)
            .expect("the weekday group always participates on a match")
            .as_str()
            .to_lowercase();
        return Some(RecurrenceInfo {
            recurrence_type: RecurrenceType::Weekly,
            day: Some(day),
        });
    }

    if weekly_pattern().is_match(&lower) {
        return Some(RecurrenceInfo {
            recurrence_type: RecurrenceType::Weekly,
            day: None,
        });
    }

    if monthly_pattern().is_match(&lower) {
        return Some(RecurrenceInfo {
            recurrence_type: RecurrenceType::Monthly,
            day: None,
        });
    }

    if recurring_pattern().is_match(&lower) || recurring_umlaut_pattern().is_match(&lower) {
        return Some(RecurrenceInfo {
            recurrence_type: RecurrenceType::Recurring,
            day: None,
        });
    }

    None
}

#[cfg(test)]
mod tests {
    use super::*;

    fn info(recurrence_type: RecurrenceType, day: Option<&str>) -> RecurrenceInfo {
        RecurrenceInfo {
            recurrence_type,
            day: day.map(str::to_string),
        }
    }

    /// The daily branch, including `jeden tag` with whitespace that JavaScript's
    /// `\s` accepts and the crate's Unicode `\s` does not (`\u{FEFF}`) or does
    /// too while JavaScript does not (`\u{0085}`).
    #[test]
    fn daily_patterns_match_as_in_node() {
        for text in [
            "Ich trinke taeglich Kaffee",
            "Täglich um 8",
            "jeden Tag",
            "jeden   Tag",
            "jeden\u{00a0}Tag",
            "jeden\u{feff}Tag",
            "TAEGLICH",
            "taeglich",
            "TAEGLICH!",
            "(taeglich)",
            // JavaScript's `\b` is ASCII: a non-ASCII letter before the keyword
            // is not a word character, so the boundary holds.
            "ütaeglich",
            "maßtaeglich",
            "pätaeglich",
        ] {
            assert_eq!(
                detect_recurrence(text),
                Some(info(RecurrenceType::Daily, None)),
                "{text}"
            );
        }
        // `\u{0085}` is not part of JavaScript's `\s`, and the trailing
        // boundary still applies.
        assert_eq!(detect_recurrence("jeden\u{0085}tag"), None);
        assert_eq!(detect_recurrence("taeglichsein"), None);
    }

    /// `/jeden\s+(montag|…)/i` returns the day, lower-cased (`:30`).
    #[test]
    fn any_weekday_reports_its_name_in_lower_case() {
        for (text, day) in [
            ("Jeden Montag", "montag"),
            ("jeden   Montag", "montag"),
            ("Jeden\tMontag", "montag"),
            ("JEDEN SONNTAG", "sonntag"),
            ("jeden dienstag", "dienstag"),
            ("jeden mittwoch", "mittwoch"),
            ("jeden donnerstag", "donnerstag"),
            ("jeden freitag", "freitag"),
            ("jeden samstag", "samstag"),
        ] {
            assert_eq!(
                detect_recurrence(text),
                Some(info(RecurrenceType::Weekly, Some(day))),
                "{text}"
            );
        }
        // Without `jeden` there is no day, and `jeden montags` is no match.
        assert_eq!(detect_recurrence("Montag"), None);
        assert_eq!(detect_recurrence("jeden montags"), None);
    }

    #[test]
    fn weekly_and_monthly_patterns_match_as_in_node() {
        for text in ["woechentlich", "Wöchentlich"] {
            assert_eq!(
                detect_recurrence(text),
                Some(info(RecurrenceType::Weekly, None)),
                "{text}"
            );
        }
        for text in ["monatlich", "Monatlich", "jeden Monat"] {
            assert_eq!(
                detect_recurrence(text),
                Some(info(RecurrenceType::Monthly, None)),
                "{text}"
            );
        }
    }

    /// The `üblicherweise` boundary quirk: sentence-initial `üblicherweise` is
    /// *not* recurring in Node 24, but its ASCII-preceded form is.
    #[test]
    fn the_umlaut_alternative_needs_an_ascii_word_character_before_it() {
        for text in [
            "immer",
            "regelmäßig",
            "normalerweise",
            "gewöhnlich",
            "ueblicherweise",
        ] {
            assert_eq!(
                detect_recurrence(text),
                Some(info(RecurrenceType::Recurring, None)),
                "{text}"
            );
        }
        for text in [
            "üblicherweise",
            "Üblicherweise",
            "üblicherweise.",
            "üblicherweiseä",
        ] {
            assert_eq!(detect_recurrence(text), None, "{text}");
        }
        for text in ["xüblicherweise", "xüblicherweiseä"] {
            assert_eq!(
                detect_recurrence(text),
                Some(info(RecurrenceType::Recurring, None)),
                "{text}"
            );
        }
        // The trailing boundary of the ASCII-initial alternatives applies too.
        assert_eq!(detect_recurrence("Wörtimmer"), None);
        assert_eq!(detect_recurrence("nimma"), None);
    }

    /// The branch order of `:23-51`: the first hit wins, so a text that carries
    /// two patterns is classified by the earlier one.
    #[test]
    fn the_branches_run_in_source_order() {
        assert_eq!(
            detect_recurrence("jeden montag"),
            Some(info(RecurrenceType::Weekly, Some("montag")))
        );
        assert_eq!(
            detect_recurrence("üblicherweise montags taeglich"),
            Some(info(RecurrenceType::Daily, None))
        );
        assert_eq!(
            detect_recurrence("normalerweise jeden Monat"),
            Some(info(RecurrenceType::Monthly, None))
        );
        assert_eq!(
            detect_recurrence("immer wieder"),
            Some(info(RecurrenceType::Recurring, None))
        );
    }

    /// No pattern hits: the source returns `null` (`:53`).
    #[test]
    fn unrelated_text_has_no_recurrence() {
        assert_eq!(detect_recurrence(""), None);
        assert_eq!(detect_recurrence("no match here"), None);
    }

    /// `RecurrenceType` keeps the TypeScript union spellings (`:8`).
    #[test]
    fn the_type_spellings_are_the_typescript_ones() {
        assert_eq!(RecurrenceType::Daily.as_str(), "daily");
        assert_eq!(RecurrenceType::Weekly.as_str(), "weekly");
        assert_eq!(RecurrenceType::Monthly.as_str(), "monthly");
        assert_eq!(RecurrenceType::Recurring.as_str(), "recurring");
    }
}
