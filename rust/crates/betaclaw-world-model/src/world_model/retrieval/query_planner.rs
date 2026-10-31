//! Port of `src/server/world-model/retrieval/queryPlanner.ts` (140 lines).
//!
//! | TypeScript | Rust |
//! | --- | --- |
//! | `queryPlanner.ts:1-5` (`TimeWindow`) | [`TimeWindow`] |
//! | `queryPlanner.ts:7-20` (`PlannedQuery`) | [`PlannedQuery`], [`QueryIntent`] |
//! | `queryPlanner.ts:22-25` (`QueryPlanInput`) | [`QueryPlanInput`] |
//! | `queryPlanner.ts:27-72` (`PATTERNS`) | the four `LazyLock<Regex>` of this module |
//! | `queryPlanner.ts:74-80` (`detectTimeWindow`) | [`detect_time_window`] |
//! | `queryPlanner.ts:82-84` (`isTwoDigitTimePart`) | [`is_two_digit_time_part`] |
//! | `queryPlanner.ts:86-112` (`detectAsOf`) | [`detect_as_of`] |
//! | `queryPlanner.ts:114-126` (`detectIntent`) | [`detect_intent`] |
//! | `queryPlanner.ts:132-143` (`planQuery`) | [`plan_query`] |
//! | `queryPlanner.ts:145-149` (`extractEntityMention`) | [`extract_entity_mention`] |
//!
//! # Why this module carries its own `Date`
//!
//! The source plans against JavaScript `Date` values: `new Date(now)`,
//! `setUTCDate(getUTCDate() - 7)`, `setUTCHours(0, 0, 0, 0)` and
//! `toISOString()`. [`JsDate`] is exactly that subset — an epoch-millisecond
//! `number` plus the four operations the builders use. The day arithmetic runs
//! on the civil-calendar formulas of `MakeDay`/`MakeDay`-inverse, so a
//! day-of-month outside the month overflows into the next month exactly like
//! `setUTCDate` does (`new Date('2026-02-30')` is `2026-03-02T00:00:00.000Z` in
//! V8, verified against node v24). Whole-day UTC arithmetic is exact in
//! milliseconds, so `setUTCDate(day - n)` is `epoch_ms - n * 86_400_000`.
//!
//! # Verified TypeScript quirks
//!
//! * `detectAsOf` appends `Z` to an offset-less date-time
//!   (`queryPlanner.ts:100-101`), because `Date.parse` would read it as *local*
//!   time; the port parses offset-less values as UTC everywhere, so a caller
//!   that passes `now: '2026-02-15T09:30'` gets `09:30Z` where the source would
//!   use the host timezone (deliberate deviation — a ported unit test must not
//!   depend on the host offset).
//! * `input.now ? new Date(input.now) : new Date()` (`:133`) uses truthiness: an
//!   **empty** `now` string means "now". The port keeps that.
//! * `Date.parse` accepts the ISO field ranges of the specification and
//!   overflows a day-of-month (02-30 → 03-02) but rejects month `13`, day `32`,
//!   minute `60`, second `60` and `24:00:12`. [`JsDate::parse`] reproduces
//!   exactly those rules; the permissive legacy forms (`'Aug 18 2026'`, RFC
//!   2822) are *not* reproduced — no caller of this slice passes one (OP).
//! * `Date#toISOString()` **throws** `RangeError` on an invalid date. Rust has
//!   no exception here, so an unparsable `now` yields no time window and no
//!   as-of values instead of throwing. The only caller of `planQuery`
//!   (`index.ts:105`) passes no `now` at all, so the case is unreachable from
//!   the retrieval path (deliberate deviation, OP).
//! * `String.prototype.replace(/en?$/, '')` (`:65`) strips a trailing `e`/`en`
//!   *once*, so `'monaten'` → `'monat'` → `'monaten'` and `'woche'` →
//!   `'woch'` → `'wochen'`; [`normalize_unit`] spells that out.
//!
//! `\s`, `trim` and `toLowerCase` follow Rust's Unicode definitions
//! (`is_whitespace`, `str::trim`, `str::to_lowercase`), which differ from the
//! JavaScript ones only for U+0085 and U+FEFF; every input of this slice is
//! ASCII or German text (OP).
//!
//! Regexes: the four time patterns, the as-of marker, the six intent patterns
//! and the entity mention need alternation, capture groups and match offsets,
//! which the port would otherwise hand-write; `regex` is already a workspace
//! dependency for exactly this reason (`rust/Cargo.toml:32-40`). Every pattern
//! that JavaScript writes with `\d` is written with `[0-9]` here, because
//! Rust's `\d` is Unicode-aware and `Number('١٢')` is `NaN` in JavaScript.

use std::sync::LazyLock;

use regex::Regex;

