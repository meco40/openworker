//! Port of `src/server/master/delegation/triggerPolicy.ts:1-44`.
//!
//! The admission gate of [`super::dispatcher`]: three checks in the source's
//! order — a per-`(scope, capability)` cooldown, a global/per-capability
//! capacity ceiling, then a non-positive timeout — and the accepted trigger is
//! remembered for the next cooldown window.
//!
//! # The module-global map becomes owned state
//!
//! `lastCapabilityTriggerAt` (`triggerPolicy.ts:12`) is a process-wide `Map` and
//! `resetTriggerPolicyState` (`:42-44`) clears it for tests. Rust has no such
//! ambient mutable store, so the map lives in [`DelegationTriggerPolicy`] and
//! [`DelegationTriggerPolicy::reset`] replaces the test hook. `dispatcher.ts`
//! creates exactly one such state per dispatcher, which is the lifetime the
//! TypeScript module global has in one process.

use std::collections::HashMap;

use crate::master::types::TriggerPolicyReason;

/// `TriggerPolicyInput` from `triggerPolicy.ts:1-10`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TriggerPolicyInput {
    pub scope_key: String,
    pub capability: String,
    /// `Date.now()` — milliseconds since the epoch.
    pub now: i64,
    pub timeout_ms: i64,
    pub cooldown_ms: i64,
    pub max_concurrent: i64,
    pub active_for_capability: i64,
    pub active_global: i64,
}

/// `TriggerPolicyResult` from `triggerPolicy.ts:12-15`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TriggerPolicyResult {
    pub allowed: bool,
    pub reason: Option<TriggerPolicyReason>,
}

impl TriggerPolicyResult {
    fn allowed() -> Self {
        Self {
            allowed: true,
            reason: None,
        }
    }

    fn denied(reason: TriggerPolicyReason) -> Self {
        Self {
            allowed: false,
            reason: Some(reason),
        }
    }
}

/// The `lastCapabilityTriggerAt` map of `triggerPolicy.ts:12`.
#[derive(Debug, Clone, Default)]
pub struct DelegationTriggerPolicy {
    last_capability_trigger_at: HashMap<String, i64>,
}

impl DelegationTriggerPolicy {
    pub fn new() -> Self {
        Self::default()
    }

    /// `triggerKey` — `triggerPolicy.ts:14-16` (`` `${scopeKey}::${capability}` ``).
    fn trigger_key(scope_key: &str, capability: &str) -> String {
        format!("{scope_key}::{capability}")
    }

    /// `evaluateTriggerPolicy` — `triggerPolicy.ts:18-40`.
    pub fn evaluate(&mut self, input: &TriggerPolicyInput) -> TriggerPolicyResult {
        let key = Self::trigger_key(&input.scope_key, &input.capability);
        let last_at = self
            .last_capability_trigger_at
            .get(&key)
            .copied()
            .unwrap_or(0);
        if input.now > last_at && input.now - last_at < input.cooldown_ms {
            return TriggerPolicyResult::denied(TriggerPolicyReason::CooldownActive);
        }
        if input.active_global >= input.max_concurrent
            || input.active_for_capability >= input.max_concurrent
        {
            return TriggerPolicyResult::denied(TriggerPolicyReason::CapacityExhausted);
        }
        if input.timeout_ms <= 0 {
            return TriggerPolicyResult::denied(TriggerPolicyReason::BudgetExceeded);
        }
        self.last_capability_trigger_at.insert(key, input.now);
        TriggerPolicyResult::allowed()
    }

    /// `resetTriggerPolicyState` — `triggerPolicy.ts:42-44`.
    pub fn reset(&mut self) {
        self.last_capability_trigger_at.clear();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn input(now: i64, cooldown_ms: i64) -> TriggerPolicyInput {
        TriggerPolicyInput {
            scope_key: "u1::w1".to_string(),
            capability: "web_search".to_string(),
            now,
            timeout_ms: 120_000,
            cooldown_ms,
            max_concurrent: 4,
            active_for_capability: 0,
            active_global: 0,
        }
    }

    /// The `lastAt ?? 0` default means a trigger in the first `cooldownMs` after
    /// the epoch would count as a cooldown hit — reproduced exactly, even though
    /// `Date.now()` never returns a value that small in production.
    #[test]
    fn a_trigger_inside_the_first_cooldown_window_is_a_cooldown_hit() {
        let mut policy = DelegationTriggerPolicy::new();
        assert_eq!(
            policy.evaluate(&input(1_000, 1_500)).reason,
            Some(TriggerPolicyReason::CooldownActive)
        );
    }

    #[test]
    fn the_first_trigger_past_the_epoch_window_is_allowed() {
        let mut policy = DelegationTriggerPolicy::new();
        assert!(policy.evaluate(&input(1_000_000, 1_500)).allowed);
        let second = policy.evaluate(&input(1_000_100, 1_500));
        assert!(!second.allowed);
        assert_eq!(second.reason, Some(TriggerPolicyReason::CooldownActive));
    }

    #[test]
    fn a_trigger_at_the_cooldown_boundary_is_allowed_again() {
        let mut policy = DelegationTriggerPolicy::new();
        policy.evaluate(&input(1_000_000, 1_500));
        assert!(policy.evaluate(&input(1_001_500, 1_500)).allowed);
    }

    #[test]
    fn capacity_and_budget_are_checked_in_order() {
        let mut policy = DelegationTriggerPolicy::new();
        let mut full = input(1_000_000, 1_500);
        full.active_global = 4;
        let denied = policy.evaluate(&full);
        assert_eq!(denied.reason, Some(TriggerPolicyReason::CapacityExhausted));

        let mut per_capability = input(1_000_000, 1_500);
        per_capability.active_for_capability = 4;
        assert_eq!(
            policy.evaluate(&per_capability).reason,
            Some(TriggerPolicyReason::CapacityExhausted)
        );

        let mut exhausted = input(1_000_000, 1_500);
        exhausted.timeout_ms = 0;
        assert_eq!(
            policy.evaluate(&exhausted).reason,
            Some(TriggerPolicyReason::BudgetExceeded)
        );
    }

    #[test]
    fn cooldown_wins_over_capacity() {
        let mut policy = DelegationTriggerPolicy::new();
        policy.evaluate(&input(1_000_000, 1_500));
        let mut full = input(1_000_100, 1_500);
        full.active_global = 4;
        assert_eq!(
            policy.evaluate(&full).reason,
            Some(TriggerPolicyReason::CooldownActive)
        );
    }

    #[test]
    fn reset_clears_the_cooldown() {
        let mut policy = DelegationTriggerPolicy::new();
        policy.evaluate(&input(1_000_000, 1_500));
        policy.reset();
        assert!(policy.evaluate(&input(1_000_100, 1_500)).allowed);
    }
}
