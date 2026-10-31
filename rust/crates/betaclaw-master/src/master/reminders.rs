//! Port of `src/server/master/reminders.ts:1-234`.
//!
//! The reminder service: create/list/get/update/pause/cancel/delete/fire, each
//! mutation followed by a scheduler sync (through [`ReminderSchedulerBridge`]),
//! an audit event and a `master.updated` invalidation.
//!
//! # Dependencies are injected, like in the source
//!
//! `constructor(repo, options = {})` takes `scheduler?` and `now?`; the event bus
//! is the only thing the source reads globally. The port takes all three: the
//! repository and the bus as references (see [`crate::master::notes`] for why the
//! handle is borrowed), the clock as a `fn() -> DateTime<Utc>` so the default
//! `Utc::now` can be replaced without a trait object.
//!
//! # Audit metadata is `JSON.stringify`
//!
//! `toMetadata` is `JSON.stringify(payload)`, which omits `undefined` properties
//! but keeps `null` ones. [`to_metadata`] therefore builds the object key by key
//! and skips `None`, and the `patch` sub-object is written in the declaration
//! order of [`ReminderPatch`] — the order a TypeScript caller's object literal
//! has in practice. `fromMetadata` swallows every parse error and any parsed
//! value that is not an object, exactly like the `try`/`catch` in
//! `reminders.ts:47-53`.

use chrono::{DateTime, Utc};
use serde_json::{Map, Value};

use crate::master::live_events::{
    publish_master_updated, MasterEventPublisher, NoopMasterEventPublisher,
    PublishMasterUpdatedInput,
};
use crate::master::repository::audit_store::MasterAuditEventInput;
use crate::master::repository::reminders_store::{MasterReminderInput, ReminderPatch};
use crate::master::repository::MasterRepository;
use crate::master::types::{MasterReminder, MasterReminderStatus, WorkspaceScope};

/// `listReminders` default from `reminders.store.ts:40` (`limit = 100`).
///
/// `reminders.ts:98` calls `listReminders(scope)` without a limit.
pub const DEFAULT_REMINDER_LIMIT: i64 = 100;

/// The `500` of `reminders.ts:102` (`listReminders(scope, 500).find(…)`).
pub const REMINDER_LOOKUP_LIMIT: i64 = 500;

/// The `500` of `reminders.ts:226` (`listAuditEvents(scope, 500)`).
pub const REMINDER_AUDIT_LIMIT: i64 = 500;

/// The default publisher, used when no bus is injected.
static NOOP_PUBLISHER: NoopMasterEventPublisher = NoopMasterEventPublisher;

/// `ReminderSchedulerBridge` from `reminders.ts:5-10`.
///
/// The scheduler is another package's concern; S9 only calls it. Every method is
/// fire-and-forget in the source, so the trait returns nothing.
pub trait ReminderSchedulerBridge: Send + Sync {
    fn sync_reminder(&self, scope: &WorkspaceScope, reminder: &MasterReminder);
    fn pause_reminder(&self, scope: &WorkspaceScope, reminder_id: &str);
    fn resume_reminder(&self, scope: &WorkspaceScope, reminder_id: &str);
    fn remove_reminder(&self, scope: &WorkspaceScope, reminder_id: &str);
}

/// `FireReminderInput` from `reminders.ts:12-17`.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct FireReminderInput {
    /// Absent means "use the clock".
    pub fired_at: Option<String>,
    /// `'manual' | 'cron' | 'api'`; absent becomes `'manual'`.
    pub source: Option<String>,
    pub summary: Option<String>,
    pub automation_rule_id: Option<String>,
}

/// `FireReminderResult` from `reminders.ts:19-23`.
#[derive(Debug, Clone, PartialEq)]
pub struct FireReminderResult {
    pub reminder: MasterReminder,
    pub fired_at: String,
    pub duplicate: bool,
}

/// `MasterRemindersServiceOptions` from `reminders.ts:25-28`.
pub struct MasterRemindersServiceOptions<'a> {
    pub scheduler: Option<&'a dyn ReminderSchedulerBridge>,
    pub publisher: &'a dyn MasterEventPublisher,
    /// `now?: () => Date`, defaulting to `Utc::now`.
    pub now: fn() -> DateTime<Utc>,
}

