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

#[cfg(test)]
mod tests {
    use std::sync::Arc;

    use serde_json::json;

    use super::*;
    use crate::channels::pairing::credentials::{ChannelCredential, ChannelCredentialStore};
    use crate::channels::pairing::test_support::{
        isolated_env, json_response, memory_store, RecordingPort, ScriptedTransport,
    };
    use crate::channels::pairing::PairChannelType;

    /// A store whose `delete_credentials` keeps the rows, as a failing database would.
    struct StubbornStore(Arc<dyn ChannelCredentialStore>);

    impl ChannelCredentialStore for StubbornStore {
        fn get_credential(&self, channel: &str, key: &str) -> Option<String> {
            self.0.get_credential(channel, key)
        }

        fn set_credential(&self, channel: &str, key: &str, value: &str) {
            self.0.set_credential(channel, key, value);
        }

        fn delete_credential(&self, channel: &str, key: &str) {
            self.0.delete_credential(channel, key);
        }

        fn delete_credentials(&self, _channel: &str) {}

        fn list_credentials(&self, channel: &str) -> Vec<ChannelCredential> {
            self.0.list_credentials(channel)
        }
    }

    fn pairing(
        store: Arc<dyn ChannelCredentialStore>,
        transport: &Arc<ScriptedTransport>,
    ) -> ChannelPairing {
        ChannelPairing::new(
            store,
            isolated_env(),
            transport.clone(),
            Arc::new(RecordingPort::default()),
        )
    }

    #[tokio::test]
    async fn telegram_unpair_deletes_the_webhook_and_clears_the_credentials() {
        let transport = ScriptedTransport::new();
        transport.then("deleteWebhook", json_response(200, json!({"ok": true})));
        let store = memory_store();
        store.set_credential("telegram", "bot_token", "1:t");
        store.set_credential("telegram", "webhook_secret", "s");
        let pairing = pairing(store.clone(), &transport);

        pairing
            .unpair_channel(PairChannelType::Telegram, None)
            .await
            .expect("unpaired");

        assert_eq!(transport.calls("deleteWebhook").len(), 1);
        assert_eq!(store.get_credential("telegram", "bot_token"), None);
        assert_eq!(store.get_credential("telegram", "webhook_secret"), None);
    }

    #[tokio::test]
    async fn discord_unpair_clears_the_token_without_an_api_call() {
        let transport = ScriptedTransport::new();
        let store = memory_store();
        store.set_credential("discord", "bot_token", "dc-token");
        let pairing = pairing(store.clone(), &transport);

        pairing
            .unpair_channel(PairChannelType::Discord, None)
            .await
            .expect("unpaired");

        assert_eq!(store.get_credential("discord", "bot_token"), None);
        assert!(transport.requests().is_empty());
    }

    #[tokio::test]
    async fn telegram_unpair_stops_the_running_poller() {
        let transport = ScriptedTransport::new();
        let store = memory_store();
        store.set_credential("telegram", "bot_token", "1:t");
        store.set_credential("telegram", "update_transport", "polling");
        let pairing = pairing(store, &transport);
        pairing.start_telegram_polling().await;
        assert!(pairing.is_telegram_polling_active());

        pairing
            .unpair_channel(PairChannelType::Telegram, None)
            .await
            .expect("unpaired");

        assert!(!pairing.is_telegram_polling_active());
    }

    #[tokio::test]
    async fn telegram_unpair_fails_while_the_token_is_still_stored() {
        let transport = ScriptedTransport::new();
        let inner = memory_store();
        inner.set_credential("telegram", "bot_token", "1:t");
        let store: Arc<dyn ChannelCredentialStore> = Arc::new(StubbornStore(inner));
        let pairing = pairing(store, &transport);

        let error = pairing
            .unpair_channel(PairChannelType::Telegram, None)
            .await
            .expect_err("the token survived");

        assert_eq!(
            error.0,
            "Telegram disconnect incomplete: bot token still present in credential store."
        );
    }
}
