//! Port of `src/server/automation/cronEngine.ts`, which wraps `cron-parser@5.5.0`
//! (`node_modules/cron-parser/dist/CronExpressionParser.js` and `CronExpression.js`).
//!
//! Ported subset, the forms the TypeScript path reaches with plain user input:
//! - five fields (seconds default to 0), or six fields with seconds first, as cron-parser reads them;
//! - `*`, `?`, numbers, ranges `a-b`, lists `a,b`, steps `*/n`, `a-b/n` and `a/n`;
//! - month and weekday names; weekday 7 is Sunday;
//! - the macros `@yearly` to `@weekends`; the empty expression means `0 * * * * *`.
//!
//! Not ported, rejected here although cron-parser accepts them: `L`, `W`, `#` and the
//! hashed `H` forms.
//!
//! Timezones: the IANA names `chrono-tz` ships (`Europe/Berlin`, `UTC`, `Etc/UTC`, `GMT`),
//! matched case-insensitively as `Intl` does, and fixed offsets `±HH:MM` such as `+05:00`,
//! which Node's `Intl` accepts too. Other offset forms (`+5`, `05:00`) are rejected, as are
//! offsets of 24 hours or more and minutes above 59.
//!
//! Next-run semantics follow cron-parser: the result is the first whole second strictly
//! after the start instant that matches every field in the wall-clock time of the zone. A
//! wall-clock time skipped by a spring-forward change fires an hour later (`02:30` runs at
//! `03:30`); a repeated fall-back time fires once, at its first occurrence.
//!
//! Search limit: cron-parser stops after `LOOP_LIMIT` (10 000) loop steps
//! (`node_modules/cron-parser/dist/CronExpression.js`). This port stops after the same number
//! of calendar days, and reports an error. Deviations: cron-parser then returns a date that
//! does not match (for example `2054-02-25` for `0 0 31 2,4,6,9,11 *`), and it skips the
//! whole day of a spring-forward change when the search starts before it (`0 9 * * *` in
//! Berlin from 2026-03-28 gives 2026-03-30). This port fires on the change day.

use chrono::{
    DateTime, Datelike, FixedOffset, LocalResult, NaiveDate, NaiveDateTime, Offset, SecondsFormat,
    TimeDelta, TimeZone, Utc,
};
use chrono_tz::Tz;
use regex::Regex;

use super::error::AutomationError;

/// `PredefinedExpressions` in cron-parser.
const PREDEFINED: [(&str, &str); 10] = [
    ("@yearly", "0 0 0 1 1 *"),
    ("@annually", "0 0 0 1 1 *"),
    ("@monthly", "0 0 0 1 * *"),
    ("@weekly", "0 0 0 * * 0"),
    ("@daily", "0 0 0 * * *"),
    ("@hourly", "0 0 * * * *"),
    ("@minutely", "0 * * * * *"),
    ("@secondly", "* * * * * *"),
    ("@weekdays", "0 0 0 * * 1-5"),
    ("@weekends", "0 0 0 * * 0,6"),
];

const MONTH_NAMES: [(&str, u32); 12] = [
    ("jan", 1),
    ("feb", 2),
    ("mar", 3),
    ("apr", 4),
    ("may", 5),
    ("jun", 6),
    ("jul", 7),
    ("aug", 8),
    ("sep", 9),
    ("oct", 10),
    ("nov", 11),
    ("dec", 12),
];

const WEEKDAY_NAMES: [(&str, u32); 7] = [
    ("sun", 0),
    ("mon", 1),
    ("tue", 2),
    ("wed", 3),
    ("thu", 4),
    ("fri", 5),
    ("sat", 6),
];

/// Missing leading fields are filled from here (`#getRawFields`).
const DEFAULT_FIELDS: [&str; 6] = ["*", "*", "*", "*", "*", "0"];

/// `LOOP_LIMIT` of cron-parser, counted here in calendar days (see module docs).
const LOOP_LIMIT: usize = 10_000;

