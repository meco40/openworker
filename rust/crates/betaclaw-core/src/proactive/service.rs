//! Port of `src/server/proactive/service.ts` (`ProactiveGateService`).
//!
//! Chat messages turn into weighted signals `<topic>.<kind>`. Over a 30-day window
//! a topic whose score reaches 0.72 is stored as a suggestion, at most once per
//! topic every 12 hours. Every other scored topic is returned as a deferred preview
//! that is not stored.
//!
//! Kept on purpose, because the source does the same:
//! - [`score_topic`] divides the `recurring` weight by 0.45, while
//!   [`build_signals`] writes 0.55.
//! - the reason text formats the score with `toFixed(2)`, see [`to_fixed_2`].
//!
//! The "preposition" pass of `extractTopics` is not ported. Each word it yields is a
//! maximal run of topic characters of at least three characters, and the token pass
//! yields exactly those runs, so the topic set does not change.

use std::collections::HashMap;

use chrono::{DateTime, NaiveDate, NaiveDateTime, SecondsFormat, Utc};

use crate::messages_store::MessageRole;

use super::repository::{ProactiveError, ProactiveRepository};
use super::types::{
    ProactiveDecision, ProactiveDecisionInput, ProactiveDecisionType, ProactiveMessageInput,
    ProactiveSignalInput, ProactiveSummaryRow,
};

const LOOKBACK_MS: i64 = 30 * 24 * 60 * 60 * 1000;
const SUGGEST_THRESHOLD: f64 = 0.72;
const SUGGEST_COOLDOWN_MS: i64 = 12 * 60 * 60 * 1000;
const MIN_TOPIC_SIGNAL_OCCURRENCES: i64 = 1;
const MAX_TOPICS_PER_EVALUATION: usize = 12;
/// `listRecentDecisions(userId, personaId, 50)` in `evaluate`.
const RECENT_DECISION_LIMIT: i64 = 50;

/// Words that never become a topic (`TOPIC_STOPWORDS`, `service.ts:14-47`).
const TOPIC_STOPWORDS: &[&str] = &[
    "ich",
    "und",
    "oder",
    "aber",
    "mit",
    "ohne",
    "mein",
    "meine",
    "meinen",
    "mich",
    "mir",
    "habe",
    "hatte",
    "heute",
    "morgen",
    "gestern",
    "dass",
    "klingt",
    "interessant",
    "invest",
    "investiere",
    "investment",
    "verfolge",
    "track",
    "monitor",
    "nachrichten",
    "news",
    "preis",
    "kurse",
    "kurs",
    "daily",
    "hourly",
];

const INVEST_TERMS: &[&str] = &["invest", "investiere", "investment", "anlege"];
const MONITOR_TERMS: &[&str] = &[
    "preis", "kurs", "price", "track", "verfolge", "schaue", "beobacht", "monitor",
];
const NEWS_TERMS: &[&str] = &["nachricht", "news", "medien", "meldung", "bericht"];
const RECURRING_TERMS: &[&str] = &[
    "täglich",
    "taeglich",
    "jeden",
    "immer",
    "stündlich",
    "stuendlich",
    "daily",
    "hourly",
    "wöchentlich",
    "woechentlich",
    "weekly",
];

/// `summaryByKey` (`service.ts:273`): summary rows by `<topic>.<kind>`.
type SummaryIndex<'a> = HashMap<&'a str, &'a ProactiveSummaryRow>;

/// `ProactiveGateService` (`service.ts:249`).
pub struct ProactiveGateService<R> {
    repository: R,
}

impl<R: ProactiveRepository> ProactiveGateService<R> {
    pub fn new(repository: R) -> Self {
        Self { repository }
    }

    /// `ingestMessages` (`service.ts:252-265`). Returns how many signals were stored.
    pub fn ingest_messages(
        &self,
        user_id: &str,
        persona_id: &str,
        messages: &[ProactiveMessageInput],
        created_at: Option<&str>,
    ) -> Result<usize, ProactiveError> {
        if user_id.is_empty() || persona_id.is_empty() || messages.is_empty() {
            return Ok(0);
        }
        let now = format_iso(resolve_now_ms(created_at));
        let signals: Vec<ProactiveSignalInput> = messages
            .iter()
            .flat_map(|message| build_signals(user_id, persona_id, message, &now))
            .collect();
        self.repository.insert_signals(&signals)
    }

