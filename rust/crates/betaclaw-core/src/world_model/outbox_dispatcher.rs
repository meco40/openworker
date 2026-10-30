//! Port of `src/server/world-model/outboxDispatcher.ts:1-186`.
//!
//! | TypeScript | Rust |
//! | --- | --- |
//! | `OutboxHandler` (`:27`) | [`OutboxHandler`] |
//! | `registerOutboxHandler` (`:34-48`) | [`OutboxDispatcher::register_handler`] |
//! | `hasHandlers` (`:50-52`) | [`OutboxDispatcher::has_handlers`] |
//! | `dispatchOutboxOnce` (`:54-85`) | [`OutboxDispatcher::dispatch_once`] with `scope: None` |
//! | `dispatchOutboxOnceInScope` (`:87-93`) | [`OutboxDispatcher::dispatch_once`] with `scope: Some` |
//! | `dispatchKnownScopes` (`:95-102`) | [`OutboxDispatcher::dispatch_known_scopes`] |
//! | `startOutboxDispatcher` (`:106-178`) | [`OutboxDispatcher::start`] |
//! | `:112-131` and `:132-146` registrations | [`OutboxDispatcher::register_default_handlers`] |
//! | `:147-167` mission-control registrations | [`MissionControlProjection`], [`mission_control_handler`] |
//! | `stopOutboxDispatcher` (`:180-186`) | [`OutboxDispatcher::stop`] |
//!
//! # Deviations
//!
//! 1. **Module state is instance state.** `handlers`, `handlerKeys`,
//!    `dispatchInFlight` and `dispatcherTimer` (`:29-32`, `:104`) belong to one
//!    [`OutboxDispatcher`]. The `workerId` (`:31`) is per instance as well.
//! 2. **The ambient scope is an argument.** `runWithWorldModelScope` (`:92`) becomes
//!    the `scope` parameter of [`OutboxHandler`]. A handler therefore runs under the
//!    scope of the batch it belongs to, as the source's handlers do.
//! 3. **Cross-slice handlers are ports.** The proactive handlers (`:133-146`) need
//!    the message repository and the outbound adapter, and the Graphiti projector
//!    (`:121-128`) needs a Graphiti client. They are passed in as
//!    [`OutboxHandlerPorts`]. The shadow handler (`:113-117`) and the three
//!    mission-control projections (`:147-167`) need only the executor and are built
//!    here.
//! 4. **`stop` ends the timer only.** `closeWorldModelDb()` (`:185`) is not called:
//!    the pool is owned by [`driver`](crate::world_model::driver), and the caller
//!    closes it.
//! 5. **The second guard of `:168` is not repeated.** It tests the same condition
//!    as `:110`, which already returned, so it cannot change the outcome.
//! 6. **Migrations take the caller's settings.** `:111` runs
//!    `runWorldModelMigrations()` outside production. [`OutboxDispatcher::start`]
//!    runs [`run_world_model_migrations`] with the same condition.

use std::collections::{HashMap, HashSet};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use futures_util::future::join_all;
use tokio::task::JoinHandle;

use crate::world_model::config::{RuntimeRole, WorldModelConfig};
use crate::world_model::db::{BoxFuture, PgError, PgExecutor};
use crate::world_model::graphiti::shadow::create_graphiti_shadow_handler;
use crate::world_model::migrations::{run_world_model_migrations, MigrationSettings};
use crate::world_model::repositories::outbox_repository::{
    claim_pending_outbox_events, mark_outbox_dispatched, mark_outbox_failed,
};
use crate::world_model::runtime::scope_discovery::list_runtime_world_model_scopes;
use crate::world_model::scope::WorldModelScope;
use crate::world_model::services::mission_control_bridge::{
    project_mission_control_task_created, project_mission_control_task_deleted,
    project_mission_control_task_status_changed,
};
use crate::world_model::types::OutboxEvent;

/// `OutboxHandler` of `:27`. The second argument is the scope the batch runs under
/// (`runWithWorldModelScope`, `:92`); `None` is the unscoped `dispatchOutboxOnce()`.
pub type OutboxHandler = Arc<
    dyn Fn(OutboxEvent, Option<WorldModelScope>) -> BoxFuture<'static, Result<(), String>>
        + Send
        + Sync,
