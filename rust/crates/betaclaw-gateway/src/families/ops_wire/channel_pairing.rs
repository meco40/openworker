//! Channel actions of the ops nodes route and the pairing snapshots it reads.
//!
//! Port of the handlers `channels.connect`, `channels.disconnect`,
//! `channels.rotateSecret` and `telegram.rejectPending` in
//! `app/api/ops/nodes/route.ts`, and of `pairChannel`, `unpairChannel`,
//! `upsertBridgeAccount`, `listBridgeAccounts`, `rejectTelegramPendingPairingRequest`
//! and `getTelegramPairingSnapshot` in `src/server/channels/pairing/*`.
//!
//! The adapter holds no state. It calls the core pairing module with the
//! [`ChannelPairing`] and credential store that the channel family owns, so the
//! ops nodes route and the channel routes act on the same credentials. The
//! integrator passes both in through [`Services::with_channel_pairing`]. Until
//! then the port stays [`Unwired`](super::ports::Unwired).

use std::sync::Arc;

use base64::Engine;
use betaclaw_core::channels::adapters::telegram::types::TelegramCallbackQuery;
use betaclaw_core::channels::adapters::types::ChannelError;
use betaclaw_core::channels::pairing::bridge_accounts::{
    list_bridge_accounts, upsert_bridge_account, BridgeAccountSummary, BridgeAccountUpsert,
    BridgeChannel,
};
use betaclaw_core::channels::pairing::credentials::{ChannelCredentialStore, ChannelEnv};
use betaclaw_core::channels::pairing::telegram_code::{
    reject_telegram_pending_pairing_request, telegram_pairing_snapshot, TelegramStatus,
};
use betaclaw_core::channels::pairing::telegram_inbound::{TelegramDispatch, TelegramInboundPort};
use betaclaw_core::channels::pairing::{random_hex, ChannelPairing, PairChannelType};
use betaclaw_core::model_hub::http::{BoxFuture, HttpTransport};
use chrono::Utc;
use serde_json::{json, Value};

use super::ports::{ChannelPairingPort, PortError, PortFuture};
use super::{iso_from_ms, store_error, BuildError, Services};
use crate::families::channels_wire::store::ChannelDb;

/// No-op inbound port used when `CorePairing` is opened directly for `ops_wire`.
struct OpsNoopTelegramInbound;

impl TelegramInboundPort for OpsNoopTelegramInbound {
    fn handle_native_command<'a>(
        &'a self,
        _chat_id: &'a str,
        _text: &'a str,
        _external_chat_id: &'a str,
    ) -> BoxFuture<'a, Result<bool, ChannelError>> {
        Box::pin(async { Ok(false) })
    }

    fn handle_model_callback<'a>(
        &'a self,
        _query: &'a TelegramCallbackQuery,
    ) -> BoxFuture<'a, Result<bool, ChannelError>> {
        Box::pin(async { Ok(false) })
    }

    fn dispatch_message<'a>(
        &'a self,
        _dispatch: TelegramDispatch<'a>,
    ) -> BoxFuture<'a, Result<bool, ChannelError>> {
        Box::pin(async { Ok(false) })
    }
}

/// The pairing port over the core [`ChannelPairing`] and its credential store.
pub struct CorePairing {
    pairing: Arc<ChannelPairing>,
    store: Arc<dyn ChannelCredentialStore>,
}

impl CorePairing {
    pub fn new(pairing: Arc<ChannelPairing>, store: Arc<dyn ChannelCredentialStore>) -> Self {
        Self { pairing, store }
    }

    pub fn open(
        messages_db_path: &str,
        transport: Arc<dyn HttpTransport>,
    ) -> Result<Self, BuildError> {
        let store: Arc<dyn ChannelCredentialStore> =
            Arc::new(ChannelDb::open(messages_db_path).map_err(store_error)?);
        let pairing = Arc::new(ChannelPairing::new(
            store.clone(),
            Arc::new(ChannelEnv::new()),
            transport,
            Arc::new(OpsNoopTelegramInbound),
        ));
        Ok(Self::new(pairing, store))
    }
}

impl Services {
    /// Replaces the channel-pairing port with the core implementation over the
    /// channel family's own pairing and credential store.
    pub fn with_channel_pairing(
        mut self,
        pairing: Arc<ChannelPairing>,
        store: Arc<dyn ChannelCredentialStore>,
    ) -> Self {
        self.channel_pairing = Arc::new(CorePairing::new(pairing, store));
        self
    }

    /// Opens a [`CorePairing`] on `messages_db_path` and attaches it.
    pub fn with_core_channel_pairing(
        mut self,
        messages_db_path: &str,
        transport: Arc<dyn HttpTransport>,
    ) -> Result<Self, BuildError> {
        self.channel_pairing = Arc::new(CorePairing::open(messages_db_path, transport)?);
        Ok(self)
    }
}

fn failed(error: ChannelError) -> PortError {
    PortError::Failed(error.0)
}