/// `TimeWindow` from `queryPlanner.ts:1-5`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TimeWindow {
    pub after: Option<String>,
    pub before: Option<String>,
    pub label: Option<String>,
}

/// The `intent` union of `PlannedQuery` — `queryPlanner.ts:9-16`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum QueryIntent {
    WhatDone,
    WhatPlanned,
    WhatCancelled,
    WhoInvolved,
    WhatOpen,
    WhatPromised,
    Generic,
}

impl QueryIntent {
    /// The union literal — it travels into `RankCandidate.queryIntent`
    /// (`index.ts:233`) where `'generic'` disables the ranking bonus.
    pub fn as_str(self) -> &'static str {
        match self {
            QueryIntent::WhatDone => "what_done",
            QueryIntent::WhatPlanned => "what_planned",
            QueryIntent::WhatCancelled => "what_cancelled",
            QueryIntent::WhoInvolved => "who_involved",
            QueryIntent::WhatOpen => "what_open",
            QueryIntent::WhatPromised => "what_promised",
            QueryIntent::Generic => "generic",
        }
    }
}

/// `PlannedQuery` from `queryPlanner.ts:7-20`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PlannedQuery {
    /// Absent when no pattern matched *or* when `now` was invalid.
    pub time_window: Option<TimeWindow>,
    pub intent: QueryIntent,
    pub entity: Option<String>,
    /// Bitemporal: the validity time the question asks about.
    pub as_of_valid_time: Option<String>,
    /// Bitemporal: the knowledge time the question asks about.
    pub as_of_known_time: Option<String>,
}

/// `QueryPlanInput` from `queryPlanner.ts:22-25`.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct QueryPlanInput {
    pub text: String,
    /// An ISO-8601 instant; `None` (or `Some("")`) means the current clock,
    /// like the truthiness check of `queryPlanner.ts:133`.
    pub now: Option<String>,
}

/// JavaScript's maximum representable time value, `8.64e15` ms from the epoch.
const MAX_TIME_VALUE: f64 = 8.64e15;
/// Milliseconds per day.
const MS_PER_DAY: f64 = 86_400_000.0;

/// The `Date` subset the planners use: an epoch-millisecond number.
///
/// `epoch_ms` is `NaN` for `Invalid Date` — the JavaScript sentinel — so every
/// operation keeps propagating invalidity instead of panicking.
#[derive(Debug, Clone, Copy, PartialEq)]
struct JsDate {
    epoch_ms: f64,
}

impl JsDate {
    /// `new Date(NaN)`.
    fn invalid() -> Self {
        Self { epoch_ms: f64::NAN }
    }

    /// `TimeClip(epochMs)`.
    fn from_epoch_ms(epoch_ms: f64) -> Self {
        if !epoch_ms.is_finite() || epoch_ms.abs() > MAX_TIME_VALUE {
            return Self::invalid();
        }
        Self {
            epoch_ms: epoch_ms.trunc(),
        }
    }

    /// `new Date()` — `queryPlanner.ts:133` without an `input.now`.
    fn now() -> Self {
        let epoch_ms = match std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH) {
            Ok(elapsed) => elapsed.as_millis() as f64,
            // A clock before 1970 is the only `Err` of this difference.
            Err(error) => -(error.duration().as_millis() as f64),
        };
        Self::from_epoch_ms(epoch_ms)
    }

    fn is_valid(&self) -> bool {
        !self.epoch_ms.is_nan()
    }

    /// `end.setUTCDate(end.getUTCDate() - days)` (`queryPlanner.ts:37`, `:47`,
    /// `:68`) — whole-day UTC arithmetic, which is exact in milliseconds.
    fn add_utc_days(&self, days: i64) -> Self {
        if !self.is_valid() {
            return *self;
        }
        Self::from_epoch_ms(self.epoch_ms - days as f64 * MS_PER_DAY)
    }

    /// `start.setUTCHours(0, 0, 0, 0)` — `queryPlanner.ts:55`.
    fn start_of_utc_day(&self) -> Self {
        if !self.is_valid() {
            return *self;
        }
        let epoch_ms = (self.epoch_ms as i64).div_euclid(MS_PER_DAY as i64) * MS_PER_DAY as i64;
        Self::from_epoch_ms(epoch_ms as f64)
    }

    /// `date.toISOString()` — `None` where JavaScript throws `RangeError`.
    fn to_iso_string(self) -> Option<String> {
        if !self.is_valid() {
            return None;
        }
        let epoch_ms = self.epoch_ms as i64;
        let day_index = epoch_ms.div_euclid(MS_PER_DAY as i64);
        let time_of_day = epoch_ms.rem_euclid(MS_PER_DAY as i64);
        let (year, month, day) = civil_from_days(day_index);
        Some(format!(
            "{year:04}-{month:02}-{day:02}T{:02}:{:02}:{:02}.{:03}Z",
            time_of_day / 3_600_000,
            (time_of_day / 60_000) % 60,
            (time_of_day / 1_000) % 60,
            time_of_day % 1_000
        ))
    }
}

