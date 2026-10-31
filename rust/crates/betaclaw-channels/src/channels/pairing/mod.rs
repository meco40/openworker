//! Port of `src/server/channels/pairing/` (S3 leftover, needed by S8).
//!
//! `index.ts` holds `pairChannel`, `isPairChannelType` and the re-export of
//! `unpairChannel`. The per-channel flows live in the sibling modules, each
//! named after its TypeScript file.
//!
//! The TypeScript modules keep their state in `globalThis` and in `process.env`.
//! The port passes that state in instead. [`ChannelPairing`] owns the credential
//! store, the environment overlay, the HTTP transport, the Telegram poller and
//! the inbound port. Each channel flow is an `impl` block on it, in the module of
//! that channel.

pub mod bridge;
pub mod bridge_accounts;
pub mod credentials;
pub mod discord;
pub mod slack;
pub mod telegram;
pub mod telegram_code;
pub mod telegram_inbound;
pub mod telegram_polling;
pub mod unpair;

#[cfg(test)]
pub(crate) mod test_support;

use std::sync::Arc;

use bridge_accounts::BridgeChannel;
use credentials::{ChannelCredentialStore, ChannelEnv};
use telegram_inbound::{InboundOutcome, TelegramBotContext, TelegramInbound, TelegramInboundPort};
use telegram_polling::TelegramPoller;

use crate::channels::adapters::telegram::api::TelegramApi;
use crate::channels::adapters::telegram::outbound::TelegramSender;
use crate::channels::adapters::telegram::types::TelegramUpdate;
use crate::channels::adapters::types::{non_empty, ChannelError};
use crate::model_hub::http::HttpTransport;

/// `PairChannelType`. The unpair side accepts the same set, so it is an alias.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PairChannelType {
    WhatsApp,
    Telegram,
    Discord,
    IMessage,
    Slack,
}

pub type UnpairChannelType = PairChannelType;

impl PairChannelType {
    /// `isPairChannelType`. The match is exact, as in the source.
    pub fn parse(value: &str) -> Option<Self> {
        match value {
            "whatsapp" => Some(Self::WhatsApp),
            "telegram" => Some(Self::Telegram),
            "discord" => Some(Self::Discord),
            "imessage" => Some(Self::IMessage),
            "slack" => Some(Self::Slack),
            _ => None,
        }
    }
}

/// The value a pairing flow returns. The shape differs per channel in the
/// source, so the optional parts are optional here as well.
#[derive(Debug, Clone, PartialEq)]
pub struct PairingOutcome {
    pub status: Option<String>,
    pub transport: Option<String>,
    pub account_id: Option<String>,
    pub peer_name: String,
    pub details: serde_json::Value,
}

/// `randomBytes(len).toString('hex')`.
pub fn random_hex(len: usize) -> Result<String, ChannelError> {
    let mut buffer = vec![0u8; len];
    getrandom::fill(&mut buffer)
        .map_err(|error| ChannelError::new(format!("random bytes unavailable: {error}")))?;
    Ok(buffer.iter().map(|byte| format!("{byte:02x}")).collect())
}

/// `APP_URL || NEXTAUTH_URL || VERCEL_URL`, the public origin of the gateway.
pub fn app_url(env: &ChannelEnv) -> Option<String> {
    ["APP_URL", "NEXTAUTH_URL", "VERCEL_URL"]
        .into_iter()
        .find_map(|name| non_empty(env.get(name)))
}

/// `url.replace(/\/$/, '')`: removes one trailing slash.
pub fn trim_one_slash(url: &str) -> &str {
    url.strip_suffix('/').unwrap_or(url)
}

/// The pairing composition root: one value per gateway, in place of the module
/// singletons of the source.
pub struct ChannelPairing {
    pub(crate) store: Arc<dyn ChannelCredentialStore>,
    pub(crate) env: Arc<ChannelEnv>,
    pub(crate) transport: Arc<dyn HttpTransport>,
    pub(crate) api: TelegramApi,
    pub(crate) inbound: Arc<TelegramInbound>,
    pub(crate) poller: TelegramPoller,
}

