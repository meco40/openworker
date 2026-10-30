//! Retry and reentrancy rules from `agent-room/orchestrator.ts`.
use regex::Regex;
use std::{
    collections::{HashMap, HashSet},
    sync::LazyLock,
};

#[derive(Default)]
pub struct Orchestrator {
    processing: HashSet<String>,
    retries: HashMap<String, u8>,
}
impl Orchestrator {
    pub fn begin(&mut self, id: &str) -> bool {
        self.processing.insert(id.into())
    }
    /// Returns true when the swarm must enter error/hold after three failures.
    pub fn finish(&mut self, id: &str, error: Option<&str>) -> bool {
        static RATE_LIMIT: LazyLock<Regex> = LazyLock::new(|| {
            Regex::new("(?i)429|too many requests|rate.limit|resource.exhausted").unwrap()
        });
        self.processing.remove(id);
        let Some(error) = error else {
            self.retries.remove(id);
            return false;
        };
        if RATE_LIMIT.is_match(error) {
            return false;
        }
        let count = self.retries.entry(id.into()).or_default();
        *count += 1;
        if *count < 3 {
            return false;
        }
        self.retries.remove(id);
        true
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn retries_rate_limits_and_success_match_ts() {
        let mut state = Orchestrator::default();
        assert!(state.begin("s"));
        assert!(!state.begin("s"));
        assert!(!state.finish("s", Some("failure")));
        for error in [
            "429",
            "TOO MANY REQUESTS",
            "rate_limit",
            "resource exhausted",
        ] {
            assert!(!state.finish("s", Some(error)));
        }
        assert!(!state.finish("s", Some("failure")));
        assert!(state.finish("s", Some("failure")));
        assert!(!state.finish("s", Some("failure")));
        assert!(!state.finish("s", None));
        assert!(!state.finish("s", Some("failure")));
        assert!(state.begin("s"));
    }
}
