//! Port of `src/server/knowledge/extractor.ts` (1-329).
//!
//! | TypeScript | Rust |
//! | --- | --- |
//! | `KnowledgeMeetingLedger` (`:17-27`) | [`KnowledgeMeetingLedger`] |
//! | `KnowledgeExtractionInput` (`:29-35`) | [`KnowledgeExtractionInput`] |
//! | `KnowledgeExtractionResult` (`:37-44`) | [`KnowledgeExtractionResult`] |
//! | `KnowledgeExtractorOptions.runExtractionModel` (`:46-48`) | [`ExtractionModel`] |
//! | `isPersonaSelfReference` (`:52-68`) | [`is_persona_self_reference`] |
//! | `isUserReference` (`:73-88`) | [`is_user_reference`] |
//! | `detectFactSubject` (`:93-97`) | [`detect_fact_subject`], [`FactSubject`] |
//! | `DEFAULT_COUNTERPART_REGEX` (`:99`) | [`COUNTERPART_PATTERN`] (private) |
//! | `tokenize` (`:101-107`) | [`tokenize`] (private) |
//! | `toStringArray` (`:109-112`) | [`to_string_array`] (private) |
//! | `toSourceRefs` (`:114-130`) | [`to_source_refs`] (private) |
//! | `fitWordRange` (`:132-150`) | [`fit_word_range`] (private) |
//! | `pickFallbackRefs` (`:152-166`) | [`pick_fallback_refs`] (private) |
//! | `detectCounterpart` (`:168-177`) | [`detect_counterpart`] (private) |
//! | `buildFallback` (`:179-241`) | [`build_fallback`] (private) |
//! | `parseRawEvents` (`:243-275`) | [`parse_raw_events`] (private) |
//! | `parseModelPayload` (`:277-318`) | [`parse_model_payload`] (private) |
//! | `KnowledgeExtractor` (`:320-365`) | [`KnowledgeExtractor`] |
//!
//! # Ports
//!
//! `runExtractionModel` is an async callback in the TypeScript. The port takes an
//! [`ExtractionModel`] trait whose method returns `impl Future + Send`. Errors of
//! the callback and of the JSON parse both lead to the fallback, like the
//! `catch` of `extract`.
//!
//! # Deviations
//!
//! * `JSON.parse` of the model output is `serde_json::from_str`. Its acceptance
//!   of the document is the same for valid JSON. Bare `NaN` and comments are
//!   rejected by both.
//! * The `extract` call uses `Utc::now()` as the reference time, like
//!   `new Date()`.
//! * `sourceSeq` values are truncated to `i64` (see `entity_extractor.rs`).

use std::future::Future;
use std::sync::LazyLock;

use chrono::Utc;
use regex::Regex;
use serde_json::{Map, Value};

use crate::knowledge::entity_extractor::{EntityExtractor, ExtractedEntity};
use crate::knowledge::event_extractor::{EventExtractor, ExtractedEvent, MinimalMessage};
use crate::knowledge::event_types::SpeakerRole;
use crate::knowledge::js_compat::{
    js_number, js_slice_prefix, js_string, js_string_or_empty, js_truthy,
};
use crate::knowledge::prompts::{
    build_knowledge_extraction_prompt, ExtractionPersonaContext, KnowledgePromptInput,
};
use crate::knowledge::repository::KnowledgeSourceRef;
use crate::knowledge::text_quality::{is_meaningful_knowledge_text, sanitize_knowledge_facts};
use crate::messages_store::StoredMessage;

/// `KnowledgeMeetingLedger` (`extractor.ts:17-27`).
#[derive(Debug, Clone, PartialEq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct KnowledgeMeetingLedger {
    pub topic_key: String,
    pub counterpart: Option<String>,
    pub participants: Vec<String>,
    pub decisions: Vec<String>,
    pub negotiated_terms: Vec<String>,
    pub open_points: Vec<String>,
    pub action_items: Vec<String>,
    pub source_refs: Vec<KnowledgeSourceRef>,
    pub confidence: f64,
}

/// `KnowledgeExtractionInput` (`extractor.ts:29-35`).
#[derive(Debug, Clone)]
pub struct KnowledgeExtractionInput {
    pub conversation_id: String,
    pub user_id: String,
    pub persona_id: String,
    pub messages: Vec<StoredMessage>,
    pub persona_context: Option<ExtractionPersonaContext>,
}

