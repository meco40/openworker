//! Port of `src/server/knowledge/eventAnswerComputer.ts` (1-70).
//!
//! | TypeScript                                    | Rust |
//! | --------------------------------------------- | ---- |
//! | `eventAnswerComputer.ts:3-6` (`EventAnswerScope`) | [`EventAnswerScope`] |
//! | `eventAnswerComputer.ts:8-13` (`EventAnswerFilter`) | [`EventAnswerFilter`] |
//! | `eventAnswerComputer.ts:18-20` (`EventCountRepository`) | [`EventCountRepository`] |
//! | `eventAnswerComputer.ts:22-31` (`EVENT_TYPE_LABELS`) | [`event_type_label`] |
//! | `eventAnswerComputer.ts:39-65` (`computeEventAnswer`) | [`compute_event_answer`] |
//! | `eventAnswerComputer.ts:67-70` (`capitalize`) | [`capitalize`] |
//!
//! Dependency of `retrieval/service/queryPlanning.ts:2`; it lives at the
//! knowledge root because that is where its TypeScript original lives.
//!
//! The answer template of `eventAnswerComputer.ts:64` is copied verbatim — it
//! is user-visible text.
//!
//! # Deviation
//!
//! `result.uniqueDays[0]` and `[length - 1]` (`:64`) interpolate `undefined`
//! when `uniqueDayCount > 0` but `uniqueDays` is empty — an inconsistent
//! aggregation result that the ported event store cannot produce. The port
//! writes the empty string instead of the literal `undefined`.

use crate::knowledge::event_types::{EventAggregationResult, KnowledgeEventFilter};
use crate::knowledge::retrieval::types::RetrievalResult;

/// `EventAnswerScope` from `eventAnswerComputer.ts:3-6`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct EventAnswerScope {
    pub user_id: String,
    pub persona_id: String,
}

/// `EventAnswerFilter` from `eventAnswerComputer.ts:8-13`.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct EventAnswerFilter {
    pub event_type: Option<String>,
    pub counterpart_entity: Option<String>,
    pub from: Option<String>,
    pub to: Option<String>,
}

/// `EventCountRepository` from `eventAnswerComputer.ts:18-20` — "Minimal repo
/// interface — keeps this module testable without a full `KnowledgeRepository`".
pub trait EventCountRepository {
    fn count_unique_days(
        &self,
        filter: &KnowledgeEventFilter,
    ) -> RetrievalResult<EventAggregationResult>;
}

/// `EVENT_TYPE_LABELS` from `eventAnswerComputer.ts:22-31`.
fn event_type_label(event_type: &str) -> &'static str {
    match event_type {
        "shared_sleep" => "geschlafen",
        "visit" => "besucht",
        "trip" => "gereist",
        "meeting" => "getroffen",
        "activity" => "unternommen",
        "meal" => "gegessen",
        "appointment" => "einen Termin gehabt",
        "celebration" => "gefeiert",
        _ => "etwas gemacht",
    }
}

/// `capitalize` from `eventAnswerComputer.ts:67-70`.
fn capitalize(text: &str) -> String {
    if text.is_empty() {
        return String::new();
    }
    let mut chars = text.chars();
    let first = chars.next().expect("non-empty");
    let rest: String = chars.as_str().to_lowercase();
    format!("{}{}", first.to_uppercase(), rest)
}

/// `computeEventAnswer` from `eventAnswerComputer.ts:39-65`.
///
/// Returns [`None`] when there are no matching events
/// (`result.uniqueDayCount === 0`).
pub fn compute_event_answer(
    event_filter: &EventAnswerFilter,
    scope: &EventAnswerScope,
    repo: &dyn EventCountRepository,
) -> RetrievalResult<Option<String>> {
    let filter = KnowledgeEventFilter {
        user_id: scope.user_id.clone(),
        persona_id: scope.persona_id.clone(),
        event_type: event_filter.event_type.clone(),
        speaker_role: None,
        subject_entity: None,
        counterpart_entity: event_filter.counterpart_entity.clone(),
        relation_label: None,
        from: event_filter.from.clone(),
        to: event_filter.to.clone(),
    };

    let result = repo.count_unique_days(&filter)?;

    if result.unique_day_count == 0 {
        return Ok(None);
    }

    let counterpart = match event_filter.counterpart_entity.as_deref() {
        Some(value) => capitalize(value),
        None => "der Person".to_string(),
    };

    let verb = event_type_label(event_filter.event_type.as_deref().unwrap_or(""));
    let day_word = if result.unique_day_count == 1 {
        "Tag"
    } else {
        "Tage"
    };

    let first_day = result.unique_days.first().cloned().unwrap_or_default();
    let last_day = result.unique_days.last().cloned().unwrap_or_default();

    Ok(Some(format!(
        "BERECHNETE ANTWORT: Insgesamt {} {} mit {} {}. (Basierend auf {} erfassten Ereignissen, Zeitraum: {} bis {})",
        result.unique_day_count, day_word, counterpart, verb, result.event_count, first_day, last_day
    )))
}

