//! Port of `src/server/world-model/services/notificationPolicy.ts:1-43`.

use std::collections::HashMap;

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct QuietHours {
    pub start: f64,
    pub end: f64,
}

#[derive(Debug, Clone, PartialEq)]
pub struct NotificationPolicyConfig {
    pub quiet_hours: Option<QuietHours>,
    pub daily_budget: Option<f64>,
    pub channel_pref: Option<HashMap<String, bool>>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum NotificationDecisionReason {
    Allow,
    QuietTime,
    BudgetExceeded,
    ChannelClosed,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct NotificationDecision {
    pub allow: bool,
    pub reason: NotificationDecisionReason,
}

fn quiet_window(hour: f64, start: f64, end: f64) -> bool {
    if start == end {
        false
    } else if start < end {
        hour >= start && hour < end
    } else {
        hour >= start || hour < end
    }
}

fn utc_hour(now: &str) -> Option<f64> {
    chrono::DateTime::parse_from_rfc3339(now)
        .ok()
        .map(|value| value.to_utc().hour() as f64)
}

use chrono::Timelike;

pub fn decide_notification(
    now: &str,
    channel: &str,
    delivered_today: f64,
    config: &NotificationPolicyConfig,
) -> NotificationDecision {
    if let (Some(quiet), Some(hour)) = (config.quiet_hours, utc_hour(now)) {
        if quiet_window(hour, quiet.start, quiet.end) {
            return NotificationDecision {
                allow: false,
                reason: NotificationDecisionReason::QuietTime,
            };
        }
    }
    if config
        .daily_budget
        .is_some_and(|budget| delivered_today >= budget)
    {
        return NotificationDecision {
            allow: false,
            reason: NotificationDecisionReason::BudgetExceeded,
        };
    }
    if config
        .channel_pref
        .as_ref()
        .and_then(|prefs| prefs.get(channel))
        == Some(&false)
    {
        return NotificationDecision {
            allow: false,
            reason: NotificationDecisionReason::ChannelClosed,
        };
    }
    NotificationDecision {
        allow: true,
        reason: NotificationDecisionReason::Allow,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn quiet_hours_cross_midnight_and_channel_preferences_are_enforced() {
        let config = NotificationPolicyConfig {
            quiet_hours: Some(QuietHours {
                start: 22.0,
                end: 6.0,
            }),
            daily_budget: Some(3.0),
            channel_pref: Some(HashMap::from([("telegram".into(), false)])),
        };
        assert_eq!(
            decide_notification("2026-10-11T23:00:00Z", "telegram", 0.0, &config).reason,
            NotificationDecisionReason::QuietTime
        );
        assert_eq!(
            decide_notification("2026-10-11T12:00:00Z", "telegram", 0.0, &config).reason,
            NotificationDecisionReason::ChannelClosed
        );
        assert_eq!(
            decide_notification("2026-10-11T12:00:00Z", "email", 3.0, &config).reason,
            NotificationDecisionReason::BudgetExceeded
        );
    }
}
