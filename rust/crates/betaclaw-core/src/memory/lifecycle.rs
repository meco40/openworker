//! Port of `src/server/memory/lifecycle.ts`.
//!
//! The lifecycle state machine decides which memories a recall is allowed to
//! see: only `new` and `confirmed` are active, and a `time_expired` transition
//! is derived from the `expiresAt` metadata key at read time. The transition
//! table is a port of the `switch` in `transitionLifecycle.ts:19-37`, including
//! its default branch, which leaves the status untouched for an unknown signal.
//!
//! # Lifecycle events
//!
//! `publishMemoryLifecycleChange` calls `getServerEventBus().publish(...)`,
//! and `src/server/events/runtime` is a process-wide singleton. The Rust port
//! keeps the event fire-and-forget through [`LifecyclePublisher`]; the gateway
//! injects [`MemoryLifecycleBus`] so in-process Rust consumers can subscribe.
//! With no subscribers, publication is discarded as in the TypeScript bus.

use serde_json::Value;
use std::panic::{catch_unwind, AssertUnwindSafe};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex as StdMutex, Weak};

use super::types::MemoryMetadata;

/// `LifecycleStatus` from `lifecycle.ts:3`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LifecycleStatus {
    New,
    Confirmed,
    Stale,
    Superseded,
    Rejected,
}

impl LifecycleStatus {
    pub fn as_str(self) -> &'static str {
        match self {
            LifecycleStatus::New => "new",
            LifecycleStatus::Confirmed => "confirmed",
            LifecycleStatus::Stale => "stale",
            LifecycleStatus::Superseded => "superseded",
            LifecycleStatus::Rejected => "rejected",
        }
    }

    /// The membership test of `knownStatus.includes(rawStatus)`.
    pub fn parse(value: &str) -> Option<Self> {
        match value {
            "new" => Some(LifecycleStatus::New),
            "confirmed" => Some(LifecycleStatus::Confirmed),
            "stale" => Some(LifecycleStatus::Stale),
            "superseded" => Some(LifecycleStatus::Superseded),
            "rejected" => Some(LifecycleStatus::Rejected),
            _ => None,
        }
    }
}

/// `LifecycleSignal` from `lifecycle.ts:5-12`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LifecycleSignal {
    UserConfirmed,
    RepeatedInSession,
    Contradicted,
    CorrectedByUser,
    TimeExpired,
    Reactivated,
    GarbageCollected,
}

impl LifecycleSignal {
    pub fn as_str(self) -> &'static str {
        match self {
            LifecycleSignal::UserConfirmed => "user_confirmed",
            LifecycleSignal::RepeatedInSession => "repeated_in_session",
            LifecycleSignal::Contradicted => "contradicted",
            LifecycleSignal::CorrectedByUser => "corrected_by_user",
            LifecycleSignal::TimeExpired => "time_expired",
            LifecycleSignal::Reactivated => "reactivated",
            LifecycleSignal::GarbageCollected => "garbage_collected",
        }
    }

    /// `String(input).trim() as LifecycleSignal` — the port keeps unknown
    /// values out of the enum and lets [`transition_lifecycle`] fall through to
    /// its default branch, which is what the TypeScript `switch` does.
    pub fn parse(value: &str) -> Option<Self> {
        match value {
            "user_confirmed" => Some(LifecycleSignal::UserConfirmed),
            "repeated_in_session" => Some(LifecycleSignal::RepeatedInSession),
            "contradicted" => Some(LifecycleSignal::Contradicted),
            "corrected_by_user" => Some(LifecycleSignal::CorrectedByUser),
            "time_expired" => Some(LifecycleSignal::TimeExpired),
            "reactivated" => Some(LifecycleSignal::Reactivated),
            "garbage_collected" => Some(LifecycleSignal::GarbageCollected),
            _ => None,
        }
    }
}

/// The result of [`resolve_lifecycle_status`].
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ResolvedLifecycleStatus {
    pub status: LifecycleStatus,
    /// Some only when the read *derived* a transition, which is what the
    /// caller publishes back onto the bus.
    pub derived_signal: Option<LifecycleSignal>,
}

