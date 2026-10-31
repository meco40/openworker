//! Port of the storage and environment that the pairing code uses.
//!
//! [`ChannelCredentialStore`] states what the pairing code needs from
//! `CredentialStore` in `src/server/channels/credentials/credentialStore.ts`.
//! The SQLite table `channel_credentials` belongs to the gateway, so this module
//! holds only the contract. The lease methods are provided on top of the four
//! primitives. A store backed by a database should override them with a
//! transaction: the defaults are not atomic.
//!
//! [`ChannelEnv`] covers the `process.env` reads and writes of the pairing code.
//! Writes stay in-process. Changing the real environment while other threads run
//! is unsound, and the gateway must not change its environment at runtime.

use std::collections::HashMap;
use std::sync::{Mutex, MutexGuard, PoisonError};

use chrono::{DateTime, SecondsFormat, Utc};

/// `ChannelCredential` from `credentialStore.ts`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ChannelCredential {
    pub channel: String,
    pub key: String,
    pub value: String,
    pub updated_at: String,
}

pub trait ChannelCredentialStore: Send + Sync {
    fn get_credential(&self, channel: &str, key: &str) -> Option<String>;
    fn set_credential(&self, channel: &str, key: &str, value: &str);
    fn delete_credential(&self, channel: &str, key: &str);
    fn delete_credentials(&self, channel: &str);
    /// Every row of a channel, ordered by key.
    fn list_credentials(&self, channel: &str) -> Vec<ChannelCredential>;

    /// `claimLease`: takes the lease unless another owner holds an unexpired one.
    /// The TTL is at least one second, as in the source.
    fn claim_lease(
        &self,
        channel: &str,
        owner_key: &str,
        expires_at_key: &str,
        owner_id: &str,
        ttl_ms: u64,
        now: DateTime<Utc>,
    ) -> bool {
        let expires_at = now + lease_ttl(ttl_ms);
        let owner_raw = self.get_credential(channel, owner_key).unwrap_or_default();
        let current_owner = owner_raw.trim();
        let expired = match self
            .get_credential(channel, expires_at_key)
            .and_then(|raw| parse_iso(&raw))
        {
            Some(current_expiry) => current_expiry <= now,
            None => true,
        };
        if !current_owner.is_empty() && current_owner != owner_id && !expired {
            return false;
        }
        self.set_credential(channel, owner_key, owner_id);
        self.set_credential(channel, expires_at_key, &to_iso(expires_at));
        true
    }

    /// `renewLease`: extends the lease only for its current owner.
    fn renew_lease(
        &self,
        channel: &str,
        owner_key: &str,
        expires_at_key: &str,
        owner_id: &str,
        ttl_ms: u64,
        now: DateTime<Utc>,
    ) -> bool {
        if self.get_credential(channel, owner_key).as_deref() != Some(owner_id) {
            return false;
        }
        self.set_credential(channel, expires_at_key, &to_iso(now + lease_ttl(ttl_ms)));
        true
    }

    /// `releaseLease`: drops the lease only for its current owner.
    fn release_lease(&self, channel: &str, owner_key: &str, expires_at_key: &str, owner_id: &str) {
        if self.get_credential(channel, owner_key).as_deref() != Some(owner_id) {
            return;
        }
        self.delete_credential(channel, owner_key);
        self.delete_credential(channel, expires_at_key);
    }
}

fn lease_ttl(ttl_ms: u64) -> chrono::Duration {
    chrono::Duration::milliseconds(ttl_ms.max(1_000) as i64)
}

/// `new Date().toISOString()`: millisecond precision, `Z` suffix.
pub fn to_iso(value: DateTime<Utc>) -> String {
    value.to_rfc3339_opts(SecondsFormat::Millis, true)
}

/// `Date.parse` for the values this module writes. An unparsable value is absent.
pub fn parse_iso(raw: &str) -> Option<DateTime<Utc>> {
    DateTime::parse_from_rfc3339(raw.trim())
        .ok()
        .map(|parsed| parsed.with_timezone(&Utc))
}

/// `process.env` for the channel code. A value set here shadows the real
/// environment, and a removed name reads as absent even if the process has it.
#[derive(Debug, Default)]
pub struct ChannelEnv {
    overrides: Mutex<HashMap<String, Option<String>>>,
}

impl ChannelEnv {
    pub fn new() -> Self {
        Self::default()
    }

    fn overrides(&self) -> MutexGuard<'_, HashMap<String, Option<String>>> {
        self.overrides
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
    }

    /// `process.env[name]`.
    pub fn get(&self, name: &str) -> Option<String> {
        match self.overrides().get(name) {
            Some(value) => value.clone(),
            None => std::env::var(name).ok(),
        }
    }

    /// `process.env[name] = value`.
    pub fn set(&self, name: &str, value: &str) {
        self.overrides()
            .insert(name.to_string(), Some(value.to_string()));
    }

    /// `delete process.env[name]`.
    pub fn remove(&self, name: &str) {
        self.overrides().insert(name.to_string(), None);
    }
}

#[cfg(test)]
mod tests {
    use chrono::TimeZone;

    use super::*;
    use crate::channels::pairing::test_support::memory_store;

    #[test]
    fn a_second_owner_is_refused_until_the_lease_expires() {
        let store = memory_store();
        let t0 = Utc.with_ymd_and_hms(2026, 10, 11, 12, 0, 0).unwrap();

        assert!(store.claim_lease("telegram", "owner", "until", "a", 30_000, t0));
        assert!(!store.claim_lease("telegram", "owner", "until", "b", 30_000, t0));
        let later = t0 + chrono::Duration::milliseconds(31_000);
        assert!(store.claim_lease("telegram", "owner", "until", "b", 30_000, later));
    }

    #[test]
    fn only_the_owner_can_renew_or_release() {
        let store = memory_store();
        let t0 = Utc.with_ymd_and_hms(2026, 10, 11, 12, 0, 0).unwrap();
        store.claim_lease("telegram", "owner", "until", "a", 30_000, t0);

        assert!(!store.renew_lease("telegram", "owner", "until", "b", 30_000, t0));
        store.release_lease("telegram", "owner", "until", "b");
        assert_eq!(
            store.get_credential("telegram", "owner").as_deref(),
            Some("a")
        );
        store.release_lease("telegram", "owner", "until", "a");
        assert_eq!(store.get_credential("telegram", "owner"), None);
    }

    #[test]
    fn env_overrides_shadow_and_removals_hide_the_process_value() {
        let env = ChannelEnv::new();
        env.set("PORT_TEST_CHANNEL_TOKEN", "abc");
        assert_eq!(env.get("PORT_TEST_CHANNEL_TOKEN").as_deref(), Some("abc"));
        env.remove("PORT_TEST_CHANNEL_TOKEN");
        assert_eq!(env.get("PORT_TEST_CHANNEL_TOKEN"), None);
    }
}