impl<'a> Default for MasterRemindersServiceOptions<'a> {
    fn default() -> Self {
        Self {
            scheduler: None,
            publisher: &NOOP_PUBLISHER,
            now: Utc::now,
        }
    }
}

/// `create` input — `reminders.ts:69-74`.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct MasterReminderCreateInput {
    pub title: String,
    pub message: String,
    pub remind_at: String,
    /// `cronExpression?: string | null`.
    pub cron_expression: Option<String>,
}

/// `MasterRemindersService` from `reminders.ts:55-233`.
pub struct MasterRemindersService<'a> {
    repo: &'a dyn MasterRepository,
    scheduler: Option<&'a dyn ReminderSchedulerBridge>,
    publisher: &'a dyn MasterEventPublisher,
    now: fn() -> DateTime<Utc>,
}

/// `ReminderAuditMetadata` from `reminders.ts:30-37`.
///
/// Only the fields a caller fills are written; the rest are `undefined` in the
/// source and disappear from `JSON.stringify`.
fn to_metadata(reminder_id: &str, patch: Option<&ReminderPatch>) -> String {
    let mut object = Map::new();
    object.insert(
        "reminderId".to_string(),
        Value::from(reminder_id.to_string()),
    );
    if let Some(patch) = patch {
        let mut fields = Map::new();
        if let Some(title) = &patch.title {
            fields.insert("title".to_string(), Value::from(title.clone()));
        }
        if let Some(message) = &patch.message {
            fields.insert("message".to_string(), Value::from(message.clone()));
        }
        if let Some(remind_at) = &patch.remind_at {
            fields.insert("remindAt".to_string(), Value::from(remind_at.clone()));
        }
        if let Some(cron_expression) = &patch.cron_expression {
            fields.insert(
                "cronExpression".to_string(),
                match cron_expression {
                    Some(text) => Value::from(text.clone()),
                    None => Value::Null,
                },
            );
        }
        if let Some(status) = &patch.status {
            fields.insert("status".to_string(), Value::from(status.clone()));
        }
        object.insert("patch".to_string(), Value::Object(fields));
    }
    Value::Object(object).to_string()
}

/// The `fire` metadata of `reminders.ts:189-195`.
///
/// `source` is already defaulted to `'manual'` by the caller, and `summary` and
/// `automationRuleId` are the two fields the source pins to `null` with
/// `?? null` — so unlike [`to_metadata`] they are always present, as JSON `null`.
fn to_fired_metadata(
    reminder_id: &str,
    fired_at: &str,
    source: &str,
    summary: Option<&str>,
    automation_rule_id: Option<&str>,
) -> String {
    let mut object = Map::new();
    object.insert(
        "reminderId".to_string(),
        Value::from(reminder_id.to_string()),
    );
    object.insert("firedAt".to_string(), Value::from(fired_at.to_string()));
    object.insert("source".to_string(), Value::from(source.to_string()));
    object.insert(
        "summary".to_string(),
        summary.map_or(Value::Null, Value::from),
    );
    object.insert(
        "automationRuleId".to_string(),
        automation_rule_id.map_or(Value::Null, Value::from),
    );
    Value::Object(object).to_string()
}

/// `fromMetadata` — `reminders.ts:47-53`.
///
/// Returns the two fields the duplicate check reads; a parse failure or a
/// non-object payload yields `None`.
fn from_metadata(value: &str) -> Option<(Option<String>, Option<String>)> {
    let parsed: Value = serde_json::from_str(value).ok()?;
    let object = parsed.as_object()?;
    let text = |key: &str| object.get(key).and_then(Value::as_str).map(str::to_string);
    Some((text("reminderId"), text("firedAt")))
}