/// `KnowledgeExtractionResult` (`extractor.ts:37-44`).
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct KnowledgeExtractionResult {
    pub facts: Vec<String>,
    pub teaser: String,
    pub episode: String,
    pub meeting_ledger: KnowledgeMeetingLedger,
    pub events: Vec<ExtractedEvent>,
    pub entities: Vec<ExtractedEntity>,
}

/// The `kind` of a fact (`extractor.ts:93`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FactSubject {
    Assistant,
    User,
    Conversation,
}

impl FactSubject {
    /// The TypeScript union member, verbatim.
    pub fn as_str(self) -> &'static str {
        match self {
            FactSubject::Assistant => "assistant",
            FactSubject::User => "user",
            FactSubject::Conversation => "conversation",
        }
    }
}

/// An error from the extraction model call. The extractor only needs to know
/// that the call failed, so the text is for logs.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ExtractionModelError(pub String);

/// `runExtractionModel(prompt): Promise<string>` (`extractor.ts:46-48`).
pub trait ExtractionModel {
    /// Sends the extraction prompt and returns the raw model output.
    fn run_extraction_model(
        &self,
        prompt: &str,
    ) -> impl Future<Output = Result<String, ExtractionModelError>> + Send;
}

/// The model type of [`KnowledgeExtractor::fallback_only`]. It is never called.
#[derive(Debug, Clone, Copy)]
pub struct NoExtractionModel;

impl ExtractionModel for NoExtractionModel {
    async fn run_extraction_model(&self, _prompt: &str) -> Result<String, ExtractionModelError> {
        Err(ExtractionModelError(
            "no extraction model configured".to_string(),
        ))
    }
}

static PERSONA_SELF: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"\b(ich|mein|meine|mir|mich|my|mine)\b|\bi\s+am\b|\bi\s+have\b")
        .expect("persona self-reference pattern")
});
static USER_REFERENCE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"\b(du|dein|deine|dir|dich|user|you|your)\b|\bdu\s+hast\b|\bdu\s+bist\b")
        .expect("user reference pattern")
});

/// `isPersonaSelfReference` (`extractor.ts:52-68`).
pub fn is_persona_self_reference(fact: &str) -> bool {
    PERSONA_SELF.is_match(fact.to_lowercase().trim())
}

/// `isUserReference` (`extractor.ts:73-88`).
pub fn is_user_reference(fact: &str) -> bool {
    USER_REFERENCE.is_match(fact.to_lowercase().trim())
}

/// `detectFactSubject` (`extractor.ts:93-97`).
pub fn detect_fact_subject(fact: &str) -> FactSubject {
    if is_persona_self_reference(fact) {
        FactSubject::Assistant
    } else if is_user_reference(fact) {
        FactSubject::User
    } else {
        FactSubject::Conversation
    }
}

/// `DEFAULT_COUNTERPART_REGEX` (`extractor.ts:99`).
static COUNTERPART_PATTERN: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?i)\b(andreas|sarah|michael|anna|john|jane)\b").expect("counterpart pattern")
});
static FALLBACK_FACT_KEYWORDS: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(
        r"(?i)\b(vereinbart|entschieden|offen|action|todo|rabatt|vertrag|deadline|regel|regeln|rule|rules)\b",
    )
    .expect("fallback fact keywords")
});
static DECISION_KEYWORDS: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?i)\b(vereinbart|entschieden|beschlossen)\b").expect("decision keywords")
});
static NEGOTIATED_KEYWORDS: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?i)\b(rabatt|vertrag|preis|laufzeit)\b").expect("negotiated keywords")
});
static OPEN_KEYWORDS: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?i)\b(offen|ausstehend|todo|sla)\b").expect("open keywords"));
static ACTION_KEYWORDS: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?i)\b(sendet|bis|deadline|aufgabe|todo)\b").expect("action keywords")
});

/// `tokenize` (`extractor.ts:101-107`): trimmed, split on whitespace runs.
fn tokenize(text: &str) -> Vec<&str> {
    text.split_whitespace().collect()
}

/// `toStringArray` (`extractor.ts:109-112`).
fn to_string_array(values: Option<&Value>) -> Vec<String> {
    let Some(items) = values.and_then(Value::as_array) else {
        return Vec::new();
    };
    items
        .iter()
        .map(|value| js_string_or_empty(Some(value)).trim().to_string())
        .filter(|value| !value.is_empty())
        .collect()
}

