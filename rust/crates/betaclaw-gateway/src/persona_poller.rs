//! Mirrors `src/server/telegram/personaTelegramPoller.ts`.
//! A failed inbound round retains the offset so Telegram retries it.
use crate::background::BackgroundTask;
use betaclaw_core::channels::adapters::telegram::{
    api::{TELEGRAM_ALLOWED_UPDATES, TELEGRAM_API_BASE},
    types::TelegramUpdate,
};
use betaclaw_core::channels::pairing::telegram_inbound::{TelegramBotContext, TelegramInbound};
use betaclaw_core::personas::telegram_bots::{
    PersonaTelegramBot, PersonaTelegramBotRegistry, PersonaTelegramTransport,
};
use serde::Deserialize;
use std::{collections::HashSet, sync::Arc, time::Duration};

type PollResult = Result<(), Box<dyn std::error::Error + Send + Sync>>;
pub type PersonaPollerHandle = BackgroundTask;

#[derive(Deserialize)]
struct GetUpdatesResponse {
    ok: bool,
    #[serde(default)]
    result: Vec<TelegramUpdate>,
}

pub struct PersonaPoller {
    client: reqwest::Client,
    db_path: String,
    inbound: Arc<TelegramInbound>,
    api_base: String,
    warned_tokens: HashSet<String>,
}

