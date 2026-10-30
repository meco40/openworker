//! Port of `src/server/channels/credentials/credentialStore.ts`: the
//! `channel_credentials` table of the messages database, behind the core
//! [`ChannelCredentialStore`] port.
//!
//! The gateway state holds one connection to that database, behind a tokio mutex.
//! The channel services open a second one: the pairing code keeps an owned
//! `Arc<dyn ChannelCredentialStore>` and runs synchronous calls, which the tokio
//! mutex cannot serve. Both connections use the shared opener, so the busy timeout
//! applies and concurrent writes queue instead of failing.
//!
//! The lease methods (`claimLease`, `renewLease`, `releaseLease`) run each
//! read-decide-write sequence in one `BEGIN IMMEDIATE` transaction, so two
//! connections cannot both take the same lease.

use std::sync::{Mutex, PoisonError};

use betaclaw_core::channels::pairing::credentials::{
    parse_iso, to_iso, ChannelCredential, ChannelCredentialStore,
};
use betaclaw_core::messages_store::types::Conversation;
use betaclaw_core::messages_store::{now_iso, MessageRepositoryError, MessagesStore};
use chrono::{DateTime, Utc};
use rusqlite::{params, Connection, OptionalExtension};

/// The messages database as the channel services use it.
pub struct ChannelDb {
    store: Mutex<MessagesStore>,
}

impl ChannelDb {
    pub fn open(path: &str) -> Result<Self, MessageRepositoryError> {
        Ok(Self {
            store: Mutex::new(MessagesStore::open(path)?),
        })
    }

    /// Runs `operation` with the store locked. Keep it synchronous: the lock is
    /// a std mutex and must not be held across an await.
    pub fn with<T>(&self, operation: impl FnOnce(&MessagesStore) -> T) -> T {
        let guard = self.store.lock().unwrap_or_else(PoisonError::into_inner);
        operation(&guard)
    }

    /// `getOrCreateConversation(channelType, externalChatId)` of the TypeScript
    /// message service, used by the inbound paths before the dispatch.
    pub fn get_or_create_conversation(
        &self,
        channel_type: &str,
        external_chat_id: &str,
    ) -> Result<Conversation, MessageRepositoryError> {
        self.with(|store| {
            store.get_or_create_conversation(channel_type, external_chat_id, None, None)
        })
    }
}

impl ChannelCredentialStore for ChannelDb {
    fn get_credential(&self, channel: &str, key: &str) -> Option<String> {
        self.with(|store| {
            store
                .connection()
                .query_row(
                    "SELECT value FROM channel_credentials WHERE channel = ?1 AND key = ?2",
                    params![channel, key],
                    |row| row.get::<_, String>(0),
                )
                .optional()
        })
        .unwrap_or_else(|error| {
            tracing::warn!(%error, "channel credential read failed");
            None
        })
    }

    fn set_credential(&self, channel: &str, key: &str, value: &str) {
        let now = now_iso();
        let result = self.with(|store| {
            store.connection().execute(
                "INSERT INTO channel_credentials (channel, key, value, updated_at)
                 VALUES (?1, ?2, ?3, ?4)
                 ON CONFLICT(channel, key) DO UPDATE SET
                     value = excluded.value, updated_at = excluded.updated_at",
                params![channel, key, value, now],
            )
        });
        if let Err(error) = result {
            tracing::warn!(%error, "channel credential write failed");
        }
    }

    fn delete_credential(&self, channel: &str, key: &str) {
        let result = self.with(|store| {
            store.connection().execute(
                "DELETE FROM channel_credentials WHERE channel = ?1 AND key = ?2",
                params![channel, key],
            )
        });
        if let Err(error) = result {
            tracing::warn!(%error, "channel credential delete failed");
        }
    }

    fn delete_credentials(&self, channel: &str) {
        let result = self.with(|store| {
            store.connection().execute(
                "DELETE FROM channel_credentials WHERE channel = ?1",
                params![channel],
            )
        });
        if let Err(error) = result {
            tracing::warn!(%error, "channel credential delete failed");
        }
    }

