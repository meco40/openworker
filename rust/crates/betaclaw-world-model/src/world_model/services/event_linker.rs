//! Port of `src/server/world-model/services/eventLinker.ts:1-87`.

use std::sync::LazyLock;

use regex::Regex;

use crate::world_model::types::EventStatus;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum EventUtteranceKind {
    Proposal,
    Plan,
    Change,
    Cancellation,
    History,
    OutcomeConfirmation,
    Unknown,
}

#[derive(Debug, Clone, PartialEq)]
pub struct EventCandidateHit {
    pub event_id: String,
    pub title: String,
    pub confidence: f64,
    pub status: EventStatus,
}

static OUTCOME: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(war|bin gewesen|hab ich|war ich).*(essen|kino|dort|da)").unwrap()
});
static CHANGE_CANCEL: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?s)(doch nicht|nicht mehr).*(stattdessen|sondern|dafür|ich gehe|gehe ich)")
        .unwrap()
});
static CANCELLATION: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(doch nicht|nicht mehr|absage|stornier|ett sage ich ab|gehe ich doch nicht)")
        .unwrap()
});
static HISTORY: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(
        r"(was habe ich|was hab ich|letzte woche|gestern|rueckblick|erinnere mich an die woche)",
    )
    .unwrap()
});
static PLAN: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(ich gehe|gehe ich|ich plane|termin|ich habe .* vor|lass uns|erinnere mich)")
        .unwrap()
});
static CHANGE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(statt|stattdessen|ersatz|andere plan)").unwrap());

pub fn classify_event_utterance(text: &str) -> EventUtteranceKind {
    let text = text.trim().to_lowercase();
    if OUTCOME.is_match(&text) {
        return EventUtteranceKind::OutcomeConfirmation;
    }
    if CHANGE_CANCEL.is_match(&text) {
        return EventUtteranceKind::Change;
    }
    if CANCELLATION.is_match(&text) {
        return EventUtteranceKind::Cancellation;
    }
    if HISTORY.is_match(&text) {
        return EventUtteranceKind::History;
    }
    if PLAN.is_match(&text) {
        return EventUtteranceKind::Plan;
    }
    if CHANGE.is_match(&text) {
        return EventUtteranceKind::Change;
    }
    EventUtteranceKind::Unknown
}

pub fn pick_event_candidate(
    kind: EventUtteranceKind,
    candidates: &[EventCandidateHit],
) -> Option<EventCandidateHit> {
    if matches!(
        kind,
        EventUtteranceKind::OutcomeConfirmation | EventUtteranceKind::Cancellation
    ) {
        let mut active = candidates.iter().filter(|candidate| {
            matches!(
                candidate.status,
                EventStatus::Planned | EventStatus::Proposed
            )
        });
        let first = active.next()?;
        if active.next().is_some() {
            return None;
        }
        return Some(first.clone());
    }
    candidates.first().cloned()
}

pub fn outcome_for_utterance(kind: EventUtteranceKind) -> Option<EventStatus> {
    match kind {
        EventUtteranceKind::OutcomeConfirmation => Some(EventStatus::Completed),
        EventUtteranceKind::Cancellation => Some(EventStatus::Cancelled),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_confirmed_past_tense_completes_one_unambiguous_active_event() {
        let kind = classify_event_utterance("Ich war gestern im Kino");
        assert_eq!(kind, EventUtteranceKind::OutcomeConfirmation);
        assert_eq!(outcome_for_utterance(kind), Some(EventStatus::Completed));
        let hit = EventCandidateHit {
            event_id: "e1".into(),
            title: "Kino".into(),
            confidence: 1.0,
            status: EventStatus::Planned,
        };
        assert_eq!(
            pick_event_candidate(kind, std::slice::from_ref(&hit)),
            Some(hit.clone())
        );
        assert_eq!(pick_event_candidate(kind, &[hit.clone(), hit]), None);
        assert_eq!(
            classify_event_utterance("Ich gehe doch nicht ins Kino, sondern essen"),
            EventUtteranceKind::Change
        );
    }
}
