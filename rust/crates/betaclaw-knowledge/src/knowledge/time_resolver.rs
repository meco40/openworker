//! Port of `src/server/knowledge/timeResolver.ts` (1-193).
//!
//! | TypeScript | Rust |
//! | --- | --- |
//! | `TimeResolutionContext` (`:6-9`) | [`TimeResolutionContext`] |
//! | `ResolvedTime` (`:11-17`) | [`ResolvedTime`] |
//! | `GERMAN_NUMBERS` + `parseGermanNumber` (`:19-44`) | [`parse_german_number`] |
//! | `toUserLocalDate` (`:46-63`) | [`to_user_local_date`] |
//! | `formatDate` (`:65-70`) | [`format_date`] |
//! | `addDays` (`:72-76`) | [`add_days`] |
//! | `resolveRelativeTime` (`:82-193`) | [`resolve_relative_time`] (calls [`resolve_on`]) |
//!
//! # Time zones
//!
//! `toUserLocalDate` resolves an IANA name with `Intl.DateTimeFormat`. The port
//! resolves it with `chrono-tz`, which carries the IANA database, so every valid
//! name gives the TypeScript's calendar day, summer-time changes included.
//!
//! * An unknown name makes `Intl.DateTimeFormat` throw a `RangeError`. The port
//!   returns [`None`], which the callers already read as "no date resolved".
//! * `None` and the empty name use the **system** zone. The TypeScript returns the
//!   UTC instant for them, and its local getters then read the system zone.
//!
//! # Other deviations
//!
//! * An unparsable `messageTimestamp` makes JavaScript produce `NaN-NaN-NaN`
//!   strings. The port returns [`None`] instead.
//! * `\w` is ASCII (`[0-9A-Za-z_]`), like the TypeScript regex. So
//!   `in fünf Tagen` does not match the "in N Tagen" pattern, in both versions.
//! * `new Date(y, m, d)` rolls over an impossible day (`31.02.` becomes
//!   March 3rd); [`js_date`] reproduces that.

use std::sync::LazyLock;

use chrono::{DateTime, Datelike, Local, NaiveDate, Utc};
use chrono_tz::Tz;
use regex::Regex;

/// `TimeResolutionContext` (`timeResolver.ts:6-9`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TimeResolutionContext {
    /// ISO timestamp of the message.
    pub message_timestamp: String,
    /// IANA name such as `Europe/Berlin`; see the module header.
    pub user_timezone: Option<String>,
}

/// `ResolvedTime` (`timeResolver.ts:11-17`).
#[derive(Debug, Clone, PartialEq)]
pub struct ResolvedTime {
    /// `YYYY-MM-DD`.
    pub absolute_date: String,
    /// `YYYY-MM-DD` for ranges such as "letzte Woche".
    pub absolute_date_end: Option<String>,
    pub resolution_confidence: f64,
    pub was_relative: bool,
    pub original_text: String,
}

/// `GERMAN_NUMBERS[lower]` (`timeResolver.ts:19-37`).
fn german_number(word: &str) -> Option<i64> {
    Some(match word {
        "ein" | "eins" | "einem" | "einer" => 1,
        "zwei" => 2,
        "drei" => 3,
        "vier" => 4,
        "fuenf" | "fünf" => 5,
        "sechs" => 6,
        "sieben" => 7,
        "acht" => 8,
        "neun" => 9,
        "zehn" => 10,
        "elf" => 11,
        "zwoelf" | "zwölf" => 12,
        _ => return None,
    })
}

/// `parseGermanNumber` (`timeResolver.ts:39-44`). Falls back to a leading
/// integer like `parseInt`, and to `1` when there is none.
pub fn parse_german_number(word: &str) -> i64 {
    let lower = word.to_lowercase();
    if let Some(number) = german_number(&lower) {
        return number;
    }
    let digits: String = lower.chars().take_while(|ch| ch.is_ascii_digit()).collect();
    digits.parse::<i64>().unwrap_or(1)
}