/// The stored status of an updated reminder, for `resolveUpdateAction`
/// (`reminders.ts:210-215`).
fn resolve_update_action(status: Option<&str>) -> &'static str {
    match status {
        Some(value) if value == MasterReminderStatus::Paused.as_str() => "paused",
        Some(value) if value == MasterReminderStatus::Cancelled.as_str() => "cancelled",
        Some(value) if value == MasterReminderStatus::Pending.as_str() => "resumed",
        _ => "updated",
    }
}

impl<'a> MasterRemindersService<'a> {
    /// `constructor(repo, options = {})` — `reminders.ts:59-65`.
    pub fn new(repo: &'a dyn MasterRepository) -> Self {
        Self::with_options(repo, MasterRemindersServiceOptions::default())
    }

    /// The same constructor with the optional `scheduler`/`now`/bus supplied.
    pub fn with_options(
        repo: &'a dyn MasterRepository,
        options: MasterRemindersServiceOptions<'a>,
    ) -> Self {
        Self {
            repo,
            scheduler: options.scheduler,
            publisher: options.publisher,
            now: options.now,
        }
    }

    /// `publishMasterUpdated({ scope, resources: ['reminders', 'metrics'], reminderId })`.
    fn publish(&self, scope: &WorkspaceScope, reminder_id: &str) {
        use crate::master::live_events::MasterInvalidationResource::{Metrics, Reminders};
        publish_master_updated(
            self.publisher,
            &PublishMasterUpdatedInput {
                scope: scope.clone(),
                resources: vec![Reminders, Metrics],
                run_id: None,
                approval_request_id: None,
                session_id: None,
                reminder_id: Some(reminder_id.to_string()),
            },
        );
    }

    /// `create` — `reminders.ts:67-95`.
    pub fn create(
        &self,
        scope: &WorkspaceScope,
        input: &MasterReminderCreateInput,
    ) -> rusqlite::Result<MasterReminder> {
        let reminder = self.repo.create_reminder(
            scope,
            &MasterReminderInput {
                title: input.title.clone(),
                message: input.message.clone(),
                remind_at: input.remind_at.clone(),
                cron_expression: input.cron_expression.clone(),
                status: MasterReminderStatus::Pending.as_str().to_string(),
            },
        )?;
        if let Some(scheduler) = self.scheduler {
            scheduler.sync_reminder(scope, &reminder);
        }
        self.repo.append_audit_event(
            scope,
            &MasterAuditEventInput {
                category: "reminder".to_string(),
                action: "created".to_string(),
                metadata: to_metadata(&reminder.id, None),
            },
        )?;
        self.publish(scope, &reminder.id);
        Ok(reminder)
    }

    /// `list` — `reminders.ts:97-99`.
    pub fn list(&self, scope: &WorkspaceScope) -> rusqlite::Result<Vec<MasterReminder>> {
        self.repo.list_reminders(scope, DEFAULT_REMINDER_LIMIT)
    }

    /// `get` — `reminders.ts:101-103`.
    pub fn get(
        &self,
        scope: &WorkspaceScope,
        reminder_id: &str,
    ) -> rusqlite::Result<Option<MasterReminder>> {
        Ok(self
            .repo
            .list_reminders(scope, REMINDER_LOOKUP_LIMIT)?
            .into_iter()
            .find(|entry| entry.id == reminder_id))
    }

    /// `update` — `reminders.ts:105-137`.
    ///
    /// `Object.fromEntries(Object.entries(patch).filter(([, value]) =>
    /// value !== undefined))` is the `None`-means-absent convention of
    /// [`ReminderPatch`]; an all-`None` patch short-circuits to [`Self::get`]
    /// without touching the row, the scheduler or the audit log.
    pub fn update(
        &self,
        scope: &WorkspaceScope,
        reminder_id: &str,
        patch: &ReminderPatch,
    ) -> rusqlite::Result<Option<MasterReminder>> {
        if patch == &ReminderPatch::default() {
            return self.get(scope, reminder_id);
        }

        let Some(reminder) = self.repo.update_reminder(scope, reminder_id, patch)? else {
            return Ok(None);
        };

        if let Some(scheduler) = self.scheduler {
            scheduler.sync_reminder(scope, &reminder);
            if reminder.status == MasterReminderStatus::Paused.as_str()
                || reminder.status == MasterReminderStatus::Cancelled.as_str()
            {
                scheduler.pause_reminder(scope, &reminder.id);
            } else if reminder.status == MasterReminderStatus::Pending.as_str() {
                scheduler.resume_reminder(scope, &reminder.id);
            }
        }

        self.repo.append_audit_event(
            scope,
            &MasterAuditEventInput {
                category: "reminder".to_string(),
                action: resolve_update_action(Some(&reminder.status)).to_string(),
                metadata: to_metadata(&reminder.id, Some(patch)),
            },
        )?;
        self.publish(scope, &reminder.id);
        Ok(Some(reminder))
    }