/// `toSourceRefs` (`extractor.ts:114-130`). A non-array or an empty result
/// falls back to `fallback`.
fn to_source_refs(
    values: Option<&Value>,
    fallback: Vec<KnowledgeSourceRef>,
) -> Vec<KnowledgeSourceRef> {
    let Some(items) = values.and_then(Value::as_array) else {
        return fallback;
    };
    let refs: Vec<KnowledgeSourceRef> = items
        .iter()
        .filter_map(|entry| {
            let empty = Map::new();
            let record = entry.as_object().unwrap_or(&empty);
            let seq = js_number(record.get("seq"));
            let quote = js_string_or_empty(record.get("quote")).trim().to_string();
            if !seq.is_finite() || quote.is_empty() {
                return None;
            }
            Some(KnowledgeSourceRef {
                seq: seq.floor() as i64,
                quote,
            })
        })
        .collect();
    if refs.is_empty() {
        fallback
    } else {
        refs
    }
}

/// `fitWordRange` (`extractor.ts:132-150`): cut to `max_words`, or pad with
/// `filler` up to `min_words`.
fn fit_word_range(text: &str, min_words: usize, max_words: usize, filler: &str) -> String {
    let mut words: Vec<String> = tokenize(text).into_iter().map(str::to_string).collect();
    if words.len() > max_words {
        return words[..max_words].join(" ");
    }
    while words.len() < min_words {
        words.push(filler.to_string());
    }
    words.join(" ")
}

/// `pickFallbackRefs` (`extractor.ts:152-166`). Keeps the first six
/// meaningful non-system messages, then drops those without a positive seq.
///
/// The TypeScript also filters on `Number.isFinite(Number(seq))`. A missing seq
/// is `null` there, which converts to `0` and passes, so the filter is omitted.
fn pick_fallback_refs(messages: &[StoredMessage]) -> Vec<KnowledgeSourceRef> {
    messages
        .iter()
        .filter(|message| message.role != "system")
        .filter(|message| is_meaningful_knowledge_text(&message.content))
        .take(6)
        .map(|message| KnowledgeSourceRef {
            seq: message.seq.unwrap_or(0),
            quote: js_slice_prefix(message.content.trim(), 220),
        })
        .filter(|reference| reference.seq > 0 && !reference.quote.is_empty())
        .collect()
}

/// `detectCounterpart` (`extractor.ts:168-177`): the first known first name in
/// the non-system messages, capitalised.
fn detect_counterpart(messages: &[StoredMessage]) -> Option<String> {
    let corpus = messages
        .iter()
        .filter(|message| message.role != "system")
        .map(|message| message.content.as_str())
        .collect::<Vec<_>>()
        .join(" ");
    let captured = COUNTERPART_PATTERN
        .captures(&corpus)?
        .get(1)?
        .as_str()
        .trim()
        .to_string();
    let mut chars = captured.chars();
    let first = chars.next()?;
    Some(format!("{}{}", first.to_uppercase(), chars.as_str()))
}