/// `toUserLocalDate` (`timeResolver.ts:46-63`). The calendar date of the instant
/// in `user_timezone`. See the module header for unknown names and the system zone.
pub fn to_user_local_date(iso_timestamp: &str, user_timezone: Option<&str>) -> Option<NaiveDate> {
    let instant = DateTime::parse_from_rfc3339(iso_timestamp.trim())
        .ok()?
        .with_timezone(&Utc);
    match user_timezone.filter(|name| !name.is_empty()) {
        Some(name) => {
            let zone: Tz = name.parse().ok()?;
            Some(instant.with_timezone(&zone).date_naive())
        }
        None => Some(instant.with_timezone(&Local).date_naive()),
    }
}

/// `formatDate` (`timeResolver.ts:65-70`): `YYYY-MM-DD`, month and day padded.
pub fn format_date(date: NaiveDate) -> String {
    format!("{}-{:02}-{:02}", date.year(), date.month(), date.day())
}

/// `addDays` (`timeResolver.ts:72-76`).
pub fn add_days(date: NaiveDate, days: i64) -> Option<NaiveDate> {
    date.checked_add_signed(chrono::Duration::days(days))
}

/// `new Date(year, monthIndex, day)` as used by the full-date and short-date
/// branches of `resolveRelativeTime`. JavaScript rolls months and days over
/// instead of rejecting them, so the port adds the offset to the first of the
/// month.
fn js_date(year: i32, month: i64, day: i64) -> Option<NaiveDate> {
    // `month` is 1-based here; `month - 1` may be negative, like in JavaScript.
    let month0 = month - 1;
    let year = i64::from(year) + month0.div_euclid(12);
    let month_index = month0.rem_euclid(12) + 1;
    let first = NaiveDate::from_ymd_opt(
        i32::try_from(year).ok()?,
        u32::try_from(month_index).ok()?,
        1,
    )?;
    add_days(first, day - 1)
}

static IN_N_DAYS: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?i)\bin\s+([0-9A-Za-z_]+)\s+tagen?\b").expect("in-n-days"));
static FULL_DATE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"([0-9]{1,2})\.([0-9]{1,2})\.([0-9]{4})").expect("full date"));
static SHORT_DATE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"([0-9]{1,2})\.([0-9]{1,2})\.").expect("short date"));
static HEUTE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?i)\bheute\b").expect("heute"));
static GESTERN: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?i)\bgestern\b").expect("gestern"));
static VORGESTERN: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?i)\bvorgestern\b").expect("vorgestern"));
static MORGEN: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?i)\bmorgen\b").expect("morgen"));
static GUTEN_MORGEN: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?i)\bguten\s+morgen\b").expect("guten morgen"));
static LETZTE_WOCHE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?i)\bletzte\s+woche\b").expect("letzte woche"));

/// `resolveRelativeTime` (`timeResolver.ts:82-193`).
pub fn resolve_relative_time(text: &str, context: &TimeResolutionContext) -> Option<ResolvedTime> {
    let reference =
        to_user_local_date(&context.message_timestamp, context.user_timezone.as_deref())?;
    resolve_on(text, reference)
}

