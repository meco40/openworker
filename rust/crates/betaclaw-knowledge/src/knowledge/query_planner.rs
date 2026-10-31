//! Port of `src/server/knowledge/queryPlanner.ts` (1-232).
//!
//! | TypeScript                                  | Rust |
//! | ------------------------------------------- | ---- |
//! | `queryPlanner.ts:1-5` (`KnowledgeQueryIntent`) | [`KnowledgeQueryIntent`] |
//! | `queryPlanner.ts:6` (`KnowledgeDetailDepth`)  | [`KnowledgeDetailDepth`] |
//! | `queryPlanner.ts:8-11` (`KnowledgeTimeRange`) | [`KnowledgeTimeRange`] |
//! | `queryPlanner.ts:13-16` (`KnowledgeEventQueryFilter`) | [`KnowledgeEventQueryFilter`] |
//! | `queryPlanner.ts:18-29` (`KnowledgeQueryPlan`) | [`KnowledgeQueryPlan`] |
//! | `queryPlanner.ts:31-62` (`toIsoUtc`, `startOfUtcDay`, `endOfUtcDay`, `subtractMonthsUtc`, `shiftDaysUtc`) | [`start_of_utc_day`], [`end_of_utc_day`], [`subtract_months_utc`], [`shift_days_utc`] |
//! | `queryPlanner.ts:64-102` (`parseTimeRange`)  | [`parse_time_range`] |
//! | `queryPlanner.ts:104-108` (`parseCounterpart`) | [`parse_counterpart`] |
//! | `queryPlanner.ts:110-156` (`parseTopic`)     | [`parse_topic`] |
//! | `queryPlanner.ts:158-170` (`resolveIntent`)  | [`resolve_intent`] |
//! | `queryPlanner.ts:172-182` (`resolveDetailDepth`) | [`resolve_detail_depth`] |
//! | `queryPlanner.ts:184-193` (`EVENT_TYPE_KEYWORDS`) | [`event_type_rule`] |
//! | `queryPlanner.ts:195-215` (`resolveEventFilter`) | [`resolve_event_filter`] |
//! | `queryPlanner.ts:217-232` (`planKnowledgeQuery`) | [`plan_knowledge_query`] |
//!
//! This file is the query planner that `retrieval/service/queryPlanning.ts:1`
//! and `retrieval/service/retrievalExecution.ts:1` call; it lives at the
//! knowledge root because that is where its TypeScript original lives.
//!
//! # Pattern transcription
//!
//! `\b`, `\d` and `\w` are wrapped as `(?-u:\b)`, `(?-u:\d)`, `(?-u:\w)`,
//! because JavaScript defines all three through the ASCII class
//! `[A-Za-z0-9_]` while the Rust `regex` crate is Unicode-aware by default
//! (same convention as `memory/poisoning.rs`); `/i` becomes `(?i)`. `\s` is left
//! alone: Rust's `\s` and JavaScript's `\s` differ in the single code point
//! `U+0085`.
//!
//! # Deviations
//!
//! 1. **`now` is explicit.** `planKnowledgeQuery(query, now = new Date())`
//!    (`:217`). Rust has no default argument, so [`plan_knowledge_query`] uses
//!    the current UTC time and [`plan_knowledge_query_at`] takes the instant —
//!    the deterministic entry point the tests use.
//! 2. **`Date.UTC` does not normalise out-of-range components.** `toIsoUtc`
//!    (`:31-40`) goes through `Date.UTC`, which rolls a month index of `12` or
//!    a day of `32` over. All five call sites pass components read back from a
//!    valid `Date` plus fixed hours, so no in-range bypass exists.
//!    `setUTCMonth` *is* reproduced with its overflow, see
//!    [`subtract_months_utc`].
//! 3. **Sub-millisecond precision.** A JavaScript `Date` holds milliseconds; a
//!    `DateTime<Utc>` holds nanoseconds. Every formatted timestamp is truncated
//!    to milliseconds like `toISOString()`, so the difference cannot surface.
//! 4. `counterpart`/`topic`/`eventFilter` are `string | null`/absent in the
//!    TypeScript; the port uses `Option`.

use std::sync::OnceLock;