>;

/// The handlers `startOutboxDispatcher` takes from other slices (deviation 3).
pub struct OutboxHandlerPorts {
    /// `createGraphitiProjectorHandler()` (`projector.ts:311`), built over the client port.
    pub graphiti_projector: OutboxHandler,
    /// `createProactiveQuestionHandler()` (`proactiveChannelDelivery.ts:195`).
    pub proactive_question: OutboxHandler,
    /// `createProactiveIntentFiredHandler()` (`proactiveChannelDelivery.ts:245`).
    pub proactive_intent_fired: OutboxHandler,
}

/// The event types of the Graphiti projector registration (`:121-128`).
pub const GRAPHITI_PROJECTED_EVENT_TYPES: [&str; 6] = [
    "world.observation.created",
    "world.assertion.created",
    "world.event.created",
    "world.relation.created",
    "world.task.created",
    "world.task.status_changed",
];

/// The mission-control projections registered by `:147-167`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MissionControlProjection {
    Created,
    StatusChanged,
    Deleted,
}

impl MissionControlProjection {
    /// The event type and the registration key of `:147-167`.
    fn registration(self) -> (&'static str, &'static str) {
        match self {
            Self::Created => ("world.task.created", "world-model:task-created"),
            Self::StatusChanged => ("world.task.status_changed", "world-model:task-status"),
            Self::Deleted => ("world.task.deleted", "world-model:task-deleted"),
        }
    }
}

/// `projectMissionControlTask*` (`missionControlBridge.ts:310-376`) as an outbox handler.
pub fn mission_control_handler(
    executor: Arc<dyn PgExecutor>,
    projection: MissionControlProjection,
) -> OutboxHandler {
    Arc::new(move |event: OutboxEvent, scope: Option<WorldModelScope>| {
        let executor = Arc::clone(&executor);
        Box::pin(async move {
            let result = match projection {
                MissionControlProjection::Created => {
                    project_mission_control_task_created(executor.as_ref(), scope.as_ref(), &event)
                        .await
                }
                MissionControlProjection::StatusChanged => {
                    project_mission_control_task_status_changed(
                        executor.as_ref(),
                        scope.as_ref(),
                        &event,
                    )
                    .await
                }
                MissionControlProjection::Deleted => {
                    project_mission_control_task_deleted(executor.as_ref(), scope.as_ref(), &event)
                        .await
                }
            };
            result.map_err(|error| error.message)
        })
    })
}

pub struct OutboxDispatcher {
    executor: Arc<dyn PgExecutor>,
    worker_id: String,
    batch_size: i64,
    env: HashMap<String, String>,
    runtime_role: RuntimeRole,
    handlers: Mutex<HashMap<String, Vec<OutboxHandler>>>,
    handler_keys: Mutex<HashMap<String, HashSet<String>>>,
    dispatch_in_flight: AtomicBool,
    timer: Mutex<Option<JoinHandle<()>>>,
}

impl OutboxDispatcher {
    /// `env` and `runtime_role` feed the scope discovery of `:95-96`.
    pub fn new(
        executor: Arc<dyn PgExecutor>,
        batch_size: i64,
        env: HashMap<String, String>,
        runtime_role: RuntimeRole,
    ) -> Self {
        let suffix = uuid::Uuid::new_v4().simple().to_string();
        Self {
            executor,
            worker_id: format!("world-model-{}-{}", std::process::id(), &suffix[..8]),
            batch_size,
            env,
            runtime_role,
            handlers: Mutex::new(HashMap::new()),
            handler_keys: Mutex::new(HashMap::new()),
            dispatch_in_flight: AtomicBool::new(false),
            timer: Mutex::new(None),
        }
    }

    /// `registerOutboxHandler(eventType, handler, key)` — `outboxDispatcher.ts:34-48`.
    pub fn register_handler(&self, event_type: &str, handler: OutboxHandler, key: Option<&str>) {
        if let Some(key) = key {
            let mut keys = self.handler_keys.lock().expect("handler key mutex");
            if !keys
                .entry(event_type.to_string())
                .or_default()
                .insert(key.to_string())
            {
                return;
            }
        }
        self.handlers
            .lock()
            .expect("handler mutex")
            .entry(event_type.to_string())
            .or_default()
            .push(handler);
    }