/// `buildFallback` (`extractor.ts:179-241`): a result without a model.
fn build_fallback(input: &KnowledgeExtractionInput) -> KnowledgeExtractionResult {
    let lines: Vec<String> = input
        .messages
        .iter()
        .filter(|message| message.role != "system")
        .map(|message| {
            message
                .content
                .split_whitespace()
                .collect::<Vec<_>>()
                .join(" ")
        })
        .filter(|content| is_meaningful_knowledge_text(content))
        .collect();

    let keyword_lines: Vec<String> = lines
        .iter()
        .filter(|line| FALLBACK_FACT_KEYWORDS.is_match(line))
        .cloned()
        .collect();
    let facts: Vec<String> = sanitize_knowledge_facts(&keyword_lines)
        .into_iter()
        .take(8)
        .collect();
    let fallback_facts: Vec<String> = if facts.is_empty() {
        sanitize_knowledge_facts(&lines)
            .into_iter()
            .take(5)
            .collect()
    } else {
        facts
    };
    let safe_facts = if fallback_facts.is_empty() {
        vec!["Wichtige Details aus dem Verlauf wurden besprochen.".to_string()]
    } else {
        fallback_facts
    };

    let source_refs = pick_fallback_refs(&input.messages);
    let counterpart = detect_counterpart(&input.messages);

    let mut teaser_parts = vec![format!(
        "Meetingzusammenfassung fuer {}.",
        counterpart.as_deref().unwrap_or("den Termin")
    )];
    teaser_parts.extend(
        safe_facts
            .iter()
            .take(4)
            .map(|fact| format!("Kernpunkt: {fact}")),
    );
    teaser_parts.push("Der Verlauf zeigt Verhandlung, Beschluss und offene Punkte.".to_string());
    let teaser_base = teaser_parts.join(" ");

    let episode_base = (0..35)
        .map(|index| {
            let line = if lines.is_empty() {
                "Es wurden Details zum Thema abgestimmt.".to_string()
            } else {
                lines[index % lines.len()].clone()
            };
            format!("Abschnitt {}: {line}", index + 1)
        })
        .collect::<Vec<_>>()
        .join(" ");

    let keep = |pattern: &LazyLock<Regex>| -> Vec<String> {
        safe_facts
            .iter()
            .filter(|fact| pattern.is_match(fact))
            .cloned()
            .collect()
    };

    KnowledgeExtractionResult {
        facts: safe_facts.clone(),
        teaser: fit_word_range(&teaser_base, 80, 150, "kontext"),
        episode: fit_word_range(&episode_base, 400, 800, "detail"),
        events: Vec::new(),
        entities: Vec::new(),
        meeting_ledger: KnowledgeMeetingLedger {
            topic_key: counterpart
                .as_ref()
                .map(|name| format!("meeting-{}", name.to_lowercase()))
                .unwrap_or_else(|| "general-meeting".to_string()),
            participants: match &counterpart {
                Some(name) => vec!["Ich".to_string(), name.clone()],
                None => vec!["Ich".to_string()],
            },
            counterpart,
            decisions: keep(&DECISION_KEYWORDS),
            negotiated_terms: keep(&NEGOTIATED_KEYWORDS),
            open_points: keep(&OPEN_KEYWORDS),
            action_items: keep(&ACTION_KEYWORDS),
            source_refs,
            confidence: 0.35,
        },
    }
}

/// `parseRawEvents` (`extractor.ts:243-275`). The events keep the model's
/// spelling; [`EventExtractor`] normalises them afterwards.
fn parse_raw_events(raw: Option<&Value>) -> Vec<ExtractedEvent> {
    let Some(items) = raw.and_then(Value::as_array) else {
        return Vec::new();
    };
    items
        .iter()
        .filter_map(|entry| {
            let record = entry.as_object()?;
            let event_type = js_string_or_empty(record.get("eventType"))
                .trim()
                .to_string();
            if event_type.is_empty() {
                return None;
            }

            let speaker_text = if js_truthy(record.get("speakerRole")) {
                js_string(record.get("speakerRole"))
            } else {
                "assistant".to_string()
            };
            let speaker_role = if speaker_text.trim() == "user" {
                SpeakerRole::User
            } else {
                SpeakerRole::Assistant
            };

            let day_count = {
                let numeric = js_number(record.get("dayCount"));
                let numeric = if numeric.is_nan() { 0.0 } else { numeric };
                numeric.floor().max(0.0) as i64
            };

            Some(ExtractedEvent {
                event_type,
                speaker_role,
                subject: js_string_or_empty(record.get("subject")).trim().to_string(),
                counterpart: js_string_or_empty(record.get("counterpart"))
                    .trim()
                    .to_string(),
                relation_label: js_truthy(record.get("relationLabel"))
                    .then(|| js_string(record.get("relationLabel")).trim().to_string()),
                time_expression: js_string_or_empty(record.get("timeExpression"))
                    .trim()
                    .to_string(),
                start_date: js_string_or_empty(record.get("startDate"))
                    .trim()
                    .to_string(),
                end_date: js_string_or_empty(record.get("endDate")).trim().to_string(),
                day_count,
                is_confirmation: js_truthy(record.get("isConfirmation")),
                confirmation_signals: to_string_array(record.get("confirmationSignals")),
                source_seq: record
                    .get("sourceSeq")
                    .and_then(Value::as_array)
                    .map(|seqs| {
                        seqs.iter()
                            .map(|seq| js_number(Some(seq)))
                            .filter(|seq| seq.is_finite())
                            .map(|seq| seq as i64)
                            .collect()
                    })
                    .unwrap_or_default(),
            })
        })
        .collect()
}