    /// `pause` — `reminders.ts:139-141`.
    pub fn pause(
        &self,
        scope: &WorkspaceScope,
        reminder_id: &str,
    ) -> rusqlite::Result<Option<MasterReminder>> {
        self.update(
            scope,
            reminder_id,
            &ReminderPatch {
                status: Some(MasterReminderStatus::Paused.as_str().to_string()),
                ..ReminderPatch::default()
            },
        )
    }

    /// `cancel` — `reminders.ts:143-145`.
    pub fn cancel(
        &self,
        scope: &WorkspaceScope,
        reminder_id: &str,
    ) -> rusqlite::Result<Option<MasterReminder>> {
        self.update(
            scope,
            reminder_id,
            &ReminderPatch {
                status: Some(MasterReminderStatus::Cancelled.as_str().to_string()),
                ..ReminderPatch::default()
            },
        )
    }

    /// `delete` — `reminders.ts:147-163`.
    pub fn delete(&self, scope: &WorkspaceScope, reminder_id: &str) -> rusqlite::Result<bool> {
        if let Some(scheduler) = self.scheduler {
            scheduler.remove_reminder(scope, reminder_id);
        }
        let deleted = self.repo.delete_reminder(scope, reminder_id)?;
        if deleted {
            self.repo.append_audit_event(
                scope,
                &MasterAuditEventInput {
                    category: "reminder".to_string(),
                    action: "deleted".to_string(),
                    metadata: to_metadata(reminder_id, None),
                },
            )?;
            self.publish(scope, reminder_id);
        }
        Ok(deleted)
    }

    /// `fire` — `reminders.ts:165-208`.
    ///
    /// Returns `None` for an unknown reminder (the source returns `null`). A
    /// duplicate fire returns the *unchanged* reminder with `duplicate: true`
    /// and writes no audit event.
    pub fn fire(
        &self,
        scope: &WorkspaceScope,
        reminder_id: &str,
        input: &FireReminderInput,
    ) -> rusqlite::Result<Option<FireReminderResult>> {
        let Some(reminder) = self.get(scope, reminder_id)? else {
            return Ok(None);
        };

        let fired_at = input
            .fired_at
            .clone()
            .unwrap_or_else(|| (self.now)().to_rfc3339_opts(chrono::SecondsFormat::Millis, true));
        if self.is_duplicate_fire(scope, &reminder, &fired_at)? {
            return Ok(Some(FireReminderResult {
                reminder,
                fired_at,
                duplicate: true,
            }));
        }

        let updated = self
            .repo
            .update_reminder(
                scope,
                &reminder.id,
                &ReminderPatch {
                    status: Some(MasterReminderStatus::Fired.as_str().to_string()),
                    ..ReminderPatch::default()
                },
            )?
            .unwrap_or(reminder);
        if let Some(scheduler) = self.scheduler {
            scheduler.sync_reminder(scope, &updated);
        }
        self.repo.append_audit_event(
            scope,
            &MasterAuditEventInput {
                category: "reminder".to_string(),
                action: "fired".to_string(),
                metadata: to_fired_metadata(
                    &updated.id,
                    &fired_at,
                    input.source.as_deref().unwrap_or("manual"),
                    input.summary.as_deref(),
                    input.automation_rule_id.as_deref(),
                ),
            },
        )?;
        self.publish(scope, &updated.id);

        Ok(Some(FireReminderResult {
            reminder: updated,
            fired_at,
            duplicate: false,
        }))
    }

