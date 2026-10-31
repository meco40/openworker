//! Port of `src/server/knowledge/historySummarizer.ts` (1-109).
//!
//! | TypeScript | Rust |
//! | --- | --- |
//! | `ConversationSummary` (`:9-22`) | [`ConversationSummary`] |
//! | `getISOWeek` (`:27-33`, private) | [`iso_week`] (private) |
//! | `weekKey` (`:38-41`, private) | [`week_key`] (private) |
//! | `groupByWeek` (`:47-66`) | [`group_by_week`] |
//! | `truncate` (`:71-74`, private) | [`truncate`] (private) |
//! | `unique` (`:79-81`, private) | [`unique_strings`] (private) |
//! | `buildHistorySummary` (`:89-109`) | [`build_history_summary`] |
//! | `formatDateDE` (`src/shared/lib/text.ts:14-26`, imported at `:7`) | [`format_date_de`] (private) |
//!
//! # Deviations
//!
//! * `truncate` cuts with `String#slice` in UTF-16 units, through
//!   `js_compat::js_slice_prefix`, which never splits a surrogate pair.
//! * Dates use the host's local time zone, as in the TypeScript. A timestamp
//!   without a zone offset is not parsed (see [`crate::knowledge::time_resolver`]),
//!   so it falls into the `NaN-WNaN` group that the TypeScript also produces
//!   for an invalid date.
//! * The week formula is copied as it is, including its start date. It counts
//!   from **4 January** (`new Date(year, 0, 4)`), not from 1 January as ISO 8601
//!   does. Keys therefore sit one week behind ISO (Thursday 12 February 2026 gives
//!   `2026-W06`, ISO week 7), and a week that straddles New Year can get two keys
//!   (`2024-W00` and `2025-W00`). Grouping is unaffected inside a year. The
//!   TypeScript does the same; the tests below pin it. Flagged for review, not fixed here.

use std::collections::HashMap;

use chrono::{Datelike, Duration, NaiveDate};

use crate::knowledge::js_compat::js_slice_prefix;
use crate::knowledge::retrieval::js_str_len;
use crate::knowledge::time_resolver::to_user_local_date;

/// `ConversationSummary` (`historySummarizer.ts:9-22`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ConversationSummary {
    pub id: String,
    pub user_id: String,
    pub persona_id: String,
    pub conversation_id: String,
    pub summary_text: String,
    pub key_topics: Vec<String>,
    pub entities_mentioned: Vec<String>,
    pub emotional_tone: Option<String>,
    pub message_count: i64,
    pub time_range_start: String,
    pub time_range_end: String,
    pub created_at: String,
}

/// `getISOWeek` (`historySummarizer.ts:27-33`).
fn iso_week(day: NaiveDate) -> i64 {
    // `d.setDate(d.getDate() + 3 - ((d.getDay() + 6) % 7))`: move to the
    // Thursday of the ISO week. `num_days_from_monday` is 0 for Monday.
    let monday_based = i64::from(day.weekday().num_days_from_monday());
    let thursday = day
        .checked_add_signed(Duration::days(3 - monday_based))
        .unwrap_or(day);
    let year_start = NaiveDate::from_ymd_opt(thursday.year(), 1, 4).unwrap_or(thursday);
    let days = (thursday - year_start).num_days();
    // Math.ceil(((time diff) / 86400000 + 1) / 7); f64 keeps the same rounding.
    ((days + 1) as f64 / 7.0).ceil() as i64
}

/// `weekKey` (`historySummarizer.ts:38-41`): `YYYY-Www` of the local date.
fn week_key(timestamp: &str) -> String {
    match to_user_local_date(timestamp, None) {
        Some(day) => format!("{}-W{:02}", day.year(), iso_week(day)),
        None => "NaN-WNaN".to_string(),
    }
}

/// The millisecond value of `new Date(x).getTime()`, `NaN` when unparsable.
fn millis(timestamp: &str) -> f64 {
    crate::knowledge::retrieval::js_date_parse_millis(timestamp)
}

/// `groupByWeek` (`historySummarizer.ts:47-66`): sort by `timeRangeStart`, then
/// group by week in the order each week first appears.
pub fn group_by_week(summaries: &[ConversationSummary]) -> Vec<Vec<&ConversationSummary>> {
    if summaries.is_empty() {
        return Vec::new();
    }
    let mut sorted: Vec<&ConversationSummary> = summaries.iter().collect();
    // `total_cmp` gives a total order even for NaN, so the sort cannot panic.
    sorted.sort_by(|a, b| millis(&a.time_range_start).total_cmp(&millis(&b.time_range_start)));

    let mut index: HashMap<String, usize> = HashMap::new();
    let mut groups: Vec<Vec<&ConversationSummary>> = Vec::new();
    for summary in sorted {
        let key = week_key(&summary.time_range_start);
        match index.get(&key) {
            Some(&position) => groups[position].push(summary),
            None => {
                index.insert(key, groups.len());
                groups.push(vec![summary]);
            }
        }
    }
    groups
}