use chrono::{DateTime, Datelike, Duration, NaiveDate, SecondsFormat, TimeZone, Utc};
use regex::Regex;

use crate::knowledge::retrieval::pattern;

/// `KnowledgeQueryIntent` from `queryPlanner.ts:1-5`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum KnowledgeQueryIntent {
    MeetingRecall,
    NegotiationRecall,
    CountRecall,
    GeneralRecall,
}

/// `KnowledgeDetailDepth` from `queryPlanner.ts:6`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum KnowledgeDetailDepth {
    Low,
    Medium,
    High,
}

/// `KnowledgeTimeRange` from `queryPlanner.ts:8-11`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct KnowledgeTimeRange {
    pub from: String,
    pub to: String,
}

/// `KnowledgeEventQueryFilter` from `queryPlanner.ts:13-16`.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct KnowledgeEventQueryFilter {
    pub event_type: Option<String>,
    pub counterpart_entity: Option<String>,
}

/// `KnowledgeQueryPlan` from `queryPlanner.ts:18-29`.
#[derive(Debug, Clone, PartialEq)]
pub struct KnowledgeQueryPlan {
    pub intent: KnowledgeQueryIntent,
    pub time_range: Option<KnowledgeTimeRange>,
    pub counterpart: Option<String>,
    pub topic: Option<String>,
    pub detail_depth: KnowledgeDetailDepth,
    pub event_filter: Option<KnowledgeEventQueryFilter>,
    /// Populated by retrieval after entity resolution (`:25-28`).
    pub resolved_entity_id: Option<String>,
    pub resolved_entity_name: Option<String>,
    pub counterpart_aliases: Option<Vec<String>>,
}

/// `new Date(...).toISOString()` — always milliseconds and always `Z`.
fn format_iso_millis(value: DateTime<Utc>) -> String {
    value.to_rfc3339_opts(SecondsFormat::Millis, true)
}

static MONTHS_PATTERN: OnceLock<Regex> = OnceLock::new();
static VORGESTERN_PATTERN: OnceLock<Regex> = OnceLock::new();
static GESTERN_PATTERN: OnceLock<Regex> = OnceLock::new();
static HEUTE_PATTERN: OnceLock<Regex> = OnceLock::new();
static MITTAG_PATTERN: OnceLock<Regex> = OnceLock::new();

/// `Date.UTC(year, month, day, hours, minutes, seconds)` for in-range
/// components, formatted like `toIsoUtc` (`queryPlanner.ts:31-40`).
fn to_iso_utc(year: i32, month0: u32, day: u32, hours: u32, minutes: u32, seconds: u32) -> String {
    let date = NaiveDate::from_ymd_opt(year, month0 + 1, day)
        .expect("Date.UTC receives in-range components at every call site");
    let naive = date
        .and_hms_opt(hours, minutes, seconds)
        .expect("the fixed hours of a day boundary are in range");
    format_iso_millis(Utc.from_utc_datetime(&naive))
}

/// `startOfUtcDay` from `queryPlanner.ts:42-44`.
fn start_of_utc_day(base: DateTime<Utc>) -> String {
    to_iso_utc(base.year(), base.month0(), base.day(), 0, 0, 0)
}

/// `endOfUtcDay` from `queryPlanner.ts:46-50` — `23:59:59.999`.
fn end_of_utc_day(base: DateTime<Utc>) -> String {
    let date = NaiveDate::from_ymd_opt(base.year(), base.month(), base.day())
        .expect("the components come from a valid instant");
    let naive = date
        .and_hms_milli_opt(23, 59, 59, 999)
        .expect("23:59:59.999 is in range");
    format_iso_millis(Utc.from_utc_datetime(&naive))
}

/// `subtractMonthsUtc` from `queryPlanner.ts:52-56`.
///
/// `setUTCMonth(month - months)` keeps the day of month and lets it overflow
/// into the following month: `2024-03-31` minus one month is `2024-03-02`,
/// because `2024-02-31` rolls over. The port reproduces that instead of
/// clamping to the end of February.
fn subtract_months_utc(base: DateTime<Utc>, months: i64) -> DateTime<Utc> {
    let total = base.year() as i64 * 12 + base.month0() as i64 - months;
    let year = total.div_euclid(12) as i32;
    let month0 = total.rem_euclid(12) as u32;
    let first = NaiveDate::from_ymd_opt(year, month0 + 1, 1).expect("normalised year and month");
    let target = first + Duration::days(base.day() as i64 - 1);
    Utc.from_utc_datetime(&target.and_time(base.time()))
}

