//! Port of `src/server/channels/messages/service/recall/state/clear.ts`
//! (`RecallStateManager`).
//!
//! The TypeScript version keeps both maps in the Node process. The port keeps
//! them in the process that runs this struct, behind short `Mutex` sections
//! that never span an `.await`.

use std::collections::HashMap;
use std::sync::{Mutex, MutexGuard};

use super::super::constants::MEM0_EMPTY_SCOPE_TTL_MS;
use super::super::utils::now_ms;
use crate::channels::messages::service::types::LastRecallState;

/// Conversation recall state and the temporarily-empty Mem0 scope cache.
#[derive(Debug, Default)]
pub struct RecallStateManager {
    last_recall_by_conversation: Mutex<HashMap<String, LastRecallState>>,
    /// Scope key to expiry in epoch milliseconds.
    empty_mem0_scope_cache: Mutex<HashMap<String, i64>>,
}

impl RecallStateManager {
    pub fn new() -> Self {
        Self::default()
    }

    /// `getState(conversationId)`.
    pub fn get_state(&self, conversation_id: &str) -> Option<LastRecallState> {
        lock(&self.last_recall_by_conversation)
            .get(conversation_id)
            .cloned()
    }

    /// `setState(conversationId, state)`.
    pub fn set_state(&self, conversation_id: &str, state: LastRecallState) {
        lock(&self.last_recall_by_conversation).insert(conversation_id.to_string(), state);
    }

    /// `deleteState(conversationId)`.
    pub fn delete_state(&self, conversation_id: &str) {
        lock(&self.last_recall_by_conversation).remove(conversation_id);
    }

    /// `isMem0ScopeTemporarilyEmpty`. An expired marker is removed and reads as
    /// "not empty".
    pub fn is_mem0_scope_temporarily_empty(
        &self,
        persona_id: &str,
        user_id: &str,
        workspace_id: Option<&str>,
    ) -> bool {
        let key = scope_key(persona_id, user_id, workspace_id);
        let mut cache = lock(&self.empty_mem0_scope_cache);
        match cache.get(&key).copied() {
            None => false,
            Some(expires_at) if expires_at <= now_ms() => {
                cache.remove(&key);
                false
            }
            Some(_) => true,
        }
    }

    /// `markMem0ScopeTemporarilyEmpty`.
    pub fn mark_mem0_scope_temporarily_empty(
        &self,
        persona_id: &str,
        user_id: &str,
        workspace_id: Option<&str>,
    ) {
        let key = scope_key(persona_id, user_id, workspace_id);
        lock(&self.empty_mem0_scope_cache).insert(key, now_ms() + MEM0_EMPTY_SCOPE_TTL_MS);
    }

    /// `clearMem0ScopeEmptyMarker`.
    pub fn clear_mem0_scope_empty_marker(
        &self,
        persona_id: &str,
        user_id: &str,
        workspace_id: Option<&str>,
    ) {
        let key = scope_key(persona_id, user_id, workspace_id);
        lock(&self.empty_mem0_scope_cache).remove(&key);
    }
}

/// `${personaId}::${userId}::${workspaceId ?? ''}`.
fn scope_key(persona_id: &str, user_id: &str, workspace_id: Option<&str>) -> String {
    format!("{persona_id}::{user_id}::{}", workspace_id.unwrap_or(""))
}

/// Recovers a poisoned lock. The maps hold plain data, so a panic in another
/// thread cannot leave them half-updated in a way that matters here.
fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn state(queried_at: i64) -> LastRecallState {
        LastRecallState {
            persona_id: "p1".to_string(),
            user_id: "u1".to_string(),
            node_ids: vec!["n1".to_string()],
            queried_at,
        }
    }

    #[test]
    fn state_round_trips_and_deletes() {
        let manager = RecallStateManager::new();
        manager.set_state("conv-1", state(42));
        assert_eq!(manager.get_state("conv-1"), Some(state(42)));
        manager.delete_state("conv-1");
        assert_eq!(manager.get_state("conv-1"), None);
    }

    #[test]
    fn empty_marker_is_set_cleared_and_expires() {
        let manager = RecallStateManager::new();
        assert!(!manager.is_mem0_scope_temporarily_empty("p1", "u1", None));

        manager.mark_mem0_scope_temporarily_empty("p1", "u1", None);
        assert!(manager.is_mem0_scope_temporarily_empty("p1", "u1", None));
        assert!(!manager.is_mem0_scope_temporarily_empty("p1", "u1", Some("ws")));

        manager.clear_mem0_scope_empty_marker("p1", "u1", None);
        assert!(!manager.is_mem0_scope_temporarily_empty("p1", "u1", None));

        // An expired entry is removed on read.
        let key = scope_key("p1", "u1", None);
        lock(&manager.empty_mem0_scope_cache).insert(key.clone(), now_ms() - 1);
        assert!(!manager.is_mem0_scope_temporarily_empty("p1", "u1", None));
        assert!(!lock(&manager.empty_mem0_scope_cache).contains_key(&key));
    }
}
