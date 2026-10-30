//! Port of `src/server/channels/pairing/unpair.ts`.
//!
//! Disconnecting removes the webhook where the provider has one and clears the
//! stored credentials. Telegram checks afterwards that no token is left behind.
//! Without an account id, every bridge account is removed and the channel rows
//! are deleted once no account remains. With an id, only that account goes.

use serde_json::json;
use tracing::warn;

use super::bridge::deregister_bridge_webhook;
use super::bridge_accounts::{
    list_bridge_account_ids, normalize_bridge_account_id, remove_bridge_account, BridgeChannel,
};
use super::{trim_one_slash, ChannelPairing, UnpairChannelType};
use crate::channels::adapters::types::{non_empty, ChannelError};

impl ChannelPairing {
    /// `unpairChannel`.
    pub async fn unpair_channel(
        &self,
        channel: UnpairChannelType,
        account_id: Option<&str>,
    ) -> Result<(), ChannelError> {
        match channel {
            UnpairChannelType::Telegram => self.unpair_telegram().await,
            UnpairChannelType::Discord => {
                self.store.delete_credentials("discord");
                self.env.remove("DISCORD_BOT_TOKEN");
                Ok(())
            }
            UnpairChannelType::Slack => {
                self.store.delete_credentials("slack");
                self.env.remove("SLACK_BOT_TOKEN");
                Ok(())
            }
            UnpairChannelType::WhatsApp => {
                self.unpair_bridge(BridgeChannel::WhatsApp, account_id)
                    .await
            }
            UnpairChannelType::IMessage => {
                self.unpair_bridge(BridgeChannel::IMessage, account_id)
                    .await
            }
        }
    }

    async fn unpair_telegram(&self) -> Result<(), ChannelError> {
        self.poller.stop();

        let token = non_empty(self.store.get_credential("telegram", "bot_token"))
            .or_else(|| non_empty(self.env.get("TELEGRAM_BOT_TOKEN")));
        if let Some(token) = token {
            if let Err(error) = self.api.post(&token, "deleteWebhook", &json!({})).await {
                warn!("Telegram deleteWebhook warning: {}", error);
            }
        }

        self.store.delete_credentials("telegram");
        let token_left = non_empty(self.store.get_credential("telegram", "bot_token")).is_some();
        let rows_left = !self.store.list_credentials("telegram").is_empty();
        if token_left || rows_left {
            return Err(ChannelError::new(
                "Telegram disconnect incomplete: bot token still present in credential store.",
            ));
        }
        self.env.remove("TELEGRAM_BOT_TOKEN");
        self.env.remove("TELEGRAM_WEBHOOK_SECRET");
        Ok(())
    }

    async fn unpair_bridge(
        &self,
        channel: BridgeChannel,
        account_id_input: Option<&str>,
    ) -> Result<(), ChannelError> {
        let bridge_base = non_empty(self.env.get(channel.bridge_url_env()))
            .map(|url| trim_one_slash(&url).to_string());
        let account_id = normalize_bridge_account_id(account_id_input)?;
        let unpair_all = account_id_input.is_none();

        let targets = if unpair_all {
            list_bridge_account_ids(self.store.as_ref(), channel)?
        } else {
            vec![account_id.clone()]
        };
        let to_clear = if targets.is_empty() {
            vec![account_id]
        } else {
            targets
        };

        for target in to_clear {
            if let Some(base) = &bridge_base {
                if let Err(error) = deregister_bridge_webhook(
                    self.transport.as_ref(),
                    self.store.as_ref(),
                    &self.env,
                    channel,
                    base,
                    &target,
                )
                .await
                {
                    warn!(
                        "{} webhook deregistration warning: {}",
                        channel.as_str(),
                        error
                    );
                }
            }
            remove_bridge_account(self.store.as_ref(), channel, Some(target.as_str()))?;
        }

        if unpair_all && list_bridge_account_ids(self.store.as_ref(), channel)?.is_empty() {
            self.store.delete_credentials(channel.as_str());
        }
        Ok(())
    }
}