/// The body of `resolveRelativeTime` for a known reference day. Kept separate
/// so the tests do not depend on the host time zone.
pub fn resolve_on(text: &str, reference: NaiveDate) -> Option<ResolvedTime> {
    let relative = |date: NaiveDate, confidence: f64| ResolvedTime {
        absolute_date: format_date(date),
        absolute_date_end: None,
        resolution_confidence: confidence,
        was_relative: true,
        original_text: text.to_string(),
    };

    if HEUTE.is_match(text) {
        return Some(relative(reference, 0.95));
    }
    if GESTERN.is_match(text) {
        return Some(relative(add_days(reference, -1)?, 0.95));
    }
    if VORGESTERN.is_match(text) {
        return Some(relative(add_days(reference, -2)?, 0.95));
    }
    if MORGEN.is_match(text) && !GUTEN_MORGEN.is_match(text) {
        return Some(relative(add_days(reference, 1)?, 0.95));
    }
    if let Some(captures) = IN_N_DAYS.captures(text) {
        let days = parse_german_number(&captures[1]);
        return Some(relative(add_days(reference, days)?, 0.9));
    }
    if LETZTE_WOCHE.is_match(text) {
        // JavaScript: getDay() 0 = Sunday. The Monday of the current week is
        // `-6` on a Sunday and `-(day - 1)` otherwise.
        let day_of_week = reference.weekday().num_days_from_sunday() as i64;
        let monday_offset = if day_of_week == 0 {
            -6
        } else {
            -(day_of_week - 1)
        };
        let this_monday = add_days(reference, monday_offset)?;
        let last_monday = add_days(this_monday, -7)?;
        let last_sunday = add_days(last_monday, 6)?;
        return Some(ResolvedTime {
            absolute_date: format_date(last_monday),
            absolute_date_end: Some(format_date(last_sunday)),
            resolution_confidence: 0.85,
            was_relative: true,
            original_text: text.to_string(),
        });
    }
    if let Some(captures) = FULL_DATE.captures(text) {
        let day: i64 = captures[1].parse().ok()?;
        let month: i64 = captures[2].parse().ok()?;
        let year: i32 = captures[3].parse().ok()?;
        let resolved = js_date(year, month, day)?;
        return Some(ResolvedTime {
            absolute_date: format_date(resolved),
            absolute_date_end: None,
            resolution_confidence: 1.0,
            was_relative: false,
            original_text: text.to_string(),
        });
    }
    if let Some(captures) = SHORT_DATE.captures(text) {
        let day: i64 = captures[1].parse().ok()?;
        let month: i64 = captures[2].parse().ok()?;
        let resolved = js_date(reference.year(), month, day)?;
        return Some(ResolvedTime {
            absolute_date: format_date(resolved),
            absolute_date_end: None,
            resolution_confidence: 1.0,
            was_relative: false,
            original_text: text.to_string(),
        });
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Wednesday, 11 February 2026.
    fn reference() -> NaiveDate {
        NaiveDate::from_ymd_opt(2026, 2, 11).expect("reference day")
    }

    #[test]
    fn heute_gestern_vorgestern_and_morgen() {
        let r = reference();
        assert_eq!(
            resolve_on("heute", r).expect("heute").absolute_date,
            "2026-02-11"
        );
        assert_eq!(
            resolve_on("gestern", r).expect("gestern").absolute_date,
            "2026-02-10"
        );
        assert_eq!(
            resolve_on("vorgestern", r)
                .expect("vorgestern")
                .absolute_date,
            "2026-02-09"
        );
        assert_eq!(
            resolve_on("morgen", r).expect("morgen").absolute_date,
            "2026-02-12"
        );
        // "Guten Morgen" is a greeting, not a date.
        assert_eq!(resolve_on("Guten Morgen", r), None);
    }

    #[test]
    fn in_n_days_uses_german_numbers_and_digits() {
        let r = reference();
        let two = resolve_on("in zwei Tagen", r).expect("zwei");
        assert_eq!(two.absolute_date, "2026-02-13");
        assert_eq!(two.resolution_confidence, 0.9);
        assert_eq!(
            resolve_on("in 3 Tagen", r).expect("digits").absolute_date,
            "2026-02-14"
        );
        // `\w` is ASCII, so "fünf" is not captured and the pattern fails.
        assert_eq!(resolve_on("in fünf Tagen", r), None);
    }

    #[test]
    fn letzte_woche_is_the_previous_monday_to_sunday() {
        let resolved = resolve_on("letzte Woche", reference()).expect("range");
        assert_eq!(resolved.absolute_date, "2026-02-02");
        assert_eq!(resolved.absolute_date_end.as_deref(), Some("2026-02-08"));
        assert_eq!(resolved.resolution_confidence, 0.85);
    }

    #[test]
    fn absolute_dates_are_not_relative_and_keep_full_confidence() {
        let full = resolve_on("am 15.02.2026", reference()).expect("full");
        assert_eq!(full.absolute_date, "2026-02-15");
        assert!(!full.was_relative);
        assert_eq!(full.resolution_confidence, 1.0);

        let short = resolve_on("15.2.", reference()).expect("short");
        assert_eq!(short.absolute_date, "2026-02-15");
    }

    #[test]
    fn an_impossible_day_rolls_over_like_javascript() {
        // 31 February 2026 is 3 March 2026 in `new Date(2026, 1, 31)`.
        assert_eq!(
            resolve_on("31.02.2026", reference())
                .expect("rollover")
                .absolute_date,
            "2026-03-03"
        );
    }

    #[test]
    fn text_without_a_time_expression_resolves_to_nothing() {
        assert_eq!(resolve_on("Kaffee ist lecker", reference()), None);
    }

    #[test]
    fn berlin_follows_the_eu_summer_time_rule() {
        // 29 March 2026 is the last Sunday of March: summer time from 01:00 UTC.
        let before = to_user_local_date("2026-03-28T23:30:00Z", Some("Europe/Berlin"));
        assert_eq!(before, NaiveDate::from_ymd_opt(2026, 3, 29));
        let after = to_user_local_date("2026-03-29T23:30:00Z", Some("Europe/Berlin"));
        assert_eq!(after, NaiveDate::from_ymd_opt(2026, 3, 30));
        // 25 October 2026 is the last Sunday of October: winter time from 01:00 UTC.
        let winter = to_user_local_date("2026-10-25T23:30:00Z", Some("Europe/Berlin"));
        assert_eq!(winter, NaiveDate::from_ymd_opt(2026, 10, 26));
    }

    /// A zone outside Europe, across both US summer-time changes. The instants are
    /// chosen so that the wrong offset gives a different calendar day.
    #[test]
    fn new_york_follows_the_us_summer_time_rule() {
        // Summer time starts on 8 March 2026 at 02:00 EST, that is 07:00 UTC.
        // At 04:30 UTC it is still 23:30 EST on 7 March.
        let before_start = to_user_local_date("2026-03-08T04:30:00Z", Some("America/New_York"));
        assert_eq!(before_start, NaiveDate::from_ymd_opt(2026, 3, 7));
        // Afterwards it is 00:30 EDT on 9 March (UTC-4), not 23:30 EST on 8 March.
        let after_start = to_user_local_date("2026-03-09T04:30:00Z", Some("America/New_York"));
        assert_eq!(after_start, NaiveDate::from_ymd_opt(2026, 3, 9));
        // Summer time ends on 1 November 2026 at 02:00 EDT, that is 06:00 UTC.
        // At 04:30 UTC it is still 00:30 EDT on 1 November.
        let before_end = to_user_local_date("2026-11-01T04:30:00Z", Some("America/New_York"));
        assert_eq!(before_end, NaiveDate::from_ymd_opt(2026, 11, 1));
        // Afterwards it is 23:30 EST on 1 November, not 00:30 on 2 November.
        let after_end = to_user_local_date("2026-11-02T04:30:00Z", Some("America/New_York"));
        assert_eq!(after_end, NaiveDate::from_ymd_opt(2026, 11, 1));
    }

    /// The day logic of the resolver uses the same zone: "heute" in New York is the
    /// calendar day of the message, not the UTC day.
    #[test]
    fn heute_in_new_york_is_the_local_day_across_the_change() {
        let context = TimeResolutionContext {
            message_timestamp: "2026-03-08T04:30:00Z".to_string(),
            user_timezone: Some("America/New_York".to_string()),
        };
        let resolved = resolve_relative_time("heute", &context).expect("heute");
        assert_eq!(resolved.absolute_date, "2026-03-07");
    }

    /// `Intl.DateTimeFormat` throws for an unknown name; the port resolves nothing.
    #[test]
    fn an_unknown_zone_resolves_to_nothing() {
        assert_eq!(
            to_user_local_date("2026-03-08T04:30:00Z", Some("Mars/Olympus")),
            None
        );
    }

    #[test]
    fn an_unparsable_timestamp_resolves_to_nothing() {
        let context = TimeResolutionContext {
            message_timestamp: "not a date".to_string(),
            user_timezone: None,
        };
        assert_eq!(resolve_relative_time("heute", &context), None);
    }
}
