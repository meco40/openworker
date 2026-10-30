//! Port of `src/server/knowledge/eventExtractor.ts` (1-152).
//!
//! | TypeScript | Rust |
//! | --- | --- |
//! | `ExtractedEvent` (`:1-14`) | [`ExtractedEvent`] |
//! | `MinimalMessage` (`:16-20`) | [`MinimalMessage`] |
//! | `EventExtractor.normalizeEvents` (`:27-56`) | [`EventExtractor::normalize_events`] |
//! | `EventExtractor.validateSpeakerRole` (`:58-73`) | [`EventExtractor::validate_speaker_role`] |
//! | `EventExtractor.resolveAbsoluteDates` (`:75-128`) | [`EventExtractor::resolve_absolute_dates`] |
//! | `GERMAN_NUMBERS` + `parseGermanNumber` (`:131-152`) | [`parse_german_count`] (private) |
//!
//! # Deviations
//!
//! * The TypeScript `speakerRole` is a string that the code copies from the
//!   message role. Here it is [`SpeakerRole`]. A message role other than
//!   `agent` or `user` (for example `system`) therefore keeps the speaker the
//!   LLM chose, where the TypeScript would write the raw role into the event.
//! * `dayCount` is an integer. JavaScript `Number("2.5")` gives `2.5`; the port
//!   reads only integer spellings and treats anything else as not a count.
//! * `ref.toISOString().slice(0, 10)` is the **UTC** calendar day. The port uses
//!   `DateTime<Utc>::date_naive`, which is the same day.

use std::sync::LazyLock;

use chrono::{DateTime, Duration, NaiveDate, Utc};
use regex::Regex;

use crate::knowledge::event_types::SpeakerRole;

/// `ExtractedEvent` (`eventExtractor.ts:1-14`).
#[derive(Debug, Clone, PartialEq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExtractedEvent {
    pub event_type: String,
    pub speaker_role: SpeakerRole,
    pub subject: String,
    pub counterpart: String,
    pub relation_label: Option<String>,
    pub time_expression: String,
    /// `YYYY-MM-DD`.
    pub start_date: String,
    /// `YYYY-MM-DD`.
    pub end_date: String,
    pub day_count: i64,
    pub is_confirmation: bool,
    pub confirmation_signals: Vec<String>,
    pub source_seq: Vec<i64>,
}

/// `MinimalMessage` (`eventExtractor.ts:16-20`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MinimalMessage {
    pub seq: i64,
    /// `user` or `agent`.
    pub role: String,
    pub content: String,
}

/// The `{ startDate, endDate, dayCount }` triple of `resolveAbsoluteDates`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ResolvedDates {
    pub start_date: String,
    pub end_date: String,
    pub day_count: i64,
}

/// `EventExtractor` (`eventExtractor.ts:22-129`). Stateless.
#[derive(Debug, Clone, Copy, Default)]
pub struct EventExtractor;

static YESTERDAY: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?i)\bgestern\b").expect("gestern"));
static DAY_BEFORE_YESTERDAY: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?i)\bvorgestern\b").expect("vorgestern"));
static LAST_N_DAYS: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?i)letzten?\s+([0-9A-Za-z_]+)\s+tage?").expect("last n days"));

/// `YYYY-MM-DD`, the `toISOString().slice(0, 10)` of the TypeScript.
fn iso_day(date: NaiveDate) -> String {
    date.format("%Y-%m-%d").to_string()
}

/// `setUTCDate(getUTCDate() + days)`.
fn shift(date: NaiveDate, days: i64) -> Option<NaiveDate> {
    date.checked_add_signed(Duration::days(days))
}

/// `GERMAN_NUMBERS` and `parseGermanNumber` (`eventExtractor.ts:131-152`).
/// Returns `0` when the text is neither a positive integer nor a known word.
fn parse_german_count(text: &str) -> i64 {
    let trimmed = text.trim().to_lowercase();
    if let Ok(numeric) = trimmed.parse::<i64>() {
        if numeric > 0 {
            return numeric;
        }
    }
    match trimmed.as_str() {
        "ein" | "eine" | "eins" => 1,
        "zwei" => 2,
        "drei" => 3,
        "vier" => 4,
        "fünf" | "fuenf" => 5,
        "sechs" => 6,
        "sieben" => 7,
        "acht" => 8,
        "neun" => 9,
        "zehn" => 10,
        _ => 0,
    }
}

impl EventExtractor {
    /// `normalizeEvents` (`eventExtractor.ts:27-56`): drop events without a type,
    /// resolve their dates against `reference` and validate the speaker role.
    pub fn normalize_events(
        &self,
        raw_events: Vec<ExtractedEvent>,
        messages: &[MinimalMessage],
        reference: DateTime<Utc>,
    ) -> Vec<ExtractedEvent> {
        raw_events
            .into_iter()
            .filter(|raw| !raw.event_type.trim().is_empty())
            .map(|raw| {
                let dates =
                    self.resolve_absolute_dates(&raw.time_expression, raw.day_count, reference);
                let with_dates = ExtractedEvent {
                    start_date: dates.start_date,
                    end_date: dates.end_date,
                    day_count: dates.day_count,
                    ..raw
                };
                self.validate_speaker_role(with_dates, messages)
            })
            .collect()
    }

