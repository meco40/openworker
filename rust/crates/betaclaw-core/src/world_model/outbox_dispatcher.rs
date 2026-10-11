//! Port of `src/server/world-model/outboxDispatcher.ts:1-113`.

use std::collections::{HashMap, HashSet};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

use futures_util::future::join_all;

use crate::world_model::db::{BoxFuture, PgError, PgExecutor};
use crate::world_model::repositories::outbox_repository::{
    claim_pending_outbox_events, mark_outbox_dispatched, mark_outbox_failed,
};
use crate::world_model::scope::WorldModelScope;
use crate::world_model::types::OutboxEvent;

pub type OutboxHandler =
    Arc<dyn Fn(OutboxEvent) -> BoxFuture<'static, Result<(), String>> + Send + Sync>;

pub struct OutboxDispatcher {
    executor: Arc<dyn PgExecutor>,
    worker_id: String,
    batch_size: i64,
    handlers: Mutex<HashMap<String, Vec<OutboxHandler>>>,
    handler_keys: Mutex<HashMap<String, HashSet<String>>>,
    dispatch_in_flight: AtomicBool,
}

impl OutboxDispatcher {
    pub fn new(executor: Arc<dyn PgExecutor>, batch_size: i64) -> Self {
        let suffix = uuid::Uuid::new_v4().simple().to_string();
        Self {
            executor,
            worker_id: format!("world-model-{}-{}", std::process::id(), &suffix[..8]),
            batch_size,
            handlers: Mutex::new(HashMap::new()),
            handler_keys: Mutex::new(HashMap::new()),
            dispatch_in_flight: AtomicBool::new(false),
        }
    }

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
            if let Some(error) =
                join_all(handlers.into_iter().map(|handler| handler(event.clone())))
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

    #[test]
    fn dispatch_runs_one_deduplicated_handler_then_marks_event() {
        let recorder = Arc::new(RecordingExecutor::new(vec![
            Ok(PgQueryResult::from_rows(vec![event_row()])),
            Ok(PgQueryResult::affected(1)),
        ]));
        let dispatcher = OutboxDispatcher::new(Arc::clone(&recorder) as Arc<dyn PgExecutor>, 20);
        let calls = Arc::new(AtomicBool::new(false));
        let called = Arc::clone(&calls);
        dispatcher.register_handler(
            "world.test",
            Arc::new(move |event| {
                let called = Arc::clone(&called);
                Box::pin(async move {
                    called.store(event.id == "out-1", Ordering::SeqCst);
                    Ok(())
                })
            }),
            Some("test-handler"),
        );
        dispatcher.register_handler(
            "world.test",
            Arc::new(|_| Box::pin(async { Ok(()) })),
            Some("test-handler"),
        );

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
        let dispatcher = OutboxDispatcher::new(Arc::clone(&recorder) as Arc<dyn PgExecutor>, 20);

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
}