    /// `evaluate` (`service.ts:267-344`). Returns the suggestions stored by this call
    /// and the deferred previews, in ranking order.
    pub fn evaluate(
        &self,
        user_id: &str,
        persona_id: &str,
        created_at: Option<&str>,
    ) -> Result<Vec<ProactiveDecision>, ProactiveError> {
        if user_id.is_empty() || persona_id.is_empty() {
            return Ok(Vec::new());
        }
        let now_ms = resolve_now_ms(created_at);
        let now = format_iso(now_ms);
        let since = format_iso(now_ms - LOOKBACK_MS);
        let summary_rows = self
            .repository
            .summarize_signals(user_id, persona_id, &since)?;
        let summary: SummaryIndex<'_> = summary_rows
            .iter()
            .map(|row| (row.signal_key.as_str(), row))
            .collect();
        let recent =
            self.repository
                .list_recent_decisions(user_id, persona_id, RECENT_DECISION_LIMIT)?;

        let mut topics: Vec<&str> = Vec::new();
        for row in &summary_rows {
            let topic = row.signal_key.split('.').next().unwrap_or_default();
            if !topic.is_empty() && !topics.contains(&topic) {
                topics.push(topic);
            }
        }
        let mut ranked: Vec<(&str, i64)> = topics
            .into_iter()
            .map(|topic| (topic, topic_occurrences(&summary, topic)))
            .filter(|(_, occurrences)| *occurrences >= MIN_TOPIC_SIGNAL_OCCURRENCES)
            .collect();
        ranked.sort_by(|a, b| b.1.cmp(&a.1));
        ranked.truncate(MAX_TOPICS_PER_EVALUATION);

        let mut output = Vec::with_capacity(ranked.len());
        for (topic, _) in ranked {
            let score = score_topic(&summary, topic);
            let candidate_key = format!("topic_watcher:{topic}");
            let recent_suggestion = recent.iter().find(|decision| {
                decision.candidate_key == candidate_key
                    && decision.decision == ProactiveDecisionType::Suggest.as_str()
                    && parse_epoch_ms(&decision.created_at)
                        .is_some_and(|created| now_ms - created < SUGGEST_COOLDOWN_MS)
            });

            let suggest = score >= SUGGEST_THRESHOLD && recent_suggestion.is_none();
            let decision = if suggest {
                ProactiveDecisionType::Suggest
            } else {
                ProactiveDecisionType::Defer
            };
            let reason = if recent_suggestion.is_some() && score >= SUGGEST_THRESHOLD {
                format!("Cooldown active for topic \"{topic}\".")
            } else {
                to_reason(decision, score, topic)
            };

            if suggest {
                output.push(self.repository.insert_decision(&ProactiveDecisionInput {
                    user_id: user_id.to_string(),
                    persona_id: persona_id.to_string(),
                    candidate_key,
                    decision,
                    score,
                    reason,
                    created_at: Some(now.clone()),
                })?);
            } else {
                output.push(ProactiveDecision {
                    id: format!("preview-{candidate_key}-{now}"),
                    user_id: user_id.to_string(),
                    persona_id: persona_id.to_string(),
                    candidate_key,
                    decision: decision.as_str().to_string(),
                    score,
                    reason,
                    created_at: now.clone(),
                });
            }
        }
        Ok(output)
    }
}

/// `normalizeText` (`service.ts:49-51`).
fn normalize_text(content: &str) -> String {
    content
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .to_lowercase()
}

/// The character class `[a-z0-9äöüß-]` of the TypeScript token regex.
fn is_topic_char(c: char) -> bool {
    c.is_ascii_alphanumeric() || matches!(c, '-' | 'ä' | 'ö' | 'ü' | 'ß')
}

/// `normalizeTopicCandidate` (`service.ts:69-85`). Tokens consist of topic characters
/// only, so the source's cleaning step is a no-op and is not repeated here.
fn normalize_topic(token: &str) -> Option<String> {
    if TOPIC_STOPWORDS.contains(&token) {
        return None;
    }
    if token.chars().count() > 5 {
        let stripped = ["preis", "price"]
            .iter()
            .find_map(|suffix| token.strip_suffix(*suffix));
        if let Some(stripped) =
            stripped.filter(|value| value.chars().count() >= 3 && !TOPIC_STOPWORDS.contains(value))
        {
            return Some(stripped.to_string());
        }
    }
    Some(token.to_string())
}