/// `ACTIVE_STATUSES` from `lifecycle.ts:14`.
const ACTIVE_STATUSES: [LifecycleStatus; 2] = [LifecycleStatus::New, LifecycleStatus::Confirmed];

/// `transitionLifecycle` from `lifecycle.ts:16-37`.
pub fn transition_lifecycle(
    current_status: LifecycleStatus,
    signal: LifecycleSignal,
) -> LifecycleStatus {
    match signal {
        LifecycleSignal::UserConfirmed => LifecycleStatus::Confirmed,
        LifecycleSignal::RepeatedInSession => {
            if current_status == LifecycleStatus::New {
                LifecycleStatus::Confirmed
            } else {
                current_status
            }
        }
        LifecycleSignal::Contradicted | LifecycleSignal::CorrectedByUser => {
            LifecycleStatus::Superseded
        }
        LifecycleSignal::TimeExpired => LifecycleStatus::Stale,
        LifecycleSignal::Reactivated => LifecycleStatus::Confirmed,
        LifecycleSignal::GarbageCollected => LifecycleStatus::Rejected,
    }
}

/// `isActiveStatus` from `lifecycle.ts:39-41`.
pub fn is_active_status(status: LifecycleStatus) -> bool {
    ACTIVE_STATUSES.contains(&status)
}

/// `resolveLifecycleStatus` from `lifecycle.ts:43-59`.
///
/// `now` is a millisecond epoch and is injected so a test can sit exactly on the
/// expiry boundary. The expiry comparison is `<=`, so a memory whose `expiresAt`
/// equals `now` is already expired.
pub fn resolve_lifecycle_status(
    metadata: Option<&MemoryMetadata>,
    now_ms: f64,
) -> ResolvedLifecycleStatus {
    let raw_status = metadata
        .and_then(|metadata| metadata.get("lifecycleStatus"))
        .and_then(Value::as_str)
        .unwrap_or("")
        .trim()
        .to_lowercase();
    let status = LifecycleStatus::parse(&raw_status).unwrap_or(LifecycleStatus::New);

    let expires_at = metadata
        .and_then(|metadata| metadata.get("expiresAt"))
        .and_then(Value::as_str)
        .map(parse_epoch_millis);

    if let Some(expires_at) = expires_at.filter(|value| value.is_finite()) {
        if expires_at <= now_ms && is_active_status(status) {
            return ResolvedLifecycleStatus {
                status: transition_lifecycle(status, LifecycleSignal::TimeExpired),
                derived_signal: Some(LifecycleSignal::TimeExpired),
            };
        }
    }

    ResolvedLifecycleStatus {
        status,
        derived_signal: None,
    }
}

/// `Date.parse` semantics for an ISO-8601 timestamp.
fn parse_epoch_millis(value: &str) -> f64 {
    if value.trim().is_empty() {
        return f64::NAN;
    }
    match chrono::DateTime::parse_from_rfc3339(value) {
        Ok(parsed) => parsed.timestamp_millis() as f64,
        Err(_) => f64::NAN,
    }
}

/// `Date.now()`, in milliseconds.
pub fn now_epoch_millis() -> f64 {
    chrono::Utc::now().timestamp_millis() as f64
}

/// `isActiveMemoryMetadata` from `lifecycle.ts:61-63`.
pub fn is_active_memory_metadata(metadata: Option<&MemoryMetadata>, now_ms: f64) -> bool {
    is_active_status(resolve_lifecycle_status(metadata, now_ms).status)
}