impl JsDate {
    /// `new Date(text)` for the ISO-8601 forms this slice produces and reads.
    fn parse(text: &str) -> Self {
        let bytes = text.as_bytes();
        if bytes.len() < 10 {
            return Self::invalid();
        }
        let Some(year) = digits(text, 0, 4) else {
            return Self::invalid();
        };
        if bytes[4] != b'-' {
            return Self::invalid();
        }
        let Some(month) = digits(text, 5, 2) else {
            return Self::invalid();
        };
        if bytes[7] != b'-' {
            return Self::invalid();
        }
        let Some(day) = digits(text, 8, 2) else {
            return Self::invalid();
        };
        // `MM` is `01-12` and `DD` is `01-31`; a day beyond the length of the
        // month overflows through `MakeDay`, exactly like V8.
        if !(1..=12).contains(&month) || !(1..=31).contains(&day) {
            return Self::invalid();
        }

        let mut hour = 0;
        let mut minute = 0;
        let mut second = 0;
        let mut millisecond = 0;
        let mut offset_ms = 0.0;
        if bytes.len() > 10 {
            if !matches!(bytes[10], b'T' | b't' | b' ') {
                return Self::invalid();
            }
            let rest = &text[11..];
            let rest_bytes = rest.as_bytes();
            if rest_bytes.len() < 5 {
                return Self::invalid();
            }
            let Some(parsed_hour) = digits(rest, 0, 2) else {
                return Self::invalid();
            };
            if rest_bytes[2] != b':' {
                return Self::invalid();
            }
            let Some(parsed_minute) = digits(rest, 3, 2) else {
                return Self::invalid();
            };
            hour = parsed_hour;
            minute = parsed_minute;
            let mut cursor = 5;
            if rest_bytes.len() > cursor && rest_bytes[cursor] == b':' {
                let Some(parsed_second) = digits(rest, cursor + 1, 2) else {
                    return Self::invalid();
                };
                second = parsed_second;
                cursor += 3;
            }
            if rest_bytes.len() > cursor && rest_bytes[cursor] == b'.' {
                let (value, seen) = parse_fraction(&rest[cursor + 1..]);
                if seen == 0 {
                    return Self::invalid();
                }
                millisecond = value;
                cursor += 1 + seen;
            }
            let tail = &rest[cursor..];
            if !tail.is_empty() {
                match tail.as_bytes()[0] {
                    b'Z' | b'z' if tail.len() == 1 => {}
                    sign @ (b'+' | b'-') => {
                        let Some(minutes) = parse_offset_minutes(&tail[1..]) else {
                            return Self::invalid();
                        };
                        offset_ms = if sign == b'-' {
                            -(minutes as f64)
                        } else {
                            minutes as f64
                        } * 60_000.0;
                    }
                    _ => return Self::invalid(),
                }
            }
            // `00-24` for the hour, `00-59` for minute and second; V8 rejects
            // `24:00:12` unless the whole time is zero.
            if hour > 24 || minute > 59 || second > 59 {
                return Self::invalid();
            }
            if hour == 24 && (minute != 0 || second != 0 || millisecond != 0) {
                return Self::invalid();
            }
        }

        let days = days_from_civil(year, month, day);
        let time_of_day = ((hour * 60 + minute) * 60 + second) * 1000 + millisecond;
        let epoch_ms = (days as f64) * MS_PER_DAY + time_of_day as f64 - offset_ms;
        Self::from_epoch_ms(epoch_ms)
    }
}

/// The `count` ASCII digits starting at byte `start`, or `None`.
///
/// `[0-9]` instead of `\d`: JavaScript's `\d` is ASCII-only and
/// `Number('\u0661')` is `NaN`, while Rust's `\d` would match it.
fn digits(text: &str, start: usize, count: usize) -> Option<i64> {
    let bytes = text.as_bytes();
    let slice = bytes.get(start..start + count)?;
    let mut value = 0_i64;
    for byte in slice {
        if !byte.is_ascii_digit() {
            return None;
        }
        value = value * 10 + i64::from(byte - b'0');
    }
    Some(value)
}

/// The fractional seconds of `text` as milliseconds and the number of digits
/// consumed. V8 multiplies the fraction by 1000 and truncates, so `.5` is
/// 500 ms, `.99` is 990 ms and `.1000` is 100 ms.
fn parse_fraction(text: &str) -> (i64, usize) {
    let mut fraction = 0.0;
    let mut scale = 0.1;
    let mut seen = 0_usize;
    for byte in text.as_bytes() {
        if !byte.is_ascii_digit() {
            break;
        }
        if seen < 9 {
            fraction += f64::from(byte - b'0') * scale;
            scale /= 10.0;
        }
        seen += 1;
    }
    ((fraction * 1000.0).trunc() as i64, seen)
}