    /// `validateSpeakerRole` (`eventExtractor.ts:58-73`): the message role of the
    /// first source message overrides the speaker the LLM assigned.
    pub fn validate_speaker_role(
        &self,
        mut event: ExtractedEvent,
        messages: &[MinimalMessage],
    ) -> ExtractedEvent {
        let Some(&first_seq) = event.source_seq.first() else {
            return event;
        };
        let Some(source) = messages.iter().find(|message| message.seq == first_seq) else {
            return event;
        };
        let expected = match source.role.as_str() {
            "agent" => Some(SpeakerRole::Assistant),
            "user" => Some(SpeakerRole::User),
            // Other roles: see the module header.
            _ => None,
        };
        if let Some(role) = expected {
            event.speaker_role = role;
        }
        event
    }

    /// `resolveAbsoluteDates` (`eventExtractor.ts:75-128`).
    pub fn resolve_absolute_dates(
        &self,
        time_expression: &str,
        day_count: i64,
        reference: DateTime<Utc>,
    ) -> ResolvedDates {
        let reference_day = reference.date_naive();
        let single = |date: NaiveDate| ResolvedDates {
            start_date: iso_day(date),
            end_date: iso_day(date),
            day_count: 1,
        };

        if YESTERDAY.is_match(time_expression) {
            if let Some(day) = shift(reference_day, -1) {
                return single(day);
            }
        }
        if DAY_BEFORE_YESTERDAY.is_match(time_expression) {
            if let Some(day) = shift(reference_day, -2) {
                return single(day);
            }
        }
        if let Some(captures) = LAST_N_DAYS.captures(time_expression) {
            let count = parse_german_count(&captures[1]);
            if count > 0 {
                if let Some(start) = shift(reference_day, -(count - 1)) {
                    return ResolvedDates {
                        start_date: iso_day(start),
                        end_date: iso_day(reference_day),
                        day_count: count,
                    };
                }
            }
        }
        // Fallback: the LLM's dayCount, ending today.
        if day_count > 0 {
            if let Some(start) = shift(reference_day, -(day_count - 1)) {
                return ResolvedDates {
                    start_date: iso_day(start),
                    end_date: iso_day(reference_day),
                    day_count,
                };
            }
        }
        single(reference_day)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::TimeZone;

    fn reference() -> DateTime<Utc> {
        Utc.with_ymd_and_hms(2026, 2, 11, 10, 0, 0)
            .single()
            .expect("reference")
    }

    fn raw(event_type: &str, role: SpeakerRole, time: &str, day_count: i64) -> ExtractedEvent {
        ExtractedEvent {
            event_type: event_type.to_string(),
            speaker_role: role,
            subject: "Nata".to_string(),
            counterpart: "Max".to_string(),
            relation_label: None,
            time_expression: time.to_string(),
            start_date: String::new(),
            end_date: String::new(),
            day_count,
            is_confirmation: false,
            confirmation_signals: vec![],
            source_seq: vec![3],
        }
    }

    #[test]
    fn gestern_and_vorgestern_are_single_days() {
        let dates = EventExtractor.resolve_absolute_dates("gestern", 0, reference());
        assert_eq!(
            dates,
            ResolvedDates {
                start_date: "2026-02-10".into(),
                end_date: "2026-02-10".into(),
                day_count: 1
            }
        );
        let before = EventExtractor.resolve_absolute_dates("vorgestern", 0, reference());
        assert_eq!(before.start_date, "2026-02-09");
    }

    #[test]
    fn the_last_n_days_span_ends_today() {
        let dates = EventExtractor.resolve_absolute_dates("die letzten zwei Tage", 0, reference());
        assert_eq!(dates.start_date, "2026-02-10");
        assert_eq!(dates.end_date, "2026-02-11");
        assert_eq!(dates.day_count, 2);

        let digits = EventExtractor.resolve_absolute_dates("letzten 3 Tage", 0, reference());
        assert_eq!(digits.start_date, "2026-02-09");
    }

    #[test]
    fn without_a_time_expression_the_llm_day_count_is_used() {
        let dates = EventExtractor.resolve_absolute_dates("", 4, reference());
        assert_eq!(dates.start_date, "2026-02-08");
        assert_eq!(dates.end_date, "2026-02-11");
        assert_eq!(dates.day_count, 4);
    }

    #[test]
    fn with_no_signal_the_event_is_today() {
        let dates = EventExtractor.resolve_absolute_dates("", 0, reference());
        assert_eq!(
            dates,
            ResolvedDates {
                start_date: "2026-02-11".into(),
                end_date: "2026-02-11".into(),
                day_count: 1
            }
        );
    }

    #[test]
    fn the_speaker_follows_the_message_role_of_the_first_source() {
        let messages = vec![MinimalMessage {
            seq: 3,
            role: "agent".into(),
            content: "x".into(),
        }];
        let event = EventExtractor
            .validate_speaker_role(raw("meeting", SpeakerRole::User, "", 0), &messages);
        assert_eq!(event.speaker_role, SpeakerRole::Assistant);
    }

    #[test]
    fn events_without_a_type_are_dropped() {
        let events = vec![
            raw("   ", SpeakerRole::User, "gestern", 0),
            raw("visit", SpeakerRole::User, "gestern", 0),
        ];
        let normalized = EventExtractor.normalize_events(events, &[], reference());
        assert_eq!(normalized.len(), 1);
        assert_eq!(normalized[0].event_type, "visit");
        assert_eq!(normalized[0].start_date, "2026-02-10");
    }
}