#[derive(Debug, Clone, PartialEq, Eq)]
struct CronSpec {
    seconds: Vec<u32>,
    minutes: Vec<u32>,
    hours: Vec<u32>,
    months: Vec<u32>,
    days_of_month: Vec<u32>,
    /// Values as cron-parser stores them: ranges can contain 7 and 0 for Sunday.
    days_of_week: Vec<u32>,
    day_of_month_wildcard: bool,
    day_of_week_wildcard: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum FieldKind {
    /// Numbers only.
    Plain,
    /// Month names are resolved (`JAN`..`DEC`, and weekday names as cron-parser does).
    Month,
    /// Weekday names are resolved; a single weekday value 7 is stored as 0.
    Weekday,
}

/// `validateTimezone`: an IANA name that `chrono-tz` knows, or a `±HH:MM` offset (see module docs).
pub fn validate_timezone(timezone: &str) -> bool {
    parse_zone(timezone).is_some()
}

/// A zone the port accepts: an IANA name or a fixed offset.
enum Zone {
    Iana(Tz),
    Fixed(FixedOffset),
}

fn parse_zone(timezone: &str) -> Option<Zone> {
    if let Some(offset) = parse_offset(timezone) {
        return Some(Zone::Fixed(offset));
    }
    // `chrono-tz` parses names case-sensitively; Intl does not.
    chrono_tz::TZ_VARIANTS
        .iter()
        .copied()
        .find(|tz| tz.name().eq_ignore_ascii_case(timezone))
        .map(Zone::Iana)
}

/// `±HH:MM` only: two digits on each side of the colon, minutes up to 59.
fn parse_offset(timezone: &str) -> Option<FixedOffset> {
    let (sign, rest) = match timezone.as_bytes().first().copied()? {
        b'+' => (1, &timezone[1..]),
        b'-' => (-1, &timezone[1..]),
        _ => return None,
    };
    let (hours, minutes) = rest.split_once(':')?;
    let well_formed = hours.len() == 2
        && minutes.len() == 2
        && hours
            .bytes()
            .chain(minutes.bytes())
            .all(|byte| byte.is_ascii_digit());
    if !well_formed {
        return None;
    }
    let hours: i32 = hours.parse().ok()?;
    let minutes: i32 = minutes.parse().ok()?;
    if minutes > 59 {
        return None;
    }
    // `east_opt` rejects offsets of 24 hours or more.
    FixedOffset::east_opt(sign * (hours * 3600 + minutes * 60))
}

/// `validateCronExpression`.
pub fn validate_cron_expression(expression: &str, timezone: &str) -> bool {
    validate_timezone(timezone) && parse_cron(expression).is_ok()
}

/// `computeNextRunAt`, with the start instant passed in. Returns an ISO string with
/// milliseconds and `Z`, the format of `Date.prototype.toISOString`.
pub fn compute_next_run_at(
    expression: &str,
    timezone: &str,
    from: DateTime<Utc>,
) -> Result<String, AutomationError> {
    let zone = parse_zone(timezone)
        .ok_or_else(|| AutomationError::InvalidTimezone(timezone.to_string()))?;
    let spec = parse_cron(expression).map_err(AutomationError::Cron)?;
    let next = match zone {
        Zone::Iana(tz) => next_run(&spec, tz, from),
        Zone::Fixed(offset) => next_run(&spec, offset, from),
    }
    .map_err(AutomationError::Cron)?;
    Ok(to_iso_millis(next))
}

/// `Date.prototype.toISOString` format, which the SQL string comparisons rely on.
pub fn to_iso_millis(value: DateTime<Utc>) -> String {
    value.to_rfc3339_opts(SecondsFormat::Millis, true)
}

/// `new Date(value)` for the ISO strings this module writes.
pub fn parse_instant(value: &str) -> Result<DateTime<Utc>, AutomationError> {
    DateTime::parse_from_rfc3339(value)
        .map(|parsed| parsed.with_timezone(&Utc))
        .map_err(|_| AutomationError::Cron(format!("Invalid date: {value}")))
}

/// `intervalToCronExpression`: `10m`, `2h` or `3d` to a cron expression.
pub fn interval_to_cron_expression(interval: &str) -> Option<String> {
    let trimmed = interval.trim();
    let (unit_index, unit) = trimmed.char_indices().last()?;
    let digits = &trimmed[..unit_index];
    if digits.is_empty() || !digits.bytes().all(|byte| byte.is_ascii_digit()) {
        return None;
    }
    let amount: u64 = digits.parse().ok()?;
    if amount == 0 {
        return None;
    }
    match unit.to_ascii_lowercase() {
        'm' if amount <= 59 => Some(format!("*/{amount} * * * *")),
        'h' if amount <= 23 => Some(format!("0 */{amount} * * *")),
        'd' if amount <= 31 => Some(format!("0 0 */{amount} * *")),
        _ => None,
    }
}

fn parse_cron(expression: &str) -> Result<CronSpec, String> {
    let expression = PREDEFINED
        .iter()
        .find(|entry| entry.0 == expression)
        .map_or(expression, |entry| entry.1);
    // `expression || '0 * * * * *'`: only the empty string takes the default.
    let expression = if expression.is_empty() {
        "0 * * * * *"
    } else {
        expression
    };

    let trimmed = expression.trim();
    // JavaScript `"".split(/\s+/)` yields one empty atom, which then fails the day-of-week check.
    let atoms: Vec<&str> = if trimmed.is_empty() {
        vec![""]
    } else {
        trimmed.split_whitespace().collect()
    };
    if atoms.len() > 6 {
        return Err("Invalid cron expression, too many fields".to_string());
    }
    let mut fields: Vec<&str> = Vec::with_capacity(6);
    if atoms.len() < 6 {
        fields.extend_from_slice(&DEFAULT_FIELDS[atoms.len()..]);
    }
    fields.extend(atoms);

    let seconds = parse_field(fields[0], 0, 59, FieldKind::Plain)?;
    let minutes = parse_field(fields[1], 0, 59, FieldKind::Plain)?;
    let hours = parse_field(fields[2], 0, 23, FieldKind::Plain)?;
    let days_of_month = parse_field(fields[3], 1, 31, FieldKind::Plain)?;
    let months = parse_field(fields[4], 1, 12, FieldKind::Month)?;
    let days_of_week = parse_field(fields[5], 0, 7, FieldKind::Weekday)?;

    // cron-parser rejects an explicit day that the only listed month lacks (`0 0 30 2 *`).
    // Like its CronFieldCollection, it looks at the first day value only.
    let missing_day = match (months.as_slice(), days_of_month.first()) {
        ([month], Some(&day)) => day > days_in_month(*month),
        _ => false,
    };
    if missing_day {
        return Err("Invalid explicit day of month definition".to_string());
    }

    Ok(CronSpec {
        seconds,
        minutes,
        hours,
        months,
        days_of_month,
        days_of_week,
        day_of_month_wildcard: is_wildcard(fields[3]),
        day_of_week_wildcard: is_wildcard(fields[5]),
    })
}

fn is_wildcard(raw: &str) -> bool {
    raw == "*" || raw == "?"
}

fn parse_field(raw: &str, min: u32, max: u32, kind: FieldKind) -> Result<Vec<u32>, String> {
    let resolved = if kind == FieldKind::Plain {
        raw.to_string()
    } else {
        replace_aliases(raw)?
    };
    if resolved.is_empty()
        || !resolved
            .chars()
            .all(|c| c.is_ascii_digit() || matches!(c, '*' | '?' | ',' | '/' | '-'))
    {
        return Err(format!("Invalid characters, got value: {raw}"));
    }
    let resolved = resolved.replace(['*', '?'], &format!("{min}-{max}"));

    let mut values: Vec<u32> = Vec::new();
    for atom in resolved.split(',') {
        if atom.is_empty() {
            return Err("Invalid list value format".to_string());
        }
        values.extend(parse_repeat(atom, min, max, kind)?);
    }
    values.sort_unstable();
    if values.windows(2).any(|pair| pair[0] == pair[1]) {
        return Err(format!("duplicate values found in {raw}"));
    }
    Ok(values)
}

/// Replaces three-letter names (`[a-z]{3}`, case-insensitive) with their numbers.
/// Both tables are searched for both fields, as cron-parser does.
fn replace_aliases(raw: &str) -> Result<String, String> {
    let names = Regex::new(r"(?i)[a-z]{3}").expect("static pattern compiles");
    let mut out = String::with_capacity(raw.len());
    let mut last = 0;
    for found in names.find_iter(raw) {
        out.push_str(&raw[last..found.start()]);
        let key = found.as_str().to_ascii_lowercase();
        let value = MONTH_NAMES
            .iter()
            .chain(WEEKDAY_NAMES.iter())
            .find(|entry| entry.0 == key)
            .map(|entry| entry.1)
            .ok_or_else(|| format!("Validation error, cannot resolve alias \"{key}\""))?;
        out.push_str(&value.to_string());
        last = found.end();
    }
    out.push_str(&raw[last..]);
    Ok(out)
}

/// `#parseRepeat`: `a/n` means `a-max/n` when `a` is a number; `x-y/n` keeps its bounds.
fn parse_repeat(atom: &str, min: u32, max: u32, kind: FieldKind) -> Result<Vec<u32>, String> {
    let parts: Vec<&str> = atom.split('/').collect();
    match parts.as_slice() {
        [range] => parse_range(range, min, max, kind, 1),
        [base, step] => {
            let base = if base.parse::<i64>().is_ok() {
                format!("{base}-{max}")
            } else {
                (*base).to_string()
            };
            let step: i64 = step
                .parse()
                .map_err(|_| format!("Invalid repeat: {atom}"))?;
            parse_range(&base, min, max, kind, step)
        }
        _ => Err(format!("Invalid repeat: {atom}")),
    }
}

/// `#parseRange` and `#createRange`.
fn parse_range(
    val: &str,
    min: u32,
    max: u32,
    kind: FieldKind,
    step: i64,
) -> Result<Vec<u32>, String> {
    let atoms: Vec<&str> = val.split('-').collect();
    if atoms.len() <= 1 {
        let value: i64 = val.parse().map_err(|_| format!("Invalid value: {val}"))?;
        check_range(value, min, max)?;
        let stored = if kind == FieldKind::Weekday {
            value % 7
        } else {
            value
        };
        return Ok(vec![stored as u32]);
    }

    let low: i64 = atoms[0]
        .parse()
        .map_err(|_| format!("Invalid range: {val}"))?;
    let high: i64 = atoms[1]
        .parse()
        .map_err(|_| format!("Invalid range: {val}"))?;
    check_range(low, min, max)?;
    check_range(high, min, max)?;
    if low > high {
        return Err(format!(
            "Invalid range: {low}-{high}, min({low}) > max({high})"
        ));
    }
    if step <= 0 {
        return Err(format!(
            "Constraint error, cannot repeat at every {step} time."
        ));
    }

    let mut values: Vec<u32> = Vec::new();
    // cron-parser adds Sunday for any weekday range that ends on 7, even when the step skips 7.
    if kind == FieldKind::Weekday && high % 7 == 0 {
        values.push(0);
    }
    let mut index = low;
    while index <= high {
        let value = index as u32;
        if !values.contains(&value) {
            values.push(value);
        }
        index += step;
    }
    Ok(values)
}

fn check_range(value: i64, min: u32, max: u32) -> Result<(), String> {
    if (i64::from(min)..=i64::from(max)).contains(&value) {
        Ok(())
    } else {
        Err(format!(
            "Constraint error, got value {value} expected range {min}-{max}"
        ))
    }
}

impl CronSpec {
    /// The day rules of cron-parser `#matchDayOfMonth`: with both fields restricted either
    /// one may match; otherwise the restricted one must match.
    fn matches_day(&self, day: NaiveDate) -> bool {
        if !self.months.contains(&day.month()) {
            return false;
        }
        let dom_match = self.days_of_month.contains(&day.day());
        let dow_match = self
            .days_of_week
            .contains(&day.weekday().num_days_from_sunday());
        let restricted_dom = !self.day_of_month_wildcard;
        let restricted_dow = !self.day_of_week_wildcard;
        (restricted_dom && restricted_dow && (dom_match || dow_match))
            || (dom_match && !restricted_dow)
            || (self.day_of_month_wildcard && restricted_dow && dow_match)
    }

