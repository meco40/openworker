//! Gateway client registry.
//!
//! Port of `ClientRegistry` in `src/server/gateway/client-registry.ts:25-93`,
//! including the user index and the per-user connection count that the
//! connection limit check depends on.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use super::client::ClientHandle;

#[derive(Default)]
pub struct ClientRegistry {
    clients: Mutex<HashMap<String, ClientHandle>>,
    user_index: Mutex<HashMap<String, Vec<String>>>,
}

impl ClientRegistry {
    pub fn new() -> Self {
        Self {
            clients: Mutex::new(HashMap::new()),
            user_index: Mutex::new(HashMap::new()),
        }
    }

    pub fn register(&self, client: ClientHandle) {
        let conn_id = client.conn_id.to_string();
        let user_id = client.user_id.to_string();

        if let Ok(mut index) = self.user_index.lock() {
            let entry = index.entry(user_id).or_default();
            if !entry.contains(&conn_id) {
                entry.push(conn_id.clone());
            }
        }
        if let Ok(mut clients) = self.clients.lock() {
            clients.insert(conn_id, client);
        }
    }

    pub fn unregister(&self, conn_id: &str) -> Option<ClientHandle> {
        let removed = self
            .clients
            .lock()
            .ok()
            .and_then(|mut clients| clients.remove(conn_id));

        let client = removed?;
        if let Ok(mut index) = self.user_index.lock() {
            if let Some(conns) = index.get_mut(client.user_id.as_ref()) {
                conns.retain(|id| id != conn_id);
                if conns.is_empty() {
                    index.remove(client.user_id.as_ref());
                }
            }
        }
        Some(client)
    }

    pub fn get(&self, conn_id: &str) -> Option<ClientHandle> {
        self.clients
            .lock()
            .ok()
            .and_then(|clients| clients.get(conn_id).cloned())
    }

    /// Snapshot of one user's connections.
    pub fn get_by_user_id(&self, user_id: &str) -> Vec<ClientHandle> {
        let conn_ids: Vec<String> = self
            .user_index
            .lock()
            .ok()
            .and_then(|index| index.get(user_id).cloned())
            .unwrap_or_default();
        let Ok(clients) = self.clients.lock() else {
            return Vec::new();
        };
        conn_ids
            .iter()
            .filter_map(|conn_id| clients.get(conn_id).cloned())
            .collect()
    }

    pub fn get_all(&self) -> Vec<ClientHandle> {
        self.clients
            .lock()
            .map(|clients| clients.values().cloned().collect())
            .unwrap_or_default()
    }

    pub fn connection_count(&self) -> usize {
        self.clients
            .lock()
            .map(|clients| clients.len())
            .unwrap_or(0)
    }

    pub fn user_count(&self) -> usize {
        self.user_index.lock().map(|index| index.len()).unwrap_or(0)
    }

    pub fn get_user_connection_count(&self, user_id: &str) -> usize {
        self.user_index
            .lock()
            .ok()
            .and_then(|index| index.get(user_id).map(|conns| conns.len()))
            .unwrap_or(0)
    }

    /// Distinct users with at least one connection, in first-seen order.
    pub fn distinct_users(&self) -> Vec<(String, usize)> {
        let clients = match self.clients.lock() {
            Ok(clients) => clients,
            Err(_) => return Vec::new(),
        };
        let mut seen: Vec<String> = Vec::new();
        for client in clients.values() {
            let user_id = client.user_id.to_string();
            if !seen.contains(&user_id) {
                seen.push(user_id);
            }
        }
        drop(clients);
        seen.into_iter()
            .map(|user_id| {
                let count = self.get_user_connection_count(&user_id);
                (user_id, count)
            })
            .collect()
    }
}

/// Process-wide registry handle.
pub type SharedRegistry = Arc<ClientRegistry>;

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::sync::mpsc;

    fn client(name: &str, user: &str) -> ClientHandle {
        let (tx, _rx) = mpsc::channel(4);
        ClientHandle::new(name, user, "v2", 0, tx)
    }

    #[test]
    fn registers_and_indexes_by_user() {
        let registry = ClientRegistry::new();
        registry.register(client("c1", "u1"));
        registry.register(client("c2", "u1"));
        registry.register(client("c3", "u2"));

        assert_eq!(registry.connection_count(), 3);
        assert_eq!(registry.user_count(), 2);
        assert_eq!(registry.get_user_connection_count("u1"), 2);
        assert_eq!(registry.get_by_user_id("u1").len(), 2);
    }

    #[test]
    fn unregister_cleans_the_user_index() {
        let registry = ClientRegistry::new();
        registry.register(client("c1", "u1"));
        registry.register(client("c2", "u1"));

        assert!(registry.unregister("c1").is_some());
        assert_eq!(registry.connection_count(), 1);
        assert_eq!(registry.get_user_connection_count("u1"), 1);

        assert!(registry.unregister("c2").is_some());
        assert_eq!(registry.user_count(), 0);
        assert_eq!(registry.get_user_connection_count("u1"), 0);
        assert!(registry.unregister("missing").is_none());
    }

    #[test]
    fn double_register_does_not_duplicate_index_entries() {
        let registry = ClientRegistry::new();
        registry.register(client("c1", "u1"));
        registry.register(client("c1", "u1"));
        assert_eq!(registry.get_user_connection_count("u1"), 1);
    }

    #[test]
    fn distinct_users_reports_connection_counts() {
        let registry = ClientRegistry::new();
        registry.register(client("c1", "u1"));
        registry.register(client("c2", "u1"));
        registry.register(client("c3", "u2"));

        let users = registry.distinct_users();
        assert_eq!(users.len(), 2);
        assert!(users.contains(&("u1".to_string(), 2)));
        assert!(users.contains(&("u2".to_string(), 1)));
    }
}
