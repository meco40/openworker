//! Port of `src/server/channels/telegram/nativeCommands.ts`.
//!
//! The command list is the bot menu. Syncing it clears the menu first and then
//! sets it. Neither failure is returned: as in the source, both are logged.

use serde_json::{json, Value};
use tracing::warn;

use super::api::TelegramApi;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TelegramMenuCommand {
    pub command: &'static str,
    pub description: &'static str,
}

/// `TELEGRAM_NATIVE_COMMANDS`.
pub const TELEGRAM_NATIVE_COMMANDS: [TelegramMenuCommand; 6] = [
    TelegramMenuCommand {
        command: "new",
        description: "Start a new conversation",
    },
    TelegramMenuCommand {
        command: "chatdelete",
        description: "Delete the latest message in this chat",
    },
    TelegramMenuCommand {
        command: "reset",
        description: "Reset the current conversation",
    },
    TelegramMenuCommand {
        command: "persona",
        description: "List or switch persona",
    },
    TelegramMenuCommand {
        command: "cron",
        description: "Manage automation rules",
    },
    TelegramMenuCommand {
        command: "model",
        description: "Inspect or switch chat model",
    },
];

/// `syncTelegramNativeCommands`.
pub async fn sync_native_commands(
    api: &TelegramApi,
    token: &str,
    commands: &[TelegramMenuCommand],
) {
    if token.trim().is_empty() {
        return;
    }

    if let Err(error) = api
        .call_checked(token, "deleteMyCommands", &json!({}))
        .await
    {
        warn!("[Telegram] deleteMyCommands failed: {}", error);
    }

    if commands.is_empty() {
        return;
    }

    let menu: Vec<Value> = commands
        .iter()
        .map(|command| json!({ "command": command.command, "description": command.description }))
        .collect();
    if let Err(error) = api
        .call_checked(token, "setMyCommands", &json!({ "commands": menu }))
        .await
    {
        warn!("[Telegram] setMyCommands failed: {}", error);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::channels::pairing::test_support::{json_response, ScriptedTransport};

    fn api_with(transport: &std::sync::Arc<ScriptedTransport>) -> TelegramApi {
        TelegramApi::new(transport.clone())
    }

    #[tokio::test]
    async fn clears_the_menu_and_then_sets_all_commands() {
        let transport = ScriptedTransport::new();
        transport.then("deleteMyCommands", json_response(200, json!({"ok": true})));
        transport.then("setMyCommands", json_response(200, json!({"ok": true})));

        sync_native_commands(&api_with(&transport), "1:t", &TELEGRAM_NATIVE_COMMANDS).await;

        assert_eq!(transport.calls("deleteMyCommands").len(), 1);
        let set = transport.calls("setMyCommands");
        assert_eq!(set.len(), 1);
        let body = ScriptedTransport::body_of(&set[0]);
        assert_eq!(body["commands"].as_array().map(Vec::len), Some(6));
        assert_eq!(body["commands"][0]["command"], "new");
    }

    #[tokio::test]
    async fn a_failed_clear_does_not_stop_the_set() {
        let transport = ScriptedTransport::new();
        transport.then("deleteMyCommands", json_response(400, json!({"ok": false})));
        transport.then("setMyCommands", json_response(200, json!({"ok": true})));

        sync_native_commands(&api_with(&transport), "1:t", &TELEGRAM_NATIVE_COMMANDS).await;

        assert_eq!(transport.calls("setMyCommands").len(), 1);
    }

    #[tokio::test]
    async fn a_blank_token_makes_no_request() {
        let transport = ScriptedTransport::new();

        sync_native_commands(&api_with(&transport), "  ", &TELEGRAM_NATIVE_COMMANDS).await;

        assert!(transport.requests().is_empty());
    }
}