/// The parsed model output before the event and entity normalisation.
struct ParsedPayload {
    facts: Vec<String>,
    teaser: String,
    episode: String,
    meeting_ledger: KnowledgeMeetingLedger,
    events: Vec<ExtractedEvent>,
    /// The raw `entities` array; normalised by [`EntityExtractor`].
    raw_entities: Vec<Value>,
}

/// `parseModelPayload` (`extractor.ts:277-318`). `None` for anything that is not
/// a JSON object.
fn parse_model_payload(raw: &str, input: &KnowledgeExtractionInput) -> Option<ParsedPayload> {
    let refs_fallback = pick_fallback_refs(&input.messages);
    let parsed: Value = serde_json::from_str(raw).ok()?;
    let record = parsed.as_object()?;

    let facts: Vec<String> = sanitize_knowledge_facts(&to_string_array(record.get("facts")))
        .into_iter()
        .take(20)
        .collect();
    let teaser = fit_word_range(
        &js_string_or_empty(record.get("teaser")),
        80,
        150,
        "kontext",
    );
    let episode = fit_word_range(
        &js_string_or_empty(record.get("episode")),
        400,
        800,
        "detail",
    );

    let empty = Map::new();
    let meeting: &Map<String, Value> = match record.get("meetingLedger") {
        Some(Value::Object(map)) => map,
        _ => &empty,
    };
    let counterpart_raw = js_string_or_empty(meeting.get("counterpart"))
        .trim()
        .to_string();
    let confidence_raw = js_number(meeting.get("confidence"));
    let topic_key = js_string_or_empty(meeting.get("topicKey"))
        .trim()
        .to_string();

    let facts = if facts.is_empty() {
        build_fallback(input).facts
    } else {
        facts
    };

    Some(ParsedPayload {
        facts,
        teaser,
        episode,
        events: parse_raw_events(record.get("events")),
        raw_entities: record
            .get("entities")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default(),
        meeting_ledger: KnowledgeMeetingLedger {
            topic_key: if topic_key.is_empty() {
                "general-meeting".to_string()
            } else {
                topic_key
            },
            counterpart: if counterpart_raw.is_empty() {
                detect_counterpart(&input.messages)
            } else {
                Some(counterpart_raw)
            },
            participants: to_string_array(meeting.get("participants")),
            decisions: to_string_array(meeting.get("decisions")),
            negotiated_terms: to_string_array(meeting.get("negotiatedTerms")),
            open_points: to_string_array(meeting.get("openPoints")),
            action_items: to_string_array(meeting.get("actionItems")),
            source_refs: to_source_refs(meeting.get("sourceRefs"), refs_fallback),
            confidence: if confidence_raw.is_finite() {
                confidence_raw.clamp(0.0, 1.0)
            } else {
                0.6
            },
        },
    })
}

/// `KnowledgeExtractor` (`extractor.ts:320-365`).
#[derive(Debug, Clone)]
pub struct KnowledgeExtractor<M> {
    model: Option<M>,
}

impl KnowledgeExtractor<NoExtractionModel> {
    /// An extractor without a model: every call returns the fallback.
    pub fn fallback_only() -> Self {
        Self { model: None }
    }
}

impl<M: ExtractionModel> KnowledgeExtractor<M> {
    /// An extractor that asks `model` for the extraction.
    pub fn with_model(model: M) -> Self {
        Self { model: Some(model) }
    }