/// The offset of `HH:MM`, `HHMM` or `HH` in minutes.
fn parse_offset_minutes(text: &str) -> Option<i64> {
    let hours = digits(text, 0, 2)?;
    match text.len() {
        2 => Some(hours * 60),
        5 if text.as_bytes()[2] == b':' => {
            let minutes = digits(text, 3, 2)?;
            Some(hours * 60 + minutes)
        }
        4 => {
            let minutes = digits(text, 2, 2)?;
            Some(hours * 60 + minutes)
        }
        _ => None,
    }
}

/// `MakeDay(year, month - 1, day)` as a day index — the inverse of
/// [`civil_from_days`], tolerant of an out-of-range `day` (which is how
/// `new Date('2026-02-30')` becomes March).
fn days_from_civil(year: i64, month: i64, day: i64) -> i64 {
    let year = year - i64::from(month <= 2);
    let era = if year >= 0 { year } else { year - 399 } / 400;
    let year_of_era = year - era * 400;
    let month_prime = if month > 2 { month - 3 } else { month + 9 };
    let day_of_year = (153 * month_prime + 2) / 5 + day - 1;
    let day_of_era = year_of_era * 365 + year_of_era / 4 - year_of_era / 100 + day_of_year;
    era * 146_097 + day_of_era - 719_468
}

/// `MakeDay`'s inverse — a day index as `(year, month, day)`.
fn civil_from_days(day_index: i64) -> (i64, i64, i64) {
    let shifted = day_index + 719_468;
    let era = if shifted >= 0 {
        shifted
    } else {
        shifted - 146_096
    } / 146_097;
    let day_of_era = shifted - era * 146_097;
    let year_of_era =
        (day_of_era - day_of_era / 1_460 + day_of_era / 36_524 - day_of_era / 146_096) / 365;
    let year = year_of_era + era * 400;
    let day_of_year = day_of_era - (365 * year_of_era + year_of_era / 4 - year_of_era / 100);
    let month_prime = (5 * day_of_year + 2) / 153;
    let day = day_of_year - (153 * month_prime + 2) / 5 + 1;
    let month = month_prime + if month_prime < 10 { 3 } else { -9 };
    (year + i64::from(month <= 2), month, day)
}

// ─── The patterns ───────────────────────────────────────────────────────────
//
// `PATTERNS` (`queryPlanner.ts:27-72`) is an ordered array and the first match
// wins; the four branches are spelled out in that order below. `[0-9]` replaces
// every `\d` (see the module header).

/// `/letzte woche/i` — `queryPlanner.ts:33`.
static LAST_WEEK: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?i)letzte woche").expect("constant pattern"));
/// `/gestern/i` — `queryPlanner.ts:42`.
static YESTERDAY: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?i)gestern").expect("constant pattern"));
/// `/heute/i` — `queryPlanner.ts:51`.
static TODAY: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?i)heute").expect("constant pattern"));
/// `/vor\s+(\d+)\s+(monaten?|wochen?)/i` — `queryPlanner.ts:60`.
static RELATIVE_DURATION: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?i)vor\s+([0-9]+)\s+(monaten?|wochen?)").expect("constant pattern")
});
/// `/(?:as\s+of|zum\s+zeitpunkt|stand)\s+/i` — `queryPlanner.ts:87`.
static AS_OF_MARKER: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?i)(?:as\s+of|zum\s+zeitpunkt|stand)\s+").expect("constant pattern")
});
/// `/damals|zu dem zeitpunkt|damaliger wissensstand/i` — `queryPlanner.ts:108`.
static KNOWN_AS_OF: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?i)damals|zu dem zeitpunkt|damaliger wissensstand").expect("constant pattern")
});
/// `detectIntent` — `queryPlanner.ts:115-125`; the caller lower-cases the text,
/// so the patterns carry no `i` flag in the source either.
static INTENT_PATTERNS: LazyLock<[Regex; 6]> = LazyLock::new(|| {
    [
        Regex::new(
            r"was (habe ich|hab ich|habe|wurde|ist) .*(gemacht|getan|passiert|geworden|essen|war)",
        )
        .expect("constant pattern"),
        Regex::new(r"was (ist|war) .*(geplant|vor|ausgemacht|terminal)").expect("constant pattern"),
        Regex::new(r"was (ist|wurde) .*(abgesagt|storniert|cancelled)").expect("constant pattern"),
        Regex::new(r"wer (war|ist|dabei|beteiligt)|mit wem").expect("constant pattern"),
        Regex::new(r"was (ist|steht) (noch )?(offen|ausstehend)|offene (punkte|fragen)")
            .expect("constant pattern"),
        Regex::new(r"was (habe ich|hab ich) (versprochen|zugesagt)").expect("constant pattern"),
    ]
});
/// `/(?:mit|wegen|fuer|zu|von)\s+([A-ZÄÖÜ][a-zäöü]+)/` — `queryPlanner.ts:147`.
///
/// No `i` flag in the source, so the class stays case-sensitive.
static ENTITY_MENTION: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?:mit|wegen|fuer|zu|von)\s+([A-ZÄÖÜ][a-zäöü]+)").expect("constant pattern")
});

