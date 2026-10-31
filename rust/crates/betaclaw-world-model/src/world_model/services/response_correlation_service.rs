//! Port of `src/server/world-model/services/responseCorrelationService.ts:1-81`.

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CorrelatableTargetType {
    OpenLoop,
    Event,
    Task,
    IntentFire,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CorrelatableTarget {
    pub id: String,
    pub target_type: CorrelatableTargetType,
    pub channel: Option<String>,
    pub conversation_id: Option<String>,
    pub external_chat_id: Option<String>,
    pub asked_at: Option<String>,
    pub window_ms: Option<i64>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct InboundUserMessage {
    pub channel: String,
    pub conversation_id: Option<String>,
    pub external_chat_id: Option<String>,
    pub text: String,
    pub received_at: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CorrelationReason {
    Exact,
    Single,
    Ambiguous,
    None,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CorrelationDecision {
    pub matched: Option<CorrelatableTarget>,
    pub candidate_count: usize,
    pub ambiguous: bool,
    pub reason: CorrelationReason,
}

pub fn correlate_user_response(
    message: &InboundUserMessage,
    candidates: &[CorrelatableTarget],
    default_window_ms: i64,
) -> CorrelationDecision {
    let received = chrono::DateTime::parse_from_rfc3339(&message.received_at).ok();
    let positive = candidates
        .iter()
        .filter_map(|candidate| {
            let mut score = 0;
            if candidate
                .channel
                .as_deref()
                .is_some_and(|channel| channel == message.channel)
            {
                score += 2;
            }
            if candidate
                .conversation_id
                .as_ref()
                .is_some_and(|id| Some(id) == message.conversation_id.as_ref())
            {
                score += 3;
            }
            if candidate.external_chat_id.as_ref().is_some_and(|id| {
                message
                    .external_chat_id
                    .as_ref()
                    .is_some_and(|value| id == value)
            }) {
                score += 4;
            }
            if let (Some(now), Some(asked)) = (
                received,
                candidate
                    .asked_at
                    .as_deref()
                    .and_then(|value| chrono::DateTime::parse_from_rfc3339(value).ok()),
            ) {
                let delta = now.timestamp_millis() - asked.timestamp_millis();
                if delta >= 0 && delta <= candidate.window_ms.unwrap_or(default_window_ms) {
                    score += 2;
                }
            }
            (score >= 3).then_some((candidate, score))
        })
        .collect::<Vec<_>>();
    match positive.as_slice() {
        [(candidate, score)] => CorrelationDecision {
            matched: Some((*candidate).clone()),
            candidate_count: candidates.len(),
            ambiguous: false,
            reason: if *score >= 5 {
                CorrelationReason::Exact
            } else {
                CorrelationReason::Single
            },
        },
        [] => CorrelationDecision {
            matched: None,
            candidate_count: candidates.len(),
            ambiguous: false,
            reason: CorrelationReason::None,
        },
        _ => CorrelationDecision {
            matched: None,
            candidate_count: positive.len(),
            ambiguous: true,
            reason: CorrelationReason::Ambiguous,
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn target(id: &str, conversation: Option<&str>) -> CorrelatableTarget {
        CorrelatableTarget {
            id: id.into(),
            target_type: CorrelatableTargetType::OpenLoop,
            channel: Some("telegram".into()),
            conversation_id: conversation.map(str::to_string),
            external_chat_id: None,
            asked_at: Some("2026-10-11T10:00:00Z".into()),
            window_ms: None,
        }
    }

    #[test]
    fn only_deterministic_signals_correlate_and_multiple_hits_are_ambiguous() {
        let message = InboundUserMessage {
            channel: "telegram".into(),
            conversation_id: Some("c1".into()),
            external_chat_id: None,
            text: "yes".into(),
            received_at: "2026-10-11T10:01:00Z".into(),
        };
        let one = correlate_user_response(&message, &[target("t1", Some("c1"))], 600_000);
        assert_eq!(one.reason, CorrelationReason::Exact);
        let many = correlate_user_response(
            &message,
            &[target("t1", Some("c1")), target("t2", Some("c1"))],
            600_000,
        );
        assert!(many.ambiguous);
        let mut time_only = target("t3", None);
        time_only.channel = None;
        let none = correlate_user_response(&message, &[time_only], 600_000);
        assert_eq!(none.reason, CorrelationReason::None);
    }
}
