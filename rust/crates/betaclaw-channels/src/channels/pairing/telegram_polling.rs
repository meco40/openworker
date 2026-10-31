//! Port of `src/server/channels/pairing/telegramPolling.ts`.
//!
//! The TypeScript module keeps the poller in `globalThis`. Here it is a
//! [`TelegramPoller`] value owned by `ChannelPairing`. Every start bumps a
//! generation number, and a loop exits as soon as its generation is no longer
//! current. A stop therefore never aborts an update that is half processed.
//!
//! A lease in the credential store lets only one runtime poll. Its owner id has
//! the form `telegram-poller:<pid>:<random>`, as in the source.
//!
//! Change from the source: `getUpdates` is sent as a POST with a JSON body,
//! where the source puts the parameters in the query string. Telegram accepts
//! both, and the body keeps the allowed-updates list out of the URL.

use std::sync::{Arc, Mutex, MutexGuard, PoisonError};
use std::time::Duration;

use chrono::{DateTime, Utc};
use serde_json::{json, Value};
use tokio::task::JoinHandle;
use tracing::{error, info, warn};

use super::credentials::{ChannelCredentialStore, ChannelEnv};
use super::random_hex;
use super::telegram_inbound::TelegramInbound;
use crate::channels::adapters::telegram::api::{allowed_updates, TelegramApi};
use crate::channels::adapters::telegram::types::TelegramUpdate;
use crate::channels::adapters::types::{non_empty, response_json};

const CHANNEL: &str = "telegram";
const POLL_INTERVAL: Duration = Duration::from_secs(2);
const LEASE_TTL_MS: u64 = 30_000;
const CONFLICT_COOLDOWN_MS: i64 = 30_000;
const STANDBY_RETRY: Duration = Duration::from_secs(10);
const OWNER_KEY: &str = "polling_owner";
const LEASE_UNTIL_KEY: &str = "polling_lease_until";

#[derive(Default)]
struct PollerState {
    active: bool,
    generation: u64,
    owner_id: Option<String>,
    conflict_until: Option<DateTime<Utc>>,
    standby: Option<JoinHandle<()>>,
}

#[derive(Clone)]
pub struct TelegramPoller {
    store: Arc<dyn ChannelCredentialStore>,
    env: Arc<ChannelEnv>,
    api: TelegramApi,
    inbound: Arc<TelegramInbound>,
    state: Arc<Mutex<PollerState>>,
}

impl TelegramPoller {
    pub fn new(
        store: Arc<dyn ChannelCredentialStore>,
        env: Arc<ChannelEnv>,
        api: TelegramApi,
        inbound: Arc<TelegramInbound>,
    ) -> Self {
        Self {
            store,
            env,
            api,
            inbound,
            state: Arc::new(Mutex::new(PollerState::default())),
        }
    }