impl ChannelPairing {
    pub fn new(
        store: Arc<dyn ChannelCredentialStore>,
        env: Arc<ChannelEnv>,
        transport: Arc<dyn HttpTransport>,
        port: Arc<dyn TelegramInboundPort>,
    ) -> Self {
        let api = TelegramApi::new(transport.clone());
        let sender = TelegramSender::new(api.clone(), store.clone(), env.clone());
        let inbound = Arc::new(TelegramInbound::new(
            store.clone(),
            env.clone(),
            sender,
            port,
        ));
        let poller = TelegramPoller::new(store.clone(), env.clone(), api.clone(), inbound.clone());
        Self {
            store,
            env,
            transport,
            api,
            inbound,
            poller,
        }
    }

    pub fn inbound(&self) -> Arc<TelegramInbound> {
        self.inbound.clone()
    }

    /// `pairChannel`. The token is used by the token-based channels, the account
    /// id by the bridges.
    pub async fn pair_channel(
        &self,
        channel: PairChannelType,
        token: &str,
        account_id: Option<&str>,
    ) -> Result<PairingOutcome, ChannelError> {
        match channel {
            PairChannelType::Telegram => self.pair_telegram(token).await,
            PairChannelType::Discord => self.pair_discord(token).await,
            PairChannelType::Slack => self.pair_slack(token).await,
            PairChannelType::WhatsApp => {
                self.pair_bridge(BridgeChannel::WhatsApp, account_id).await
            }
            PairChannelType::IMessage => {
                self.pair_bridge(BridgeChannel::IMessage, account_id).await
            }
        }
    }

    async fn pair_bridge(
        &self,
        channel: BridgeChannel,
        account_id: Option<&str>,
    ) -> Result<PairingOutcome, ChannelError> {
        bridge::pair_bridge_channel(
            self.transport.as_ref(),
            self.store.as_ref(),
            &self.env,
            channel,
            account_id,
        )
        .await
    }

    /// `processTelegramInboundUpdate`, for updates that arrive by webhook.
    pub async fn process_telegram_update(
        &self,
        update: &TelegramUpdate,
        bot_context: Option<&TelegramBotContext>,
    ) -> Result<InboundOutcome, ChannelError> {
        self.inbound.process_update(update, bot_context).await
    }

    /// `startTelegramPolling`.
    pub async fn start_telegram_polling(&self) {
        self.poller.start().await;
    }

    /// `stopTelegramPolling`.
    pub fn stop_telegram_polling(&self) {
        self.poller.stop();
    }

    /// `isTelegramPollingActive`.
    pub fn is_telegram_polling_active(&self) -> bool {
        self.poller.is_active()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::channels::pairing::test_support::isolated_env;

    #[test]
    fn the_channel_names_are_matched_exactly() {
        assert_eq!(
            PairChannelType::parse("telegram"),
            Some(PairChannelType::Telegram)
        );
        assert_eq!(PairChannelType::parse("iMessage"), None);
        assert_eq!(PairChannelType::parse("sms"), None);
    }

    #[test]
    fn random_hex_has_twice_as_many_digits_as_bytes() {
        let secret = random_hex(32).expect("random bytes");
        assert_eq!(secret.len(), 64);
        assert!(secret.chars().all(|ch| ch.is_ascii_hexdigit()));
    }

    #[test]
    fn the_app_url_takes_the_first_configured_origin() {
        let env = isolated_env();
        assert_eq!(app_url(&env), None);
        env.set("NEXTAUTH_URL", "https://nextauth.test");
        env.set("VERCEL_URL", "vercel.test");
        assert_eq!(app_url(&env).as_deref(), Some("https://nextauth.test"));
        env.set("APP_URL", "https://app.test");
        assert_eq!(app_url(&env).as_deref(), Some("https://app.test"));
    }

    #[test]
    fn exactly_one_trailing_slash_is_removed() {
        assert_eq!(trim_one_slash("https://a.test/"), "https://a.test");
        assert_eq!(trim_one_slash("https://a.test//"), "https://a.test/");
    }
}