    /// `extract(input)`. Without a model, or when the call or its output fails,
    /// the fallback result is returned.
    pub async fn extract(&self, input: &KnowledgeExtractionInput) -> KnowledgeExtractionResult {
        let base_fallback = build_fallback(input);
        let Some(model) = self.model.as_ref() else {
            return base_fallback;
        };

        let prompt_input = KnowledgePromptInput {
            conversation_id: input.conversation_id.clone(),
            user_id: input.user_id.clone(),
            persona_id: input.persona_id.clone(),
            messages: input.messages.clone(),
        };
        let prompt =
            build_knowledge_extraction_prompt(&prompt_input, input.persona_context.as_ref());
        let Ok(response) = model.run_extraction_model(&prompt).await else {
            return base_fallback;
        };
        let Some(parsed) = parse_model_payload(&response, input) else {
            return base_fallback;
        };

        let minimal_messages: Vec<MinimalMessage> = input
            .messages
            .iter()
            .map(|message| MinimalMessage {
                seq: message.seq.unwrap_or(0),
                role: if message.role.is_empty() {
                    "user".to_string()
                } else {
                    message.role.clone()
                },
                content: message.content.clone(),
            })
            .collect();
        let events = EventExtractor.normalize_events(parsed.events, &minimal_messages, Utc::now());
        let entities =
            EntityExtractor.normalize_entities(&Value::Array(parsed.raw_entities), &input.messages);

        KnowledgeExtractionResult {
            facts: parsed.facts,
            teaser: fit_word_range(&parsed.teaser, 80, 150, "kontext"),
            episode: fit_word_range(&parsed.episode, 400, 800, "detail"),
            meeting_ledger: parsed.meeting_ledger,
            events,
            entities,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn message(seq: i64, role: &str, content: &str) -> StoredMessage {
        StoredMessage {
            id: format!("m{seq}"),
            conversation_id: "c-1".into(),
            seq: Some(seq),
            role: role.into(),
            content: content.into(),
            platform: "web".into(),
            external_msg_id: None,
            sender_name: None,
            metadata: None,
            created_at: String::new(),
        }
    }

    fn input(messages: Vec<StoredMessage>) -> KnowledgeExtractionInput {
        KnowledgeExtractionInput {
            conversation_id: "c-1".into(),
            user_id: "u-1".into(),
            persona_id: "p-1".into(),
            messages,
            persona_context: None,
        }
    }

    /// A model that returns a fixed answer.
    struct FixedModel(Result<String, ExtractionModelError>);

    impl ExtractionModel for FixedModel {
        async fn run_extraction_model(
            &self,
            _prompt: &str,
        ) -> Result<String, ExtractionModelError> {
            self.0.clone()
        }
    }

    #[test]
    fn the_fact_subject_prefers_the_persona_then_the_user() {
        assert_eq!(
            detect_fact_subject("Ich habe Kaffee"),
            FactSubject::Assistant
        );
        assert_eq!(detect_fact_subject("Du bist nett"), FactSubject::User);
        assert_eq!(
            detect_fact_subject("Heute regnet es"),
            FactSubject::Conversation
        );
    }

    #[test]
    fn fit_word_range_pads_with_the_filler_or_cuts() {
        assert_eq!(fit_word_range("a b c", 5, 10, "x"), "a b c x x");
        assert_eq!(fit_word_range("a b c d e f", 1, 3, "x"), "a b c");
        assert_eq!(fit_word_range("", 2, 3, "detail"), "detail detail");
    }

    #[test]
    fn the_fallback_keeps_the_agreed_terms_and_names_the_counterpart() {
        let result = build_fallback(&input(vec![
            message(
                1,
                "user",
                "Wir haben vereinbart, dass der Rabatt zehn Prozent betraegt.",
            ),
            message(2, "agent", "Anna kommt am Freitag zum Termin vorbei."),
        ]));
        assert!(result.facts.iter().any(|fact| fact.contains("Rabatt")));
        assert_eq!(result.meeting_ledger.counterpart.as_deref(), Some("Anna"));
        assert_eq!(result.meeting_ledger.topic_key, "meeting-anna");
        assert!(result
            .meeting_ledger
            .negotiated_terms
            .iter()
            .any(|t| t.contains("Rabatt")));
        assert_eq!(result.meeting_ledger.confidence, 0.35);
        assert!(result.teaser.split_whitespace().count() >= 80);
        assert!(result.episode.split_whitespace().count() >= 400);
    }

    #[test]
    fn a_message_without_content_gives_the_default_fact() {
        let result = build_fallback(&input(vec![message(1, "user", "ok")]));
        assert_eq!(
            result.facts,
            vec!["Wichtige Details aus dem Verlauf wurden besprochen.".to_string()]
        );
        assert_eq!(result.meeting_ledger.topic_key, "general-meeting");
        assert_eq!(result.meeting_ledger.participants, vec!["Ich".to_string()]);
    }

    #[test]
    fn ignores_system_content_and_zero_sequence_greetings_in_fallback() {
        let result = build_fallback(&input(vec![
            message(1, "system", "Andreas hat entschieden: vertraulich"),
            message(0, "user", "Hallo"),
        ]));

        assert_eq!(
            result.facts,
            vec!["Wichtige Details aus dem Verlauf wurden besprochen.".to_string()]
        );
        assert_eq!(result.meeting_ledger.topic_key, "general-meeting");
        assert_eq!(result.meeting_ledger.counterpart, None);
        assert_eq!(result.meeting_ledger.participants, vec!["Ich".to_string()]);
        assert!(result.meeting_ledger.source_refs.is_empty());
        assert_eq!(result.meeting_ledger.confidence, 0.35);
        assert!(result.teaser.contains("den Termin"));
        assert!(result.episode.split_whitespace().count() >= 400);
    }

    #[test]
    fn a_model_payload_is_parsed_and_its_confidence_clamped() {
        let payload = r#"{
            "facts": ["Der Termin ist am Freitag."],
            "teaser": "kurz",
            "episode": "lang",
            "meetingLedger": {"topicKey": "", "counterpart": "", "confidence": 2, "sourceRefs": []},
            "events": [{"eventType": "meeting", "speakerRole": "user", "timeExpression": "gestern", "sourceSeq": [3]}],
            "entities": [{"name": "Anna", "category": "person", "owner": "shared", "sourceSeq": [3]}]
        }"#;
        let parsed = parse_model_payload(
            payload,
            &input(vec![message(3, "agent", "Anna kommt zum Termin.")]),
        )
        .expect("payload");
        assert_eq!(parsed.facts, vec!["Der Termin ist am Freitag.".to_string()]);
        assert_eq!(parsed.meeting_ledger.topic_key, "general-meeting");
        assert_eq!(parsed.meeting_ledger.counterpart.as_deref(), Some("Anna"));
        assert_eq!(parsed.meeting_ledger.confidence, 1.0);
        // The source refs fall back to the messages, which have a positive seq.
        assert_eq!(parsed.meeting_ledger.source_refs.len(), 1);
        assert_eq!(parsed.events[0].speaker_role, SpeakerRole::User);
        assert_eq!(parsed.raw_entities.len(), 1);
    }

    #[test]
    fn a_non_object_or_invalid_json_is_rejected() {
        let messages = input(vec![]);
        assert!(parse_model_payload("[1, 2]", &messages).is_none());
        assert!(parse_model_payload("not json", &messages).is_none());
    }

    #[tokio::test]
    async fn without_a_model_the_fallback_is_returned() {
        let extractor = KnowledgeExtractor::fallback_only();
        let result = extractor
            .extract(&input(vec![message(
                1,
                "user",
                "Wir haben vereinbart, dass wir uns treffen.",
            )]))
            .await;
        assert!(result.events.is_empty());
        assert!(result.entities.is_empty());
    }

    #[tokio::test]
    async fn a_failing_or_invalid_model_falls_back() {
        let failing =
            KnowledgeExtractor::with_model(FixedModel(Err(ExtractionModelError("timeout".into()))));
        let garbage = KnowledgeExtractor::with_model(FixedModel(Ok("kein json".into())));
        let messages = input(vec![message(
            1,
            "user",
            "Wir haben vereinbart, dass wir uns treffen.",
        )]);
        assert!(failing.extract(&messages).await.entities.is_empty());
        assert!(garbage.extract(&messages).await.entities.is_empty());
    }

    #[tokio::test]
    async fn a_valid_model_answer_is_normalised() {
        let answer = r#"{
            "facts": ["Anna kommt am Freitag."],
            "teaser": "x",
            "episode": "y",
            "events": [{"eventType": "visit", "speakerRole": "assistant", "timeExpression": "gestern", "sourceSeq": [1]}],
            "entities": [{"name": "Anna", "category": "person", "owner": "shared", "sourceSeq": [1]}]
        }"#;
        let extractor = KnowledgeExtractor::with_model(FixedModel(Ok(answer.into())));
        let result = extractor
            .extract(&input(vec![message(
                1,
                "user",
                "Anna kommt am Freitag zu uns.",
            )]))
            .await;
        assert_eq!(result.events.len(), 1);
        // The speaker follows the message role; `gestern` resolves to a date.
        assert_eq!(result.events[0].speaker_role, SpeakerRole::User);
        assert_eq!(result.entities.len(), 1);
        assert_eq!(result.teaser.split_whitespace().count(), 80);
    }