/// `detectTimeWindow` (`queryPlanner.ts:74-80`) — the first matching pattern.
fn detect_time_window(text: &str, now: &JsDate) -> Option<TimeWindow> {
    if !now.is_valid() {
        return None;
    }
    if LAST_WEEK.is_match(text) {
        let end = now.add_utc_days(7);
        return Some(TimeWindow {
            after: end.to_iso_string(),
            before: now.to_iso_string(),
            label: Some("last_week".to_string()),
        });
    }
    if YESTERDAY.is_match(text) {
        let start = now.add_utc_days(1);
        return Some(TimeWindow {
            after: start.to_iso_string(),
            before: now.to_iso_string(),
            label: Some("yesterday".to_string()),
        });
    }
    if TODAY.is_match(text) {
        let start = now.start_of_utc_day();
        return Some(TimeWindow {
            after: start.to_iso_string(),
            before: now.to_iso_string(),
            label: Some("today".to_string()),
        });
    }
    if let Some(found) = RELATIVE_DURATION.captures(text) {
        // `Number(m[1] ?? 1)`: the `[0-9]+` group is always present, so the
        // fallback is unreachable; the port keeps the parse fallible anyway.
        let count = found
            .get(1)
            .and_then(|value| value.as_str().parse::<i64>().ok())
            .unwrap_or(1);
        let raw = found.get(2).map(|value| value.as_str()).unwrap_or("woche");
        let unit = normalize_unit(raw);
        let multiplier = if unit.starts_with("monat") { 30 } else { 7 };
        let end = now.add_utc_days(count * multiplier);
        return Some(TimeWindow {
            after: end.to_iso_string(),
            before: now.to_iso_string(),
            label: Some(format!("last_{count}_{unit}")),
        });
    }
    None
}

/// `isTwoDigitTimePart` (`queryPlanner.ts:82-84`) — exactly two `0-9` digits.
///
/// `[...part].every(...)` counts code points, so `'ä9'` is `false` twice over.
fn is_two_digit_time_part(part: &str) -> bool {
    part.len() == 2 && part.bytes().all(|byte| byte.is_ascii_digit())
}

/// `detectAsOf` (`queryPlanner.ts:86-112`).
///
/// Returns `(valid, known)`. The date part is the first ten characters after
/// the marker and must have the `YYYY-MM-DD` shape; a following `T`, `t` or
/// space whose time part consists of two or three two-digit groups is appended
/// as `T<time>Z`, because `Date.parse` would read an offset-less date-time as
/// local time (`:100-101`).
fn detect_as_of(text: &str, now: &JsDate) -> (Option<String>, Option<String>) {
    if let Some(marker) = AS_OF_MARKER.find(text) {
        let remainder = &text[marker.end()..];
        let date_part: String = remainder.chars().take(10).collect();
        let mut iso_value = if is_date_only(&date_part) {
            date_part.clone()
        } else {
            String::new()
        };
        let separator = remainder.chars().nth(10);
        if !iso_value.is_empty() {
            if let Some(separator) = separator {
                if matches!(separator, 'T' | 't' | ' ') {
                    // `remainder.slice(11).split(/\s+/)[0] ?? ''` keeps a
                    // leading empty segment, which `str::split` on a
                    // whitespace predicate reproduces.
                    let tail: String = remainder.chars().skip(11).collect();
                    let time_part = tail
                        .split(char::is_whitespace)
                        .next()
                        .unwrap_or_default()
                        .to_string();
                    let parts: Vec<&str> = time_part.split(':').collect();
                    if (parts.len() == 2 || parts.len() == 3)
                        && parts.iter().all(|part| is_two_digit_time_part(part))
                    {
                        iso_value = format!("{date_part}T{time_part}Z");
                    }
                }
            }
        }
        // `new Date(isoValue)`: an empty string is `Invalid Date`, the shape
        // check above only guards the *format*.
        let parsed = JsDate::parse(&iso_value);
        if let Some(iso) = parsed.to_iso_string() {
            return (Some(iso.clone()), Some(iso));
        }
    }
    if KNOWN_AS_OF.is_match(text) {
        return (None, now.to_iso_string());
    }
    (None, None)
}