#[cfg(test)]
mod tests {
    use super::*;

    struct CountRepo {
        result: EventAggregationResult,
        seen: std::cell::RefCell<Vec<KnowledgeEventFilter>>,
    }

    impl EventCountRepository for CountRepo {
        fn count_unique_days(
            &self,
            filter: &KnowledgeEventFilter,
        ) -> RetrievalResult<EventAggregationResult> {
            self.seen.borrow_mut().push(filter.clone());
            Ok(self.result.clone())
        }
    }

    fn result(
        unique_day_count: usize,
        days: &[&str],
        event_count: usize,
    ) -> EventAggregationResult {
        EventAggregationResult {
            unique_day_count,
            unique_days: days.iter().map(|day| (*day).to_string()).collect(),
            event_count,
            events: Vec::new(),
        }
    }

    fn repo(result: EventAggregationResult) -> CountRepo {
        CountRepo {
            result,
            seen: std::cell::RefCell::new(Vec::new()),
        }
    }

    fn scope() -> EventAnswerScope {
        EventAnswerScope {
            user_id: "user-1".to_string(),
            persona_id: "persona-1".to_string(),
        }
    }

    #[test]
    fn no_matching_event_has_no_computed_answer() {
        let repo = repo(result(0, &[], 0));
        assert_eq!(
            compute_event_answer(&EventAnswerFilter::default(), &scope(), &repo),
            Ok(None)
        );
    }

    #[test]
    fn the_answer_names_the_label_of_the_event_type_and_the_scope_filter() {
        let repo = repo(result(
            2,
            &["2024-06-01T00:00:00.000Z", "2024-06-02T00:00:00.000Z"],
            3,
        ));
        let answer = compute_event_answer(
            &EventAnswerFilter {
                event_type: Some("shared_sleep".to_string()),
                counterpart_entity: Some("max".to_string()),
                from: Some("from".to_string()),
                to: Some("to".to_string()),
            },
            &scope(),
            &repo,
        )
        .expect("count query")
        .expect("an answer");

        assert_eq!(
            answer,
            "BERECHNETE ANTWORT: Insgesamt 2 Tage mit Max geschlafen. (Basierend auf 3 erfassten Ereignissen, Zeitraum: 2024-06-01T00:00:00.000Z bis 2024-06-02T00:00:00.000Z)"
        );
        let seen = repo.seen.borrow();
        assert_eq!(seen[0].user_id, "user-1");
        assert_eq!(seen[0].persona_id, "persona-1");
        assert_eq!(seen[0].from.as_deref(), Some("from"));
    }

    #[test]
    fn a_single_day_uses_the_singular_and_an_unknown_type_falls_back() {
        let repo = repo(result(1, &["2024-06-01T00:00:00.000Z"], 1));
        let answer = compute_event_answer(
            &EventAnswerFilter {
                event_type: Some("milestone".to_string()),
                ..Default::default()
            },
            &scope(),
            &repo,
        )
        .expect("count query")
        .expect("an answer");
        assert_eq!(
            answer,
            "BERECHNETE ANTWORT: Insgesamt 1 Tag mit der Person etwas gemacht. (Basierend auf 1 erfassten Ereignissen, Zeitraum: 2024-06-01T00:00:00.000Z bis 2024-06-01T00:00:00.000Z)"
        );
    }

    #[test]
    fn the_counterpart_is_capitalized_and_lowercased() {
        assert_eq!(capitalize("MAX"), "Max");
        assert_eq!(capitalize("max"), "Max");
        assert_eq!(capitalize(""), "");
        assert_eq!(event_type_label("appointment"), "einen Termin gehabt");
        assert_eq!(event_type_label("celebration"), "gefeiert");
    }
}
