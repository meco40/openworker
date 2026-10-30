//! Port of `src/server/master/liveEvents.ts:1-30`.
//!
//! Publishes the `master.updated` invalidation event that tells the browser which
//! Master panels to refetch.
//!
//! # The event bus is a seam, not a dependency
//!
//! `publishMasterUpdated` calls `getServerEventBus().publish(...)`, and
//! `src/server/events/runtime` is a process-wide singleton of the Next.js
//! runtime. `betaclaw-core` has no such singleton, and the publish is
//! fire-and-forget in the source (the caller never reads a result), so — exactly
//! like the S5 port of `memory/lifecycle.ts:11-18` — the bus is modelled as a
//! [`MasterEventPublisher`] trait whose default implementation
//! ([`NoopMasterEventPublisher`]) only logs. The gateway injects the real bus
//! when the S13 event runtime lands.
//!
//! `MasterInvalidationResource` lives in `src/shared/eventsTypes.ts:1-8`; the
//! port declares it next to the event that carries it rather than in
//! [`crate::master::types`], because S9 is its only producer.

use serde::{Deserialize, Serialize};

use crate::master::repository::now_iso;
use crate::master::types::WorkspaceScope;

/// `'master.updated'` — `liveEvents.ts:20`.
pub const MASTER_UPDATED_EVENT: &str = "master.updated";

/// `MasterInvalidationResource` from `shared/eventsTypes.ts:1-8`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum MasterInvalidationResource {
    Runs,
    RunDetail,
    Metrics,
    Approvals,
    Subagents,
    Reminders,
    Settings,
}

impl MasterInvalidationResource {
    /// The TypeScript literal.
    pub fn as_str(self) -> &'static str {
        match self {
            MasterInvalidationResource::Runs => "runs",
            MasterInvalidationResource::RunDetail => "run_detail",
            MasterInvalidationResource::Metrics => "metrics",
            MasterInvalidationResource::Approvals => "approvals",
            MasterInvalidationResource::Subagents => "subagents",
            MasterInvalidationResource::Reminders => "reminders",
            MasterInvalidationResource::Settings => "settings",
        }
    }

    /// Parses the TypeScript literal, or `None` for an unknown value.
    pub fn parse(value: &str) -> Option<Self> {
        match value {
            "runs" => Some(MasterInvalidationResource::Runs),
            "run_detail" => Some(MasterInvalidationResource::RunDetail),
            "metrics" => Some(MasterInvalidationResource::Metrics),
            "approvals" => Some(MasterInvalidationResource::Approvals),
            "subagents" => Some(MasterInvalidationResource::Subagents),
            "reminders" => Some(MasterInvalidationResource::Reminders),
            "settings" => Some(MasterInvalidationResource::Settings),
            _ => None,
        }
    }
}

/// `PublishMasterUpdatedInput` from `liveEvents.ts:5-12`.
///
/// `scope: Pick<WorkspaceScope, 'userId' | 'workspaceId'>` picks both members of
/// the interface, so the port takes the full [`WorkspaceScope`]. There is no
/// `Default`: the source always passes a scope, and an empty scope would be a
/// silently wrong event.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PublishMasterUpdatedInput {
    pub scope: WorkspaceScope,
    pub resources: Vec<MasterInvalidationResource>,
    pub run_id: Option<String>,
    pub approval_request_id: Option<String>,
    pub session_id: Option<String>,
    pub reminder_id: Option<String>,
}

/// The `'master.updated'` payload of `ServerEventMap` (`events/types.ts:40-47`).
///
/// Field order matches the object literal in `liveEvents.ts:20-29`, so the
/// serialised JSON has the same key order. The four optional ids are `null` when
/// absent (`input.runId ?? null`), which is why they are `Option` and not
/// skipped.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MasterUpdatedEvent {
    pub user_id: String,
    pub workspace_id: String,
    pub resources: Vec<MasterInvalidationResource>,
    pub run_id: Option<String>,
    pub approval_request_id: Option<String>,
    pub session_id: Option<String>,
    pub reminder_id: Option<String>,
    pub at: String,
}

/// `getServerEventBus().publish('master.updated', …)`.
pub trait MasterEventPublisher: Send + Sync {
    fn publish_master_updated(&self, event: &MasterUpdatedEvent);
}

/// The default: log and continue. The TypeScript publish is fire-and-forget and
/// a transport failure must never break a Master mutation.
#[derive(Debug, Clone, Copy, Default)]
pub struct NoopMasterEventPublisher;

impl MasterEventPublisher for NoopMasterEventPublisher {
    fn publish_master_updated(&self, event: &MasterUpdatedEvent) {
        tracing::debug!(
            user_id = %event.user_id,
            workspace_id = %event.workspace_id,
            resources = ?event.resources,
            "master.updated"
        );
    }
}

/// `publishMasterUpdated` — `liveEvents.ts:14-30`.
///
/// `[...new Set(input.resources)]` de-duplicates while keeping the first
/// occurrence, and an empty set returns before the bus is touched — a caller
/// with nothing to invalidate must not wake any subscriber.
pub fn publish_master_updated(
    publisher: &dyn MasterEventPublisher,
    input: &PublishMasterUpdatedInput,
) {
    let mut resources: Vec<MasterInvalidationResource> = Vec::with_capacity(input.resources.len());
    for resource in &input.resources {
        if !resources.contains(resource) {
            resources.push(*resource);
        }
    }
    if resources.is_empty() {
        return;
    }

    let event = MasterUpdatedEvent {
        user_id: input.scope.user_id.clone(),
        workspace_id: input.scope.workspace_id.clone(),
        resources,
        run_id: input.run_id.clone(),
        approval_request_id: input.approval_request_id.clone(),
        session_id: input.session_id.clone(),
        reminder_id: input.reminder_id.clone(),
        at: now_iso(),
    };
    publisher.publish_master_updated(&event);
}