/// `/^[0-9]{4}-[0-9]{2}-[0-9]{2}$/` — `queryPlanner.ts:91`.
fn is_date_only(text: &str) -> bool {
    let bytes = text.as_bytes();
    if bytes.len() != 10 || bytes[4] != b'-' || bytes[7] != b'-' {
        return false;
    }
    bytes
        .iter()
        .enumerate()
        .all(|(index, byte)| index == 4 || index == 7 || byte.is_ascii_digit())
}

/// `detectIntent` (`queryPlanner.ts:114-126`) — the first pattern wins.
fn detect_intent(text: &str) -> QueryIntent {
    let patterns = &*INTENT_PATTERNS;
    if patterns[0].is_match(text) {
        return QueryIntent::WhatDone;
    }
    if patterns[1].is_match(text) {
        return QueryIntent::WhatPlanned;
    }
    if patterns[2].is_match(text) {
        return QueryIntent::WhatCancelled;
    }
    if patterns[3].is_match(text) {
        return QueryIntent::WhoInvolved;
    }
    if patterns[4].is_match(text) {
        return QueryIntent::WhatOpen;
    }
    if patterns[5].is_match(text) {
        return QueryIntent::WhatPromised;
    }
    QueryIntent::Generic
}

/// `planQuery(input)` — `queryPlanner.ts:132-143`.
///
/// `input.now` follows the truthiness of `:133`: `None` and `Some("")` both
/// mean "the current clock". An unparsable `now` is `Invalid Date` in the
/// source, whose `toISOString()` throws; the port drops the window and the
/// as-of values instead (see the module header).
pub fn plan_query(input: &QueryPlanInput) -> PlannedQuery {
    let now = match input.now.as_deref() {
        Some(text) if !text.is_empty() => JsDate::parse(text),
        _ => JsDate::now(),
    };
    let text = input.text.trim();
    let (as_of_valid_time, as_of_known_time) = detect_as_of(text, &now);
    PlannedQuery {
        time_window: detect_time_window(text, &now),
        intent: detect_intent(&text.to_lowercase()),
        as_of_valid_time,
        as_of_known_time,
        entity: extract_entity_mention(text),
    }
}

/// `extractEntityMention(text)` — `queryPlanner.ts:145-149`.
///
/// The first capitalized word of at least two letters after one of the five
/// prepositions; the source matches anywhere in the text and the port keeps that
/// (the TypeScript comment claims "first noun-like component", the regex is a
/// plain search).
pub fn extract_entity_mention(text: &str) -> Option<String> {
    ENTITY_MENTION
        .captures(text)
        .and_then(|found| found.get(1))
        .map(|value| value.as_str().to_string())
}

/// `String(m[2] ?? 'woche').toLowerCase().replace(/en?$/, '') + 'en'`
/// (`queryPlanner.ts:64-65`).
///
/// The `en?$` replacement strips a single trailing `e` or `en`: `'monaten'` and
/// `'monate'` and `'monat'` all become `'monaten'`, `'wochen'` and `'woche'`
/// become `'wochen'`.
fn normalize_unit(raw: &str) -> String {
    let lowered = raw.to_lowercase();
    let stem = lowered
        .strip_suffix("en")
        .or_else(|| lowered.strip_suffix('e'))
        .unwrap_or(lowered.as_str());
    format!("{stem}en")
}

#[cfg(test)]
mod tests {
    use super::*;

    /// `NOW` of `tests/unit/world-model/query-planner.test.ts:5`.
    const NOW: &str = "2026-08-18T12:00:00.000Z";

    fn plan(text: &str) -> PlannedQuery {
        plan_query(&QueryPlanInput {
            text: text.to_string(),
            now: Some(NOW.to_string()),
        })
    }

    fn window(text: &str) -> TimeWindow {
        plan(text).time_window.expect("a time window")
    }

    fn iso(text: &str) -> String {
        JsDate::parse(text).to_iso_string().expect("a valid date")
    }