    /// `hasHandlers(eventType)` — `outboxDispatcher.ts:50-52`.
    pub fn has_handlers(&self, event_type: &str) -> bool {
        self.handlers
            .lock()
            .expect("handler mutex")
            .get(event_type)
            .is_some_and(|list| !list.is_empty())
    }

    /// `dispatchOutboxOnce(batchSize)` and `dispatchOutboxOnceInScope(scope, batchSize)`
    /// — `outboxDispatcher.ts:54-93`. A dispatch that is already in flight returns `0`.
    pub async fn dispatch_once(
        &self,
        scope: Option<&WorldModelScope>,
        batch_size: Option<i64>,
    ) -> Result<i64, PgError> {
        if self.dispatch_in_flight.swap(true, Ordering::AcqRel) {
            return Ok(0);
        }
        let result = self
            .dispatch_claimed(scope, batch_size.unwrap_or(self.batch_size))
            .await;
        self.dispatch_in_flight.store(false, Ordering::Release);
        result
    }

    async fn dispatch_claimed(
        &self,
        scope: Option<&WorldModelScope>,
        batch_size: i64,
    ) -> Result<i64, PgError> {
        let pending = claim_pending_outbox_events::<PgError>(
            self.executor.as_ref(),
            scope,
            batch_size,
            &self.worker_id,
            None,
            None,
        )
        .await?;
        let mut handled = 0;
        for event in pending {
            let handlers = self
                .handlers
                .lock()
                .expect("handler mutex")
                .get(&event.input.event_type)
                .cloned()
                .unwrap_or_default();
            if handlers.is_empty() {
                let message = format!(
                    "[world-model:outbox] no handler registered for {}",
                    event.input.event_type
                );
                mark_outbox_failed::<PgError>(
                    self.executor.as_ref(),
                    scope,
                    &event.id,
                    &message,
                    Some(&self.worker_id),
                )
                .await?;
                continue;
            }
            if let Some(error) = join_all(
                handlers
                    .into_iter()
                    .map(|handler| handler(event.clone(), scope.cloned())),
            )
            .await
            .into_iter()
            .find_map(Result::err)
            {
                mark_outbox_failed::<PgError>(
                    self.executor.as_ref(),
                    scope,
                    &event.id,
                    &error,
                    Some(&self.worker_id),
                )
                .await?;
            } else {
                mark_outbox_dispatched::<PgError>(
                    self.executor.as_ref(),
                    scope,
                    &event.id,
                    Some(&self.worker_id),
                )
                .await?;
                handled += 1;
            }
        }
        Ok(handled)
    }

    /// `dispatchKnownScopes(batchSize)` — `outboxDispatcher.ts:95-102`. The scopes come
    /// from [`list_runtime_world_model_scopes`], and each batch runs under its own scope.
    pub async fn dispatch_known_scopes(&self, batch_size: Option<i64>) -> Result<i64, PgError> {
        let scopes = list_runtime_world_model_scopes(
            &self.env,
            Some(self.executor.as_ref()),
            self.runtime_role,
        )
        .await;
        let mut handled = 0;
        for scope in &scopes {
            handled += self.dispatch_once(Some(scope), batch_size).await?;
        }
        Ok(handled)
    }