    fn list_credentials(&self, channel: &str) -> Vec<ChannelCredential> {
        self.with(|store| -> rusqlite::Result<Vec<ChannelCredential>> {
            let mut statement = store.connection().prepare(
                "SELECT channel, key, value, updated_at FROM channel_credentials
                 WHERE channel = ?1 ORDER BY key",
            )?;
            let rows = statement.query_map(params![channel], |row| {
                Ok(ChannelCredential {
                    channel: row.get(0)?,
                    key: row.get(1)?,
                    value: row.get(2)?,
                    updated_at: row.get(3)?,
                })
            })?;
            rows.collect()
        })
        .unwrap_or_else(|error| {
            tracing::warn!(%error, "channel credential list failed");
            Vec::new()
        })
    }

    fn claim_lease(
        &self,
        channel: &str,
        owner_key: &str,
        expires_at_key: &str,
        owner_id: &str,
        ttl_ms: u64,
        now: DateTime<Utc>,
    ) -> bool {
        self.in_immediate_transaction(false, |conn| {
            let owner_raw = read_row(conn, channel, owner_key)?.unwrap_or_default();
            let current_owner = owner_raw.trim();
            let expired = match read_row(conn, channel, expires_at_key)?
                .as_deref()
                .and_then(parse_iso)
            {
                Some(current_expiry) => current_expiry <= now,
                None => true,
            };
            if !current_owner.is_empty() && current_owner != owner_id && !expired {
                return Ok(false);
            }
            write_row(conn, channel, owner_key, owner_id)?;
            write_row(
                conn,
                channel,
                expires_at_key,
                &to_iso(now + lease_ttl(ttl_ms)),
            )?;
            Ok(true)
        })
    }

    fn renew_lease(
        &self,
        channel: &str,
        owner_key: &str,
        expires_at_key: &str,
        owner_id: &str,
        ttl_ms: u64,
        now: DateTime<Utc>,
    ) -> bool {
        self.in_immediate_transaction(false, |conn| {
            if read_row(conn, channel, owner_key)?.as_deref() != Some(owner_id) {
                return Ok(false);
            }
            write_row(
                conn,
                channel,
                expires_at_key,
                &to_iso(now + lease_ttl(ttl_ms)),
            )?;
            Ok(true)
        })
    }

    fn release_lease(&self, channel: &str, owner_key: &str, expires_at_key: &str, owner_id: &str) {
        self.in_immediate_transaction((), |conn| {
            if read_row(conn, channel, owner_key)?.as_deref() != Some(owner_id) {
                return Ok(());
            }
            remove_row(conn, channel, owner_key)?;
            remove_row(conn, channel, expires_at_key)
        });
    }
}

impl ChannelDb {
    /// Runs `body` inside `BEGIN IMMEDIATE` ... `COMMIT` on the store's connection,
    /// with the store locked. A failure is logged, rolled back, and answered with
    /// `fallback`.
    fn in_immediate_transaction<T>(
        &self,
        fallback: T,
        body: impl FnOnce(&Connection) -> rusqlite::Result<T>,
    ) -> T {
        self.with(|store| {
            let conn = store.connection();
            if let Err(error) = conn.execute_batch("BEGIN IMMEDIATE") {
                tracing::warn!(%error, "channel lease transaction did not start");
                return fallback;
            }
            let outcome = body(conn).and_then(|value| conn.execute_batch("COMMIT").map(|()| value));
            match outcome {
                Ok(value) => value,
                Err(error) => {
                    let _ = conn.execute_batch("ROLLBACK");
                    tracing::warn!(%error, "channel lease transaction failed");
                    fallback
                }
            }
        })
    }
}

fn read_row(conn: &Connection, channel: &str, key: &str) -> rusqlite::Result<Option<String>> {
    conn.query_row(
        "SELECT value FROM channel_credentials WHERE channel = ?1 AND key = ?2",
        params![channel, key],
        |row| row.get::<_, String>(0),
    )
    .optional()
}

fn write_row(conn: &Connection, channel: &str, key: &str, value: &str) -> rusqlite::Result<()> {
    conn.execute(
        "INSERT INTO channel_credentials (channel, key, value, updated_at)
         VALUES (?1, ?2, ?3, ?4)
         ON CONFLICT(channel, key) DO UPDATE SET
             value = excluded.value, updated_at = excluded.updated_at",
        params![channel, key, value, now_iso()],
    )?;
    Ok(())
}