    /// `isDuplicateFire` — `reminders.ts:217-233`.
    ///
    /// A one-shot reminder that already fired is always a duplicate; a recurring
    /// one is only a duplicate of the same `firedAt` recorded in the audit log.
    fn is_duplicate_fire(
        &self,
        scope: &WorkspaceScope,
        reminder: &MasterReminder,
        fired_at: &str,
    ) -> rusqlite::Result<bool> {
        if reminder.cron_expression.is_none()
            && reminder.status == MasterReminderStatus::Fired.as_str()
        {
            return Ok(true);
        }

        Ok(self
            .repo
            .list_audit_events(scope, REMINDER_AUDIT_LIMIT)?
            .into_iter()
            .any(|entry| {
                if entry.category != "reminder" || entry.action != "fired" {
                    return false;
                }
                from_metadata(&entry.metadata).is_some_and(|(id, at)| {
                    id.as_deref() == Some(reminder.id.as_str()) && at.as_deref() == Some(fired_at)
                })
            }))
    }
}

#[cfg(test)]
mod tests {
    use std::sync::Mutex;

    use super::*;
    use crate::master::live_events::{MasterInvalidationResource, MasterUpdatedEvent};
    use crate::master::repository::sqlite_master_repository::SqliteMasterRepository;

    fn scope() -> WorkspaceScope {
        WorkspaceScope {
            user_id: "u1".to_string(),
            workspace_id: "w1".to_string(),
        }
    }

    fn fixed_clock() -> DateTime<Utc> {
        DateTime::parse_from_rfc3339("2026-03-04T05:06:07.123Z")
            .unwrap()
            .with_timezone(&Utc)
    }

    #[derive(Default)]
    struct RecordingScheduler {
        calls: Mutex<Vec<String>>,
    }

    impl RecordingScheduler {
        fn calls(&self) -> Vec<String> {
            self.calls.lock().unwrap().clone()
        }
    }

    impl ReminderSchedulerBridge for RecordingScheduler {
        fn sync_reminder(&self, _scope: &WorkspaceScope, reminder: &MasterReminder) {
            self.calls
                .lock()
                .unwrap()
                .push(format!("sync:{}", reminder.id));
        }
        fn pause_reminder(&self, _scope: &WorkspaceScope, reminder_id: &str) {
            self.calls
                .lock()
                .unwrap()
                .push(format!("pause:{reminder_id}"));
        }
        fn resume_reminder(&self, _scope: &WorkspaceScope, reminder_id: &str) {
            self.calls
                .lock()
                .unwrap()
                .push(format!("resume:{reminder_id}"));
        }
        fn remove_reminder(&self, _scope: &WorkspaceScope, reminder_id: &str) {
            self.calls
                .lock()
                .unwrap()
                .push(format!("remove:{reminder_id}"));
        }
    }

    #[derive(Default)]
    struct RecordingPublisher {
        events: Mutex<Vec<MasterUpdatedEvent>>,
    }

    impl MasterEventPublisher for RecordingPublisher {
        fn publish_master_updated(&self, event: &MasterUpdatedEvent) {
            self.events.lock().unwrap().push(event.clone());
        }
    }

    fn input() -> MasterReminderCreateInput {
        MasterReminderCreateInput {
            title: "R".to_string(),
            message: "M".to_string(),
            remind_at: "2026-03-04T06:00:00.000Z".to_string(),
            cron_expression: None,
        }
    }