    /// The registrations of `startOutboxDispatcher` (`outboxDispatcher.ts:112-167`),
    /// in source order. Each proactive and mission-control registration happens only
    /// when no handler is registered for its event type yet (`:133`, `:140`, `:147`,
    /// `:154`, `:161`).
    pub fn register_default_handlers(&self, config: &WorldModelConfig, ports: &OutboxHandlerPorts) {
        if config.graphiti_shadow_enabled {
            self.register_handler(
                "world.observation.created",
                create_graphiti_shadow_handler(Arc::clone(&self.executor)),
                Some("world-model:graphiti-shadow"),
            );
        }
        if config.graphiti_backend_enabled {
            for event_type in GRAPHITI_PROJECTED_EVENT_TYPES {
                self.register_handler(
                    event_type,
                    Arc::clone(&ports.graphiti_projector),
                    Some("world-model:graphiti-projector"),
                );
            }
        }
        if !self.has_handlers("proactive.question.requested") {
            self.register_handler(
                "proactive.question.requested",
                Arc::clone(&ports.proactive_question),
                Some("world-model:proactive-question"),
            );
        }
        if !self.has_handlers("proactive.intent.fired") {
            self.register_handler(
                "proactive.intent.fired",
                Arc::clone(&ports.proactive_intent_fired),
                Some("world-model:proactive-intent"),
            );
        }
        for projection in [
            MissionControlProjection::Created,
            MissionControlProjection::StatusChanged,
            MissionControlProjection::Deleted,
        ] {
            let (event_type, key) = projection.registration();
            if !self.has_handlers(event_type) {
                self.register_handler(
                    event_type,
                    mission_control_handler(Arc::clone(&self.executor), projection),
                    Some(key),
                );
            }
        }
    }

    /// `startOutboxDispatcher()` — `outboxDispatcher.ts:106-178`.
    ///
    /// Returns `Ok(false)` when the dispatcher is already running (`:108`) or disabled
    /// (`:110`). Otherwise it runs the migrations outside production (`:111`), registers
    /// the handlers, dispatches once and then on every `outbox_poll_interval_ms`. A
    /// failing initial dispatch is logged and does not stop the timer (`:169-171`).
    pub async fn start(
        self: Arc<Self>,
        config: &WorldModelConfig,
        ports: &OutboxHandlerPorts,
        migrations: &MigrationSettings,
    ) -> Result<bool, PgError> {
        if self.timer.lock().expect("timer mutex").is_some() {
            return Ok(false);
        }
        let production = self.env.get("NODE_ENV").map(String::as_str) == Some("production");
        let e2e_allowed = config.e2e_enabled && !production;
        if !config.enabled && !e2e_allowed {
            return Ok(false);
        }
        if !production {
            run_world_model_migrations(self.executor.as_ref(), migrations).await?;
        }
        self.register_default_handlers(config, ports);
        if let Err(error) = self.dispatch_known_scopes(None).await {
            tracing::error!(
                target: "world_model::outbox",
                "[world-model:outbox] initial dispatch failed: {}",
                error.message
            );
        }

        let interval = Duration::from_millis(config.outbox_poll_interval_ms.max(1) as u64);
        let dispatcher = Arc::clone(&self);
        let task = tokio::spawn(async move {
            let mut ticker = tokio::time::interval(interval);
            // The first tick of `tokio::time::interval` is immediate; `setInterval` (`:172`)
            // first fires after one period.
            ticker.tick().await;
            loop {
                ticker.tick().await;
                if let Err(error) = dispatcher.dispatch_known_scopes(None).await {
                    tracing::error!(
                        target: "world_model::outbox",
                        "[world-model:outbox] dispatch tick failed: {}",
                        error.message
                    );
                }
            }
        });
        *self.timer.lock().expect("timer mutex") = Some(task);
        Ok(true)
    }

    /// `stopOutboxDispatcher()` — `outboxDispatcher.ts:180-186` without the pool close
    /// (deviation 4). A later [`start`](Self::start) may start the timer again.
    pub fn stop(&self) {
        if let Some(task) = self.timer.lock().expect("timer mutex").take() {
            task.abort();
        }
    }