    /// Every `(hour, minute, second)` the spec fires at, in ascending order.
    fn wall_clock_times(&self) -> impl Iterator<Item = (u32, u32, u32)> + '_ {
        self.hours.iter().flat_map(move |&hour| {
            self.minutes.iter().flat_map(move |&minute| {
                self.seconds
                    .iter()
                    .map(move |&second| (hour, minute, second))
            })
        })
    }
}

/// Days in a month for the explicit day check; February has 29, as in cron-parser.
fn days_in_month(month: u32) -> u32 {
    match month {
        2 => 29,
        4 | 6 | 9 | 11 => 30,
        _ => 31,
    }
}

/// First whole second strictly after `from` at which the schedule fires, in the wall-clock
/// time of `tz`. Gives up after [`LOOP_LIMIT`] calendar days.
fn next_run<Z: TimeZone>(
    spec: &CronSpec,
    tz: Z,
    from: DateTime<Utc>,
) -> Result<DateTime<Utc>, String> {
    let start = DateTime::<Utc>::from_timestamp(from.timestamp() + 1, 0)
        .ok_or("Could not compute next run")?;
    let mut day = start.with_timezone(&tz).date_naive();
    for _ in 0..LOOP_LIMIT {
        if spec.matches_day(day) {
            // ponytail: every time of a matching day is converted, at most 86 400 for
            // `* * * * * *`; fine for cron-sized sets, a faster search would need the DST rules.
            let next = spec
                .wall_clock_times()
                .filter_map(|(hour, minute, second)| day.and_hms_opt(hour, minute, second))
                .map(|local| local_to_utc(&tz, local))
                .filter(|instant| *instant >= start)
                .min();
            if let Some(instant) = next {
                return Ok(instant);
            }
        }
        day = day.succ_opt().ok_or("Could not compute next run")?;
    }
    Err("Could not compute next run".to_string())
}