/// `extractTopics` (`service.ts:87-103`), token pass only; see the module note.
fn extract_topics(text: &str) -> Vec<String> {
    let mut topics: Vec<String> = Vec::new();
    for token in text.split(|c: char| !is_topic_char(c)) {
        if token.chars().count() < 3 {
            continue;
        }
        let Some(topic) = normalize_topic(token) else {
            continue;
        };
        if !topics.contains(&topic) {
            topics.push(topic);
        }
    }
    topics
}

fn has_any(text: &str, terms: &[&str]) -> bool {
    terms.iter().any(|term| text.contains(*term))
}

/// `buildSignalsFromMessage` (`service.ts:105-201`). Only user messages count.
fn build_signals(
    user_id: &str,
    persona_id: &str,
    message: &ProactiveMessageInput,
    fallback_created_at: &str,
) -> Vec<ProactiveSignalInput> {
    if message.role != MessageRole::User {
        return Vec::new();
    }
    let text = normalize_text(&message.content);
    if text.is_empty() {
        return Vec::new();
    }
    let created_at_input = message
        .created_at
        .as_deref()
        .filter(|value| !value.is_empty())
        .unwrap_or(fallback_created_at);
    let created_at = format_iso(resolve_now_ms(Some(created_at_input)));

    let invest = has_any(&text, INVEST_TERMS);
    let monitor = has_any(&text, MONITOR_TERMS);
    let news = has_any(&text, NEWS_TERMS);
    let recurring = has_any(&text, RECURRING_TERMS);

    let mut signals = Vec::new();
    for topic in extract_topics(&text) {
        let mut kinds: Vec<(&str, f64)> = Vec::new();
        if invest {
            kinds.push(("invest", 0.7));
        }
        if monitor {
            kinds.push(("monitor", 0.65));
        }
        if news {
            kinds.push(("news", 0.6));
        }
        if recurring {
            kinds.push(("recurring", 0.55));
        }
        if kinds.is_empty() {
            kinds.push(("mention", 0.2));
        }
        for (kind, weight) in kinds {
            signals.push(ProactiveSignalInput {
                user_id: user_id.to_string(),
                persona_id: persona_id.to_string(),
                signal_key: format!("{topic}.{kind}"),
                weight,
                source: "chat".to_string(),
                created_at: created_at.clone(),
            });
        }
    }
    signals
}

/// `topicSignalOccurrences` (`service.ts:231-239`).
fn topic_occurrences(summary: &SummaryIndex<'_>, topic: &str) -> i64 {
    ["invest", "monitor", "news", "recurring", "mention"]
        .iter()
        .filter_map(|kind| summary.get(format!("{topic}.{kind}").as_str()))
        .map(|row| row.occurrences)
        .sum()
}

/// `scoreTopic` (`service.ts:203-229`). Each kind's summed weight is capped at 1 after
/// division by its divisor, then weighted 0.35 / 0.27 / 0.2 / 0.12 / 0.06.
fn score_topic(summary: &SummaryIndex<'_>, topic: &str) -> f64 {
    let normalised = |kind: &str, divisor: f64| {
        let weight = summary
            .get(format!("{topic}.{kind}").as_str())
            .map_or(0.0, |row| row.total_weight);
        (weight / divisor).clamp(0.0, 1.0)
    };
    let score = normalised("invest", 0.7) * 0.35
        + normalised("monitor", 0.65) * 0.27
        + normalised("news", 0.55) * 0.2
        + normalised("recurring", 0.45) * 0.12
        + normalised("mention", 0.6) * 0.06;
    score.clamp(0.0, 1.0)
}

/// `toReason` (`service.ts:241-247`).
fn to_reason(decision: ProactiveDecisionType, score: f64, topic: &str) -> String {
    if decision == ProactiveDecisionType::Suggest {
        format!(
            "Strong evidence for topic \"{topic}\" (score={}).",
            to_fixed_2(score)
        )
    } else {
        format!(
            "Not enough evidence for topic \"{topic}\" yet (score={}).",
            to_fixed_2(score)
        )
    }
}