fn unsupported_channel(channel: &str) -> PortError {
    PortError::Failed(format!("Unsupported channel: {channel}"))
}

/// The bridge channels: WhatsApp and iMessage.
fn bridge_channel(channel: &str) -> Result<BridgeChannel, PortError> {
    match channel {
        "whatsapp" => Ok(BridgeChannel::WhatsApp),
        "imessage" => Ok(BridgeChannel::IMessage),
        other => Err(PortError::Failed(format!(
            "Unsupported bridge channel: {other}."
        ))),
    }
}

/// `randomBytes(24).toString('base64url')`: 24 bytes from the core random source,
/// as unpadded URL-safe base64.
fn new_webhook_secret() -> Result<String, PortError> {
    let hex = random_hex(24).map_err(failed)?;
    let bytes = (0..hex.len())
        .step_by(2)
        .map(|index| u8::from_str_radix(&hex[index..index + 2], 16))
        .collect::<Result<Vec<u8>, _>>()
        .map_err(|error| PortError::Failed(error.to_string()))?;
    Ok(base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(bytes))
}

/// The account object of `listBridgeAccounts`, with the keys the TypeScript
/// route returns.
fn account_json(account: &BridgeAccountSummary) -> Value {
    json!({
        "accountId": account.account_id,
        "pairingStatus": account.pairing_status,
        "peerName": account.peer_name,
        "lastSeenAt": account.last_seen_at,
        "allowFrom": account.allow_from,
    })
}

impl ChannelPairingPort for CorePairing {
    fn connect(
        &self,
        channel: String,
        token: String,
        account_id: Option<String>,
    ) -> PortFuture<'_, Value> {
        Box::pin(async move {
            let kind =
                PairChannelType::parse(&channel).ok_or_else(|| unsupported_channel(&channel))?;
            let outcome = self
                .pairing
                .pair_channel(kind, &token, account_id.as_deref())
                .await
                .map_err(failed)?;
            Ok(json!({
                "status": outcome.status,
                "transport": outcome.transport,
                "accountId": outcome.account_id,
                "peerName": outcome.peer_name,
                "details": outcome.details,
            }))
        })
    }

    fn disconnect(&self, channel: String, account_id: Option<String>) -> PortFuture<'_, ()> {
        Box::pin(async move {
            let kind =
                PairChannelType::parse(&channel).ok_or_else(|| unsupported_channel(&channel))?;
            self.pairing
                .unpair_channel(kind, account_id.as_deref())
                .await
                .map_err(failed)
        })
    }

    /// `upsertBridgeAccount` with a fresh secret, the connected status and a
    /// last-seen touch, as `channels.rotateSecret` writes it.
    fn rotate_secret(&self, channel: String, account_id: String) -> PortFuture<'_, ()> {
        Box::pin(async move {
            let kind = bridge_channel(&channel)?;
            let input = BridgeAccountUpsert {
                account_id: Some(account_id),
                pairing_status: Some("connected".to_string()),
                webhook_secret: Some(new_webhook_secret()?),
                peer_name: None,
                touch_last_seen: true,
            };
            upsert_bridge_account(self.store.as_ref(), kind, &input, Utc::now())
                .map(|_| ())
                .map_err(failed)
        })
    }

    fn reject_pending_telegram(&self) -> PortFuture<'_, bool> {
        Box::pin(async move {
            Ok(reject_telegram_pending_pairing_request(
                self.store.as_ref(),
                Utc::now(),
            ))
        })
    }

    fn telegram_pairing(&self) -> PortFuture<'_, Value> {
        Box::pin(async move {
            let snapshot = telegram_pairing_snapshot(self.store.as_ref(), Utc::now());
            let status = match snapshot.status {
                TelegramStatus::Idle => "idle",
                TelegramStatus::AwaitingCode => "awaiting_code",
                TelegramStatus::Connected => "connected",
            };
            Ok(json!({
                "status": status,
                "pendingChatId": snapshot.pending_chat_id,
                "pendingExpiresAt": snapshot
                    .pending_expires_at
                    .map(|at| iso_from_ms(at.timestamp_millis())),
                "hasPending": snapshot.has_pending,
            }))
        })
    }

    fn bridge_accounts(&self, channel: String) -> PortFuture<'_, Value> {
        Box::pin(async move {
            let kind = bridge_channel(&channel)?;
            let accounts = list_bridge_accounts(self.store.as_ref(), kind).map_err(failed)?;
            Ok(Value::Array(accounts.iter().map(account_json).collect()))
        })
    }
}

#[cfg(test)]
mod tests {
    use std::collections::BTreeMap;
    use std::sync::Mutex;

    use betaclaw_core::channels::adapters::telegram::types::TelegramCallbackQuery;
    use betaclaw_core::channels::pairing::credentials::{ChannelCredential, ChannelEnv};
    use betaclaw_core::channels::pairing::telegram_inbound::{
        TelegramDispatch, TelegramInboundPort,
    };
    use betaclaw_core::model_hub::http::{BoxFuture, UnreachableTransport};

    use super::*;