/// `withLifecycleSignal` from `lifecycle.ts:65-77`.
pub fn with_lifecycle_signal(
    metadata: Option<&MemoryMetadata>,
    signal: LifecycleSignal,
    now_iso: impl Fn() -> String,
) -> MemoryMetadata {
    let current = resolve_lifecycle_status(metadata, now_epoch_millis()).status;
    let mut next = metadata.cloned().unwrap_or_default();
    next.insert(
        "lifecycleStatus".to_string(),
        Value::String(transition_lifecycle(current, signal).as_str().to_string()),
    );
    next.insert(
        "lifecycleSignal".to_string(),
        Value::String(signal.as_str().to_string()),
    );
    next.insert("lifecycleUpdatedAt".to_string(), Value::String(now_iso()));
    next
}

/// One `memory.lifecycle.changed` event.
#[derive(Debug, Clone, PartialEq)]
pub struct MemoryLifecycleChange {
    pub memory_id: String,
    pub user_id: String,
    pub persona_id: String,
    pub status: LifecycleStatus,
    pub signal: LifecycleSignal,
    /// `input.provider || 'mem0'`.
    pub provider: super::types::MemoryProviderKind,
    pub at: String,
}

/// `getServerEventBus().publish('memory.lifecycle.changed', …)`.
pub trait LifecyclePublisher: Send + Sync {
    fn publish_memory_lifecycle_change(&self, change: &MemoryLifecycleChange);
}

/// Process-local delivery for memory lifecycle events.
type LifecycleHandler = Arc<dyn Fn(&MemoryLifecycleChange) + Send + Sync>;

#[derive(Default)]
struct MemoryLifecycleBusInner {
    next_subscriber_id: AtomicU64,
    subscribers: StdMutex<Vec<(u64, LifecycleHandler)>>,
}

#[derive(Clone, Default)]
pub struct MemoryLifecycleBus(Arc<MemoryLifecycleBusInner>);

pub struct MemoryLifecycleSubscription {
    bus: Weak<MemoryLifecycleBusInner>,
    subscriber_id: u64,
}

impl MemoryLifecycleBus {
    pub fn subscribe(
        &self,
        handler: impl Fn(&MemoryLifecycleChange) + Send + Sync + 'static,
    ) -> MemoryLifecycleSubscription {
        let subscriber_id = self.0.next_subscriber_id.fetch_add(1, Ordering::Relaxed);
        self.0
            .subscribers
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .push((subscriber_id, Arc::new(handler)));
        MemoryLifecycleSubscription {
            bus: Arc::downgrade(&self.0),
            subscriber_id,
        }
    }
}

impl LifecyclePublisher for MemoryLifecycleBus {
    fn publish_memory_lifecycle_change(&self, change: &MemoryLifecycleChange) {
        let subscribers = self
            .0
            .subscribers
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .iter()
            .map(|(_, handler)| Arc::clone(handler))
            .collect::<Vec<_>>();
        for handler in subscribers {
            if catch_unwind(AssertUnwindSafe(|| handler(change))).is_err() {
                tracing::error!("memory lifecycle subscriber failed");
            }
        }
    }
}

impl Drop for MemoryLifecycleSubscription {
    fn drop(&mut self) {
        let Some(bus) = self.bus.upgrade() else {
            return;
        };
        bus.subscribers
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .retain(|(id, _)| *id != self.subscriber_id);
    }
}

/// The default: log and continue. A statistics or transport failure must never
/// break a memory operation, and the TypeScript publish is fire-and-forget.
#[derive(Debug, Clone, Copy, Default)]
pub struct NoopLifecyclePublisher;

impl LifecyclePublisher for NoopLifecyclePublisher {
    fn publish_memory_lifecycle_change(&self, change: &MemoryLifecycleChange) {
        tracing::debug!(
            memory_id = %change.memory_id,
            status = change.status.as_str(),
            signal = change.signal.as_str(),
            "memory lifecycle changed"
        );
    }
}