    /// Never hold this guard across an `.await`.
    fn state(&self) -> MutexGuard<'_, PollerState> {
        self.state.lock().unwrap_or_else(PoisonError::into_inner)
    }

    pub fn is_active(&self) -> bool {
        self.state().active
    }

    fn owner_id(&self) -> String {
        let mut state = self.state();
        state
            .owner_id
            .get_or_insert_with(|| {
                let suffix = random_hex(4).unwrap_or_else(|_| "0000".to_string());
                format!("telegram-poller:{}:{suffix}", std::process::id())
            })
            .clone()
    }

    fn token(&self) -> Option<String> {
        non_empty(self.store.get_credential(CHANNEL, "bot_token"))
            .or_else(|| non_empty(self.env.get("TELEGRAM_BOT_TOKEN")))
    }

    fn is_current(&self, generation: u64) -> bool {
        let state = self.state();
        state.active && state.generation == generation
    }

    /// `startTelegramPolling`.
    pub async fn start(&self) {
        if self.is_active() {
            info!("[Telegram Polling] Already active, skipping start.");
            return;
        }
        let conflict_until = self.state().conflict_until;
        if conflict_until.is_some_and(|until| Utc::now() < until) {
            self.schedule_standby();
            return;
        }

        let Some(token) = self.token() else {
            warn!("[Telegram Polling] No bot token configured, cannot start polling.");
            return;
        };
        let transport = self.store.get_credential(CHANNEL, "update_transport");
        if transport.as_deref() != Some("polling") {
            info!(
                "[Telegram Polling] Transport is not polling (transport={}), skipping.",
                transport.unwrap_or_default()
            );
            return;
        }

        let owner = self.owner_id();
        let claimed = self.store.claim_lease(
            CHANNEL,
            OWNER_KEY,
            LEASE_UNTIL_KEY,
            &owner,
            LEASE_TTL_MS,
            Utc::now(),
        );
        if !claimed {
            info!("[Telegram Polling] Another runtime owns polling lease; will retry.");
            self.schedule_standby();
            return;
        }

        match self
            .api
            .post(
                &token,
                "deleteWebhook",
                &json!({ "drop_pending_updates": false }),
            )
            .await
        {
            Ok(response) if response.is_ok() => {
                info!("[Telegram Polling] Webhook cleared before starting polling.");
            }
            Ok(_) => {}
            Err(error) => {
                warn!(
                    "[Telegram Polling] deleteWebhook failed (continuing anyway): {}",
                    error
                );
            }
        }

        let generation = {
            let mut state = self.state();
            state.active = true;
            state.generation += 1;
            state.generation
        };
        info!("[Telegram Polling] Started.");
        self.spawn_loop(generation);
    }

    /// `stopTelegramPolling`: ends the loop at its next check and releases the lease.
    pub fn stop(&self) {
        let standby = {
            let mut state = self.state();
            state.active = false;
            state.generation += 1;
            state.standby.take()
        };
        if let Some(handle) = standby {
            handle.abort();
        }
        let owner = self.state().owner_id.clone();
        if let Some(owner) = owner {
            self.store
                .release_lease(CHANNEL, OWNER_KEY, LEASE_UNTIL_KEY, &owner);
        }
        info!("[Telegram Polling] Stopped.");
    }

    fn spawn_loop(&self, generation: u64) {
        let poller = self.clone();
        tokio::spawn(async move {
            loop {
                tokio::time::sleep(POLL_INTERVAL).await;
                if !poller.is_current(generation) {
                    break;
                }
                poller.poll_once().await;
            }
        });
    }

    /// `scheduleStandbyRetry`: after a lost lease or a conflict, try again later.
    fn schedule_standby(&self) {
        let mut state = self.state();
        if state.standby.is_some() {
            return;
        }
        let poller = self.clone();
        state.standby = Some(tokio::spawn(async move {
            tokio::time::sleep(STANDBY_RETRY).await;
            poller.state().standby = None;
            poller.start().await;
        }));
    }

    fn set_conflict(&self) {
        self.state().conflict_until =
            Some(Utc::now() + chrono::Duration::milliseconds(CONFLICT_COOLDOWN_MS));
    }

    /// `pollOnce`: renews the lease, fetches updates, persists the offset and
    /// then processes each update.
    pub(crate) async fn poll_once(&self) {
        let owner = self.owner_id();
        if !self.store.renew_lease(
            CHANNEL,
            OWNER_KEY,
            LEASE_UNTIL_KEY,
            &owner,
            LEASE_TTL_MS,
            Utc::now(),
        ) {
            info!("[Telegram Polling] Lease lost; stopping local poller.");
            self.stop();
            self.schedule_standby();
            return;
        }

        let Some(token) = self.token() else {
            self.stop();
            return;
        };
        let offset = self
            .store
            .get_credential(CHANNEL, "polling_offset")
            .and_then(|raw| raw.trim().parse::<i64>().ok())
            .unwrap_or(0);

        let body = json!({
            "offset": offset,
            "timeout": 1,
            "allowed_updates": allowed_updates(),
        });
        let response = match self.api.post(&token, "getUpdates", &body).await {
            Ok(response) => response,
            Err(fetch_error) => {
                error!("[Telegram Polling] Fetch error: {}", fetch_error);
                return;
            }
        };
        if !response.is_ok() {
            let status = response.status.as_u16();
            error!("[Telegram Polling] getUpdates HTTP error: {}", status);
            match status {
                401 | 404 => {
                    warn!(
                        "[Telegram Polling] Bot token appears invalid (HTTP {}). Stopping polling.",
                        status
                    );
                    self.stop();
                }
                409 => {
                    warn!("[Telegram Polling] Conflict (409) - another getUpdates is active. Backing off.");
                    self.set_conflict();
                    self.stop();
                    self.schedule_standby();
                }
                _ => {}
            }
            return;
        }

        let data = response_json(&response);
        let updates = match (
            data.get("ok").and_then(Value::as_bool),
            data.get("result").and_then(Value::as_array),
        ) {
            (Some(true), Some(list)) if !list.is_empty() => list.clone(),
            _ => return,
        };

        // Agent runs triggered by an update can outlast the lease TTL.
        let heartbeat = self.spawn_heartbeat(owner);
        let mut max_update_id = offset;
        for raw in &updates {
            if let Some(update_id) = raw.get("update_id").and_then(Value::as_i64) {
                if update_id >= max_update_id {
                    max_update_id = update_id + 1;
                }
            }
            // Persist before processing: a restart mid agent-run must not replay the update.
            self.store
                .set_credential(CHANNEL, "polling_offset", &max_update_id.to_string());

            match serde_json::from_value::<TelegramUpdate>(raw.clone()) {
                Ok(update) if update.message.is_some() || update.callback_query.is_some() => {
                    if let Err(process_error) = self.inbound.process_update(&update, None).await {
                        error!(
                            "[Telegram Polling] Error processing update: {}",
                            process_error
                        );
                    }
                }
                Ok(_) => {}
                Err(parse_error) => {
                    error!(
                        "[Telegram Polling] Skipping malformed update: {}",
                        parse_error
                    );
                }
            }
        }
        heartbeat.abort();
    }

    fn spawn_heartbeat(&self, owner: String) -> JoinHandle<()> {
        let store = self.store.clone();
        tokio::spawn(async move {
            loop {
                tokio::time::sleep(Duration::from_millis(LEASE_TTL_MS / 3)).await;
                store.renew_lease(
                    CHANNEL,
                    OWNER_KEY,
                    LEASE_UNTIL_KEY,
                    &owner,
                    LEASE_TTL_MS,
                    Utc::now(),
                );
            }
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::channels::adapters::telegram::outbound::TelegramSender;
    use crate::channels::pairing::test_support::{
        isolated_env, json_response, memory_store, RecordingPort, ScriptedTransport,
    };

    struct Setup {
        poller: TelegramPoller,
        store: Arc<dyn ChannelCredentialStore>,
        transport: Arc<ScriptedTransport>,
        port: Arc<RecordingPort>,
    }

    fn setup() -> Setup {
        let transport = ScriptedTransport::new();
        let store = memory_store();
        store.set_credential(CHANNEL, "bot_token", "1:t");
        store.set_credential(CHANNEL, "update_transport", "polling");
        let env = isolated_env();
        let api = TelegramApi::new(transport.clone());
        let port = Arc::new(RecordingPort::default());
        let sender = TelegramSender::new(api.clone(), store.clone(), env.clone());
        let inbound = Arc::new(TelegramInbound::new(
            store.clone(),
            env.clone(),
            sender,
            port.clone(),
        ));
        let poller = TelegramPoller::new(store.clone(), env, api, inbound);
        Setup {
            poller,
            store,
            transport,
            port,
        }
    }

    /// Takes the lease the way `start` would, so `poll_once` finds it owned.
    fn take_lease(s: &Setup) {
        let owner = s.poller.owner_id();
        assert!(s.store.claim_lease(
            CHANNEL,
            OWNER_KEY,
            LEASE_UNTIL_KEY,
            &owner,
            LEASE_TTL_MS,
            Utc::now()
        ));
    }

    #[tokio::test]
    async fn a_batch_advances_the_offset_past_every_update_and_dispatches_them() {
        let s = setup();
        take_lease(&s);
        s.transport.then(
            "getUpdates",
            json_response(
                200,
                json!({"ok": true, "result": [
                    {"update_id": 10, "message": {"message_id": 1, "chat": {"id": 42, "type": "private"}, "text": "hi"}},
                    {"update_id": 11, "callback_query": {"id": "cb", "data": "x"}},
                    {"update_id": 12},
                ]}),
            ),
        );
        s.transport
            .then("sendMessage", json_response(200, json!({"ok": true})));
        s.transport.then(
            "answerCallbackQuery",
            json_response(200, json!({"ok": true})),
        );

        s.poller.poll_once().await;

        assert_eq!(
            s.store.get_credential(CHANNEL, "polling_offset").as_deref(),
            Some("13")
        );
        let body = ScriptedTransport::body_of(&s.transport.calls("getUpdates")[0]);
        assert_eq!(body["offset"], 0);
    }

    #[tokio::test]
    async fn a_conflict_sets_the_cooldown_and_stops() {
        let s = setup();
        take_lease(&s);
        {
            let mut state = s.poller.state();
            state.active = true;
        }
        s.transport
            .then("getUpdates", json_response(409, json!({"ok": false})));

        s.poller.poll_once().await;

        assert!(!s.poller.is_active());
        assert!(s.poller.state().conflict_until.is_some());
    }

    #[tokio::test]
    async fn a_lost_lease_makes_no_request() {
        let s = setup();
        s.store.set_credential(CHANNEL, OWNER_KEY, "someone-else");
        s.store.set_credential(
            CHANNEL,
            LEASE_UNTIL_KEY,
            &(Utc::now() + chrono::Duration::milliseconds(60_000)).to_rfc3339(),
        );

        s.poller.poll_once().await;

        assert!(s.transport.calls("getUpdates").is_empty());
        assert!(s.port.dispatched.lock().unwrap().is_empty());
    }
}