    /// An in-memory credential table, the test double of the messages database.
    #[derive(Default)]
    struct MemoryCredentials(Mutex<BTreeMap<(String, String), String>>);

    impl ChannelCredentialStore for MemoryCredentials {
        fn get_credential(&self, channel: &str, key: &str) -> Option<String> {
            let table = self.0.lock().expect("table lock");
            table.get(&(channel.to_string(), key.to_string())).cloned()
        }

        fn set_credential(&self, channel: &str, key: &str, value: &str) {
            let mut table = self.0.lock().expect("table lock");
            table.insert((channel.to_string(), key.to_string()), value.to_string());
        }

        fn delete_credential(&self, channel: &str, key: &str) {
            let mut table = self.0.lock().expect("table lock");
            table.remove(&(channel.to_string(), key.to_string()));
        }

        fn delete_credentials(&self, channel: &str) {
            let mut table = self.0.lock().expect("table lock");
            table.retain(|(owner, _), _| owner != channel);
        }

        fn list_credentials(&self, channel: &str) -> Vec<ChannelCredential> {
            let table = self.0.lock().expect("table lock");
            table
                .iter()
                .filter(|((owner, _), _)| owner == channel)
                .map(|((owner, key), value)| ChannelCredential {
                    channel: owner.clone(),
                    key: key.clone(),
                    value: value.clone(),
                    updated_at: String::new(),
                })
                .collect()
        }
    }

    /// Inbound handling is not exercised by pairing, so every call answers "not handled".
    struct NoInbound;

    impl TelegramInboundPort for NoInbound {
        fn handle_native_command<'a>(
            &'a self,
            _chat_id: &'a str,
            _text: &'a str,
            _external_chat_id: &'a str,
        ) -> BoxFuture<'a, Result<bool, ChannelError>> {
            Box::pin(async { Ok(false) })
        }

        fn handle_model_callback<'a>(
            &'a self,
            _query: &'a TelegramCallbackQuery,
        ) -> BoxFuture<'a, Result<bool, ChannelError>> {
            Box::pin(async { Ok(false) })
        }

        fn dispatch_message<'a>(
            &'a self,
            _dispatch: TelegramDispatch<'a>,
        ) -> BoxFuture<'a, Result<bool, ChannelError>> {
            Box::pin(async { Ok(false) })
        }
    }

    /// The port over a real core pairing whose HTTP transport always fails.
    fn fixture() -> (Arc<MemoryCredentials>, CorePairing) {
        let store = Arc::new(MemoryCredentials::default());
        let pairing = Arc::new(ChannelPairing::new(
            store.clone(),
            Arc::new(ChannelEnv::new()),
            Arc::new(UnreachableTransport),
            Arc::new(NoInbound),
        ));
        let port = CorePairing::new(pairing, store.clone());
        (store, port)
    }

    #[tokio::test]
    async fn disconnecting_discord_clears_its_credentials() {
        let (store, port) = fixture();
        store.set_credential("discord", "bot_token", "token");
        port.disconnect("discord".into(), None)
            .await
            .expect("unpair discord");
        assert_eq!(store.get_credential("discord", "bot_token"), None);
    }

    #[tokio::test]
    async fn connecting_telegram_fails_when_the_api_is_unreachable() {
        let (_store, port) = fixture();
        let error = port
            .connect("telegram".into(), "123:token".into(), None)
            .await
            .expect_err("no network in the test transport");
        assert!(matches!(error, PortError::Failed(_)));
    }

    #[tokio::test]
    async fn connecting_an_unknown_channel_is_refused() {
        let (_store, port) = fixture();
        assert_eq!(
            port.connect("webchat".into(), String::new(), None).await,
            Err(PortError::Failed(
                "Unsupported channel: webchat".to_string()
            ))
        );
    }

    #[tokio::test]
    async fn rotating_a_bridge_secret_marks_the_account_connected() {
        let (_store, port) = fixture();
        port.rotate_secret("whatsapp".into(), "work".into())
            .await
            .expect("rotate");
        let accounts = port
            .bridge_accounts("whatsapp".into())
            .await
            .expect("list accounts");
        assert_eq!(accounts[0]["accountId"], "work");
        assert_eq!(accounts[0]["pairingStatus"], "connected");
    }

    #[tokio::test]
    async fn rotating_a_non_bridge_channel_is_refused() {
        let (_store, port) = fixture();
        assert_eq!(
            port.rotate_secret("telegram".into(), "default".into())
                .await,
            Err(PortError::Failed(
                "Unsupported bridge channel: telegram.".to_string()
            ))
        );
    }

    #[tokio::test]
    async fn telegram_snapshot_is_idle_with_nothing_pending() {
        let (_store, port) = fixture();
        assert_eq!(
            port.telegram_pairing().await.expect("snapshot"),
            json!({
                "status": "idle",
                "pendingChatId": null,
                "pendingExpiresAt": null,
                "hasPending": false,
            })
        );
        assert_eq!(port.reject_pending_telegram().await, Ok(false));
    }
}