/// `shiftDaysUtc` from `queryPlanner.ts:58-62`.
fn shift_days_utc(base: DateTime<Utc>, days: i64) -> DateTime<Utc> {
    base + Duration::days(days)
}

/// `parseTimeRange` from `queryPlanner.ts:64-102`.
///
/// The test order is the source's: `vor N monat(en)`, `vorgestern`, `gestern`,
/// `heute` + `mittag`, otherwise no range.
fn parse_time_range(query: &str, now: DateTime<Utc>) -> Option<KnowledgeTimeRange> {
    let months_pattern = pattern(r"(?i)vor\s+(?-u:(\d+))\s+monat(?:en)?", &MONTHS_PATTERN);
    if let Some(captures) = months_pattern.captures(query) {
        let digits = captures.get(1).expect("capture group 1").as_str();
        // `Math.max(0, Math.floor(Number(monthsMatch[1])))`: a digit run, so
        // `Number` cannot produce `NaN`.
        let months = digits.parse::<f64>().unwrap_or(0.0).floor().max(0.0);
        let months = if months > i64::MAX as f64 {
            i64::MAX
        } else {
            months as i64
        };
        return Some(KnowledgeTimeRange {
            from: format_iso_millis(subtract_months_utc(now, months)),
            to: format_iso_millis(now),
        });
    }

    if pattern(r"(?i)(?-u:\b)vorgestern(?-u:\b)", &VORGESTERN_PATTERN).is_match(query) {
        let day = shift_days_utc(now, -2);
        return Some(KnowledgeTimeRange {
            from: start_of_utc_day(day),
            to: end_of_utc_day(day),
        });
    }

    if pattern(r"(?i)(?-u:\b)gestern(?-u:\b)", &GESTERN_PATTERN).is_match(query) {
        let day = shift_days_utc(now, -1);
        return Some(KnowledgeTimeRange {
            from: start_of_utc_day(day),
            to: end_of_utc_day(day),
        });
    }

    if pattern(r"(?i)(?-u:\b)heute(?-u:\b)", &HEUTE_PATTERN).is_match(query)
        && pattern(r"(?i)(?-u:\b)mittag(?-u:\b)", &MITTAG_PATTERN).is_match(query)
    {
        let (year, month0, day) = (now.year(), now.month0(), now.day());
        return Some(KnowledgeTimeRange {
            from: to_iso_utc(year, month0, day, 11, 0, 0),
            to: to_iso_utc(year, month0, day, 14, 0, 0),
        });
    }

    None
}

static ARTICLE_PATTERN: OnceLock<Regex> = OnceLock::new();
static TOPIC_TOKEN_PATTERN: OnceLock<Regex> = OnceLock::new();
static PUNCTUATION_PATTERN: OnceLock<Regex> = OnceLock::new();
static TOPIC_CUE_PATTERN: OnceLock<Regex> = OnceLock::new();
static COUNTERPART_PATTERN: OnceLock<Regex> = OnceLock::new();
static INTENT_COUNT_PATTERN: OnceLock<Regex> = OnceLock::new();
static INTENT_NEGOTIATION_PATTERN: OnceLock<Regex> = OnceLock::new();
static INTENT_MEETING_PATTERN: OnceLock<Regex> = OnceLock::new();
static DETAIL_HIGH_PATTERN: OnceLock<Regex> = OnceLock::new();
static DETAIL_MEDIUM_PATTERN: OnceLock<Regex> = OnceLock::new();