    /// The `Date` field ranges of the specification, verified against node
    /// v24 (`new Date(value).toISOString()`): a day-of-month overflows into the
    /// next month, while month `13`, day `32`, minute `60`, second `60` and
    /// `24:00:12` are `Invalid Date`.
    #[test]
    fn js_date_parsing_follows_the_iso_field_ranges() {
        assert_eq!(iso("2026-02-30"), "2026-03-02T00:00:00.000Z");
        assert_eq!(iso("2026-02-31"), "2026-03-03T00:00:00.000Z");
        assert_eq!(iso("2024-02-29"), "2024-02-29T00:00:00.000Z");
        assert_eq!(iso("2026-02-15T09:30Z"), "2026-02-15T09:30:00.000Z");
        assert_eq!(iso("2026-02-15T09:30:12.5Z"), "2026-02-15T09:30:12.500Z");
        assert_eq!(iso("2026-02-15T09:30:12.99Z"), "2026-02-15T09:30:12.990Z");
        assert_eq!(
            iso("2026-02-15T09:30:12.1000Z"),
            "2026-02-15T09:30:12.100Z",
            "V8 scales the fraction by 1000 and truncates"
        );
        assert_eq!(
            iso("2026-02-15T24:00Z"),
            "2026-02-16T00:00:00.000Z",
            "hour 24 is a valid field value"
        );
        assert_eq!(iso("2026-02-15t09:30z"), "2026-02-15T09:30:00.000Z");
        assert_eq!(iso("0000-01-01"), "0000-01-01T00:00:00.000Z");
        assert_eq!(iso("2026-02-15T09:30:12+02:00"), "2026-02-15T07:30:12.000Z");

        for invalid in [
            "",
            "garbage",
            "2026-13-15",
            "2026-00-15",
            "2026-01-00",
            "2026-02-32",
            "2026-02-15T25:00Z",
            "2026-02-15T24:00:12Z",
            "2026-02-15T23:60Z",
            "2026-02-15T23:59:60Z",
            "2026-2-15",
            "2026/02/15",
            "2026-02-15T09",
        ] {
            assert!(
                JsDate::parse(invalid).to_iso_string().is_none(),
                "`new Date({invalid:?})` is an invalid date"
            );
        }
    }

    /// The offset-less date-time of a caller-supplied `now` is UTC in the port
    /// where `Date.parse` would use the host timezone (module header).
    #[test]
    fn an_offset_less_now_is_interpreted_as_utc() {
        assert_eq!(iso("2026-02-15T09:30"), "2026-02-15T09:30:00.000Z");
        assert_eq!(iso("2026-02-15 09:30:12"), "2026-02-15T09:30:12.000Z");
    }

    /// `tests/unit/world-model/query-planner.test.ts:8-19`.
    #[test]
    fn relative_windows_use_the_current_instant_as_the_before_bound() {
        let last_week = plan("Was habe ich letzte Woche gemacht?");
        assert_eq!(last_week.intent, QueryIntent::WhatDone);
        let last_week_window = last_week.time_window.expect("last_week");
        assert_eq!(last_week_window.label.as_deref(), Some("last_week"));
        assert_eq!(
            last_week_window.after.as_deref(),
            Some("2026-08-11T12:00:00.000Z")
        );
        assert_eq!(last_week_window.before.as_deref(), Some(NOW));

        assert_eq!(
            window("Was ist vor 2 Wochen passiert?").label.as_deref(),
            Some("last_2_wochen")
        );
        assert_eq!(
            plan("Was ist vor 2 Wochen passiert?").intent,
            QueryIntent::WhatDone
        );
    }

    /// `tests/unit/world-model/query-planner.test.ts:21-37`.
    #[test]
    fn yesterday_today_and_months_match_the_source() {
        let yesterday = window("Was habe ich gestern gemacht?");
        assert_eq!(yesterday.after.as_deref(), Some("2026-08-17T12:00:00.000Z"));
        assert_eq!(yesterday.before.as_deref(), Some(NOW));
        assert_eq!(yesterday.label.as_deref(), Some("yesterday"));

        let today = window("Was ist heute geplant?");
        assert_eq!(today.after.as_deref(), Some("2026-08-18T00:00:00.000Z"));
        assert_eq!(today.before.as_deref(), Some(NOW));
        assert_eq!(today.label.as_deref(), Some("today"));

        let months = window("Was ist vor 2 Monaten geplant?");
        assert_eq!(months.after.as_deref(), Some("2026-06-19T12:00:00.000Z"));
        assert_eq!(months.before.as_deref(), Some(NOW));
        assert_eq!(months.label.as_deref(), Some("last_2_monaten"));
    }

    /// `tests/unit/world-model/query-planner.test.ts:39-56`.
    #[test]
    fn intents_match_the_source_order() {
        assert_eq!(
            plan("Was ist diese Woche geplant?").intent,
            QueryIntent::WhatPlanned
        );
        assert_eq!(
            plan("Was wurde abgesagt?").intent,
            QueryIntent::WhatCancelled
        );
        assert_eq!(plan("Was steht noch offen?").intent, QueryIntent::WhatOpen);
        assert_eq!(plan("Wer war dabei?").intent, QueryIntent::WhoInvolved);
        assert_eq!(
            plan("Was habe ich versprochen?").intent,
            QueryIntent::WhatPromised
        );
        assert_eq!(plan("Erzaehl mir etwas").intent, QueryIntent::Generic);
        assert_eq!(
            plan("Was ist mit Kino geplant?").intent,
            QueryIntent::WhatPlanned
        );
        assert_eq!(
            plan("Was ist mit Kino abgesagt?").intent,
            QueryIntent::WhatCancelled
        );

        // `detectIntent` runs on `text.toLowerCase()` (`:138`).
        assert_eq!(
            plan("WAS HABE ICH GESTERN GEMACHT?").intent,
            QueryIntent::WhatDone
        );
    }