    pub fn worker_id(&self) -> &str {
        &self.worker_id
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::world_model::db::drive_sync;
    use crate::world_model::db::testing::{Recorded, RecordingExecutor};
    use crate::world_model::db::{PgQueryResult, PgRow};
    use serde_json::json;

    fn event_row() -> PgRow {
        json!({
            "id":"out-1", "event_type":"world.test", "aggregate_type":"test", "aggregate_id":"a1",
            "payload":{"value":1}, "status":"pending", "attempts":0, "error_message":null,
            "created_at":"2026-10-11T10:00:00.000Z", "dispatched_at":null
        })
        .as_object()
        .unwrap()
        .clone()
    }

    fn sqls(executor: &RecordingExecutor) -> Vec<String> {
        executor
            .calls()
            .iter()
            .filter_map(|call| match call {
                Recorded::Statement(statement) => Some(statement.sql.clone()),
                Recorded::Release => None,
            })
            .collect()
    }

    fn dispatcher(recorder: &Arc<RecordingExecutor>) -> OutboxDispatcher {
        OutboxDispatcher::new(
            Arc::clone(recorder) as Arc<dyn PgExecutor>,
            20,
            HashMap::new(),
            RuntimeRole::App,
        )
    }

    fn noop_handler() -> OutboxHandler {
        Arc::new(|_, _| Box::pin(async { Ok(()) }))
    }

    #[test]
    fn dispatch_runs_one_deduplicated_handler_then_marks_event() {
        let recorder = Arc::new(RecordingExecutor::new(vec![
            Ok(PgQueryResult::from_rows(vec![event_row()])),
            Ok(PgQueryResult::affected(1)),
        ]));
        let dispatcher = dispatcher(&recorder);
        let calls = Arc::new(AtomicBool::new(false));
        let called = Arc::clone(&calls);
        dispatcher.register_handler(
            "world.test",
            Arc::new(move |event, _scope| {
                let called = Arc::clone(&called);
                Box::pin(async move {
                    called.store(event.id == "out-1", Ordering::SeqCst);
                    Ok(())
                })
            }),
            Some("test-handler"),
        );
        dispatcher.register_handler("world.test", noop_handler(), Some("test-handler"));

        assert_eq!(
            drive_sync(dispatcher.dispatch_once(None, None))
                .unwrap()
                .unwrap(),
            1
        );
        assert!(calls.load(Ordering::SeqCst));
        assert_eq!(
            sqls(&recorder),
            [
                crate::world_model::repositories::outbox_repository::SQL_CLAIM_OUTBOX,
                crate::world_model::repositories::outbox_repository::SQL_MARK_DISPATCHED,
            ]
        );
    }

    #[test]
    fn missing_handler_is_recorded_as_a_failure() {
        let recorder = Arc::new(RecordingExecutor::new(vec![
            Ok(PgQueryResult::from_rows(vec![event_row()])),
            Ok(PgQueryResult::affected(1)),
        ]));
        let dispatcher = dispatcher(&recorder);

        assert_eq!(
            drive_sync(dispatcher.dispatch_once(None, None))
                .unwrap()
                .unwrap(),
            0
        );
        assert_eq!(
            sqls(&recorder)[1],
            crate::world_model::repositories::outbox_repository::SQL_MARK_OUTBOX_FAILED
        );
    }

    #[test]
    fn a_handler_is_registered_once_per_key_and_has_handlers_reports_it() {
        let recorder = Arc::new(RecordingExecutor::new(vec![]));
        let dispatcher = dispatcher(&recorder);
        assert!(!dispatcher.has_handlers("world.test"));
        dispatcher.register_handler("world.test", noop_handler(), Some("same"));
        dispatcher.register_handler("world.test", noop_handler(), Some("same"));
        assert!(dispatcher.has_handlers("world.test"));
        assert_eq!(
            dispatcher
                .handlers
                .lock()
                .unwrap()
                .get("world.test")
                .map(Vec::len),
            Some(1)
        );
    }

    #[test]
    fn start_is_a_no_op_while_the_dispatcher_is_disabled() {
        let recorder = Arc::new(RecordingExecutor::new(vec![]));
        let dispatcher = Arc::new(dispatcher(&recorder));
        let ports = OutboxHandlerPorts {
            graphiti_projector: noop_handler(),
            proactive_question: noop_handler(),
            proactive_intent_fired: noop_handler(),
        };
        let migrations = MigrationSettings {
            admin_database_url: None,
            migrations_dir: String::new(),
        };
        let started = drive_sync(Arc::clone(&dispatcher).start(
            &WorldModelConfig::default(),
            &ports,
            &migrations,
        ))
        .expect("bridge")
        .expect("start");
        assert!(!started);
        assert!(recorder.calls().is_empty());
        assert!(!dispatcher.has_handlers("proactive.question.requested"));
    }
}