/// `parseCounterpart` from `queryPlanner.ts:104-108`.
///
/// The source class is `[a-zA-Z\u00C0-\u017F][\w\-\u00C0-\u017F]*`; `\w` is
/// expanded to its ASCII definition `[A-Za-z0-9_]` because this pattern also
/// contains a non-ASCII range and therefore cannot be wrapped in `(?-u:…)`.
fn parse_counterpart(query: &str) -> Option<String> {
    let captures = pattern(
        r"(?i)(?-u:\b)mit\s+([a-zA-Z\u{00C0}-\u{017F}][A-Za-z0-9_\u{00C0}-\u{017F}-]*)",
        &COUNTERPART_PATTERN,
    )
    .captures(query)?;
    let name = captures.get(1)?.as_str();
    Some(name.trim().to_lowercase())
}

/// `parseTopic` from `queryPlanner.ts:110-156`.
fn parse_topic(query: &str) -> Option<String> {
    let lowered = query.to_lowercase();
    if lowered.contains("ausgehandelt") {
        return Some("ausgehandelt".to_string());
    }

    // Explicit topic cues are preferred and always accepted.
    const EXPLICIT_TOPIC_CUES: [&str; 10] = [
        "zum thema",
        "bezug auf",
        "bezug",
        "bezueglich",
        "bezüglich",
        "hinsichtlich",
        "ueber",
        "über",
        "about",
        "thema",
    ];
    for cue in EXPLICIT_TOPIC_CUES {
        let marker = format!("{cue} ");
        let Some(at) = lowered.find(&marker) else {
            continue;
        };
        let remainder = lowered[at + marker.len()..].trim_start();
        let remainder =
            pattern(r"^(?:das|die|den|dem)\s+", &ARTICLE_PATTERN).replace(remainder, "");
        if let Some(captures) =
            pattern(r"(?i)^([a-z0-9][a-z0-9-]*)", &TOPIC_TOKEN_PATTERN).captures(&remainder)
        {
            if let Some(token) = captures.get(1) {
                return Some(token.as_str().to_lowercase());
            }
        }
    }

    const CANDIDATES: [&str; 6] = ["sauna", "meeting", "vertrag", "rabatt", "sla", "preis"];
    let normalized_tokens: Vec<String> = pattern(r"[?!.,;:]+", &PUNCTUATION_PATTERN)
        .replace_all(&lowered, " ")
        .split_whitespace()
        .map(str::to_string)
        .collect();
    let has_topic_cue = pattern(
        r"(?i)(?-u:\b)(detail|details|regel|regeln|status|stand)(?-u:\b)",
        &TOPIC_CUE_PATTERN,
    )
    .is_match(&lowered);
    let tail_token = normalized_tokens.last().cloned().unwrap_or_default();
    let normalized_for_contains = format!(" {} ", normalized_tokens.join(" "));

    for candidate in CANDIDATES {
        if !normalized_for_contains.contains(&format!(" {candidate} ")) {
            continue;
        }

        // Keep telegraphic prompts ("heute mittag sauna") searchable by topic,
        // but avoid forcing topic filters for longer narrative/location
        // questions.
        let is_telegraphic_tail = normalized_tokens.len() <= 4 && tail_token == candidate;
        if has_topic_cue || is_telegraphic_tail {
            return Some(candidate.to_string());
        }
    }

    None
}

/// `resolveIntent` from `queryPlanner.ts:158-170`.
fn resolve_intent(query: &str) -> KnowledgeQueryIntent {
    let lowered = query.to_lowercase();
    if pattern(
        r"(?i)(?-u:\b)(wie\s+viele?\s+tage?|wie\s+oft|insgesamt|anzahl)(?-u:\b)",
        &INTENT_COUNT_PATTERN,
    )
    .is_match(&lowered)
    {
        return KnowledgeQueryIntent::CountRecall;
    }
    if pattern(
        r"(?i)(?-u:\b)(ausgehandelt|verhandelt|deal|vereinbart)(?-u:\b)",
        &INTENT_NEGOTIATION_PATTERN,
    )
    .is_match(&lowered)
    {
        return KnowledgeQueryIntent::NegotiationRecall;
    }
    if pattern(
        r"(?i)(?-u:\b)(meeting|besprech|termin)(?-u:\b)",
        &INTENT_MEETING_PATTERN,
    )
    .is_match(&lowered)
    {
        return KnowledgeQueryIntent::MeetingRecall;
    }
    KnowledgeQueryIntent::GeneralRecall
}