    /// `tests/unit/world-model/query-planner.test.ts:58-89`.
    #[test]
    fn as_of_timestamps_use_the_date_and_appended_z_rules() {
        let date_only = plan("Stand 2026-02-15");
        assert_eq!(
            date_only.as_of_valid_time.as_deref(),
            Some("2026-02-15T00:00:00.000Z")
        );
        assert_eq!(
            date_only.as_of_known_time.as_deref(),
            Some("2026-02-15T00:00:00.000Z")
        );

        let minutes = plan("as of 2026-02-15T09:30");
        assert_eq!(
            minutes.as_of_valid_time.as_deref(),
            Some("2026-02-15T09:30:00.000Z")
        );

        let seconds = plan("Zum Zeitpunkt 2026-02-15 09:30:12");
        assert_eq!(
            seconds.as_of_known_time.as_deref(),
            Some("2026-02-15T09:30:12.000Z")
        );

        let historical = plan("Was war damals?");
        assert_eq!(historical.as_of_valid_time, None);
        assert_eq!(historical.as_of_known_time.as_deref(), Some(NOW));

        for ignored in ["as of 2026-13-15", "as of 15.02.2026"] {
            let ignored_plan = plan(ignored);
            assert_eq!(ignored_plan.as_of_valid_time, None, "{ignored}");
            assert_eq!(ignored_plan.as_of_known_time, None, "{ignored}");
        }

        // A single-digit hour group is not a two-digit time part (`:96-99`),
        // so the date-only value survives unchanged.
        assert_eq!(
            plan("Stand 2026-02-15T09").as_of_valid_time.as_deref(),
            Some("2026-02-15T00:00:00.000Z")
        );
    }

    /// `tests/unit/world-model/query-planner.test.ts:91-99`.
    #[test]
    fn the_current_clock_is_used_when_no_reference_time_is_supplied() {
        let plan = plan_query(&QueryPlanInput {
            text: "Was ist heute geplant?".to_string(),
            now: None,
        });
        let window = plan.time_window.expect("today");
        assert_eq!(window.label.as_deref(), Some("today"));
        let before = window.before.expect("before");
        assert!(before.ends_with('Z') && before.len() == 24, "{before}");
        assert!(JsDate::parse(&before).is_valid());

        // `input.now` is checked for truthiness, so `''` means "now" (`:133`).
        let empty = plan_query(&QueryPlanInput {
            text: "Was ist heute geplant?".to_string(),
            now: Some(String::new()),
        });
        assert_eq!(
            empty.time_window.expect("today").label.as_deref(),
            Some("today")
        );
    }

    /// The documented deviation: an unparsable `now` cannot throw in Rust.
    #[test]
    fn an_unparsable_now_yields_no_window_instead_of_throwing() {
        let plan = plan_query(&QueryPlanInput {
            text: "Was ist heute geplant?".to_string(),
            now: Some("garbage".to_string()),
        });
        assert_eq!(plan.time_window, None);
        assert_eq!(plan.as_of_known_time, None);
        assert_eq!(plan.intent, QueryIntent::WhatPlanned);
    }

    #[test]
    fn entity_mentions_are_case_sensitive_and_keep_umlauts() {
        assert_eq!(
            extract_entity_mention("Rueckblick mit Mike"),
            Some("Mike".to_string())
        );
        assert_eq!(extract_entity_mention("Was habe ich gemacht?"), None);
        assert_eq!(extract_entity_mention("Rueckblick mit mike"), None);
        assert_eq!(
            extract_entity_mention("Treffen wegen Müller"),
            Some("Müller".to_string())
        );
        assert_eq!(
            extract_entity_mention("Kaffee mit Änne"),
            Some("Änne".to_string())
        );
        assert_eq!(plan("Kino").entity, None);
    }

    #[test]
    fn the_unit_normalization_matches_the_replace_pattern() {
        assert_eq!(normalize_unit("monaten"), "monaten");
        assert_eq!(normalize_unit("monate"), "monaten");
        assert_eq!(normalize_unit("monat"), "monaten");
        assert_eq!(normalize_unit("wochen"), "wochen");
        assert_eq!(normalize_unit("woche"), "wochen");
        assert_eq!(normalize_unit("WOCHE"), "wochen");
    }
}