    /// One service with a recording publisher, plus the publisher itself.
    fn setup<'a>(
        repo: &'a SqliteMasterRepository,
        publisher: &'a RecordingPublisher,
        scheduler: Option<&'a RecordingScheduler>,
    ) -> MasterRemindersService<'a> {
        MasterRemindersService::with_options(
            repo,
            MasterRemindersServiceOptions {
                scheduler: scheduler.map(|value| value as &dyn ReminderSchedulerBridge),
                publisher,
                now: || fixed_clock(),
            },
        )
    }

    /// One audit entry by action.
    ///
    /// `listAuditEvents` orders by `created_at DESC`, and a test writes all of
    /// its rows inside the same millisecond, so the order of equal timestamps is
    /// not part of the contract — selecting by action is the stable way to read
    /// a specific entry.
    fn audit_action(
        repo: &SqliteMasterRepository,
        scope: &WorkspaceScope,
        action: &str,
    ) -> crate::master::types::MasterAuditEvent {
        repo.list_audit_events(scope, 100)
            .unwrap()
            .into_iter()
            .find(|entry| entry.action == action)
            .unwrap_or_else(|| panic!("no audit entry with action {action}"))
    }

    #[test]
    fn create_writes_the_pending_reminder_an_audit_event_and_an_invalidation() {
        let repo = SqliteMasterRepository::open(":memory:").unwrap();
        let publisher = RecordingPublisher::default();
        let scheduler = RecordingScheduler::default();
        let service = setup(&repo, &publisher, Some(&scheduler));
        let scope = scope();

        let reminder = service.create(&scope, &input()).unwrap();
        assert_eq!(reminder.status, MasterReminderStatus::Pending.as_str());
        assert_eq!(scheduler.calls(), vec![format!("sync:{}", reminder.id)]);

        let audit = repo.list_audit_events(&scope, 100).unwrap();
        assert_eq!(audit.len(), 1);
        assert_eq!(audit[0].category, "reminder");
        assert_eq!(audit[0].action, "created");
        assert_eq!(
            audit[0].metadata,
            format!("{{\"reminderId\":\"{}\"}}", reminder.id)
        );

        let events = publisher.events.lock().unwrap().clone();
        assert_eq!(events.len(), 1);
        assert_eq!(
            events[0].resources,
            vec![
                MasterInvalidationResource::Reminders,
                MasterInvalidationResource::Metrics
            ]
        );
        assert_eq!(events[0].reminder_id, Some(reminder.id));
    }

    #[test]
    fn the_default_publisher_and_clock_are_usable_without_options() {
        let repo = SqliteMasterRepository::open(":memory:").unwrap();
        let service = MasterRemindersService::new(&repo);
        let scope = scope();
        let reminder = service.create(&scope, &input()).unwrap();

        // `now` defaults to `Utc::now`: the fired stamp is "now", not fixed.
        let fired = service
            .fire(&scope, &reminder.id, &FireReminderInput::default())
            .unwrap();
        let fired = fired.unwrap();
        assert!(!fired.duplicate);
        assert!(fired.fired_at.len() == "2026-01-01T00:00:00.000Z".len());
        assert!(fired.fired_at.ends_with('Z'));
    }

    #[test]
    fn a_missing_reminder_yields_nothing() {
        let repo = SqliteMasterRepository::open(":memory:").unwrap();
        let publisher = RecordingPublisher::default();
        let service = setup(&repo, &publisher, None);
        let scope = scope();

        assert!(service.get(&scope, "missing").unwrap().is_none());
        assert!(service
            .fire(&scope, "missing", &FireReminderInput::default())
            .unwrap()
            .is_none());
        assert!(service
            .update(
                &scope,
                "missing",
                &ReminderPatch {
                    title: Some("X".to_string()),
                    ..ReminderPatch::default()
                }
            )
            .unwrap()
            .is_none());
        assert!(!service.delete(&scope, "missing").unwrap());
        assert!(publisher.events.lock().unwrap().is_empty());
    }

    #[test]
    fn an_all_absent_patch_short_circuits_to_get() {
        let repo = SqliteMasterRepository::open(":memory:").unwrap();
        let publisher = RecordingPublisher::default();
        let service = setup(&repo, &publisher, None);
        let scope = scope();
        let reminder = service.create(&scope, &input()).unwrap();

        let unchanged = service
            .update(&scope, &reminder.id, &ReminderPatch::default())
            .unwrap()
            .unwrap();
        assert_eq!(unchanged.title, "R");
        // No second audit entry and no second invalidation.
        assert_eq!(repo.list_audit_events(&scope, 100).unwrap().len(), 1);
        assert_eq!(publisher.events.lock().unwrap().len(), 1);
    }

    #[test]
    fn pausing_syncs_pauses_and_audits_the_action() {
        let repo = SqliteMasterRepository::open(":memory:").unwrap();
        let publisher = RecordingPublisher::default();
        let scheduler = RecordingScheduler::default();
        let service = setup(&repo, &publisher, Some(&scheduler));
        let scope = scope();
        let reminder = service.create(&scope, &input()).unwrap();

        let paused = service.pause(&scope, &reminder.id).unwrap().unwrap();
        assert_eq!(paused.status, MasterReminderStatus::Paused.as_str());
        assert_eq!(
            scheduler.calls(),
            vec![
                format!("sync:{}", reminder.id),
                format!("sync:{}", reminder.id),
                format!("pause:{}", reminder.id),
            ]
        );
        let paused_entry = audit_action(&repo, &scope, "paused");
        assert_eq!(
            paused_entry.metadata,
            format!(
                "{{\"reminderId\":\"{}\",\"patch\":{{\"status\":\"paused\"}}}}",
                reminder.id
            )
        );
    }

    #[test]
    fn resuming_from_paused_audits_resumed_and_cancelling_audits_cancelled() {
        let repo = SqliteMasterRepository::open(":memory:").unwrap();
        let publisher = RecordingPublisher::default();
        let scheduler = RecordingScheduler::default();
        let service = setup(&repo, &publisher, Some(&scheduler));
        let scope = scope();
        let reminder = service.create(&scope, &input()).unwrap();

        service.pause(&scope, &reminder.id).unwrap().unwrap();
        let resumed = service
            .update(
                &scope,
                &reminder.id,
                &ReminderPatch {
                    status: Some(MasterReminderStatus::Pending.as_str().to_string()),
                    ..ReminderPatch::default()
                },
            )
            .unwrap()
            .unwrap();
        assert_eq!(resumed.status, MasterReminderStatus::Pending.as_str());
        assert_eq!(
            scheduler.calls().last().unwrap(),
            &format!("resume:{}", reminder.id)
        );

        service.cancel(&scope, &reminder.id).unwrap().unwrap();
        let mut actions: Vec<String> = repo
            .list_audit_events(&scope, 100)
            .unwrap()
            .into_iter()
            .map(|entry| entry.action)
            .collect();
        actions.sort();
        assert_eq!(actions, vec!["cancelled", "created", "paused", "resumed"]);
    }

    #[test]
    fn delete_reports_the_audit_event_and_the_invalidation_only_when_it_deleted() {
        let repo = SqliteMasterRepository::open(":memory:").unwrap();
        let publisher = RecordingPublisher::default();
        let scheduler = RecordingScheduler::default();
        let service = setup(&repo, &publisher, Some(&scheduler));
        let scope = scope();
        let reminder = service.create(&scope, &input()).unwrap();

        assert!(service.delete(&scope, &reminder.id).unwrap());
        assert_eq!(
            scheduler.calls().last().unwrap(),
            &format!("remove:{}", reminder.id)
        );
        let deleted_entry = audit_action(&repo, &scope, "deleted");
        assert_eq!(
            deleted_entry.metadata,
            format!("{{\"reminderId\":\"{}\"}}", reminder.id)
        );
        assert_eq!(publisher.events.lock().unwrap().len(), 2);

        // The second delete removes nothing, so nothing is published.
        assert!(!service.delete(&scope, &reminder.id).unwrap());
        assert_eq!(publisher.events.lock().unwrap().len(), 2);
        assert_eq!(repo.list_audit_events(&scope, 100).unwrap().len(), 2);
    }

    #[test]
    fn fire_stamps_the_clock_and_records_the_source() {
        let repo = SqliteMasterRepository::open(":memory:").unwrap();
        let publisher = RecordingPublisher::default();
        let service = setup(&repo, &publisher, None);
        let scope = scope();
        let reminder = service.create(&scope, &input()).unwrap();

        let fired = service
            .fire(&scope, &reminder.id, &FireReminderInput::default())
            .unwrap()
            .unwrap();
        assert!(!fired.duplicate);
        assert_eq!(fired.fired_at, "2026-03-04T05:06:07.123Z");
        assert_eq!(fired.reminder.status, MasterReminderStatus::Fired.as_str());

        let fired_entry = audit_action(&repo, &scope, "fired");
        assert_eq!(
            fired_entry.metadata,
            format!(
                "{{\"reminderId\":\"{}\",\"firedAt\":\"2026-03-04T05:06:07.123Z\",\"source\":\"manual\",\"summary\":null,\"automationRuleId\":null}}",
                reminder.id
            )
        );
    }

    #[test]
    fn an_explicit_fired_at_wins_and_a_one_shot_reminder_never_fires_twice() {
        let repo = SqliteMasterRepository::open(":memory:").unwrap();
        let publisher = RecordingPublisher::default();
        let service = setup(&repo, &publisher, None);
        let scope = scope();
        let reminder = service.create(&scope, &input()).unwrap();

        let fire_input = FireReminderInput {
            fired_at: Some("2026-03-04T07:00:00.000Z".to_string()),
            source: Some("cron".to_string()),
            summary: Some("note".to_string()),
            automation_rule_id: Some("rule-1".to_string()),
        };
        let first = service
            .fire(&scope, &reminder.id, &fire_input)
            .unwrap()
            .unwrap();
        assert_eq!(first.fired_at, "2026-03-04T07:00:00.000Z");

        let fired_entry = audit_action(&repo, &scope, "fired");
        assert_eq!(
            fired_entry.metadata,
            format!(
                "{{\"reminderId\":\"{}\",\"firedAt\":\"2026-03-04T07:00:00.000Z\",\"source\":\"cron\",\"summary\":\"note\",\"automationRuleId\":\"rule-1\"}}",
                reminder.id
            )
        );

        // Without a cron expression the fired reminder is a permanent duplicate.
        let second = service
            .fire(&scope, &reminder.id, &fire_input)
            .unwrap()
            .unwrap();
        assert!(second.duplicate);
        assert_eq!(second.reminder.status, MasterReminderStatus::Fired.as_str());
        assert_eq!(second.fired_at, "2026-03-04T07:00:00.000Z");
        // Still two entries: the duplicate wrote no audit event.
        assert_eq!(repo.list_audit_events(&scope, 100).unwrap().len(), 2);
    }

    #[test]
    fn a_recurring_reminder_only_duplicates_the_same_fired_at() {
        let repo = SqliteMasterRepository::open(":memory:").unwrap();
        let publisher = RecordingPublisher::default();
        let service = setup(&repo, &publisher, None);
        let scope = scope();
        let reminder = service
            .create(
                &scope,
                &MasterReminderCreateInput {
                    cron_expression: Some("0 3 * * *".to_string()),
                    ..input()
                },
            )
            .unwrap();

        let at = |fired_at: &str| FireReminderInput {
            fired_at: Some(fired_at.to_string()),
            ..FireReminderInput::default()
        };
        assert!(
            !service
                .fire(&scope, &reminder.id, &at("2026-03-04T07:00:00.000Z"))
                .unwrap()
                .unwrap()
                .duplicate
        );
        assert!(
            service
                .fire(&scope, &reminder.id, &at("2026-03-04T07:00:00.000Z"))
                .unwrap()
                .unwrap()
                .duplicate
        );
        // A new instant is a new fire, even though the reminder already fired.
        assert!(
            !service
                .fire(&scope, &reminder.id, &at("2026-03-05T07:00:00.000Z"))
                .unwrap()
                .unwrap()
                .duplicate
        );
    }

    #[test]
    fn from_metadata_swallows_invalid_payloads() {
        assert_eq!(from_metadata("not json"), None);
        assert_eq!(from_metadata("\"text\""), None);
        assert_eq!(from_metadata("5"), None);
        assert_eq!(
            from_metadata("{\"reminderId\":\"r1\"}"),
            Some((Some("r1".to_string()), None))
        );
        assert_eq!(from_metadata("{}"), Some((None, None)));
    }
}