/// `resolveDetailDepth` from `queryPlanner.ts:172-182`.
fn resolve_detail_depth(query: &str, intent: KnowledgeQueryIntent) -> KnowledgeDetailDepth {
    let lowered = query.to_lowercase();
    if intent == KnowledgeQueryIntent::NegotiationRecall {
        return KnowledgeDetailDepth::High;
    }
    if pattern(
        r"(?i)(?-u:\b)(exakt|detail|warum|wieso|wie genau|vollstaendig|komplett)(?-u:\b)",
        &DETAIL_HIGH_PATTERN,
    )
    .is_match(&lowered)
    {
        return KnowledgeDetailDepth::High;
    }
    if pattern(
        r"(?i)(?-u:\b)(was|wie|wann|heute|gestern|vor)(?-u:\b)",
        &DETAIL_MEDIUM_PATTERN,
    )
    .is_match(&lowered)
    {
        return KnowledgeDetailDepth::Medium;
    }
    KnowledgeDetailDepth::Low
}

/// `EVENT_TYPE_KEYWORDS` from `queryPlanner.ts:184-193`.
///
/// The list order is the match priority; `\w*` is the ASCII `\w`.
fn event_type_rules() -> &'static [(Regex, &'static str)] {
    static RULES: OnceLock<Vec<(Regex, &'static str)>> = OnceLock::new();
    RULES.get_or_init(|| {
        vec![
            (
                Regex::new(r"(?i)(?-u:\b)(geschlafen|uebernacht(?-u:\w)*|schlaf(?-u:\w)*)(?-u:\b)")
                    .expect("static regex"),
                "shared_sleep",
            ),
            (
                Regex::new(r"(?i)(?-u:\b)(besucht(?-u:\w)*|besuch(?-u:\w)*)(?-u:\b)")
                    .expect("static regex"),
                "visit",
            ),
            (
                Regex::new(r"(?i)(?-u:\b)(reise(?-u:\w)*|gereist|trip|urlaub(?-u:\w)*)(?-u:\b)")
                    .expect("static regex"),
                "trip",
            ),
            (
                Regex::new(r"(?i)(?-u:\b)(treffen|getroffen|meeting)(?-u:\b)")
                    .expect("static regex"),
                "meeting",
            ),
            (
                Regex::new(r"(?i)(?-u:\b)(aktivitaet(?-u:\w)*|unternommen|gemacht)(?-u:\b)")
                    .expect("static regex"),
                "activity",
            ),
            (
                Regex::new(r"(?i)(?-u:\b)(essen|gegessen|meal|dinner|lunch)(?-u:\b)")
                    .expect("static regex"),
                "meal",
            ),
            (
                Regex::new(r"(?i)(?-u:\b)(termin(?-u:\w)*|appointment)(?-u:\b)")
                    .expect("static regex"),
                "appointment",
            ),
            (
                Regex::new(r"(?i)(?-u:\b)(feier(?-u:\w)*|gefeiert|party|celebration)(?-u:\b)")
                    .expect("static regex"),
                "celebration",
            ),
        ]
    })
}

/// `resolveEventFilter` from `queryPlanner.ts:195-215`.
///
/// `undefined` when neither an event-type keyword nor a counterpart matched.
fn resolve_event_filter(
    query: &str,
    counterpart: Option<&str>,
) -> Option<KnowledgeEventQueryFilter> {
    let lowered = query.to_lowercase();
    let mut event_type: Option<String> = None;

    for (rule, name) in event_type_rules() {
        if rule.is_match(&lowered) {
            event_type = Some((*name).to_string());
            break;
        }
    }

    if event_type.is_none() && counterpart.is_none() {
        return None;
    }

    Some(KnowledgeEventQueryFilter {
        event_type,
        counterpart_entity: counterpart.map(str::to_string),
    })
}

/// `planKnowledgeQuery(query, now = new Date())` from `queryPlanner.ts:217-232`.
pub fn plan_knowledge_query(query: &str) -> KnowledgeQueryPlan {
    plan_knowledge_query_at(query, Utc::now())
}

/// `planKnowledgeQuery(query, now)` from `queryPlanner.ts:217-232` with an
/// explicit instant — the deterministic entry point for tests.
pub fn plan_knowledge_query_at(query: &str, now: DateTime<Utc>) -> KnowledgeQueryPlan {
    let normalized = query.trim();
    let intent = resolve_intent(normalized);
    let counterpart = parse_counterpart(normalized);
    let event_filter = if intent == KnowledgeQueryIntent::CountRecall {
        resolve_event_filter(normalized, counterpart.as_deref())
    } else {
        None
    };

    KnowledgeQueryPlan {
        intent,
        time_range: parse_time_range(normalized, now),
        counterpart,
        topic: parse_topic(normalized),
        detail_depth: resolve_detail_depth(normalized, intent),
        event_filter,
        resolved_entity_id: None,
        resolved_entity_name: None,
        counterpart_aliases: None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 2024-06-15T10:30:00.000Z — the "now" of every deterministic case.
    fn now() -> DateTime<Utc> {
        Utc.with_ymd_and_hms(2024, 6, 15, 10, 30, 0)
            .single()
            .expect("a valid instant")
    }

    #[test]
    fn a_month_offset_keeps_the_day_and_the_time_of_day() {
        let plan = plan_knowledge_query_at("was war vor 2 monaten", now());
        let range = plan.time_range.expect("a range");
        assert_eq!(range.from, "2024-04-15T10:30:00.000Z");
        assert_eq!(range.to, "2024-06-15T10:30:00.000Z");
    }

    #[test]
    fn a_month_offset_overflows_the_short_month_like_setutcmonth() {
        // setUTCMonth(1) on 2024-03-31 is 2024-02-31, which rolls over to
        // 2024-03-02 because 2024 is a leap year.
        let base = Utc
            .with_ymd_and_hms(2024, 3, 31, 0, 0, 0)
            .single()
            .expect("a valid instant");
        let plan = plan_knowledge_query_at("vor 1 monat", base);
        assert_eq!(
            plan.time_range.expect("a range").from,
            "2024-03-02T00:00:00.000Z"
        );
    }

    #[test]
    fn the_relative_days_cover_the_whole_utc_day() {
        let gestern = plan_knowledge_query_at("gestern mit Max", now())
            .time_range
            .expect("a range");
        assert_eq!(gestern.from, "2024-06-14T00:00:00.000Z");
        assert_eq!(gestern.to, "2024-06-14T23:59:59.999Z");

        let vorgestern = plan_knowledge_query_at("vorgestern", now())
            .time_range
            .expect("a range");
        assert_eq!(vorgestern.from, "2024-06-13T00:00:00.000Z");
        assert_eq!(vorgestern.to, "2024-06-13T23:59:59.999Z");
    }

    #[test]
    fn heute_mittag_is_the_three_hour_window_of_the_same_utc_day() {
        let range = plan_knowledge_query_at("heute mittag sauna", now())
            .time_range
            .expect("a range");
        assert_eq!(range.from, "2024-06-15T11:00:00.000Z");
        assert_eq!(range.to, "2024-06-15T14:00:00.000Z");
        assert!(plan_knowledge_query_at("heute abend", now())
            .time_range
            .is_none());
        assert!(plan_knowledge_query_at("Sauna war gut", now())
            .time_range
            .is_none());
    }

    #[test]
    fn only_mit_introduces_a_counterpart() {
        assert_eq!(
            plan_knowledge_query_at("Gestern mit Max gesprochen", now()).counterpart,
            Some("max".to_string())
        );
        // `\b` is ASCII: "mitigieren" must not match the "mit " cue.
        assert_eq!(
            plan_knowledge_query_at("das zu mitigieren", now()).counterpart,
            None
        );
        assert_eq!(
            plan_knowledge_query_at("ohne Namen", now()).counterpart,
            None
        );
    }

    #[test]
    fn topics_come_from_the_cues_the_tail_or_the_ausgehandelt_marker() {
        assert_eq!(
            plan_knowledge_query_at("heute mittag sauna", now()).topic,
            Some("sauna".to_string())
        );
        assert_eq!(
            plan_knowledge_query_at("was ist der Status zum Thema Vertrag", now()).topic,
            Some("vertrag".to_string())
        );
        assert_eq!(
            plan_knowledge_query_at("erzaehl mir was das ausgehandelt war", now()).topic,
            Some("ausgehandelt".to_string())
        );
        // A longer narrative question does not force a topic filter: eight
        // tokens, no topic cue, no telegraphic tail.
        assert_eq!(
            plan_knowledge_query_at(
                "kannst du mir den rabatt bitte ausfuehrlich erklaeren",
                now()
            )
            .topic,
            None
        );
    }

    #[test]
    fn the_intent_order_is_count_negotiation_meeting_then_general() {
        assert_eq!(
            plan_knowledge_query_at("Wie viele Tage waren wir in der Sauna?", now()).intent,
            KnowledgeQueryIntent::CountRecall
        );
        assert_eq!(
            plan_knowledge_query_at("was haben wir ausgehandelt", now()).intent,
            KnowledgeQueryIntent::NegotiationRecall
        );
        assert_eq!(
            plan_knowledge_query_at("wann war das Meeting", now()).intent,
            KnowledgeQueryIntent::MeetingRecall
        );
        assert_eq!(
            plan_knowledge_query_at("Sauna war gut", now()).intent,
            KnowledgeQueryIntent::GeneralRecall
        );
    }

    #[test]
    fn an_event_filter_needs_a_keyword_or_a_counterpart() {
        let with_both = plan_knowledge_query_at("wie oft waren wir mit Max beim essen", now());
        assert_eq!(with_both.intent, KnowledgeQueryIntent::CountRecall);
        assert_eq!(
            with_both.event_filter,
            Some(KnowledgeEventQueryFilter {
                event_type: Some("meal".to_string()),
                counterpart_entity: Some("max".to_string()),
            })
        );

        let plain_count = plan_knowledge_query_at("wie viele Tage waren wir dort", now());
        assert_eq!(plain_count.event_filter, None);

        // Outside a count query the filter is never resolved.
        assert_eq!(
            plan_knowledge_query_at("wann war das Meeting mit Max", now()).event_filter,
            None
        );
    }

    #[test]
    fn the_detail_depth_follows_the_intent_and_the_keywords() {
        assert_eq!(
            resolve_detail_depth(
                "was war ausgehandelt",
                KnowledgeQueryIntent::NegotiationRecall
            ),
            KnowledgeDetailDepth::High
        );
        assert_eq!(
            resolve_detail_depth("bitte exakt", KnowledgeQueryIntent::GeneralRecall),
            KnowledgeDetailDepth::High
        );
        assert_eq!(
            resolve_detail_depth("wann war das", KnowledgeQueryIntent::GeneralRecall),
            KnowledgeDetailDepth::Medium
        );
        assert_eq!(
            resolve_detail_depth("sauna", KnowledgeQueryIntent::GeneralRecall),
            KnowledgeDetailDepth::Low
        );
    }

    #[test]
    fn the_keyword_rules_keep_their_priority_order() {
        // "geschlafen" wins over "essen" because it is the first rule.
        assert_eq!(
            resolve_event_filter("wir waren schlafen und essen", None)
                .map(|filter| filter.event_type),
            Some(Some("shared_sleep".to_string()))
        );
        assert_eq!(
            resolve_event_filter("das treffen war gut", None).map(|filter| filter.event_type),
            Some(Some("meeting".to_string()))
        );
        assert_eq!(resolve_event_filter("nichts", None), None);
        assert_eq!(
            resolve_event_filter("nichts", Some("max")).map(|filter| filter.counterpart_entity),
            Some(Some("max".to_string()))
        );
        assert_eq!(event_type_rules().len(), 8);
    }

    #[test]
    fn a_plan_starts_without_resolved_entities() {
        let plan = plan_knowledge_query_at("Sauna war gut", now());
        assert_eq!(plan.resolved_entity_id, None);
        assert_eq!(plan.resolved_entity_name, None);
        assert_eq!(plan.counterpart_aliases, None);
        assert_eq!(plan.time_range, None);
        assert_eq!(plan.topic, None);
    }
}