fn remove_row(conn: &Connection, channel: &str, key: &str) -> rusqlite::Result<()> {
    conn.execute(
        "DELETE FROM channel_credentials WHERE channel = ?1 AND key = ?2",
        params![channel, key],
    )?;
    Ok(())
}

/// The lease TTL of the core `credentials.rs`: at least one second.
fn lease_ttl(ttl_ms: u64) -> chrono::Duration {
    chrono::Duration::milliseconds(ttl_ms.max(1_000) as i64)
}

#[cfg(test)]
mod tests {
    use std::sync::{Arc, Barrier};

    use chrono::TimeZone;

    use super::*;
    use crate::families::channels_wire::test_support::ScratchDir;

    #[test]
    fn a_lease_is_held_by_one_owner_until_it_expires() {
        let scratch = ScratchDir::new();
        let db = ChannelDb::open(&scratch.path_string("messages.db")).expect("open");
        let t0 = Utc.with_ymd_and_hms(2026, 10, 11, 12, 0, 0).unwrap();

        assert!(db.claim_lease("telegram", "owner", "until", "a", 30_000, t0));
        assert!(!db.claim_lease("telegram", "owner", "until", "b", 30_000, t0));
        assert!(!db.renew_lease("telegram", "owner", "until", "b", 30_000, t0));
        db.release_lease("telegram", "owner", "until", "b");
        assert_eq!(db.get_credential("telegram", "owner").as_deref(), Some("a"));
        let later = t0 + chrono::Duration::milliseconds(31_000);
        assert!(db.claim_lease("telegram", "owner", "until", "b", 30_000, later));
        db.release_lease("telegram", "owner", "until", "b");
        assert_eq!(db.get_credential("telegram", "owner"), None);
    }

    #[test]
    fn concurrent_claims_on_separate_connections_have_exactly_one_winner() {
        let scratch = ScratchDir::new();
        let path = scratch.path_string("messages.db");
        let first = Arc::new(ChannelDb::open(&path).expect("open first"));
        let second = Arc::new(ChannelDb::open(&path).expect("open second"));
        const ROUNDS: usize = 50;
        let barrier = Arc::new(Barrier::new(2));
        let now = Utc::now();

        let racer = |db: Arc<ChannelDb>, owner: &'static str| {
            let barrier = barrier.clone();
            std::thread::spawn(move || {
                (0..ROUNDS)
                    .map(|round| {
                        barrier.wait();
                        db.claim_lease(
                            "telegram",
                            &format!("owner-{round}"),
                            &format!("until-{round}"),
                            owner,
                            30_000,
                            now,
                        )
                    })
                    .collect::<Vec<bool>>()
            })
        };
        let left = racer(first, "left");
        let right = racer(second, "right");
        let left = left.join().expect("left racer");
        let right = right.join().expect("right racer");

        for round in 0..ROUNDS {
            assert_eq!(
                u8::from(left[round]) + u8::from(right[round]),
                1,
                "round {round} must have exactly one winner"
            );
        }
    }

    #[test]
    fn credentials_round_trip_through_the_table() {
        let scratch = ScratchDir::new();
        let db = ChannelDb::open(&scratch.path_string("messages.db")).expect("open");

        db.set_credential("telegram", "bot_token", "first");
        db.set_credential("telegram", "bot_token", "second");
        db.set_credential("telegram", "webhook_secret", "s");
        db.set_credential("slack", "bot_token", "other");

        assert_eq!(
            db.get_credential("telegram", "bot_token").as_deref(),
            Some("second")
        );
        let keys: Vec<String> = db
            .list_credentials("telegram")
            .into_iter()
            .map(|row| row.key)
            .collect();
        assert_eq!(keys, vec!["bot_token", "webhook_secret"]);

        db.delete_credential("telegram", "webhook_secret");
        assert_eq!(db.get_credential("telegram", "webhook_secret"), None);
        db.delete_credentials("telegram");
        assert!(db.list_credentials("telegram").is_empty());
        assert_eq!(
            db.get_credential("slack", "bot_token").as_deref(),
            Some("other")
        );
    }
}
