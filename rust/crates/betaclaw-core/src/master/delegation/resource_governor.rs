//! Port of `src/server/master/delegation/resourceGovernor.ts:1-28`.
//!
//! An in-memory concurrency counter, global and per capability. The TypeScript
//! `Map<string, number>` drops a capability key as soon as its count reaches
//! zero, so a released capability is indistinguishable from one never seen; the
//! port removes the entry the same way. `Math.max(0, …)` is reproduced so a
//! stray `release` can never drive a counter negative.

use std::collections::HashMap;

/// `DelegationResourceGovernor` from `resourceGovernor.ts:1-28`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DelegationResourceGovernor {
    max_concurrent: i64,
    active_global: i64,
    active_by_capability: HashMap<String, i64>,
}

impl DelegationResourceGovernor {
    /// `constructor(maxConcurrent)` — `resourceGovernor.ts:4`.
    pub fn new(max_concurrent: i64) -> Self {
        Self {
            max_concurrent,
            active_global: 0,
            active_by_capability: HashMap::new(),
        }
    }

    /// `getActiveGlobal` — `resourceGovernor.ts:6-8`.
    pub fn get_active_global(&self) -> i64 {
        self.active_global
    }

    /// `getActiveForCapability` — `resourceGovernor.ts:10-12`.
    pub fn get_active_for_capability(&self, capability: &str) -> i64 {
        self.active_by_capability
            .get(capability)
            .copied()
            .unwrap_or(0)
    }

    /// `tryAcquire` — `resourceGovernor.ts:14-20`.
    pub fn try_acquire(&mut self, capability: &str) -> bool {
        if self.active_global >= self.max_concurrent {
            return false;
        }
        self.active_global += 1;
        *self
            .active_by_capability
            .entry(capability.to_string())
            .or_insert(0) += 1;
        true
    }

    /// `release` — `resourceGovernor.ts:22-27`.
    pub fn release(&mut self, capability: &str) {
        self.active_global = 0.max(self.active_global - 1);
        let next = 0.max(
            self.active_by_capability
                .get(capability)
                .copied()
                .unwrap_or(1)
                - 1,
        );
        if next == 0 {
            self.active_by_capability.remove(capability);
        } else {
            self.active_by_capability
                .insert(capability.to_string(), next);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn acquire_stops_at_the_cap() {
        let mut governor = DelegationResourceGovernor::new(2);
        assert!(governor.try_acquire("a"));
        assert!(governor.try_acquire("b"));
        assert!(!governor.try_acquire("c"));
        assert_eq!(governor.get_active_global(), 2);
    }

    #[test]
    fn per_capability_counts_track_acquires() {
        let mut governor = DelegationResourceGovernor::new(4);
        governor.try_acquire("a");
        governor.try_acquire("a");
        assert_eq!(governor.get_active_for_capability("a"), 2);
        assert_eq!(governor.get_active_for_capability("b"), 0);
    }

    #[test]
    fn release_never_goes_negative_and_drops_the_key() {
        let mut governor = DelegationResourceGovernor::new(4);
        governor.release("a");
        assert_eq!(governor.get_active_global(), 0);
        assert_eq!(governor.get_active_for_capability("a"), 0);

        governor.try_acquire("a");
        governor.release("a");
        assert_eq!(governor.get_active_for_capability("a"), 0);
        assert!(governor.active_by_capability.is_empty());
    }
}
