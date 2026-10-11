//! Port of `src/server/world-model/services/followUpPolicy.ts:1-59`.

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct FollowUpContext<'a> {
    pub now: &'a str,
    pub quiet_hours: Option<(f64, f64)>,
    pub daily_budget: Option<f64>,
    pub delivered_today: Option<f64>,
    pub channel_available: Option<bool>,
    pub user_interaction_active: Option<bool>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DeliveryDecisionReason {
    Allow,
    QuietTime,
    BudgetExceeded,
    ChannelUnavailable,
    UserActive,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct DeliveryDecision {
    pub allow: bool,
    pub reason: DeliveryDecisionReason,
}

fn deny(reason: DeliveryDecisionReason) -> DeliveryDecision {
    DeliveryDecision {
        allow: false,
        reason,
    }
}

fn is_in_quiet_window(hour: f64, start: f64, end: f64) -> bool {
    if start == end {
        false
    } else if start < end {
        hour >= start && hour < end
    } else {
        hour >= start || hour < end
    }
}

use chrono::Timelike;

pub fn decide_open_loop_delivery(
    status: &str,
    attempts: Option<i64>,
    max_attempts: Option<i64>,
    do_not_ask_before: Option<&str>,
    context: FollowUpContext<'_>,
) -> DeliveryDecision {
    if attempts.unwrap_or(0) >= max_attempts.unwrap_or(3) {
        return deny(DeliveryDecisionReason::BudgetExceeded);
    }
    if status != "open" && status != "scheduled" {
        return deny(DeliveryDecisionReason::UserActive);
    }
    let now = chrono::DateTime::parse_from_rfc3339(context.now).ok();
    if let (Some(before), Some(now)) = (
        do_not_ask_before.and_then(|value| chrono::DateTime::parse_from_rfc3339(value).ok()),
        now,
    ) {
        if before > now {
            return deny(DeliveryDecisionReason::QuietTime);
        }
    }
    if context.user_interaction_active == Some(true) {
        return deny(DeliveryDecisionReason::UserActive);
    }
    if let (Some((start, end)), Some(now)) = (context.quiet_hours, now) {
        if is_in_quiet_window(now.to_utc().hour() as f64, start, end) {
            return deny(DeliveryDecisionReason::QuietTime);
        }
    }
    if context
        .daily_budget
        .is_some_and(|budget| context.delivered_today.unwrap_or(0.0) >= budget)
    {
        return deny(DeliveryDecisionReason::BudgetExceeded);
    }
    if context.channel_available == Some(false) {
        return deny(DeliveryDecisionReason::ChannelUnavailable);
    }
    DeliveryDecision {
        allow: true,
        reason: DeliveryDecisionReason::Allow,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn context(now: &str) -> FollowUpContext<'_> {
        FollowUpContext {
            now,
            quiet_hours: Some((22.0, 6.0)),
            daily_budget: Some(2.0),
            delivered_today: Some(0.0),
            channel_available: Some(true),
            user_interaction_active: Some(false),
        }
    }

    #[test]
    fn policy_order_and_cross_midnight_quiet_hours_match_the_source() {
        assert_eq!(
            decide_open_loop_delivery(
                "open",
                Some(3),
                Some(3),
                None,
                context("2026-10-11T23:00:00Z")
            )
            .reason,
            DeliveryDecisionReason::BudgetExceeded
        );
        assert_eq!(
            decide_open_loop_delivery("closed", None, None, None, context("2026-10-11T23:00:00Z"))
                .reason,
            DeliveryDecisionReason::UserActive
        );
        assert_eq!(
            decide_open_loop_delivery("open", None, None, None, context("2026-10-11T23:00:00Z"))
                .reason,
            DeliveryDecisionReason::QuietTime
        );
        assert!(
            decide_open_loop_delivery("open", None, None, None, context("2026-10-11T12:00:00Z"))
                .allow
        );
    }
}