/// `value.toFixed(2)` for a score in `0..=1`. JavaScript rounds an exact tie up,
/// while Rust's `{:.2}` rounds it to even, so the digits are taken from the exact
/// decimal expansion and the third digit decides.
fn to_fixed_2(value: f64) -> String {
    let exact = format!("{value:.40}");
    let (int_part, fraction) = exact.split_once('.').unwrap_or((exact.as_str(), ""));
    let digit =
        |index: usize| u64::from(fraction.as_bytes().get(index).copied().unwrap_or(b'0') - b'0');
    let hundredths = int_part.parse::<u64>().unwrap_or(0) * 100
        + digit(0) * 10
        + digit(1)
        + u64::from(digit(2) >= 5);
    format!("{}.{:02}", hundredths / 100, hundredths % 100)
}

/// `nowIso` (`service.ts:53-58`) as epoch milliseconds. A missing, empty or
/// unparsable value means the current time.
fn resolve_now_ms(input: Option<&str>) -> i64 {
    input
        .filter(|value| !value.is_empty())
        .and_then(parse_epoch_ms)
        .unwrap_or_else(|| Utc::now().timestamp_millis())
}

/// `new Date(value).getTime()` for the forms the TypeScript side writes and reads.
/// Offset-less values are read as UTC. V8 reads them as local time, so the two only
/// differ when the host is not in UTC.
fn parse_epoch_ms(value: &str) -> Option<i64> {
    let value = value.trim();
    if let Ok(parsed) = DateTime::parse_from_rfc3339(value) {
        return Some(parsed.timestamp_millis());
    }
    ["%Y-%m-%dT%H:%M:%S%.f", "%Y-%m-%d %H:%M:%S%.f"]
        .iter()
        .find_map(|format| NaiveDateTime::parse_from_str(value, format).ok())
        .or_else(|| {
            NaiveDate::parse_from_str(value, "%Y-%m-%d")
                .ok()?
                .and_hms_opt(0, 0, 0)
        })
        .map(|naive| naive.and_utc().timestamp_millis())
}

/// `new Date(ms).toISOString()`: millisecond precision, `Z` suffix.
fn format_iso(epoch_ms: i64) -> String {
    DateTime::<Utc>::from_timestamp_millis(epoch_ms)
        .expect("instants from parsed or current times are in range")
        .to_rfc3339_opts(SecondsFormat::Millis, true)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::proactive::sqlite_repository::SqliteProactiveRepository;

    fn service() -> ProactiveGateService<SqliteProactiveRepository> {
        ProactiveGateService::new(SqliteProactiveRepository::open(":memory:").expect("open"))
    }

    #[test]
    fn topics_drop_stopwords_and_strip_the_price_suffix() {
        assert_eq!(
            extract_topics("ich bitcoinpreis tracken"),
            vec!["bitcoin", "tracken"]
        );
        assert_eq!(extract_topics("preis kurs"), Vec::<String>::new());
    }

    #[test]
    fn to_fixed_2_rounds_exact_ties_up_like_javascript() {
        assert_eq!(to_fixed_2(0.125), "0.13");
        assert_eq!(to_fixed_2(0.82), "0.82");
        assert_eq!(to_fixed_2(1.0), "1.00");
    }

    #[test]
    fn a_strong_topic_is_suggested_once_and_then_cools_down() {
        let service = service();
        let message = ProactiveMessageInput {
            role: MessageRole::User,
            content: "bitcoin investieren, Kurs, Nachrichten verfolgen".to_string(),
            created_at: None,
        };
        service
            .ingest_messages("u-1", "p-1", &[message], None)
            .expect("ingest");

        let first = service.evaluate("u-1", "p-1", None).expect("evaluate");
        let suggested = first
            .iter()
            .find(|decision| decision.candidate_key == "topic_watcher:bitcoin")
            .expect("bitcoin is ranked");
        assert_eq!(suggested.decision, "suggest");
        assert_eq!(
            suggested.reason,
            "Strong evidence for topic \"bitcoin\" (score=0.82)."
        );

        let second = service
            .evaluate("u-1", "p-1", None)
            .expect("evaluate again");
        let deferred = second
            .iter()
            .find(|decision| decision.candidate_key == "topic_watcher:bitcoin")
            .expect("bitcoin is still ranked");
        assert_eq!(deferred.decision, "defer");
        assert_eq!(deferred.reason, "Cooldown active for topic \"bitcoin\".");
    }
}