/// `publishMemoryLifecycleChange` from `lifecycle.ts:79-92`.
pub fn publish_memory_lifecycle_change(
    publisher: &dyn LifecyclePublisher,
    memory_id: &str,
    user_id: &str,
    persona_id: &str,
    status: LifecycleStatus,
    signal: LifecycleSignal,
    provider: Option<super::types::MemoryProviderKind>,
) {
    publisher.publish_memory_lifecycle_change(&MemoryLifecycleChange {
        memory_id: memory_id.to_string(),
        user_id: user_id.to_string(),
        persona_id: persona_id.to_string(),
        status,
        signal,
        provider: provider.unwrap_or_default(),
        at: super::utils::now_iso(),
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::sync::Mutex;

    struct Recording(Mutex<Vec<MemoryLifecycleChange>>);

    impl LifecyclePublisher for Recording {
        fn publish_memory_lifecycle_change(&self, change: &MemoryLifecycleChange) {
            self.0.lock().expect("lock").push(change.clone());
        }
    }

    fn now_ms() -> f64 {
        parse_epoch_millis("2026-01-11T00:00:00Z")
    }

    #[test]
    fn the_transition_table_matches_the_switch() {
        assert_eq!(
            transition_lifecycle(LifecycleStatus::New, LifecycleSignal::UserConfirmed),
            LifecycleStatus::Confirmed
        );
        assert_eq!(
            transition_lifecycle(LifecycleStatus::New, LifecycleSignal::RepeatedInSession),
            LifecycleStatus::Confirmed
        );
        // `repeated_in_session` is a no-op once the status left `new`.
        assert_eq!(
            transition_lifecycle(LifecycleStatus::Stale, LifecycleSignal::RepeatedInSession),
            LifecycleStatus::Stale
        );
        assert_eq!(
            transition_lifecycle(LifecycleStatus::New, LifecycleSignal::Contradicted),
            LifecycleStatus::Superseded
        );
        assert_eq!(
            transition_lifecycle(LifecycleStatus::Confirmed, LifecycleSignal::CorrectedByUser),
            LifecycleStatus::Superseded
        );
        assert_eq!(
            transition_lifecycle(LifecycleStatus::New, LifecycleSignal::TimeExpired),
            LifecycleStatus::Stale
        );
        assert_eq!(
            transition_lifecycle(LifecycleStatus::Stale, LifecycleSignal::Reactivated),
            LifecycleStatus::Confirmed
        );
        assert_eq!(
            transition_lifecycle(
                LifecycleStatus::Confirmed,
                LifecycleSignal::GarbageCollected
            ),
            LifecycleStatus::Rejected
        );
    }

    /// Only `new` and `confirmed` are active; everything else is filtered out
    /// of a recall, so this is the gate that hides superseded memories.
    #[test]
    fn only_new_and_confirmed_are_active() {
        assert!(is_active_status(LifecycleStatus::New));
        assert!(is_active_status(LifecycleStatus::Confirmed));
        for status in [
            LifecycleStatus::Stale,
            LifecycleStatus::Superseded,
            LifecycleStatus::Rejected,
        ] {
            assert!(!is_active_status(status), "{status:?} must stay inactive");
        }
    }

    #[test]
    fn an_unknown_status_is_normalised_to_new() {
        let metadata = MemoryMetadata::from_iter([("lifecycleStatus".to_string(), json!("bogus"))]);
        let resolved = resolve_lifecycle_status(Some(&metadata), now_ms());
        assert_eq!(resolved.status, LifecycleStatus::New);
        assert_eq!(resolved.derived_signal, None);
    }

    /// The expiry boundary is inclusive: `expiresAt === now` is already stale.
    #[test]
    fn an_expired_active_memory_is_derived_as_stale() {
        let metadata = MemoryMetadata::from_iter([
            ("lifecycleStatus".to_string(), json!("confirmed")),
            ("expiresAt".to_string(), json!("2026-01-11T00:00:00Z")),
        ]);
        let resolved = resolve_lifecycle_status(Some(&metadata), now_ms());
        assert_eq!(resolved.status, LifecycleStatus::Stale);
        assert_eq!(resolved.derived_signal, Some(LifecycleSignal::TimeExpired));
        assert!(!is_active_memory_metadata(Some(&metadata), now_ms()));
    }

    /// A non-active status is never re-derived: a `rejected` memory with a past
    /// `expiresAt` stays rejected instead of bouncing back to `stale`.
    #[test]
    fn a_non_active_status_is_not_re_derived() {
        let metadata = MemoryMetadata::from_iter([
            ("lifecycleStatus".to_string(), json!("rejected")),
            ("expiresAt".to_string(), json!("2020-01-01T00:00:00Z")),
        ]);
        let resolved = resolve_lifecycle_status(Some(&metadata), now_ms());
        assert_eq!(resolved.status, LifecycleStatus::Rejected);
        assert_eq!(resolved.derived_signal, None);
    }

    #[test]
    fn a_memory_without_expiry_stays_active() {
        let metadata =
            MemoryMetadata::from_iter([("lifecycleStatus".to_string(), json!("confirmed"))]);
        assert!(is_active_memory_metadata(Some(&metadata), now_ms()));
        let resolved = resolve_lifecycle_status(None, now_ms());
        assert_eq!(resolved.status, LifecycleStatus::New);
        assert!(is_active_memory_metadata(None, now_ms()));
    }

    #[test]
    fn now_epoch_millis_is_a_plausible_clock() {
        assert!(now_epoch_millis() > 1_700_000_000_000.0);
    }

    #[test]
    fn with_lifecycle_signal_stamps_status_signal_and_timestamp() {
        let metadata = MemoryMetadata::from_iter([("lifecycleStatus".to_string(), json!("new"))]);
        let stamped =
            with_lifecycle_signal(Some(&metadata), LifecycleSignal::UserConfirmed, || {
                "2026-01-11T00:00:00Z".to_string()
            });
        assert_eq!(stamped["lifecycleStatus"], "confirmed");
        assert_eq!(stamped["lifecycleSignal"], "user_confirmed");
        assert_eq!(stamped["lifecycleUpdatedAt"], "2026-01-11T00:00:00Z");
        assert_eq!(stamped.len(), 3, "no extra keys are introduced");
    }

    /// The publish is fire-and-forget: the timestamp is stamped by the port and
    /// the provider defaults to `mem0`.
    #[test]
    fn the_publish_stamps_a_timestamp_and_defaults_the_provider() {
        let publisher = Recording(Mutex::new(Vec::new()));
        publish_memory_lifecycle_change(
            &publisher,
            "n1",
            "u1",
            "p1",
            LifecycleStatus::Confirmed,
            LifecycleSignal::UserConfirmed,
            None,
        );
        let events = publisher.0.lock().expect("lock");
        assert_eq!(events.len(), 1);
        assert_eq!(events[0].memory_id, "n1");
        assert_eq!(
            events[0].provider,
            super::super::types::MemoryProviderKind::Mem0
        );
        assert!(!events[0].at.is_empty());
    }

    #[test]
    fn lifecycle_bus_delivers_to_subscribers_and_isolates_failures() {
        let bus = MemoryLifecycleBus::default();
        let received = Arc::new(Mutex::new(Vec::new()));
        let received_by_handler = Arc::clone(&received);
        let subscription = bus.subscribe(move |change| {
            received_by_handler
                .lock()
                .expect("lock")
                .push(change.clone());
        });
        let _failing_subscription = bus.subscribe(|_| panic!("listener failure"));
        let change = MemoryLifecycleChange {
            memory_id: "n1".to_string(),
            user_id: "u1".to_string(),
            persona_id: "p1".to_string(),
            status: LifecycleStatus::Confirmed,
            signal: LifecycleSignal::UserConfirmed,
            provider: super::super::types::MemoryProviderKind::Postgres,
            at: "2026-10-12T00:00:00.000Z".to_string(),
        };

        bus.publish_memory_lifecycle_change(&change);

        assert_eq!(
            received.lock().expect("lock").as_slice(),
            std::slice::from_ref(&change)
        );
        drop(subscription);
        bus.publish_memory_lifecycle_change(&change);
        assert_eq!(received.lock().expect("lock").as_slice(), &[change]);
    }
}