#[cfg(test)]
mod tests {
    use std::sync::{Arc, Mutex};

    use super::*;

    #[derive(Default)]
    struct RecordingPublisher {
        events: Mutex<Vec<MasterUpdatedEvent>>,
    }

    impl MasterEventPublisher for RecordingPublisher {
        fn publish_master_updated(&self, event: &MasterUpdatedEvent) {
            self.events.lock().unwrap().push(event.clone());
        }
    }

    fn scope() -> WorkspaceScope {
        WorkspaceScope {
            user_id: "u1".to_string(),
            workspace_id: "persona:p1:w1".to_string(),
        }
    }

    /// The four optional ids absent, as in a `resources`-only invalidation.
    fn input(resources: Vec<MasterInvalidationResource>) -> PublishMasterUpdatedInput {
        PublishMasterUpdatedInput {
            scope: scope(),
            resources,
            run_id: None,
            approval_request_id: None,
            session_id: None,
            reminder_id: None,
        }
    }

    fn published(publisher: &Arc<RecordingPublisher>) -> Vec<MasterUpdatedEvent> {
        publisher.events.lock().unwrap().clone()
    }

    #[test]
    fn an_empty_resource_list_never_reaches_the_bus() {
        let publisher = Arc::new(RecordingPublisher::default());
        publish_master_updated(publisher.as_ref(), &input(Vec::new()));
        assert!(published(&publisher).is_empty());
    }

    #[test]
    fn resources_are_deduplicated_keeping_the_first_occurrence() {
        let publisher = Arc::new(RecordingPublisher::default());
        publish_master_updated(
            publisher.as_ref(),
            &input(vec![
                MasterInvalidationResource::Metrics,
                MasterInvalidationResource::Runs,
                MasterInvalidationResource::Metrics,
                MasterInvalidationResource::Runs,
            ]),
        );
        let events = published(&publisher);
        assert_eq!(events.len(), 1);
        assert_eq!(
            events[0]
                .resources
                .iter()
                .map(|resource| resource.as_str())
                .collect::<Vec<_>>(),
            vec!["metrics", "runs"]
        );
    }

    #[test]
    fn the_payload_matches_the_event_map_shape_key_for_key() {
        let publisher = Arc::new(RecordingPublisher::default());
        let mut request = input(vec![MasterInvalidationResource::Runs]);
        request.run_id = Some("run-1".to_string());
        publish_master_updated(publisher.as_ref(), &request);
        let events = published(&publisher);
        let json = serde_json::to_value(&events[0]).unwrap();
        assert_eq!(
            json,
            serde_json::json!({
                "userId": "u1",
                "workspaceId": "persona:p1:w1",
                "resources": ["runs"],
                "runId": "run-1",
                "approvalRequestId": null,
                "sessionId": null,
                "reminderId": null,
                "at": events[0].at,
            })
        );
        // `new Date().toISOString()` — millisecond precision, `Z` suffix.
        assert!(events[0].at.ends_with('Z'));
        assert_eq!(events[0].at.len(), "2026-01-01T00:00:00.000Z".len());
        // Unset ids stay `null` rather than disappearing.
        assert_eq!(events[0].session_id, None);
    }

    #[test]
    fn the_serialised_key_order_follows_the_object_literal() {
        let event = MasterUpdatedEvent {
            user_id: "u1".to_string(),
            workspace_id: "w1".to_string(),
            resources: vec![MasterInvalidationResource::Settings],
            run_id: None,
            approval_request_id: None,
            session_id: None,
            reminder_id: Some("rem-1".to_string()),
            at: "2026-01-01T00:00:00.000Z".to_string(),
        };
        let keys: Vec<String> = serde_json::from_str::<serde_json::Map<String, serde_json::Value>>(
            &serde_json::to_string(&event).unwrap(),
        )
        .unwrap()
        .keys()
        .cloned()
        .collect();
        assert_eq!(
            keys,
            vec![
                "userId",
                "workspaceId",
                "resources",
                "runId",
                "approvalRequestId",
                "sessionId",
                "reminderId",
                "at",
            ]
        );
    }

    #[test]
    fn every_resource_round_trips_through_its_literal() {
        let literals = [
            "runs",
            "run_detail",
            "metrics",
            "approvals",
            "subagents",
            "reminders",
            "settings",
        ];
        for literal in literals {
            let resource = MasterInvalidationResource::parse(literal).expect("known resource");
            assert_eq!(resource.as_str(), literal);
            assert_eq!(
                serde_json::to_value(resource).unwrap(),
                serde_json::json!(literal)
            );
        }
        assert_eq!(MasterInvalidationResource::parse("unknown"), None);
    }

    #[test]
    fn the_noop_publisher_accepts_an_event() {
        let event = MasterUpdatedEvent {
            user_id: "u1".to_string(),
            workspace_id: "w1".to_string(),
            resources: vec![MasterInvalidationResource::Metrics],
            run_id: None,
            approval_request_id: None,
            session_id: None,
            reminder_id: None,
            at: now_iso(),
        };
        NoopMasterEventPublisher.publish_master_updated(&event);
    }
}