/// Local wall-clock time to an instant. A skipped time fires at the instant the offset in
/// force before the change gives, so `02:30` on the spring-forward day fires at `03:30`. A
/// repeated time fires at its first occurrence, as cron-parser does.
fn local_to_utc<Z: TimeZone>(tz: &Z, local: NaiveDateTime) -> DateTime<Utc> {
    match tz.from_local_datetime(&local) {
        LocalResult::Single(at) | LocalResult::Ambiguous(at, _) => at.with_timezone(&Utc),
        LocalResult::None => {
            // A day earlier is well before the change, so its offset is the one before it.
            let before = tz
                .offset_from_utc_datetime(&(local - TimeDelta::days(1)))
                .fix();
            (local - TimeDelta::seconds(i64::from(before.local_minus_utc()))).and_utc()
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn at(year: i32, month: u32, day: u32, hour: u32, minute: u32, second: u32) -> DateTime<Utc> {
        Utc.with_ymd_and_hms(year, month, day, hour, minute, second)
            .unwrap()
    }

    fn next(expression: &str, from: DateTime<Utc>) -> String {
        next_in(expression, "UTC", from)
    }

    fn next_in(expression: &str, timezone: &str, from: DateTime<Utc>) -> String {
        compute_next_run_at(expression, timezone, from).expect("expression has a next run")
    }

    #[test]
    fn steps_resolve_to_the_next_matching_minute() {
        assert_eq!(
            next("*/5 * * * *", at(2026, 10, 11, 10, 0, 30)),
            "2026-10-11T10:05:00.000Z"
        );
    }

    #[test]
    fn the_next_run_is_strictly_after_the_start() {
        assert_eq!(
            next("*/5 * * * *", at(2026, 10, 11, 10, 5, 0)),
            "2026-10-11T10:10:00.000Z"
        );
    }

    #[test]
    fn six_fields_put_seconds_first() {
        assert_eq!(
            next("*/15 * * * * *", at(2026, 10, 11, 10, 0, 0)),
            "2026-10-11T10:00:15.000Z"
        );
    }

    #[test]
    fn names_and_weekday_seven_match_the_same_days() {
        // 2026-10-10 is a Saturday, 2026-10-12 a Monday, 2026-10-18 a Sunday.
        assert_eq!(
            next("0 9 * * MON-FRI", at(2026, 10, 10, 12, 0, 0)),
            "2026-10-12T09:00:00.000Z"
        );
        assert_eq!(
            next("0 12 * * 7", at(2026, 10, 12, 12, 0, 0)),
            "2026-10-18T12:00:00.000Z"
        );
    }

    #[test]
    fn restricted_day_of_month_and_weekday_match_either() {
        // 2026-10-02 is a Friday, so it matches before the 13th.
        assert_eq!(
            next("0 0 13 * FRI", at(2026, 10, 1, 0, 0, 0)),
            "2026-10-02T00:00:00.000Z"
        );
    }

    #[test]
    fn macros_and_the_empty_expression_work() {
        assert_eq!(
            next("@daily", at(2026, 10, 11, 10, 0, 0)),
            "2026-10-12T00:00:00.000Z"
        );
        assert_eq!(
            next("", at(2026, 10, 11, 10, 0, 30)),
            "2026-10-11T10:01:00.000Z"
        );
    }

    #[test]
    fn malformed_expressions_are_rejected() {
        for bad in [
            "60 * * * *",
            "1,1 * * * *",
            "*/0 * * * *",
            "L * * * *",
            "0 0 * * MONDAYS",
            "   ",
        ] {
            assert!(
                !validate_cron_expression(bad, "UTC"),
                "{bad} should be invalid"
            );
        }
    }

    #[test]
    fn iana_zones_are_accepted_and_unknown_names_rejected() {
        assert!(validate_timezone("UTC"));
        assert!(validate_timezone("Etc/UTC"));
        assert!(validate_timezone("Europe/Berlin"));
        assert!(validate_timezone("europe/berlin"));
        assert!(!validate_timezone("Mars/Olympus"));
        assert!(!validate_timezone(""));
        assert!(
            compute_next_run_at("* * * * *", "Mars/Olympus", at(2026, 10, 11, 0, 0, 0)).is_err()
        );
    }

    #[test]
    fn offset_zones_accept_hh_mm_and_reject_other_forms() {
        assert!(validate_timezone("+05:00"));
        assert!(validate_timezone("-03:30"));
        assert!(validate_timezone("+00:00"));
        assert!(!validate_timezone("+5"));
        assert!(!validate_timezone("05:00"));
        assert!(!validate_timezone("+05:60"));
        assert!(!validate_timezone("+24:00"));
        assert!(!validate_cron_expression("* * * * *", "+5"));
    }

    #[test]
    fn an_offset_zone_fires_at_its_local_time() {
        // 09:00 at UTC+5 is 04:00Z.
        assert_eq!(
            next_in("0 9 * * *", "+05:00", at(2026, 10, 11, 0, 0, 0)),
            "2026-10-11T04:00:00.000Z"
        );
    }

    #[test]
    fn a_berlin_rule_fires_on_the_day_the_clocks_go_forward() {
        // Berlin is CET (UTC+1) until 2026-03-29 02:00 and CEST (UTC+2) after it, so 09:00 on
        // that day is 07:00Z.
        assert_eq!(
            next_in("0 9 * * *", "Europe/Berlin", at(2026, 3, 28, 8, 0, 0)),
            "2026-03-29T07:00:00.000Z"
        );
    }

    #[test]
    fn a_berlin_rule_fires_on_the_day_the_clocks_go_back() {
        // 2026-10-25 03:00 CEST becomes 02:00 CET, so 09:00 is 08:00Z.
        assert_eq!(
            next_in("0 9 * * *", "Europe/Berlin", at(2026, 10, 24, 7, 0, 0)),
            "2026-10-25T08:00:00.000Z"
        );
    }

    #[test]
    fn a_skipped_local_time_fires_an_hour_later_and_a_repeated_one_once() {
        // 02:30 does not exist on 2026-03-29, so it fires at 03:30 CEST (01:30Z).
        assert_eq!(
            next_in("30 2 * * *", "Europe/Berlin", at(2026, 3, 28, 12, 0, 0)),
            "2026-03-29T01:30:00.000Z"
        );
        // 02:30 happens twice on 2026-10-25. The first occurrence (00:30Z) fires, the second
        // does not, so the next run is the following day.
        assert_eq!(
            next_in("30 2 * * *", "Europe/Berlin", at(2026, 10, 24, 12, 0, 0)),
            "2026-10-25T00:30:00.000Z"
        );
        assert_eq!(
            next_in("30 2 * * *", "Europe/Berlin", at(2026, 10, 25, 0, 30, 0)),
            "2026-10-26T01:30:00.000Z"
        );
    }

    #[test]
    fn a_day_missing_from_its_only_month_is_rejected() {
        assert!(!validate_cron_expression("0 0 31 2 *", "UTC"));
        assert!(!validate_cron_expression("0 0 30 2 *", "UTC"));
        assert!(compute_next_run_at("0 0 31 2 *", "UTC", at(2026, 10, 11, 0, 0, 0)).is_err());
        // February 29 is valid, the next one is in 2028.
        assert!(validate_cron_expression("0 0 29 2 *", "UTC"));
        assert_eq!(
            next("0 0 29 2 *", at(2026, 10, 11, 0, 0, 0)),
            "2028-02-29T00:00:00.000Z"
        );
    }

    #[test]
    fn a_schedule_that_never_matches_stops_at_the_loop_limit() {
        // No 31st in these months. The search gives up instead of returning a date that does
        // not match, as cron-parser does.
        assert!(
            compute_next_run_at("0 0 31 2,4,6,9,11 *", "UTC", at(2026, 10, 11, 0, 0, 0)).is_err()
        );
        // A match eight years away is still within the limit (2096-03-01 to 2104-02-29).
        assert_eq!(
            next("0 0 29 2 *", at(2096, 3, 1, 0, 0, 0)),
            "2104-02-29T00:00:00.000Z"
        );
    }

    #[test]
    fn interval_shortcuts_map_to_cron() {
        assert_eq!(
            interval_to_cron_expression("10m").as_deref(),
            Some("*/10 * * * *")
        );
        assert_eq!(
            interval_to_cron_expression("2h").as_deref(),
            Some("0 */2 * * *")
        );
        assert_eq!(
            interval_to_cron_expression("3d").as_deref(),
            Some("0 0 */3 * *")
        );
        assert_eq!(
            interval_to_cron_expression("15M").as_deref(),
            Some("*/15 * * * *")
        );
        assert_eq!(interval_to_cron_expression("60m"), None);
        assert_eq!(interval_to_cron_expression("0h"), None);
        assert_eq!(interval_to_cron_expression("soon"), None);
    }
}