impl PersonaPoller {
    pub fn is_enabled_from_env() -> bool {
        Self::parse_enabled(std::env::var("BETACLAW_TELEGRAM_POLLER").ok().as_deref())
    }
    pub fn parse_enabled(value: Option<&str>) -> bool {
        value.is_some_and(|v| v.trim().eq_ignore_ascii_case("rust"))
    }
    pub fn new(
        client: reqwest::Client,
        db_path: String,
        inbound: Arc<TelegramInbound>,
        api_base: Option<&str>,
    ) -> Self {
        Self {
            client,
            db_path,
            inbound,
            api_base: api_base
                .unwrap_or(TELEGRAM_API_BASE)
                .trim_end_matches('/')
                .to_string(),
            warned_tokens: HashSet::new(),
        }
    }
    pub fn start(mut self) -> PersonaPollerHandle {
        let (stop, mut signal) = tokio::sync::watch::channel(false);
        let task = tokio::spawn(async move {
            let mut interval = tokio::time::interval(Duration::from_secs(2));
            interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
            loop {
                tokio::select! { _ = signal.changed() => break, _ = interval.tick() => {} }
                if *signal.borrow() {
                    break;
                }
                if let Err(error) = self.poll_all_active_bots().await {
                    tracing::warn!(%error, "[telegram-poller] failed to read bots");
                }
            }
        });
        BackgroundTask { stop, task }
    }
    pub async fn poll_all_active_bots(&mut self) -> PollResult {
        let bots = PersonaTelegramBotRegistry::open(&self.db_path)?.list_active_bots()?;
        let mut seen = HashSet::new();
        for bot in bots {
            if bot.transport != PersonaTelegramTransport::Polling
                || !bot.active
                || bot.token.trim().is_empty()
            {
                continue;
            }
            if !seen.insert(bot.token.clone()) {
                if self.warned_tokens.insert(bot.token.clone()) {
                    tracing::warn!(bot_id = %bot.bot_id, "[telegram-poller] duplicate token skipped");
                }
                continue;
            }
            if let Err(error) = self.poll_bot_once(&bot).await {
                let message = redacted_error(&error.to_string(), &bot.token);
                tracing::warn!(bot_id = %bot.bot_id, error = %message, "[telegram-poller] round failed; offset retained");
            }
        }
        Ok(())
    }
    async fn poll_bot_once(&self, bot: &PersonaTelegramBot) -> PollResult {
        let response = self.client.post(format!("{}/bot{}/getUpdates", self.api_base, bot.token))
            .json(&serde_json::json!({"offset":bot.polling_offset,"timeout":1,"limit":20,"allowed_updates":TELEGRAM_ALLOWED_UPDATES}))
            .timeout(Duration::from_secs(5)).send().await.map_err(|e| e.without_url())?
            .error_for_status().map_err(|e| e.without_url())?;
        let updates: GetUpdatesResponse = response.json().await.map_err(|e| e.without_url())?;
        if !updates.ok || updates.result.is_empty() {
            return Ok(());
        }
        let context = TelegramBotContext {
            bot_id: bot.bot_id.clone(),
            persona_id: bot.persona_id.clone(),
            token: bot.token.clone(),
        };
        let mut max_id = bot.polling_offset;
        for update in &updates.result {
            self.inbound.process_update(update, Some(&context)).await?;
            max_id = max_id.max(update.update_id);
        }
        let next = max_id
            .checked_add(1)
            .ok_or("Telegram update offset overflow")?;
        if next > bot.polling_offset {
            PersonaTelegramBotRegistry::open(&self.db_path)?
                .set_polling_offset(&bot.bot_id, next)?;
        }
        Ok(())
    }
}
fn redacted_error(message: &str, token: &str) -> String {
    message.replace(token, "[REDACTED]")
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{families::channels_wire::store::ChannelDb, model_hub_transport::ReqwestTransport};
    use betaclaw_core::channels::{
        adapters::{telegram::types::TelegramCallbackQuery, types::ChannelError},
        pairing::{
            credentials::ChannelEnv,
            telegram_inbound::{TelegramDispatch, TelegramInboundPort},
            ChannelPairing,
        },
    };
    use betaclaw_core::model_hub::http::BoxFuture;
    use betaclaw_core::personas::telegram_bots::UpsertPersonaTelegramBotInput;
    use std::sync::{
        atomic::{AtomicBool, Ordering},
        Mutex,
    };
    #[derive(Default)]
    struct Port {
        seen: Mutex<Vec<String>>,
        fail: AtomicBool,
        slow: AtomicBool,
    }
    impl TelegramInboundPort for Port {
        fn handle_native_command<'a>(
            &'a self,
            _: &'a str,
            _: &'a str,
            _: &'a str,
        ) -> BoxFuture<'a, Result<bool, ChannelError>> {
            Box::pin(async { Ok(false) })
        }
        fn handle_model_callback<'a>(
            &'a self,
            _: &'a TelegramCallbackQuery,
        ) -> BoxFuture<'a, Result<bool, ChannelError>> {
            Box::pin(async { Ok(false) })
        }
        fn dispatch_message<'a>(
            &'a self,
            message: TelegramDispatch<'a>,
        ) -> BoxFuture<'a, Result<bool, ChannelError>> {
            Box::pin(async move {
                self.seen
                    .lock()
                    .unwrap()
                    .push(message.external_msg_id.to_string());
                assert_eq!(message.bot_context.unwrap().persona_id, "p1");
                if self.slow.load(Ordering::Relaxed) {
                    tokio::time::sleep(Duration::from_millis(20)).await;
                }
                if self.fail.load(Ordering::Relaxed) {
                    Err(ChannelError::new("dispatch failed"))
                } else {
                    Ok(true)
                }
            })
        }
    }
    async fn poller() -> (
        PersonaPoller,
        Arc<Port>,
        tokio::task::JoinHandle<()>,
        std::path::PathBuf,
    ) {
        let path = std::env::temp_dir().join(format!("poller-{}.db", uuid::Uuid::new_v4()));
        PersonaTelegramBotRegistry::open(path.to_str().unwrap())
            .unwrap()
            .upsert_bot(&UpsertPersonaTelegramBotInput {
                bot_id: "bot1".into(),
                persona_id: "p1".into(),
                token: "secret-token".into(),
                webhook_secret: "s".into(),
                peer_name: None,
                transport: PersonaTelegramTransport::Polling,
            })
            .unwrap();
        let port = Arc::new(Port::default());
        let pairing = ChannelPairing::new(
            Arc::new(ChannelDb::open(":memory:").unwrap()),
            Arc::new(ChannelEnv::default()),
            Arc::new(ReqwestTransport::new()),
            port.clone(),
        );
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let base = format!("http://{}", listener.local_addr().unwrap());
        let router = axum::Router::new().route("/botsecret-token/getUpdates", axum::routing::post(|axum::Json(body): axum::Json<serde_json::Value>| async move {
            assert_eq!(body["allowed_updates"], serde_json::json!(TELEGRAM_ALLOWED_UPDATES));
            axum::Json(serde_json::json!({"ok":true,"result":[
                {"update_id":1,"message":{"message_id":1,"chat":{"id":1,"type":"private"},"text":"one"}},
                {"update_id":2,"message":{"message_id":2,"chat":{"id":1,"type":"private"},"text":"two"}}
            ]}))
        }));
        let server = tokio::spawn(async move {
            axum::serve(listener, router).await.unwrap();
        });
        (
            PersonaPoller::new(
                reqwest::Client::new(),
                path.to_string_lossy().into(),
                pairing.inbound(),
                Some(&base),
            ),
            port,
            server,
            path,
        )
    }
    #[tokio::test]
    async fn forwards_in_order_then_commits_offset() {
        let (mut poller, port, server, path) = poller().await;
        poller.poll_all_active_bots().await.unwrap();
        assert_eq!(*port.seen.lock().unwrap(), vec!["1", "2"]);
        assert_eq!(
            PersonaTelegramBotRegistry::open(path.to_str().unwrap())
                .unwrap()
                .list_active_bots()
                .unwrap()[0]
                .polling_offset,
            3
        );
        server.abort();
        let _ = std::fs::remove_file(path);
    }
    #[tokio::test]
    async fn stop_drains_the_in_flight_inbound_round_before_committing_offset() {
        let (poller, port, server, path) = poller().await;
        port.slow.store(true, Ordering::Relaxed);
        let handle = poller.start();
        tokio::time::timeout(Duration::from_secs(2), async {
            while port.seen.lock().unwrap().is_empty() {
                tokio::time::sleep(Duration::from_millis(1)).await;
            }
        })
        .await
        .unwrap();
        handle.stop().await;
        assert_eq!(*port.seen.lock().unwrap(), vec!["1", "2"]);
        assert_eq!(
            PersonaTelegramBotRegistry::open(path.to_str().unwrap())
                .unwrap()
                .list_active_bots()
                .unwrap()[0]
                .polling_offset,
            3
        );
        server.abort();
        let _ = std::fs::remove_file(path);
    }

    #[tokio::test]
    async fn failure_preserves_offset_and_retries_next_round() {
        let (mut poller, port, server, path) = poller().await;
        port.fail.store(true, Ordering::Relaxed);
        poller.poll_all_active_bots().await.unwrap();
        assert_eq!(
            PersonaTelegramBotRegistry::open(path.to_str().unwrap())
                .unwrap()
                .list_active_bots()
                .unwrap()[0]
                .polling_offset,
            0
        );
        port.fail.store(false, Ordering::Relaxed);
        poller.poll_all_active_bots().await.unwrap();
        assert_eq!(*port.seen.lock().unwrap(), vec!["1", "1", "2"]);
        server.abort();
        let _ = std::fs::remove_file(path);
    }
    #[test]
    fn token_is_redacted_and_only_rust_owns_the_poller() {
        assert!(!redacted_error(
            "request to /botsecret-token/getUpdates failed",
            "secret-token"
        )
        .contains("secret-token"));
        for value in [None, Some(""), Some("node"), Some("off"), Some("false")] {
            assert!(!PersonaPoller::parse_enabled(value));
        }
        for value in [Some("rust"), Some(" RUST ")] {
            assert!(PersonaPoller::parse_enabled(value));
        }
    }
}
