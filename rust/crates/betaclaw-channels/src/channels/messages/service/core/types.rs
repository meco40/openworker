//! Port of `src/server/channels/messages/service/core/types.ts` (`ServiceState`).
//!
//! The TypeScript `Map`s and `Set`s are shared mutable state. They become `Mutex`es,
//! and no lock is held across an `.await`, so the single-threaded ordering of the
//! TypeScript event loop is kept at each step. `ServiceComponents` and
//! `ToolExecutionResult` in `core/types.ts` are declarations only and have no port.

use std::collections::{HashMap, HashSet};
use std::sync::{Mutex, MutexGuard};

use crate::channels::messages::service::core::project_management::PendingProjectClarification;
use crate::model_hub::http::AbortSignal;

/// `ServiceState` (`core/types.ts:21-33`).
#[derive(Debug, Default)]
pub struct ServiceState {
    /// `activeRequests`: one abort signal per conversation.
    pub active_requests: Mutex<HashMap<String, AbortSignal>>,
    /// `processingMessages`: client message ids in flight.
    pub processing_messages: Mutex<HashSet<String>>,
    /// `pendingProjectClarifications`, keyed by `getProjectClarificationKey`.
    pub pending_project_clarifications: Mutex<HashMap<String, PendingProjectClarification>>,
}

impl ServiceState {
    pub fn new() -> Self {
        Self::default()
    }
}

/// Locks a state map. A poisoned lock still yields its data: a panicking request
/// must not stop later requests, which the TypeScript process would not do either.
pub fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}