/// `formatDateDE` (`src/shared/lib/text.ts:14-26`): `DD.MM.YYYY` of the local
/// date, or the input unchanged when it does not parse.
fn format_date_de(iso: &str) -> String {
    match to_user_local_date(iso, None) {
        Some(day) => format!("{:02}.{:02}.{}", day.day(), day.month(), day.year()),
        None => iso.to_string(),
    }
}

/// `truncate` (`historySummarizer.ts:71-74`).
fn truncate(text: &str, max_length: i64) -> String {
    if (js_str_len(text) as i64) <= max_length {
        return text.to_string();
    }
    format!("{}...", js_slice_prefix(text, max_length - 3))
}

/// `unique` (`historySummarizer.ts:79-81`) applied with `filter`: keeps the first
/// occurrence of each value, in order.
fn unique_strings<'a>(values: impl Iterator<Item = &'a String>) -> Vec<&'a String> {
    let mut out: Vec<&String> = Vec::new();
    for value in values {
        if !out.contains(&value) {
            out.push(value);
        }
    }
    out
}

/// `buildHistorySummary` (`historySummarizer.ts:89-109`). The persona name is
/// accepted for parity and not used, like the `_personaName` of the TypeScript.
pub fn build_history_summary(
    summaries: &[ConversationSummary],
    _persona_name: &str,
    budget_chars: i64,
) -> String {
    if summaries.is_empty() {
        return String::new();
    }

    let header = "Bisheriger Verlauf mit dem User (aeltere Sessions):";
    let week_lines: Vec<String> = group_by_week(summaries)
        .iter()
        .map(|week| {
            let start = format_date_de(&week[0].time_range_start);
            let end = format_date_de(&week[week.len() - 1].time_range_start);
            let date_range = if start == end {
                start
            } else {
                format!("{start}-{end}")
            };
            let topics = unique_strings(week.iter().flat_map(|summary| summary.key_topics.iter()));
            let topics: Vec<&str> = topics.into_iter().map(String::as_str).collect();
            let summary_texts: Vec<&str> = week.iter().map(|s| s.summary_text.as_str()).collect();
            format!(
                "{date_range}: {} [Themen: {}]",
                summary_texts.join(" "),
                topics.join(", ")
            )
        })
        .collect();

    truncate(
        &format!("{header}\n{}", week_lines.join("\n")),
        budget_chars,
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    fn summary(start: &str, text: &str, topics: &[&str]) -> ConversationSummary {
        ConversationSummary {
            id: format!("s-{start}"),
            user_id: "u".to_string(),
            persona_id: "p".to_string(),
            conversation_id: "c".to_string(),
            summary_text: text.to_string(),
            key_topics: topics.iter().map(|t| t.to_string()).collect(),
            entities_mentioned: vec![],
            emotional_tone: None,
            message_count: 4,
            time_range_start: start.to_string(),
            time_range_end: start.to_string(),
            created_at: start.to_string(),
        }
    }

    #[test]
    fn summaries_in_the_same_iso_week_share_a_group() {
        // 9 Feb and 11 Feb 2026 are both in ISO week 7; 16 Feb is week 8.
        let items = vec![
            summary("2026-02-16T12:00:00.000Z", "C", &[]),
            summary("2026-02-11T12:00:00.000Z", "B", &[]),
            summary("2026-02-09T12:00:00.000Z", "A", &[]),
        ];
        let groups = group_by_week(&items);
        assert_eq!(groups.len(), 2);
        assert_eq!(
            groups[0]
                .iter()
                .map(|s| s.summary_text.as_str())
                .collect::<Vec<_>>(),
            ["A", "B"]
        );
        assert_eq!(groups[1][0].summary_text, "C");
    }

    #[test]
    fn the_week_key_matches_the_typescript_formula_not_iso() {
        // ISO week 7 of 2026, but the TypeScript counts from 4 January: W06.
        assert_eq!(week_key("2026-02-11T12:00:00.000Z"), "2026-W06");
        // Thursday 1 January 2026 falls before 4 January and gives week 00.
        assert_eq!(week_key("2026-01-01T12:00:00.000Z"), "2026-W00");
    }

    #[test]
    fn the_history_lines_join_topics_and_respect_the_budget() {
        let items = vec![
            summary(
                "2026-02-09T12:00:00.000Z",
                "Erste Session.",
                &["Reisen", "Essen"],
            ),
            summary(
                "2026-02-11T12:00:00.000Z",
                "Zweite Session.",
                &["Essen", "Arbeit"],
            ),
        ];
        let text = build_history_summary(&items, "Nata", 10_000);
        assert!(text.starts_with("Bisheriger Verlauf mit dem User (aeltere Sessions):\n"));
        assert!(text.contains("Erste Session. Zweite Session. [Themen: Reisen, Essen, Arbeit]"));

        let short = build_history_summary(&items, "Nata", 40);
        assert_eq!(js_str_len(&short), 40);
        assert!(short.ends_with("..."));
    }

    #[test]
    fn an_empty_list_yields_an_empty_summary() {
        assert_eq!(build_history_summary(&[], "Nata", 100), "");
        assert!(group_by_week(&[]).is_empty());
    }
}