    #[tokio::test]
    async fn normalises_malformed_model_fields_like_the_typescript_extractor() {
        let transcript = vec![
            message(
                1,
                "user",
                "Wir starten das Meeting mit Andreas um 09:00 Uhr.",
            ),
            message(
                2,
                "agent",
                "Wir verhandeln einen Rahmenvertrag fuer 12 Monate.",
            ),
            message(
                3,
                "user",
                "Andreas bietet 5 Prozent Rabatt, wir fordern 8 Prozent.",
            ),
            message(
                4,
                "agent",
                "Nach Ruecksprache einigen wir uns auf 8 Prozent Rabatt.",
            ),
            message(
                5,
                "user",
                "Offen bleibt die finale SLA-Abnahme bis naechste Woche.",
            ),
            message(
                6,
                "agent",
                "Andreas sendet den Vertragsentwurf bis Freitag.",
            ),
        ];
        let teaser = (0..180)
            .map(|index| format!("teaser{index}"))
            .collect::<Vec<_>>()
            .join(" ");
        let episode = (0..900)
            .map(|index| format!("episode{index}"))
            .collect::<Vec<_>>()
            .join(" ");
        let answer = json!({
            "facts": [0, " ", "Erneut vereinbart: Der Vertrag gilt bis Freitag."],
            "teaser": teaser,
            "episode": episode,
            "meetingLedger": {
                "topicKey": " ",
                "counterpart": "",
                "participants": "not-an-array",
                "decisions": [0, " Entscheidung bestätigt "],
                "negotiatedTerms": null,
                "openPoints": [false],
                "actionItems": [" Aufgabe senden "],
                "sourceRefs": [
                    null,
                    "not-a-reference",
                    {"seq": "not-finite", "quote": "invalid"},
                    {"seq": 3, "quote": "  "},
                    {"seq": 2.9, "quote": "  belegte Aussage  "}
                ],
                "confidence": "not-finite"
            },
            "events": [
                null,
                "not-an-event",
                {},
                {"eventType": "meeting", "speakerRole": "", "sourceSeq": "not-an-array"},
                {
                    "eventType": "trip",
                    "speakerRole": "user",
                    "relationLabel": " Beziehung ",
                    "dayCount": -2,
                    "sourceSeq": [1, "not-finite", 2]
                }
            ],
            "entities": []
        })
        .to_string();
        let extractor = KnowledgeExtractor::with_model(FixedModel(Ok(answer)));

        let result = extractor.extract(&input(transcript)).await;

        assert_eq!(
            result.facts,
            vec!["Erneut vereinbart: Der Vertrag gilt bis Freitag."]
        );
        assert_eq!(result.teaser.split_whitespace().count(), 150);
        assert_eq!(result.episode.split_whitespace().count(), 800);
        assert_eq!(result.meeting_ledger.topic_key, "general-meeting");
        assert_eq!(
            result.meeting_ledger.counterpart.as_deref(),
            Some("Andreas")
        );
        assert!(result.meeting_ledger.participants.is_empty());
        assert_eq!(result.meeting_ledger.decisions, ["Entscheidung bestätigt"]);
        assert!(result.meeting_ledger.negotiated_terms.is_empty());
        assert!(result.meeting_ledger.open_points.is_empty());
        assert_eq!(result.meeting_ledger.action_items, ["Aufgabe senden"]);
        assert_eq!(
            result.meeting_ledger.source_refs,
            [KnowledgeSourceRef {
                seq: 2,
                quote: "belegte Aussage".to_string(),
            }]
        );
        assert_eq!(result.meeting_ledger.confidence, 0.6);
        assert_eq!(result.events.len(), 2);
        assert_eq!(result.events[0].speaker_role, SpeakerRole::Assistant);
        assert_eq!(result.events[0].relation_label, None);
        assert!(result.events[0].source_seq.is_empty());
        assert_eq!(result.events[1].speaker_role, SpeakerRole::User);
        assert_eq!(
            result.events[1].relation_label.as_deref(),
            Some("Beziehung")
        );
        assert_eq!(result.events[1].day_count, 1);
        assert_eq!(result.events[1].source_seq, [1, 2]);
        assert!(result.entities.is_empty());
    }
}
